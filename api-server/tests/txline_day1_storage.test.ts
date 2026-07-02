import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures: any[] = [];
const oddsUpdates: any[] = [];
const scoreUpdates: any[] = [];
const timelineEvents: any[] = [];

const prismaMock = {
    arenaFixture: {
        upsert: vi.fn(async ({ where, update, create }) => {
            const existing = fixtures.find((fixture) => fixture.fixtureId === where.fixtureId);
            if (existing) {
                Object.assign(existing, update);
                return existing;
            }
            const row = { id: `fixture-${fixtures.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
            fixtures.push(row);
            return row;
        }),
        findMany: vi.fn(async ({ where, take }) => {
            const rows = where?.fixtureId?.in
                ? fixtures.filter((fixture) => where.fixtureId.in.includes(fixture.fixtureId))
                : fixtures;
            return typeof take === 'number' ? rows.slice(0, take) : rows;
        }),
        findUnique: vi.fn(async ({ where }) => fixtures.find((fixture) => fixture.fixtureId === where.fixtureId) || null),
    },
    arenaOddsUpdate: {
        createMany: vi.fn(async ({ data }) => {
            oddsUpdates.push(...data.map((row: any, index: number) => ({ id: `odds-${oddsUpdates.length + index + 1}`, createdAt: new Date(), ...row })));
            return { count: data.length };
        }),
        findMany: vi.fn(async ({ where, take }) => oddsUpdates.filter((row) => row.fixtureId === where.fixtureId).slice(0, take)),
    },
    arenaScoreUpdate: {
        createMany: vi.fn(async ({ data }) => {
            scoreUpdates.push(...data.map((row: any, index: number) => ({ id: `score-${scoreUpdates.length + index + 1}`, createdAt: new Date(), ...row })));
            return { count: data.length };
        }),
        findMany: vi.fn(async ({ where, take }) => scoreUpdates.filter((row) => row.fixtureId === where.fixtureId).slice(0, take)),
    },
    arenaTimelineEvent: {
        createMany: vi.fn(async ({ data }) => {
            let inserted = 0;
            for (const row of data) {
                if (timelineEvents.some((event) => event.dedupeKey === row.dedupeKey)) continue;
                inserted += 1;
                timelineEvents.push({
                    id: `timeline-${timelineEvents.length + 1}`,
                    createdAt: new Date(),
                    ...row,
                });
            }
            return { count: inserted };
        }),
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
};

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

describe('TxLINE Day 1 snapshot storage', () => {
    beforeEach(() => {
        fixtures.splice(0);
        oddsUpdates.splice(0);
        scoreUpdates.splice(0);
        timelineEvents.splice(0);
        vi.clearAllMocks();
    });

    it('stores fixtures, odds, scores, and returns a proof bundle', async () => {
        const {
            getReplayTimeline,
            getTxlineSnapshotProof,
            recordOddsUpdates,
            recordScoreUpdates,
            upsertFixtures,
        } = await import('../src/services/arena/arena.service');

        await upsertFixtures([{
            fixtureId: 'fixture-1',
            sport: 'football',
            homeTeam: 'Argentina',
            awayTeam: 'Brazil',
            startsAt: new Date('2026-07-01T18:00:00.000Z'),
            status: 'scheduled',
            raw: { merkleRoot: 'fixture-root' },
        }]);
        await recordOddsUpdates([{
            fixtureId: 'fixture-1',
            market: 'match_winner',
            selection: 'Argentina',
            odds: 2,
            impliedProbability: 0.5,
            source: 'txline',
            sourceUpdateId: 'odds-1',
            sourceTimestamp: new Date('2026-07-01T18:01:00.000Z'),
            raw: { merkleRoot: 'odds-root' },
        }]);
        await recordScoreUpdates([{
            fixtureId: 'fixture-1',
            homeScore: 0,
            awayScore: 0,
            status: 'scheduled',
            source: 'txline',
            sourceUpdateId: 'score-1',
            sourceTimestamp: new Date('2026-07-01T18:01:00.000Z'),
            raw: { merkleRoot: 'score-root' },
        }]);

        const proof = await getTxlineSnapshotProof('fixture-1');

        expect(proof.acceptance).toMatchObject({
            hasFixture: true,
            oddsSnapshots: 1,
            scoreSnapshots: 1,
            replayEvents: 2,
        });
        expect(proof.fixture).toMatchObject({ fixtureId: 'fixture-1', raw: { merkleRoot: 'fixture-root' } });
        expect((proof.latestOdds as any[])[0].raw).toEqual({ merkleRoot: 'odds-root' });
        expect((proof.latestScores as any[])[0].raw).toEqual({ merkleRoot: 'score-root' });

        const replay = await getReplayTimeline('fixture-1');
        expect(replay).toMatchObject({
            fixtureId: 'fixture-1',
            deterministic: true,
            count: 2,
        });
        expect((replay.events as any[])[0]).toMatchObject({
            fixtureId: 'fixture-1',
            teams: { home: 'Argentina', away: 'Brazil' },
            sourceEndpoint: '/api/odds/snapshot/fixture-1',
        });
        expect((replay.events as any[])[1]).toMatchObject({
            fixtureId: 'fixture-1',
            teams: { home: 'Argentina', away: 'Brazil' },
            scoreState: { status: 'scheduled', homeScore: 0, awayScore: 0 },
            sourceEndpoint: '/api/scores/snapshot/fixture-1',
        });
    });
});
