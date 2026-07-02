import { beforeEach, describe, expect, it, vi } from 'vitest';

const timelineEvents: any[] = [];
const strategySignals: any[] = [];

const prismaMock = {
    arenaTimelineEvent: {
        findMany: vi.fn(async ({ where, take }) => {
            const rows = timelineEvents
                .filter((row) => row.fixtureId === where.fixtureId)
                .sort((a, b) => {
                    const time = Number(a.txlineTimestamp) - Number(b.txlineTimestamp);
                    if (time !== 0) return time;
                    const type = String(a.eventType).localeCompare(String(b.eventType));
                    if (type !== 0) return type;
                    return String(a.id).localeCompare(String(b.id));
                });
            return typeof take === 'number' ? rows.slice(0, take) : rows;
        }),
    },
    arenaOddsUpdate: {
        findMany: vi.fn(async () => []),
    },
    arenaScoreUpdate: {
        findMany: vi.fn(async () => []),
    },
    arenaFixture: {
        findMany: vi.fn(async () => []),
    },
    arenaStrategySignal: {
        createMany: vi.fn(async ({ data }) => {
            let inserted = 0;
            for (const row of data) {
                if (strategySignals.some((signal) => signal.dedupeKey === row.dedupeKey)) continue;
                inserted += 1;
                strategySignals.push({
                    id: `signal-${strategySignals.length + 1}`,
                    createdAt: new Date('2026-07-01T18:03:00.000Z'),
                    ...row,
                });
            }
            return { count: inserted };
        }),
        findMany: vi.fn(async ({ where, take }) => {
            const rows = strategySignals
                .filter((row) => row.fixtureId === where.fixtureId)
                .sort((a, b) => Number(b.signalTimestamp) - Number(a.signalTimestamp));
            return typeof take === 'number' ? rows.slice(0, take) : rows;
        }),
    },
};

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

describe('TxLINE Day 3 strategy engine', () => {
    beforeEach(() => {
        timelineEvents.splice(0);
        strategySignals.splice(0);
        vi.clearAllMocks();
    });

    it('builds deterministic sharp movement signals from replay events', async () => {
        const { buildSharpMovementSignals } = await import('../src/services/arena/strategyEngine');

        const signals = buildSharpMovementSignals([
            {
                id: 'score-1',
                sequence: 1,
                fixtureId: 'fixture-1',
                type: 'score',
                teams: { home: 'Argentina', away: 'Brazil' },
                scoreState: { status: 'live', homeScore: 1, awayScore: 0 },
                txlineTimestamp: '2026-07-01T18:00:00.000Z',
                sourceEndpoint: '/api/scores/stream',
                raw: {},
            },
            {
                id: 'odds-1',
                sequence: 2,
                fixtureId: 'fixture-1',
                type: 'odds',
                teams: { home: 'Argentina', away: 'Brazil' },
                marketType: '1X2_PARTICIPANT_RESULT:ft',
                selection: 'part1',
                oddsValue: 2,
                txlineTimestamp: '2026-07-01T18:01:00.000Z',
                sourceEndpoint: '/api/odds/stream',
                raw: {},
            },
            {
                id: 'odds-2',
                sequence: 3,
                fixtureId: 'fixture-1',
                type: 'odds',
                teams: { home: 'Argentina', away: 'Brazil' },
                marketType: '1X2_PARTICIPANT_RESULT:ft',
                selection: 'part1',
                oddsValue: 1.8,
                txlineTimestamp: '2026-07-01T18:02:00.000Z',
                sourceEndpoint: '/api/odds/stream',
                raw: {},
            },
        ], {
            minOddsChangePct: 0.01,
            minImpliedProbabilityDelta: 0.001,
            maxStakeSol: 0.05,
        });

        expect(signals).toHaveLength(1);
        expect(signals[0]).toMatchObject({
            strategy: 'sharp_movement_v1',
            signalType: 'sharp_odds_movement',
            fixtureId: 'fixture-1',
            marketType: '1X2_PARTICIPANT_RESULT:ft',
            selection: 'part1',
            direction: 'BUY_SELECTION',
            oddsBefore: 2,
            oddsAfter: 1.8,
            sourceEventIds: ['odds-1', 'odds-2'],
            tradeIntent: {
                mode: 'signal_only',
                action: 'quote_buy',
                rollupMode: 'NONE',
                maxStakeSol: 0.05,
            },
        });
        expect(signals[0].scoreContext).toMatchObject({ status: 'live', homeScore: 1, awayScore: 0 });
        expect(signals[0].dedupeKey).toMatch(/^[a-f0-9]{64}$/);
    });

    it('runs strategy from stored replay and persists deduped signals', async () => {
        const { listStrategySignals, runStrategyForFixture } = await import('../src/services/arena/strategyEngine');

        timelineEvents.push(
            {
                id: 'timeline-score-1',
                fixtureId: 'fixture-1',
                eventType: 'score',
                homeTeam: 'Argentina',
                awayTeam: 'Brazil',
                scoreState: { status: 'live', homeScore: 0, awayScore: 0 },
                txlineTimestamp: new Date('2026-07-01T18:00:00.000Z'),
                sourceEndpoint: '/api/scores/stream',
                sourceUpdateId: 'score-1',
                raw: {},
            },
            {
                id: 'timeline-odds-1',
                fixtureId: 'fixture-1',
                eventType: 'odds',
                homeTeam: 'Argentina',
                awayTeam: 'Brazil',
                marketType: '1X2_PARTICIPANT_RESULT:ft',
                selection: 'part2',
                oddsValue: 2.4,
                txlineTimestamp: new Date('2026-07-01T18:01:00.000Z'),
                sourceEndpoint: '/api/odds/stream',
                sourceUpdateId: 'odds-1',
                raw: {},
            },
            {
                id: 'timeline-odds-2',
                fixtureId: 'fixture-1',
                eventType: 'odds',
                homeTeam: 'Argentina',
                awayTeam: 'Brazil',
                marketType: '1X2_PARTICIPANT_RESULT:ft',
                selection: 'part2',
                oddsValue: 2.7,
                txlineTimestamp: new Date('2026-07-01T18:02:00.000Z'),
                sourceEndpoint: '/api/odds/stream',
                sourceUpdateId: 'odds-2',
                raw: {},
            }
        );

        const firstRun = await runStrategyForFixture('fixture-1', {
            minOddsChangePct: 0.01,
            minImpliedProbabilityDelta: 0.001,
        });
        const secondRun = await runStrategyForFixture('fixture-1', {
            minOddsChangePct: 0.01,
            minImpliedProbabilityDelta: 0.001,
        });
        const listed = await listStrategySignals('fixture-1');

        expect(firstRun).toMatchObject({
            fixtureId: 'fixture-1',
            deterministic: true,
            evaluatedEvents: 3,
            generatedSignals: 1,
            insertedSignals: 1,
        });
        expect(secondRun).toMatchObject({
            generatedSignals: 1,
            insertedSignals: 0,
        });
        expect(listed).toMatchObject({
            fixtureId: 'fixture-1',
            strategy: 'sharp_movement_v1',
            count: 1,
        });
        expect((listed.signals as any[])[0]).toMatchObject({
            direction: 'SELL_SELECTION',
            tradeIntent: {
                mode: 'signal_only',
                action: 'quote_sell',
                rollupMode: 'NONE',
            },
        });
    });
});
