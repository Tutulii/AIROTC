import { TxlineFixture, TxlineOddsUpdate, TxlineScoreUpdate } from './types';

const DEFAULT_TXLINE_BASE_URL = 'https://txline.txodds.com';
const REQUEST_TIMEOUT_MS = 12_000;
const GUEST_JWT_CACHE_MS = 10 * 60 * 1000;
const ODDS_SNAPSHOT_ENDPOINT = '/api/odds/snapshot';
const SCORES_SNAPSHOT_ENDPOINT = '/api/scores/snapshot';
export const ODDS_STREAM_ENDPOINT = '/api/odds/stream';
export const SCORES_STREAM_ENDPOINT = '/api/scores/stream';

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

export function txlineActiveFixtureSource(): 'txline' | 'unconfigured' {
    if (txlineAuthConfigured()) return 'txline';
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

function normalizeStatusToken(value: unknown): string {
    return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeFixtureStatus(raw: Record<string, unknown>, startsAt?: Date): string {
    const rawStatus = firstString(raw, ['GameState', 'status', 'state', 'fixtureStatus'], 'unknown');
    const status = normalizeStatusToken(rawStatus);

    if (['live', 'in_play', 'in_progress', 'running', 'started', 'first_half', 'second_half', '2'].includes(status)) {
        return 'live';
    }
    if (['scheduled', 'upcoming', 'not_started', 'pre_match', 'prematch', 'pending', '1'].includes(status)) {
        return 'upcoming';
    }
    if (['final', 'finished', 'complete', 'completed', 'closed', 'settled', 'full_time', 'fulltime', 'ft', '3', '4'].includes(status)) {
        return 'final';
    }

    if (startsAt && startsAt.getTime() > Date.now() - 15 * 60 * 1000) {
        return 'upcoming';
    }

    return 'unknown';
}

export function normalizeFixturesPayload(payload: unknown): TxlineFixture[] {
    const rows = firstArray(payload, ['fixtures', 'data.fixtures', 'data', 'items', 'results']);
    return rows
        .map((row): TxlineFixture | null => {
            const raw = asRecord(row);
            const fixtureId = firstString(raw, ['FixtureId', 'fixtureId', 'fixture_id', 'id', 'matchId', 'MatchId', 'eventId', 'EventId']);
            if (!fixtureId) return null;
            const startsAt = firstDate(raw, ['StartTime', 'startsAt', 'startTime', 'start_time', 'scheduledAt']);
            return {
                fixtureId,
                sport: firstString(raw, ['sport', 'sportName', 'Sport', 'SportId'], 'football'),
                homeTeam: firstString(raw, ['Participant1', 'homeTeam', 'home_team', 'home.name', 'teams.home.name']) || undefined,
                awayTeam: firstString(raw, ['Participant2', 'awayTeam', 'away_team', 'away.name', 'teams.away.name']) || undefined,
                startsAt,
                status: normalizeFixtureStatus(raw, startsAt),
                raw: {
                    ...raw,
                    source: firstString(raw, ['source', 'Source'], 'txline'),
                    sourceEndpoint: firstString(raw, ['sourceEndpoint', 'SourceEndpoint'], '/api/fixtures/snapshot'),
                },
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
    return normalizeFixturesPayload(await fetchJson('/api/fixtures/snapshot'));
}

export async function fetchOddsSnapshot(fixtureId: string): Promise<TxlineOddsUpdate[]> {
    return normalizeOddsPayload(await fetchJson(`${ODDS_SNAPSHOT_ENDPOINT}/${encodeURIComponent(fixtureId)}`), fixtureId);
}

export async function fetchScoresSnapshot(fixtureId: string): Promise<TxlineScoreUpdate[]> {
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
