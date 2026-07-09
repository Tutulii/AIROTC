import { beforeEach, describe, expect, it, vi } from 'vitest';

const outcomeRows: any[] = [];
const scoreRows: any[] = [];
const signalRows: any[] = [];

function fixtureMatches(row: any, fixtureFilter: any): boolean {
    if (!fixtureFilter) return true;
    if (typeof fixtureFilter === 'string') return row.fixtureId === fixtureFilter;
    if (Array.isArray(fixtureFilter.in)) return fixtureFilter.in.includes(row.fixtureId);
    if (typeof fixtureFilter.startsWith === 'string') return row.fixtureId.startsWith(fixtureFilter.startsWith);
    return true;
}

const prismaMock = {
    arenaOutcome: {
        upsert: vi.fn(async ({ where, update, create }) => {
            const existing = outcomeRows.find((row) => row.fixtureId === where.fixtureId);
            if (existing) {
                Object.assign(existing, update, { updatedAt: new Date('2026-07-01T20:00:00.000Z') });
                return existing;
            }
            const row = {
                id: `outcome-${outcomeRows.length + 1}`,
                createdAt: new Date('2026-07-01T20:00:00.000Z'),
                updatedAt: new Date('2026-07-01T20:00:00.000Z'),
                ...create,
            };
            outcomeRows.push(row);
            return row;
        }),
        findUnique: vi.fn(async ({ where }) => outcomeRows.find((row) => row.fixtureId === where.fixtureId) || null),
        findMany: vi.fn(async ({ where, take } = {}) => {
            const rows = where?.fixtureId
                ? outcomeRows.filter((row) => fixtureMatches(row, where.fixtureId))
                : outcomeRows;
            const sourceFiltered = where?.source?.startsWith
                ? rows.filter((row) => String(row.source || '').startsWith(where.source.startsWith))
                : rows;
            return typeof take === 'number' ? sourceFiltered.slice(0, take) : sourceFiltered;
        }),
    },
    arenaScoreUpdate: {
        findMany: vi.fn(async ({ where } = {}) => {
            const rows = where?.fixtureId
                ? scoreRows.filter((row) => fixtureMatches(row, where.fixtureId))
                : scoreRows;
            return [...rows].sort((a, b) => Number(b.sourceTimestamp) - Number(a.sourceTimestamp));
        }),
    },
    arenaStrategySignal: {
        findMany: vi.fn(async ({ where, take } = {}) => {
            const rows = where?.fixtureId
                ? signalRows.filter((row) => fixtureMatches(row, where.fixtureId))
                : signalRows;
            const sorted = [...rows].sort((a, b) => Number(a.signalTimestamp) - Number(b.signalTimestamp));
            return typeof take === 'number' ? sorted.slice(0, take) : sorted;
        }),
    },
};

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

vi.mock('../src/services/arena/arena.service', () => ({
    getReplayTimeline: vi.fn(async () => ({ events: [] })),
    recordOddsUpdates: vi.fn(async () => 0),
    recordScoreUpdates: vi.fn(async () => 0),
}));

describe('TxLINE Day 4 outcomes and backtest', () => {
    beforeEach(() => {
        outcomeRows.splice(0);
        scoreRows.splice(0);
        signalRows.splice(0);
        vi.clearAllMocks();
    });

    it('derives a final outcome from a TxLINE score update', async () => {
        const { deriveOutcomeFromScoreUpdate } = await import('../src/services/arena/outcomeBacktest');

        const outcome = deriveOutcomeFromScoreUpdate({
            fixtureId: 'fixture-1',
            homeScore: 2,
            awayScore: 1,
            status: 'finished',
            source: 'txline',
            sourceUpdateId: 'score-final',
            sourceTimestamp: new Date('2026-07-01T20:00:00.000Z'),
            raw: {
                GameState: 'finished',
                Score: {
                    Participant1: { Total: { Goals: 2 } },
                    Participant2: { Total: { Goals: 1 } },
                },
            },
        });

        expect(outcome).toMatchObject({
            fixtureId: 'fixture-1',
            homeScore: 2,
            awayScore: 1,
            winner: 'part1',
            source: 'txline',
            sourceUpdateId: 'score-final',
        });
    });

    it('derives a TxLINE outcome from game_finalised rows with omitted zero-goal fields', async () => {
        const { deriveOutcomeFromScoreUpdate } = await import('../src/services/arena/outcomeBacktest');

        const outcome = deriveOutcomeFromScoreUpdate({
            fixtureId: '18179552',
            status: 'final',
            source: 'txline',
            sourceUpdateId: 'score-finalised',
            sourceTimestamp: new Date('2026-07-03T04:20:05.521Z'),
            raw: {
                GameState: 'scheduled',
                Action: 'game_finalised',
                Score: {
                    Participant1: { Total: { Goals: 2, Corners: 4 } },
                    Participant2: { Total: { YellowCards: 2, Corners: 2 } },
                },
            },
        });

        expect(outcome).toMatchObject({
            fixtureId: '18179552',
            homeScore: 2,
            awayScore: 0,
            winner: 'part1',
            source: 'txline',
            sourceUpdateId: 'score-finalised',
        });
    });

    it('does not create outcomes for non-final score updates', async () => {
        const { deriveOutcomeFromScoreUpdate } = await import('../src/services/arena/outcomeBacktest');

        const outcome = deriveOutcomeFromScoreUpdate({
            fixtureId: 'fixture-1',
            homeScore: 2,
            awayScore: 1,
            status: 'scheduled',
            source: 'txline',
            sourceTimestamp: new Date('2026-07-01T19:00:00.000Z'),
            raw: { GameState: 'scheduled' },
        });

        expect(outcome).toBeNull();
    });

    it('derives and stores final outcomes from stored score rows', async () => {
        const { deriveOutcomesFromStoredScores } = await import('../src/services/arena/outcomeBacktest');
        scoreRows.push(
            {
                id: 'score-1',
                fixtureId: 'fixture-1',
                homeScore: 2,
                awayScore: 2,
                status: 'completed',
                source: 'txline',
                sourceUpdateId: 'score-final',
                sourceTimestamp: new Date('2026-07-01T20:00:00.000Z'),
                createdAt: new Date('2026-07-01T20:00:00.000Z'),
                raw: { GameState: 'completed' },
            },
            {
                id: 'score-2',
                fixtureId: 'fixture-2',
                homeScore: 0,
                awayScore: 0,
                status: 'scheduled',
                source: 'txline',
                sourceTimestamp: new Date('2026-07-01T19:00:00.000Z'),
                createdAt: new Date('2026-07-01T19:00:00.000Z'),
                raw: { GameState: 'scheduled' },
            }
        );

        const result = await deriveOutcomesFromStoredScores();

        expect(result).toMatchObject({
            scannedScoreRows: 2,
            storedOutcomes: 1,
        });
        expect(outcomeRows[0]).toMatchObject({
            fixtureId: 'fixture-1',
            homeScore: 2,
            awayScore: 2,
            winner: 'draw',
        });
    });

    it('ignores stale fallback score rows when deriving outcomes', async () => {
        const { deriveOutcomesFromStoredScores } = await import('../src/services/arena/outcomeBacktest');
        scoreRows.push(
            {
                id: 'score-fallback',
                fixtureId: 'fixture-1',
                homeScore: 9,
                awayScore: 0,
                status: 'completed',
                source: 'espn_scoreboard_fallback',
                sourceUpdateId: 'fallback-final',
                sourceTimestamp: new Date('2026-07-01T21:00:00.000Z'),
                createdAt: new Date('2026-07-01T21:00:00.000Z'),
                raw: { GameState: 'completed' },
            },
            {
                id: 'score-txline',
                fixtureId: 'fixture-1',
                homeScore: 1,
                awayScore: 2,
                status: 'completed',
                source: 'txline',
                sourceUpdateId: 'txline-final',
                sourceTimestamp: new Date('2026-07-01T20:00:00.000Z'),
                createdAt: new Date('2026-07-01T20:00:00.000Z'),
                raw: { GameState: 'completed' },
            }
        );

        const result = await deriveOutcomesFromStoredScores('fixture-1');

        expect(result).toMatchObject({
            scannedScoreRows: 2,
            storedOutcomes: 1,
        });
        expect(outcomeRows).toHaveLength(1);
        expect(outcomeRows[0]).toMatchObject({
            fixtureId: 'fixture-1',
            homeScore: 1,
            awayScore: 2,
            winner: 'part2',
            source: 'txline',
        });
    });

    it('hides fallback outcomes from TxLINE outcome reads', async () => {
        const { getOutcomeForFixture, listOutcomes } = await import('../src/services/arena/outcomeBacktest');
        outcomeRows.push(
            {
                id: 'outcome-fallback',
                fixtureId: 'fixture-fallback',
                status: 'finished',
                homeScore: 9,
                awayScore: 0,
                winner: 'part1',
                source: 'espn_scoreboard_fallback',
                sourceTimestamp: new Date('2026-07-01T21:00:00.000Z'),
                settledAt: new Date('2026-07-01T21:00:00.000Z'),
                raw: {},
                createdAt: new Date('2026-07-01T21:00:00.000Z'),
                updatedAt: new Date('2026-07-01T21:00:00.000Z'),
            },
            {
                id: 'outcome-txline',
                fixtureId: 'fixture-txline',
                status: 'finished',
                homeScore: 1,
                awayScore: 2,
                winner: 'part2',
                source: 'txline_demo_replay',
                sourceTimestamp: new Date('2026-07-01T20:00:00.000Z'),
                settledAt: new Date('2026-07-01T20:00:00.000Z'),
                raw: {},
                createdAt: new Date('2026-07-01T20:00:00.000Z'),
                updatedAt: new Date('2026-07-01T20:00:00.000Z'),
            }
        );

        await expect(getOutcomeForFixture('fixture-fallback')).rejects.toThrow('txline_outcome_not_found');
        await expect(getOutcomeForFixture('fixture-txline')).resolves.toMatchObject({
            fixtureId: 'fixture-txline',
            source: 'txline_demo_replay',
        });
        await expect(listOutcomes(10)).resolves.toMatchObject({
            count: 1,
            outcomes: [
                {
                    fixtureId: 'fixture-txline',
                    source: 'txline_demo_replay',
                },
            ],
        });
    });

    it('derives a trusted TxLINE outcome from stored score replay before returning 404', async () => {
        const { getOutcomeForFixture } = await import('../src/services/arena/outcomeBacktest');
        scoreRows.push({
            fixtureId: 'fixture-replay-only',
            homeScore: 3,
            awayScore: 1,
            status: 'finished',
            source: 'txline',
            sourceUpdateId: 'score-replay-final',
            sourceTimestamp: new Date('2026-07-01T22:00:00.000Z'),
            raw: { GameState: 'finished' },
            createdAt: new Date('2026-07-01T22:00:00.000Z'),
            updatedAt: new Date('2026-07-01T22:00:00.000Z'),
        });

        await expect(getOutcomeForFixture('fixture-replay-only')).resolves.toMatchObject({
            fixtureId: 'fixture-replay-only',
            homeScore: 3,
            awayScore: 1,
            winner: 'part1',
            source: 'txline',
        });
    });

    it('runs accuracy and PnL backtests only for signals before a stored outcome', async () => {
        const { runBacktest } = await import('../src/services/arena/outcomeBacktest');
        outcomeRows.push({
            id: 'outcome-1',
            fixtureId: 'fixture-1',
            status: 'finished',
            homeScore: 2,
            awayScore: 1,
            winner: 'part1',
            source: 'txline',
            sourceTimestamp: new Date('2026-07-01T20:00:00.000Z'),
            settledAt: new Date('2026-07-01T20:00:00.000Z'),
            raw: {},
            createdAt: new Date('2026-07-01T20:00:00.000Z'),
            updatedAt: new Date('2026-07-01T20:00:00.000Z'),
        });
        signalRows.push(
            {
                id: 'signal-1',
                fixtureId: 'fixture-1',
                marketType: '1X2_PARTICIPANT_RESULT',
                selection: 'part1',
                direction: 'BUY_SELECTION',
                oddsAfter: 2,
                signalTimestamp: new Date('2026-07-01T19:00:00.000Z'),
            },
            {
                id: 'signal-2',
                fixtureId: 'fixture-1',
                marketType: '1X2_PARTICIPANT_RESULT',
                selection: 'draw',
                direction: 'BUY_SELECTION',
                oddsAfter: 3,
                signalTimestamp: new Date('2026-07-01T19:05:00.000Z'),
            },
            {
                id: 'signal-3',
                fixtureId: 'fixture-1',
                marketType: '1X2_PARTICIPANT_RESULT',
                selection: 'part2',
                direction: 'SELL_SELECTION',
                oddsAfter: 4,
                signalTimestamp: new Date('2026-07-01T19:10:00.000Z'),
            },
            {
                id: 'signal-4',
                fixtureId: 'fixture-1',
                marketType: '1X2_PARTICIPANT_RESULT',
                selection: 'part1',
                direction: 'BUY_SELECTION',
                oddsAfter: 2,
                signalTimestamp: new Date('2026-07-01T20:01:00.000Z'),
            }
        );

        const report = await runBacktest({ minSampleSize: 3 });

        expect(report).toMatchObject({
            day: 4,
            totalSignals: 4,
            storedOutcomes: 1,
            evaluableSignals: 3,
            correctSignals: 2,
            accuracy: 2 / 3,
            oneUnitPnl: 1,
            sampleSizeWarning: null,
            verdict: 'backtest_sample_available',
            skippedCounts: {
                evaluable: 3,
                signal_not_before_outcome: 1,
            },
        });
    });

    it('filters backtests to an explicit replay fixture set', async () => {
        const { runBacktest } = await import('../src/services/arena/outcomeBacktest');
        outcomeRows.push(
            {
                id: 'outcome-1',
                fixtureId: 'demo-replay-worldcup-001',
                status: 'finished',
                homeScore: 2,
                awayScore: 0,
                winner: 'part1',
                source: 'txline_demo_replay',
                sourceTimestamp: new Date('2026-07-01T20:00:00.000Z'),
                settledAt: new Date('2026-07-01T20:00:00.000Z'),
                raw: {},
            },
            {
                id: 'outcome-2',
                fixtureId: 'live-fixture-1',
                status: 'finished',
                homeScore: 0,
                awayScore: 1,
                winner: 'part2',
                source: 'txline',
                sourceTimestamp: new Date('2026-07-01T20:00:00.000Z'),
                settledAt: new Date('2026-07-01T20:00:00.000Z'),
                raw: {},
            }
        );
        signalRows.push(
            {
                id: 'signal-demo',
                fixtureId: 'demo-replay-worldcup-001',
                marketType: '1X2_PARTICIPANT_RESULT',
                selection: 'part1',
                direction: 'BUY_SELECTION',
                oddsAfter: 2,
                signalTimestamp: new Date('2026-07-01T19:00:00.000Z'),
            },
            {
                id: 'signal-live',
                fixtureId: 'live-fixture-1',
                marketType: '1X2_PARTICIPANT_RESULT',
                selection: 'part2',
                direction: 'BUY_SELECTION',
                oddsAfter: 2,
                signalTimestamp: new Date('2026-07-01T19:00:00.000Z'),
            }
        );

        const report = await runBacktest({
            fixtureIds: ['demo-replay-worldcup-001'],
            minSampleSize: 1,
        });

        expect(report).toMatchObject({
            totalSignals: 1,
            storedOutcomes: 1,
            evaluableSignals: 1,
            correctSignals: 1,
            verdict: 'backtest_sample_available',
        });
        expect((report as any).evaluations[0].fixtureId).toBe('demo-replay-worldcup-001');
    });

    it('defines a labeled settled demo replay fixture set for judge proof', async () => {
        const { DEMO_REPLAY_SOURCE, demoReplayFixtureSpecs } = await import('../src/services/arena/demoReplayBackfill');

        const specs = demoReplayFixtureSpecs();

        expect(DEMO_REPLAY_SOURCE).toBe('txline_demo_replay');
        expect(specs).toHaveLength(6);
        expect(specs.every((spec) => spec.fixtureId.startsWith('demo-replay-worldcup-'))).toBe(true);
        expect(new Set(specs.map((spec) => spec.finalScore.winner))).toEqual(new Set(['part1', 'part2', 'draw']));
        expect(specs.every((spec) => spec.odds.length >= 3)).toBe(true);
    });
});
