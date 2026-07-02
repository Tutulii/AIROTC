import { TxlineFixture, TxlineOddsUpdate, TxlineScoreUpdate } from './types';

const DEFAULT_TXLINE_BASE_URL = 'https://txline.txodds.com';
const REQUEST_TIMEOUT_MS = 12_000;
const GUEST_JWT_CACHE_MS = 10 * 60 * 1000;
const ODDS_SNAPSHOT_ENDPOINT = '/api/odds/snapshot';
const SCORES_SNAPSHOT_ENDPOINT = '/api/scores/snapshot';
export const ODDS_STREAM_ENDPOINT = '/api/odds/stream';
export const SCORES_STREAM_ENDPOINT = '/api/scores/stream';
const ESPN_SCOREBOARD_BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports';
const ESPN_FALLBACK_LEAGUES = [
    { key: 'mlb', sport: 'baseball', path: 'baseball/mlb' },
    { key: 'wnba', sport: 'basketball', path: 'basketball/wnba' },
    { key: 'mls', sport: 'soccer', path: 'soccer/usa.1' },
    { key: 'epl', sport: 'soccer', path: 'soccer/eng.1' },
];

let guestJwtCache: { token: string; expiresAt: number } | null = null;

function cleanBaseUrl(value: string | undefined): string {
    return (value || DEFAULT_TXLINE_BASE_URL).replace(/\/$/, '');
}

export function txlineBaseUrl(): string {
    return cleanBaseUrl(process.env.TXLINE_API_BASE_URL || process.env.TXLINE_BASE_URL);
}

export function txlineNetwork(): string {
    if (process.env.TXLINE_NETWORK) return process.env.TXLINE_NETWORK;
    const baseUrl = txlineBaseUrl();
    if (baseUrl.includes('txline-dev.txodds.com')) return 'devnet';
    if (baseUrl.includes('txline.txodds.com')) return 'mainnet';
    return 'custom';
}

export function txlineAuthConfigured(): boolean {
    return Boolean(process.env.TXLINE_API_KEY || process.env.TXLINE_API_TOKEN);
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

export function txlineFallbackEnabled(): boolean {
    return envFlag(process.env.TXLINE_SCOREBOARD_FALLBACK_ENABLED, true);
}

export function txlineActiveFixtureSource(): 'txline' | 'espn_scoreboard_fallback' | 'unconfigured' {
    if (txlineAuthConfigured()) return 'txline';
    if (txlineFallbackEnabled()) return 'espn_scoreboard_fallback';
    return 'unconfigured';
}

export function txlineGuestJwtMode(): 'env' | 'auto' {
    return process.env.TXLINE_GUEST_JWT ? 'env' : 'auto';
}

export function clearTxlineGuestJwtCacheForTests(): void {
    guestJwtCache = null;
}

function txlineApiToken(): string {
    return process.env.TXLINE_API_TOKEN || process.env.TXLINE_API_KEY || '';
}

async function fetchGuestJwt(): Promise<string> {
    if (process.env.TXLINE_GUEST_JWT) return process.env.TXLINE_GUEST_JWT;
    if (guestJwtCache && guestJwtCache.expiresAt > Date.now()) return guestJwtCache.token;

    const response = await fetch(`${txlineBaseUrl()}/auth/guest/start`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
        throw new Error(`TxLINE guest auth failed ${response.status} ${response.statusText}`);
    }

    const payload = await response.json() as { token?: unknown };
    if (typeof payload.token !== 'string' || !payload.token.trim()) {
        throw new Error('TxLINE guest auth returned no token');
    }

    guestJwtCache = {
        token: payload.token,
        expiresAt: Date.now() + GUEST_JWT_CACHE_MS,
    };
    return payload.token;
}

async function headers(): Promise<Record<string, string>> {
    const apiToken = txlineApiToken();
    if (!apiToken) {
        throw new Error('TXLINE_API_TOKEN is required before calling TxLINE snapshot endpoints');
    }

    return {
        Accept: 'application/json',
        Authorization: `Bearer ${await fetchGuestJwt()}`,
        'X-Api-Token': apiToken,
    };
}

async function fetchJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const url = `${txlineBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: await headers(),
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`TxLINE request failed ${response.status} ${response.statusText}`);
        }
        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nested(value: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => asRecord(current)[key], value);
}

function firstString(source: Record<string, unknown>, keys: string[], fallback = ''): string {
    for (const key of keys) {
        const value = key.includes('.') ? nested(source, key) : source[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return fallback;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = key.includes('.') ? nested(source, key) : source[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim()) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return undefined;
}

function firstDate(source: Record<string, unknown>, keys: string[], fallback?: Date): Date | undefined {
    for (const key of keys) {
        const value = key.includes('.') ? nested(source, key) : source[key];
        if (value instanceof Date && Number.isFinite(value.getTime())) return value;
        if (typeof value === 'string' || typeof value === 'number') {
            const parsed = new Date(value);
            if (Number.isFinite(parsed.getTime())) return parsed;
        }
    }
    return fallback;
}

function maybeArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function firstArray(payload: unknown, keys: string[]): unknown[] {
    if (Array.isArray(payload)) return payload;
    const root = asRecord(payload);
    for (const key of keys) {
        const value = key.includes('.') ? nested(root, key) : root[key];
        if (Array.isArray(value)) return value;
    }
    return [];
}

function espnScoreboardUrl(path: string): string {
    return `${ESPN_SCOREBOARD_BASE_URL}/${path}/scoreboard?limit=100`;
}

function espnStatusName(event: Record<string, unknown>): string {
    const type = asRecord(nested(event, 'status.type'));
    const state = firstString(type, ['state']).toLowerCase();
    const name = firstString(type, ['name', 'description', 'detail']).toLowerCase();
    const completed = type.completed === true;

    if (completed || name.includes('final') || name.includes('full time') || state === 'post') return 'final';
    if (state === 'in' || name.includes('in_progress') || name.includes('live')) return 'live';
    if (state === 'pre' || name.includes('scheduled') || name.includes('pre')) return 'scheduled';
    return firstString(type, ['name', 'description'], 'unknown').toLowerCase() || 'unknown';
}

function espnTeamName(competitor: Record<string, unknown>): string | undefined {
    const team = asRecord(competitor.team);
    return firstString(team, ['displayName', 'shortDisplayName', 'name', 'abbreviation']) ||
        firstString(competitor, ['displayName', 'name', 'abbreviation']) ||
        undefined;
}

function espnCompetitors(event: Record<string, unknown>): Record<string, unknown>[] {
    const competitions = maybeArray(event.competitions).map(asRecord);
    const competition = competitions[0] || {};
    return maybeArray(competition.competitors).map(asRecord);
}

function espnFixtureId(leagueKey: string, eventId: string): string {
    return `espn:${leagueKey}:${eventId}`;
}

function parseEspnFixtureId(fixtureId: string): { leagueKey: string; eventId: string } | null {
    const parts = fixtureId.split(':');
    if (parts.length !== 3 || parts[0] !== 'espn' || !parts[1] || !parts[2]) return null;
    return { leagueKey: parts[1], eventId: parts[2] };
}

function espnEventToFixture(event: unknown, league: typeof ESPN_FALLBACK_LEAGUES[number]): TxlineFixture | null {
    const raw = asRecord(event);
    const eventId = firstString(raw, ['id', 'uid']);
    if (!eventId) return null;

    const competitors = espnCompetitors(raw);
    const home = competitors.find((competitor) => firstString(competitor, ['homeAway']).toLowerCase() === 'home') || competitors[0] || {};
    const away = competitors.find((competitor) => firstString(competitor, ['homeAway']).toLowerCase() === 'away') || competitors[1] || {};
    const startsAt = firstDate(raw, ['date']);

    return {
        fixtureId: espnFixtureId(league.key, eventId),
        sport: league.sport,
        homeTeam: espnTeamName(home),
        awayTeam: espnTeamName(away),
        startsAt,
        status: espnStatusName(raw),
        raw: {
            source: 'espn_scoreboard_fallback',
            fallbackFor: 'txline',
            league: league.key,
            sourceEndpoint: espnScoreboardUrl(league.path),
            espnEventId: eventId,
            marketSelections: ['part1', 'draw', 'part2'],
            raw,
        },
    };
}

async function fetchEspnJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(espnScoreboardUrl(path), {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`ESPN fallback request failed ${response.status} ${response.statusText}`);
        }
        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

export async function fetchEspnFallbackFixturesSnapshot(): Promise<TxlineFixture[]> {
    const results = await Promise.allSettled(
        ESPN_FALLBACK_LEAGUES.map(async (league) => {
            const payload = await fetchEspnJson(league.path);
            return firstArray(payload, ['events'])
                .map((event) => espnEventToFixture(event, league))
                .filter((fixture): fixture is TxlineFixture => Boolean(fixture));
        })
    );

    const fixtures = results
        .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
        .sort((a, b) => {
            const left = a.startsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
            const right = b.startsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
            return left - right;
        });

    if (fixtures.length === 0) {
        const firstError = results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
        throw new Error(firstError?.reason?.message || 'espn_scoreboard_fallback_returned_no_fixtures');
    }

    return fixtures;
}

function espnScore(competitor: Record<string, unknown>): number | undefined {
    const value = competitor.score;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

async function fetchEspnFallbackScoresSnapshot(fixtureId: string): Promise<TxlineScoreUpdate[]> {
    const parsed = parseEspnFixtureId(fixtureId);
    if (!parsed) {
        throw new Error('TXLINE_API_TOKEN is required before calling TxLINE score snapshots for non-fallback fixtures');
    }
    const league = ESPN_FALLBACK_LEAGUES.find((candidate) => candidate.key === parsed.leagueKey);
    if (!league) throw new Error(`unsupported_espn_fallback_league:${parsed.leagueKey}`);

    const payload = await fetchEspnJson(league.path);
    const event = firstArray(payload, ['events'])
        .map(asRecord)
        .find((candidate) => firstString(candidate, ['id', 'uid']) === parsed.eventId);
    if (!event) throw new Error(`espn_fallback_fixture_not_found:${fixtureId}`);

    const competitors = espnCompetitors(event);
    const home = competitors.find((competitor) => firstString(competitor, ['homeAway']).toLowerCase() === 'home') || competitors[0] || {};
    const away = competitors.find((competitor) => firstString(competitor, ['homeAway']).toLowerCase() === 'away') || competitors[1] || {};
    const homeScore = espnScore(home);
    const awayScore = espnScore(away);
    const sourceTimestamp = new Date();
    const status = espnStatusName(event);

    return [{
        fixtureId,
        homeScore,
        awayScore,
        status,
        source: 'espn_scoreboard_fallback',
        sourceEndpoint: espnScoreboardUrl(league.path),
        sourceUpdateId: `${fixtureId}:${status}:${homeScore ?? 'na'}:${awayScore ?? 'na'}`,
        sourceTimestamp,
        raw: {
            source: 'espn_scoreboard_fallback',
            fallbackFor: 'txline',
            league: league.key,
            espnEventId: parsed.eventId,
            normalizedScoreState: {
                status,
                action: status,
                homeScore: homeScore ?? null,
                awayScore: awayScore ?? null,
                homeTeam: espnTeamName(home),
                awayTeam: espnTeamName(away),
            },
            raw: event,
        },
    }];
}

function impliedProbability(odds: number): number | undefined {
    if (odds <= 1) return undefined;
    return Number((1 / odds).toFixed(6));
}

function normalizeTxlinePrice(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return parsed > 100 ? Number((parsed / 1000).toFixed(6)) : parsed;
}

function txlineSourceId(raw: Record<string, unknown>, selection?: string, index?: number): string | undefined {
    const base = firstString(raw, ['MessageId', 'messageId', 'updateId', 'update_id', 'id', 'Id', 'hash']);
    const seq = firstString(raw, ['Seq', 'seq']);
    const suffix = selection || (index !== undefined ? String(index) : '');
    const parts = [base, seq, suffix].filter(Boolean);
    return parts.length > 0 ? parts.join(':') : undefined;
}

function marketType(raw: Record<string, unknown>): string {
    const base = firstString(raw, ['SuperOddsType', 'market', 'marketName', 'market_type', 'type'], 'match_winner');
    const period = firstString(raw, ['MarketPeriod']);
    const parameters = firstString(raw, ['MarketParameters']);
    return [base, period, parameters].filter(Boolean).join(':');
}

function scoreState(raw: Record<string, unknown>): Record<string, unknown> {
    const score = asRecord(raw.Score || raw.score);
    const homeScore = firstNumber(raw, [
        'homeScore',
        'home_score',
        'score.home',
        'home.score',
        'Score.Participant1.Total.Goals',
        'Score.Home',
        'Score.home',
        'Data.New.Score.Participant1.Total.Goals',
        'Data.Score.Participant1.Total.Goals',
        'Data.New.homeScore',
        'Data.homeScore',
    ]);
    const awayScore = firstNumber(raw, [
        'awayScore',
        'away_score',
        'score.away',
        'away.score',
        'Score.Participant2.Total.Goals',
        'Score.Away',
        'Score.away',
        'Data.New.Score.Participant2.Total.Goals',
        'Data.Score.Participant2.Total.Goals',
        'Data.New.awayScore',
        'Data.awayScore',
    ]);
    return {
        status: firstString(raw, ['GameState', 'status', 'state', 'matchStatus'], 'unknown'),
        action: firstString(raw, ['Action']),
        clock: raw.Clock || nested(raw, 'Data.New.Clock') || null,
        homeScore: homeScore ?? null,
        awayScore: awayScore ?? null,
        score,
        stats: raw.Stats || null,
        possession: raw.Possession || null,
        possessionType: raw.PossessionType || null,
    };
}

export function normalizeFixturesPayload(payload: unknown): TxlineFixture[] {
    const rows = firstArray(payload, ['fixtures', 'data.fixtures', 'data', 'items', 'results']);
    return rows
        .map((row): TxlineFixture | null => {
            const raw = asRecord(row);
            const fixtureId = firstString(raw, ['FixtureId', 'fixtureId', 'fixture_id', 'id', 'matchId', 'MatchId', 'eventId', 'EventId']);
            if (!fixtureId) return null;
            return {
                fixtureId,
                sport: firstString(raw, ['sport', 'sportName', 'Sport', 'SportId'], 'football'),
                homeTeam: firstString(raw, ['Participant1', 'homeTeam', 'home_team', 'home.name', 'teams.home.name']) || undefined,
                awayTeam: firstString(raw, ['Participant2', 'awayTeam', 'away_team', 'away.name', 'teams.away.name']) || undefined,
                startsAt: firstDate(raw, ['StartTime', 'startsAt', 'startTime', 'start_time', 'scheduledAt']),
                status: firstString(raw, ['GameState', 'status', 'state', 'fixtureStatus'], 'unknown'),
                raw,
            } satisfies TxlineFixture;
        })
        .filter((item): item is TxlineFixture => Boolean(item));
}

export function normalizeOddsPayload(payload: unknown, fallbackFixtureId?: string): TxlineOddsUpdate[] {
    const rows = firstArray(payload, ['odds', 'data.odds', 'data.markets', 'markets', 'items', 'updates', 'data']);
    return rows
        .flatMap((row): TxlineOddsUpdate[] => {
            const raw = asRecord(row);
            const fixtureId = firstString(raw, ['FixtureId', 'fixtureId', 'fixture_id', 'id.fixture', 'matchId', 'MatchId'], fallbackFixtureId || '');
            if (!fixtureId) return [];

            const market = marketType(raw);
            const sourceTimestamp = firstDate(raw, ['Ts', 'timestamp', 'updatedAt', 'sourceTimestamp', 'time'], new Date())!;
            const priceValues = maybeArray(raw.Prices || raw.prices);
            const priceNames = maybeArray(raw.PriceNames || raw.priceNames);

            if (priceValues.length > 0) {
                return priceValues
                    .map((price, index): TxlineOddsUpdate | null => {
                        const selection = String(priceNames[index] || `selection_${index + 1}`);
                        const odds = normalizeTxlinePrice(price);
                        if (odds === undefined || odds <= 1) return null;
                        return {
                            fixtureId,
                            market,
                            selection,
                            odds,
                            impliedProbability: impliedProbability(odds),
                            source: 'txline',
                            sourceEndpoint: fallbackFixtureId ? `${ODDS_SNAPSHOT_ENDPOINT}/${fallbackFixtureId}` : ODDS_STREAM_ENDPOINT,
                            sourceUpdateId: txlineSourceId(raw, selection, index),
                            sourceTimestamp,
                            raw: {
                                ...raw,
                                selectedPriceName: selection,
                                selectedPrice: price,
                                selectedPriceIndex: index,
                            },
                        } satisfies TxlineOddsUpdate;
                    })
                    .filter((item): item is TxlineOddsUpdate => Boolean(item));
            }

            const selection = firstString(raw, ['selection', 'selectionName', 'runner', 'team', 'outcome', 'name']);
            const odds = normalizeTxlinePrice(firstNumber(raw, ['odds', 'price', 'Price', 'decimalOdds', 'decimal', 'value']));
            if (!selection || odds === undefined || odds <= 1) return [];
            return [{
                fixtureId,
                market,
                selection,
                odds,
                impliedProbability: impliedProbability(odds),
                source: 'txline',
                sourceEndpoint: fallbackFixtureId ? `${ODDS_SNAPSHOT_ENDPOINT}/${fallbackFixtureId}` : ODDS_STREAM_ENDPOINT,
                sourceUpdateId: txlineSourceId(raw),
                sourceTimestamp,
                raw,
            } satisfies TxlineOddsUpdate];
        })
        .filter((item): item is TxlineOddsUpdate => Boolean(item));
}

export function normalizeScoresPayload(payload: unknown, fallbackFixtureId?: string): TxlineScoreUpdate[] {
    const rows = firstArray(payload, ['scores', 'data.scores', 'data', 'items', 'updates']);
    return rows
        .map((row): TxlineScoreUpdate | null => {
            const raw = asRecord(row);
            const fixtureId = firstString(raw, ['FixtureId', 'fixtureId', 'fixture_id', 'id.fixture', 'matchId', 'MatchId'], fallbackFixtureId || '');
            if (!fixtureId) return null;
            const state = scoreState(raw);
            return {
                fixtureId,
                homeScore: firstNumber(raw, [
                    'homeScore',
                    'home_score',
                    'score.home',
                    'home.score',
                    'Score.Participant1.Total.Goals',
                    'Score.Home',
                    'Score.home',
                    'Data.New.Score.Participant1.Total.Goals',
                    'Data.Score.Participant1.Total.Goals',
                    'Data.New.homeScore',
                    'Data.homeScore',
                ]),
                awayScore: firstNumber(raw, [
                    'awayScore',
                    'away_score',
                    'score.away',
                    'away.score',
                    'Score.Participant2.Total.Goals',
                    'Score.Away',
                    'Score.away',
                    'Data.New.Score.Participant2.Total.Goals',
                    'Data.Score.Participant2.Total.Goals',
                    'Data.New.awayScore',
                    'Data.awayScore',
                ]),
                status: firstString(state, ['status'], 'unknown'),
                source: 'txline',
                sourceEndpoint: fallbackFixtureId ? `${SCORES_SNAPSHOT_ENDPOINT}/${fallbackFixtureId}` : SCORES_STREAM_ENDPOINT,
                sourceUpdateId: txlineSourceId(raw),
                sourceTimestamp: firstDate(raw, ['Ts', 'timestamp', 'updatedAt', 'sourceTimestamp', 'time'], new Date())!,
                raw: {
                    ...raw,
                    normalizedScoreState: state,
                },
            } satisfies TxlineScoreUpdate;
        })
        .filter((item): item is TxlineScoreUpdate => Boolean(item));
}

export async function fetchFixturesSnapshot(): Promise<TxlineFixture[]> {
    if (!txlineAuthConfigured() && txlineFallbackEnabled()) {
        return fetchEspnFallbackFixturesSnapshot();
    }
    return normalizeFixturesPayload(await fetchJson('/api/fixtures/snapshot'));
}

export async function fetchOddsSnapshot(fixtureId: string): Promise<TxlineOddsUpdate[]> {
    return normalizeOddsPayload(await fetchJson(`${ODDS_SNAPSHOT_ENDPOINT}/${encodeURIComponent(fixtureId)}`), fixtureId);
}

export async function fetchScoresSnapshot(fixtureId: string): Promise<TxlineScoreUpdate[]> {
    if (!txlineAuthConfigured() && txlineFallbackEnabled()) {
        return fetchEspnFallbackScoresSnapshot(fixtureId);
    }
    return normalizeScoresPayload(await fetchJson(`${SCORES_SNAPSHOT_ENDPOINT}/${encodeURIComponent(fixtureId)}`), fixtureId);
}

export interface TxlineSseMessage {
    event?: string;
    id?: string;
    data: unknown;
}

export function parseSseMessages(buffer: string): { messages: TxlineSseMessage[]; remainder: string } {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const chunks = normalized.split('\n\n');
    const remainder = chunks.pop() || '';
    const messages = chunks
        .map((chunk): TxlineSseMessage | null => {
            let event: string | undefined;
            let id: string | undefined;
            const dataLines: string[] = [];
            for (const line of chunk.split('\n')) {
                if (!line || line.startsWith(':')) continue;
                const separator = line.indexOf(':');
                const field = separator === -1 ? line : line.slice(0, separator);
                const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
                if (field === 'event') event = value;
                if (field === 'id') id = value;
                if (field === 'data') dataLines.push(value);
            }
            if (dataLines.length === 0) return null;
            const text = dataLines.join('\n');
            let data: unknown = text;
            try {
                data = JSON.parse(text);
            } catch {
                // Some SSE providers send text control frames; keep them as raw text.
            }
            return { event, id, data };
        })
        .filter((message): message is TxlineSseMessage => Boolean(message));
    return { messages, remainder };
}

export interface TxlineStreamOptions {
    signal?: AbortSignal;
    maxEvents?: number;
    onMessage: (message: TxlineSseMessage) => Promise<void> | void;
}

export async function readTxlineSseStream(path: string, options: TxlineStreamOptions): Promise<number> {
    const response = await fetch(`${txlineBaseUrl()}${path}`, {
        method: 'GET',
        headers: await headers(),
        signal: options.signal,
    });
    if (!response.ok) {
        throw new Error(`TxLINE stream failed ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
        throw new Error('TxLINE stream response had no body');
    }

    const reader = (response.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let count = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseMessages(buffer);
        buffer = parsed.remainder;
        for (const message of parsed.messages) {
            await options.onMessage(message);
            count += 1;
            if (options.maxEvents && count >= options.maxEvents) {
                await reader.cancel();
                return count;
            }
        }
    }

    buffer += decoder.decode();
    const parsed = parseSseMessages(`${buffer}\n\n`);
    for (const message of parsed.messages) {
        await options.onMessage(message);
        count += 1;
    }
    return count;
}
