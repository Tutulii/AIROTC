import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import {
    fetchFixturesSnapshot,
    fetchOddsSnapshot,
    fetchScoresSnapshot,
    normalizeOddsPayload,
    normalizeScoresPayload,
    txlineActiveFixtureSource,
    txlineAuthConfigured,
    txlineBaseUrl,
    txlineGuestJwtMode,
    txlineNetwork,
} from './txlineClient';
import {
    ArenaReplayEvent,
    ArenaTimelineEventInput,
    TxlineFixture,
    TxlineOddsUpdate,
    TxlineRuntimeConfig,
    TxlineScoreUpdate,
} from './types';

const prismaAny = prisma as any;
let lastFixtureAutoSyncAt = 0;
let fixtureAutoSyncPromise: Promise<unknown> | null = null;

function fixtureAutoSyncEnabled(): boolean {
    return (process.env.TXLINE_FIXTURE_AUTO_SYNC_ON_LIST || 'true').toLowerCase() !== 'false';
}

function fixtureAutoSyncIntervalMs(): number {
    return Math.max(Number(process.env.TXLINE_FIXTURE_AUTO_SYNC_INTERVAL_MS) || 120_000, 30_000);
}

async function maybeAutoSyncFixtures(): Promise<void> {
    if (!fixtureAutoSyncEnabled()) return;
    if (!txlineAuthConfigured()) return;

    const now = Date.now();
    if (now - lastFixtureAutoSyncAt < fixtureAutoSyncIntervalMs()) return;
    if (!fixtureAutoSyncPromise) {
        fixtureAutoSyncPromise = syncFixturesFromTxline()
            .catch(() => undefined)
            .finally(() => {
                lastFixtureAutoSyncAt = Date.now();
                fixtureAutoSyncPromise = null;
            });
    }
    await fixtureAutoSyncPromise;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

export function txlineRuntimeConfig(): TxlineRuntimeConfig {
    return {
        day: 4,
        txlineBaseUrl: txlineBaseUrl(),
        txlineNetwork: txlineNetwork(),
        txlineConfigured: txlineAuthConfigured(),
        activeFixtureSource: txlineActiveFixtureSource(),
        scoreboardFallbackEnabled: false,
        txlineGuestJwtMode: txlineGuestJwtMode(),
        requiredSnapshots: [
            '/api/fixtures/snapshot',
            '/api/odds/snapshot/:fixtureId',
            '/api/scores/snapshot/:fixtureId',
        ],
        streamEndpoints: [
            '/api/odds/stream',
            '/api/scores/stream',
        ],
        replayEndpoints: [
            '/v1/txline/replay/:fixtureId',
            '/v1/txline/replay/:fixtureId/stream',
        ],
        strategyEndpoints: [
            '/v1/txline/strategy/config',
            '/v1/txline/strategy/run/:fixtureId',
            '/v1/txline/strategy/signals/:fixtureId',
            '/v1/txline/strategy/signals/:signalId/offer',
        ],
        outcomeEndpoints: [
            '/v1/txline/outcomes/:fixtureId',
            '/v1/txline/outcomes/sync/:fixtureId',
            '/v1/txline/outcomes/derive',
        ],
        backtestEndpoints: [
            '/v1/txline/backtest',
        ],
        demoReplayEndpoints: [
            '/v1/txline/demo-replay/seed',
            '/v1/txline/demo-replay/proof',
        ],
        proofModes: ['live_txline', 'demo_replay'],
    };
}

function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function timelineDedupeKey(event: ArenaTimelineEventInput): string {
    return crypto
        .createHash('sha256')
        .update(stableJson({
            fixtureId: event.fixtureId,
            eventType: event.eventType,
            sourceEndpoint: event.sourceEndpoint,
            sourceUpdateId: event.sourceUpdateId || null,
            txlineTimestamp: event.txlineTimestamp.toISOString(),
            marketType: event.marketType || null,
            selection: event.selection || null,
            oddsValue: event.oddsValue ?? null,
            raw: event.sourceUpdateId ? null : event.raw,
        }))
        .digest('hex');
}

async function fixtureMetadataById(fixtureIds: string[]): Promise<Map<string, any>> {
    const uniqueIds = [...new Set(fixtureIds.filter(Boolean))];
    if (uniqueIds.length === 0) return new Map();
    const fixtures = await prismaAny.arenaFixture.findMany({
        where: { fixtureId: { in: uniqueIds } },
    });
    return new Map(fixtures.map((fixture: any) => [fixture.fixtureId, fixture]));
}

function eventTeams(update: { fixtureId: string; raw: Record<string, unknown> }, fixture?: any): { homeTeam?: string; awayTeam?: string } {
    return {
        homeTeam: fixture?.homeTeam || (typeof update.raw.Participant1 === 'string' ? update.raw.Participant1 : undefined),
        awayTeam: fixture?.awayTeam || (typeof update.raw.Participant2 === 'string' ? update.raw.Participant2 : undefined),
    };
}

function timelineEventsFromOdds(updates: TxlineOddsUpdate[], fixtures: Map<string, any>): ArenaTimelineEventInput[] {
    return updates.map((update) => {
        const teams = eventTeams(update, fixtures.get(update.fixtureId));
        return {
            fixtureId: update.fixtureId,
            eventType: 'odds',
            homeTeam: teams.homeTeam,
            awayTeam: teams.awayTeam,
            marketType: update.market,
            selection: update.selection,
            oddsValue: update.odds,
            txlineTimestamp: update.sourceTimestamp,
            sourceEndpoint: update.sourceEndpoint || `/api/odds/snapshot/${update.fixtureId}`,
            sourceUpdateId: update.sourceUpdateId,
            raw: update.raw,
        };
    });
}

function timelineEventsFromScores(updates: TxlineScoreUpdate[], fixtures: Map<string, any>): ArenaTimelineEventInput[] {
    return updates.map((update) => {
        const teams = eventTeams(update, fixtures.get(update.fixtureId));
        const rawScoreState = update.raw.normalizedScoreState;
        return {
            fixtureId: update.fixtureId,
            eventType: 'score',
            homeTeam: teams.homeTeam,
            awayTeam: teams.awayTeam,
            scoreState: rawScoreState && typeof rawScoreState === 'object' && !Array.isArray(rawScoreState)
                ? rawScoreState as Record<string, unknown>
                : {
                    status: update.status,
                    homeScore: update.homeScore ?? null,
                    awayScore: update.awayScore ?? null,
                },
            txlineTimestamp: update.sourceTimestamp,
            sourceEndpoint: update.sourceEndpoint || `/api/scores/snapshot/${update.fixtureId}`,
            sourceUpdateId: update.sourceUpdateId,
            raw: update.raw,
        };
    });
}

export async function recordTimelineEvents(events: ArenaTimelineEventInput[]): Promise<number> {
    if (events.length === 0) return 0;
    const result = await prismaAny.arenaTimelineEvent.createMany({
        data: events.map((event) => ({
            fixtureId: event.fixtureId,
            eventType: event.eventType,
            homeTeam: event.homeTeam || null,
            awayTeam: event.awayTeam || null,
            marketType: event.marketType || null,
            selection: event.selection || null,
            oddsValue: event.oddsValue ?? null,
            scoreState: event.scoreState ? jsonValue(event.scoreState) : null,
            txlineTimestamp: event.txlineTimestamp,
            sourceEndpoint: event.sourceEndpoint,
            sourceUpdateId: event.sourceUpdateId || null,
            dedupeKey: timelineDedupeKey(event),
            raw: jsonValue(event.raw),
        })),
        skipDuplicates: true,
    });
    return typeof result?.count === 'number' ? result.count : events.length;
}

export async function upsertFixtures(fixtures: TxlineFixture[]): Promise<number> {
    for (const fixture of fixtures) {
        await prismaAny.arenaFixture.upsert({
            where: { fixtureId: fixture.fixtureId },
            update: {
                sport: fixture.sport,
                homeTeam: fixture.homeTeam || null,
                awayTeam: fixture.awayTeam || null,
                startsAt: fixture.startsAt || null,
                status: fixture.status,
                raw: jsonValue(fixture.raw),
            },
            create: {
                fixtureId: fixture.fixtureId,
                sport: fixture.sport,
                homeTeam: fixture.homeTeam || null,
                awayTeam: fixture.awayTeam || null,
                startsAt: fixture.startsAt || null,
                status: fixture.status,
                raw: jsonValue(fixture.raw),
            },
        });
    }
    return fixtures.length;
}

export async function syncFixturesFromTxline(): Promise<{ count: number; fixtures: TxlineFixture[] }> {
    const fixtures = await fetchFixturesSnapshot();
    await upsertFixtures(fixtures);
    return { count: fixtures.length, fixtures };
}

export async function recordOddsUpdates(updates: TxlineOddsUpdate[]): Promise<number> {
    if (updates.length === 0) return 0;
    await prismaAny.arenaOddsUpdate.createMany({
        data: updates.map((update) => ({
            fixtureId: update.fixtureId,
            market: update.market,
            selection: update.selection,
            odds: update.odds,
            impliedProbability: update.impliedProbability ?? null,
            source: update.source,
            sourceUpdateId: update.sourceUpdateId || null,
            sourceTimestamp: update.sourceTimestamp,
            raw: jsonValue(update.raw),
        })),
    });
    const fixtures = await fixtureMetadataById(updates.map((update) => update.fixtureId));
    await recordTimelineEvents(timelineEventsFromOdds(updates, fixtures));
    return updates.length;
}

export async function recordScoreUpdates(updates: TxlineScoreUpdate[]): Promise<number> {
    if (updates.length === 0) return 0;
    await prismaAny.arenaScoreUpdate.createMany({
        data: updates.map((update) => ({
            fixtureId: update.fixtureId,
            homeScore: update.homeScore ?? null,
            awayScore: update.awayScore ?? null,
            status: update.status,
            source: update.source,
            sourceUpdateId: update.sourceUpdateId || null,
            sourceTimestamp: update.sourceTimestamp,
            raw: jsonValue(update.raw),
        })),
    });
    const fixtures = await fixtureMetadataById(updates.map((update) => update.fixtureId));
    await recordTimelineEvents(timelineEventsFromScores(updates, fixtures));
    return updates.length;
}

export async function syncOddsSnapshot(fixtureId: string): Promise<{ count: number; updates: TxlineOddsUpdate[] }> {
    const updates = await fetchOddsSnapshot(fixtureId);
    await recordOddsUpdates(updates);
    return { count: updates.length, updates };
}

export async function syncScoresSnapshot(fixtureId: string): Promise<{ count: number; updates: TxlineScoreUpdate[] }> {
    const updates = await fetchScoresSnapshot(fixtureId);
    await recordScoreUpdates(updates);
    return { count: updates.length, updates };
}

export async function ingestOddsPayload(fixtureId: string, payload: unknown): Promise<{ recorded: number; updates: TxlineOddsUpdate[] }> {
    const updates = normalizeOddsPayload(payload, fixtureId);
    const recorded = await recordOddsUpdates(updates);
    return { recorded, updates };
}

export async function ingestScoresPayload(fixtureId: string, payload: unknown): Promise<{ recorded: number; updates: TxlineScoreUpdate[] }> {
    const updates = normalizeScoresPayload(payload, fixtureId);
    const recorded = await recordScoreUpdates(updates);
    return { recorded, updates };
}

export async function listTxlineFixtures(limit = 50): Promise<any[]> {
    await maybeAutoSyncFixtures();
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    const activeSource = txlineActiveFixtureSource();
    const candidates = await prismaAny.arenaFixture.findMany({
        orderBy: [{ startsAt: 'asc' }, { createdAt: 'desc' }],
        take: Math.max(cappedLimit, 500),
    });
    return candidates
        .filter((row: any) => String(row?.raw?.source || '') !== 'espn_scoreboard_fallback')
        .sort((left: any, right: any) => {
            const leftSource = String(left?.raw?.source || '');
            const rightSource = String(right?.raw?.source || '');
            const leftActive = activeSource !== 'unconfigured' && leftSource === activeSource ? 0 : 1;
            const rightActive = activeSource !== 'unconfigured' && rightSource === activeSource ? 0 : 1;
            if (leftActive !== rightActive) return leftActive - rightActive;
            const leftStart = left?.startsAt ? new Date(left.startsAt).getTime() : Number.MAX_SAFE_INTEGER;
            const rightStart = right?.startsAt ? new Date(right.startsAt).getTime() : Number.MAX_SAFE_INTEGER;
            if (leftStart !== rightStart) return leftStart - rightStart;
            const leftUpdated = left?.updatedAt ? new Date(left.updatedAt).getTime() : 0;
            const rightUpdated = right?.updatedAt ? new Date(right.updatedAt).getTime() : 0;
            return rightUpdated - leftUpdated;
        })
        .slice(0, cappedLimit);
}

export async function getTxlineSnapshotProof(fixtureId: string): Promise<Record<string, unknown>> {
    const [fixture, latestOdds, latestScores, replayEvents] = await Promise.all([
        prismaAny.arenaFixture.findUnique({ where: { fixtureId } }),
        prismaAny.arenaOddsUpdate.findMany({
            where: { fixtureId },
            orderBy: [{ sourceTimestamp: 'desc' }, { createdAt: 'desc' }],
            take: 20,
        }),
        prismaAny.arenaScoreUpdate.findMany({
            where: { fixtureId },
            orderBy: [{ sourceTimestamp: 'desc' }, { createdAt: 'desc' }],
            take: 20,
        }),
        prismaAny.arenaTimelineEvent.findMany({
            where: { fixtureId },
            orderBy: [{ txlineTimestamp: 'asc' }, { eventType: 'asc' }, { sourceUpdateId: 'asc' }, { id: 'asc' }],
            take: 20,
        }),
    ]);

    if (!fixture && latestOdds.length === 0 && latestScores.length === 0) {
        const error = new Error('txline_fixture_snapshot_not_found');
        (error as any).statusCode = 404;
        throw error;
    }

    return {
        day: 1,
        fixtureId,
        fixture,
        latestOdds,
        latestScores,
        replayEvents: replayEvents.map((event: any, index: number) => serializeReplayEvent(event, index)),
        acceptance: {
            hasFixture: Boolean(fixture),
            oddsSnapshots: latestOdds.length,
            scoreSnapshots: latestScores.length,
            replayEvents: replayEvents.length,
        },
    };
}

function serializeReplayEvent(event: any, index: number): ArenaReplayEvent {
    return {
        id: event.id,
        sequence: index + 1,
        fixtureId: event.fixtureId,
        type: event.eventType,
        teams: {
            home: event.homeTeam || undefined,
            away: event.awayTeam || undefined,
        },
        marketType: event.marketType || undefined,
        selection: event.selection || undefined,
        oddsValue: event.oddsValue ?? undefined,
        scoreState: event.scoreState || undefined,
        txlineTimestamp: event.txlineTimestamp instanceof Date
            ? event.txlineTimestamp.toISOString()
            : new Date(event.txlineTimestamp).toISOString(),
        sourceEndpoint: event.sourceEndpoint,
        sourceUpdateId: event.sourceUpdateId || undefined,
        raw: event.raw,
    };
}

export async function rebuildReplayTimeline(fixtureId: string): Promise<{ inserted: number; odds: number; scores: number }> {
    const [fixtures, oddsUpdates, scoreUpdates] = await Promise.all([
        fixtureMetadataById([fixtureId]),
        prismaAny.arenaOddsUpdate.findMany({
            where: { fixtureId },
            orderBy: [{ sourceTimestamp: 'asc' }, { market: 'asc' }, { selection: 'asc' }, { id: 'asc' }],
        }),
        prismaAny.arenaScoreUpdate.findMany({
            where: { fixtureId },
            orderBy: [{ sourceTimestamp: 'asc' }, { id: 'asc' }],
        }),
    ]);

    const oddsEvents = timelineEventsFromOdds(oddsUpdates.map((update: any) => ({
        fixtureId: update.fixtureId,
        market: update.market,
        selection: update.selection,
        odds: update.odds,
        impliedProbability: update.impliedProbability ?? undefined,
        source: update.source,
        sourceEndpoint: update.sourceEndpoint || `/api/odds/snapshot/${update.fixtureId}`,
        sourceUpdateId: update.sourceUpdateId || undefined,
        sourceTimestamp: update.sourceTimestamp,
        raw: update.raw,
    })), fixtures);
    const scoreEvents = timelineEventsFromScores(scoreUpdates.map((update: any) => ({
        fixtureId: update.fixtureId,
        homeScore: update.homeScore ?? undefined,
        awayScore: update.awayScore ?? undefined,
        status: update.status,
        source: update.source,
        sourceEndpoint: update.sourceEndpoint || `/api/scores/snapshot/${update.fixtureId}`,
        sourceUpdateId: update.sourceUpdateId || undefined,
        sourceTimestamp: update.sourceTimestamp,
        raw: update.raw,
    })), fixtures);

    const inserted = await recordTimelineEvents([...oddsEvents, ...scoreEvents]);
    return {
        inserted,
        odds: oddsUpdates.length,
        scores: scoreUpdates.length,
    };
}

export async function getReplayTimeline(fixtureId: string, limit = 500): Promise<Record<string, unknown>> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 1000);
    let events = await prismaAny.arenaTimelineEvent.findMany({
        where: { fixtureId },
        orderBy: [{ txlineTimestamp: 'asc' }, { eventType: 'asc' }, { sourceUpdateId: 'asc' }, { id: 'asc' }],
        take: boundedLimit,
    });

    let rebuilt = false;
    if (events.length === 0) {
        await rebuildReplayTimeline(fixtureId);
        rebuilt = true;
        events = await prismaAny.arenaTimelineEvent.findMany({
            where: { fixtureId },
            orderBy: [{ txlineTimestamp: 'asc' }, { eventType: 'asc' }, { sourceUpdateId: 'asc' }, { id: 'asc' }],
            take: boundedLimit,
        });
    }

    return {
        fixtureId,
        deterministic: true,
        rebuilt,
        count: events.length,
        order: ['txlineTimestamp', 'eventType', 'sourceUpdateId', 'id'],
        events: events.map((event: any, index: number) => serializeReplayEvent(event, index)),
    };
}
