import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import {
    recordOddsUpdates,
    recordScoreUpdates,
} from './arena.service';
import { runStrategyForFixture } from './strategyEngine';
import {
    deriveOutcomesFromStoredScores,
    runBacktest,
} from './outcomeBacktest';
import {
    ArenaOutcomeWinner,
    TxlineOddsUpdate,
    TxlineScoreUpdate,
} from './types';

const prismaAny = prisma as any;

export const DEMO_REPLAY_SOURCE = 'txline_demo_replay';
export const DEMO_REPLAY_PREFIX = 'demo-replay-worldcup-';

export interface DemoReplaySelection {
    selection: ArenaOutcomeWinner;
    before: number;
    after: number;
}

export interface DemoReplayFixtureSpec {
    fixtureId: string;
    homeTeam: string;
    awayTeam: string;
    startsAt: Date;
    finalScore: {
        home: number;
        away: number;
        winner: ArenaOutcomeWinner;
    };
    odds: DemoReplaySelection[];
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function minutesBefore(date: Date, minutes: number): Date {
    return new Date(date.getTime() - minutes * 60_000);
}

function minutesAfter(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60_000);
}

function impliedProbability(odds: number): number {
    return Number((1 / odds).toFixed(6));
}

export function demoReplayFixtureSpecs(): DemoReplayFixtureSpec[] {
    const base = new Date('2026-07-03T18:00:00.000Z');
    return [
        {
            fixtureId: `${DEMO_REPLAY_PREFIX}001`,
            homeTeam: 'Demo Argentina',
            awayTeam: 'Demo Canada',
            startsAt: base,
            finalScore: { home: 2, away: 0, winner: 'part1' },
            odds: [
                { selection: 'part1', before: 2.1, after: 1.72 },
                { selection: 'draw', before: 3.3, after: 4.0 },
                { selection: 'part2', before: 4.2, after: 5.8 },
            ],
        },
        {
            fixtureId: `${DEMO_REPLAY_PREFIX}002`,
            homeTeam: 'Demo Spain',
            awayTeam: 'Demo Japan',
            startsAt: minutesAfter(base, 120),
            finalScore: { home: 1, away: 2, winner: 'part2' },
            odds: [
                { selection: 'part1', before: 1.85, after: 1.55 },
                { selection: 'draw', before: 3.9, after: 4.8 },
                { selection: 'part2', before: 1.8, after: 2.15 },
            ],
        },
        {
            fixtureId: `${DEMO_REPLAY_PREFIX}003`,
            homeTeam: 'Demo England',
            awayTeam: 'Demo Denmark',
            startsAt: minutesAfter(base, 240),
            finalScore: { home: 1, away: 1, winner: 'draw' },
            odds: [
                { selection: 'draw', before: 3.6, after: 2.95 },
                { selection: 'part1', before: 2.2, after: 2.7 },
                { selection: 'part2', before: 2.4, after: 2.9 },
            ],
        },
        {
            fixtureId: `${DEMO_REPLAY_PREFIX}004`,
            homeTeam: 'Demo Brazil',
            awayTeam: 'Demo Morocco',
            startsAt: minutesAfter(base, 360),
            finalScore: { home: 0, away: 1, winner: 'part2' },
            odds: [
                { selection: 'part2', before: 2.2, after: 1.9 },
                { selection: 'part1', before: 2.5, after: 3.1 },
                { selection: 'draw', before: 3.4, after: 4.0 },
            ],
        },
        {
            fixtureId: `${DEMO_REPLAY_PREFIX}005`,
            homeTeam: 'Demo France',
            awayTeam: 'Demo USA',
            startsAt: minutesAfter(base, 480),
            finalScore: { home: 3, away: 1, winner: 'part1' },
            odds: [
                { selection: 'part2', before: 2.6, after: 2.1 },
                { selection: 'draw', before: 3.3, after: 4.2 },
                { selection: 'part1', before: 2.1, after: 2.55 },
            ],
        },
        {
            fixtureId: `${DEMO_REPLAY_PREFIX}006`,
            homeTeam: 'Demo Portugal',
            awayTeam: 'Demo Uruguay',
            startsAt: minutesAfter(base, 600),
            finalScore: { home: 2, away: 2, winner: 'draw' },
            odds: [
                { selection: 'part1', before: 2.2, after: 2.7 },
                { selection: 'part2', before: 2.3, after: 1.95 },
                { selection: 'draw', before: 3.8, after: 3.1 },
            ],
        },
    ];
}

function fixtureRaw(spec: DemoReplayFixtureSpec): Record<string, unknown> {
    return {
        proofMode: 'demo_replay',
        source: DEMO_REPLAY_SOURCE,
        FixtureId: spec.fixtureId,
        Participant1: spec.homeTeam,
        Participant2: spec.awayTeam,
        StartDate: spec.startsAt.toISOString(),
        Status: 'finished',
        note: 'Deterministic settled replay data for judge demo when live TxLINE devnet has no final outcomes.',
    };
}

function oddsUpdatesForFixture(spec: DemoReplayFixtureSpec): TxlineOddsUpdate[] {
    return spec.odds.flatMap((odds, index) => {
        const firstTimestamp = minutesBefore(spec.startsAt, 60 - index);
        const secondTimestamp = minutesBefore(spec.startsAt, 45 - index);
        return [
            {
                fixtureId: spec.fixtureId,
                market: '1X2_PARTICIPANT_RESULT',
                selection: odds.selection,
                odds: odds.before,
                impliedProbability: impliedProbability(odds.before),
                source: DEMO_REPLAY_SOURCE,
                sourceEndpoint: '/demo-replay/odds',
                sourceUpdateId: `${spec.fixtureId}-${odds.selection}-open`,
                sourceTimestamp: firstTimestamp,
                raw: {
                    proofMode: 'demo_replay',
                    FixtureId: spec.fixtureId,
                    MarketType: '1X2_PARTICIPANT_RESULT',
                    Selection: odds.selection,
                    Price: odds.before,
                    Timestamp: firstTimestamp.toISOString(),
                },
            },
            {
                fixtureId: spec.fixtureId,
                market: '1X2_PARTICIPANT_RESULT',
                selection: odds.selection,
                odds: odds.after,
                impliedProbability: impliedProbability(odds.after),
                source: DEMO_REPLAY_SOURCE,
                sourceEndpoint: '/demo-replay/odds',
                sourceUpdateId: `${spec.fixtureId}-${odds.selection}-move`,
                sourceTimestamp: secondTimestamp,
                raw: {
                    proofMode: 'demo_replay',
                    FixtureId: spec.fixtureId,
                    MarketType: '1X2_PARTICIPANT_RESULT',
                    Selection: odds.selection,
                    Price: odds.after,
                    Timestamp: secondTimestamp.toISOString(),
                },
            },
        ];
    });
}

function finalScoreUpdateForFixture(spec: DemoReplayFixtureSpec): TxlineScoreUpdate {
    const sourceTimestamp = minutesAfter(spec.startsAt, 115);
    return {
        fixtureId: spec.fixtureId,
        homeScore: spec.finalScore.home,
        awayScore: spec.finalScore.away,
        status: 'finished',
        source: DEMO_REPLAY_SOURCE,
        sourceEndpoint: '/demo-replay/scores',
        sourceUpdateId: `${spec.fixtureId}-final-score`,
        sourceTimestamp,
        raw: {
            proofMode: 'demo_replay',
            FixtureId: spec.fixtureId,
            Action: 'finished',
            GameState: 'finished',
            Score: {
                Participant1: { Total: { Goals: spec.finalScore.home } },
                Participant2: { Total: { Goals: spec.finalScore.away } },
            },
            normalizedScoreState: {
                status: 'finished',
                homeScore: spec.finalScore.home,
                awayScore: spec.finalScore.away,
            },
            Timestamp: sourceTimestamp.toISOString(),
        },
    };
}

async function clearExistingDemoReplay(): Promise<void> {
    const where = { fixtureId: { startsWith: DEMO_REPLAY_PREFIX } };
    await prismaAny.arenaStrategyOffer.deleteMany({ where });
    await prismaAny.arenaStrategySignal.deleteMany({ where });
    await prismaAny.arenaOutcome.deleteMany({ where });
    await prismaAny.arenaTimelineEvent.deleteMany({ where });
    await prismaAny.arenaScoreUpdate.deleteMany({ where });
    await prismaAny.arenaOddsUpdate.deleteMany({ where });
    await prismaAny.arenaFixture.deleteMany({ where });
}

async function upsertDemoFixture(spec: DemoReplayFixtureSpec): Promise<void> {
    await prismaAny.arenaFixture.upsert({
        where: { fixtureId: spec.fixtureId },
        update: {
            sport: 'football',
            homeTeam: spec.homeTeam,
            awayTeam: spec.awayTeam,
            startsAt: spec.startsAt,
            status: 'finished',
            raw: jsonValue(fixtureRaw(spec)),
        },
        create: {
            fixtureId: spec.fixtureId,
            sport: 'football',
            homeTeam: spec.homeTeam,
            awayTeam: spec.awayTeam,
            startsAt: spec.startsAt,
            status: 'finished',
            raw: jsonValue(fixtureRaw(spec)),
        },
    });
}

export async function seedSettledDemoReplay(options: { reset?: boolean; minSampleSize?: number } = {}): Promise<Record<string, unknown>> {
    const reset = options.reset !== false;
    const specs = demoReplayFixtureSpecs();
    const fixtureIds = specs.map((spec) => spec.fixtureId);
    const minSampleSize = Math.min(Math.max(Math.floor(options.minSampleSize || 12), 1), 1000);

    if (reset) await clearExistingDemoReplay();

    let recordedOdds = 0;
    let recordedScores = 0;
    const strategyRuns = [];
    const outcomeDerivations = [];

    for (const spec of specs) {
        await upsertDemoFixture(spec);
        const odds = oddsUpdatesForFixture(spec);
        const score = finalScoreUpdateForFixture(spec);
        recordedOdds += await recordOddsUpdates(odds);
        recordedScores += await recordScoreUpdates([score]);
        strategyRuns.push(await runStrategyForFixture(spec.fixtureId, {
            minOddsChangePct: 0.01,
            minImpliedProbabilityDelta: 0.003,
            limit: 250,
        }));
        outcomeDerivations.push(await deriveOutcomesFromStoredScores(spec.fixtureId));
    }

    const backtest = await runBacktest({
        fixtureIds,
        minSampleSize,
        limit: 5000,
    });

    return {
        mode: 'demo_replay',
        source: DEMO_REPLAY_SOURCE,
        reset,
        generatedAt: new Date().toISOString(),
        fixtureIds,
        seeded: {
            fixtures: specs.length,
            oddsUpdates: recordedOdds,
            scoreUpdates: recordedScores,
        },
        strategyRuns: strategyRuns.map((run: any) => ({
            fixtureId: run.fixtureId,
            evaluatedEvents: run.evaluatedEvents,
            generatedSignals: run.generatedSignals,
            insertedSignals: run.insertedSignals,
        })),
        outcomeDerivations,
        backtest,
        judgeNote: 'This is a labeled deterministic replay proof. It proves the strategy, outcome, and backtest machinery end-to-end when live TxLINE devnet does not yet expose enough final match outcomes.',
    };
}

export async function getSettledDemoReplayProof(options: { minSampleSize?: number } = {}): Promise<Record<string, unknown>> {
    const specs = demoReplayFixtureSpecs();
    const fixtureIds = specs.map((spec) => spec.fixtureId);
    const minSampleSize = Math.min(Math.max(Math.floor(options.minSampleSize || 12), 1), 1000);
    const where = { fixtureId: { in: fixtureIds } };
    const [fixtures, oddsUpdates, scoreUpdates, signals, outcomes, backtest] = await Promise.all([
        prismaAny.arenaFixture.count({ where }),
        prismaAny.arenaOddsUpdate.count({ where }),
        prismaAny.arenaScoreUpdate.count({ where }),
        prismaAny.arenaStrategySignal.count({ where }),
        prismaAny.arenaOutcome.count({ where }),
        runBacktest({ fixtureIds, minSampleSize, limit: 5000 }),
    ]);

    return {
        mode: 'demo_replay',
        source: DEMO_REPLAY_SOURCE,
        generatedAt: new Date().toISOString(),
        fixtureIds,
        seeded: {
            fixtures,
            oddsUpdates,
            scoreUpdates,
            signals,
            outcomes,
            ready: fixtures === specs.length && outcomes === specs.length && signals > 0,
        },
        backtest,
        judgeNote: 'Read-only proof for the labeled deterministic replay dataset. If ready is false, run POST /v1/txline/demo-replay/seed first.',
    };
}
