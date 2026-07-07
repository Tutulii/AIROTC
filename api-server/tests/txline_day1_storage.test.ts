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

    it('updates fixture status and replay when TxLINE score updates arrive', async () => {
        const {
            getTxlineSnapshotProof,
            recordScoreUpdates,
            upsertFixtures,
        } = await import('../src/services/arena/arena.service');

        await upsertFixtures([{
            fixtureId: 'fixture-live',
            sport: 'football',
            homeTeam: 'Australia',
            awayTeam: 'Egypt',
            startsAt: new Date('2026-07-01T18:00:00.000Z'),
            status: 'upcoming',
            raw: { source: 'txline' },
        }]);
        await recordScoreUpdates([{
            fixtureId: 'fixture-live',
            homeScore: 1,
            awayScore: 0,
            status: 'live',
            source: 'txline',
            sourceUpdateId: 'score-live-1',
            sourceTimestamp: new Date('2026-07-01T18:10:00.000Z'),
            raw: {
                GameState: 'live',
                normalizedScoreState: { status: 'live', homeScore: 1, awayScore: 0 },
            },
        }]);

        const proof = await getTxlineSnapshotProof('fixture-live');

        expect(proof.fixture).toMatchObject({
            fixtureId: 'fixture-live',
            status: 'live',
            raw: {
                latestScoreUpdateId: 'score-live-1',
            },
        });
        expect(proof.acceptance).toMatchObject({
            scoreSnapshots: 1,
            replayEvents: 1,
        });
    });

    it('does not downgrade a final fixture when a stale TxLINE snapshot still reports GameState 1', async () => {
        const {
            getTxlineSnapshotProof,
            recordScoreUpdates,
            upsertFixtures,
        } = await import('../src/services/arena/arena.service');

        await upsertFixtures([{
            fixtureId: '18175918',
            sport: 'football',
            homeTeam: 'Argentina',
            awayTeam: 'Cape Verde',
            startsAt: new Date('2026-07-03T22:00:00.000Z'),
            status: 'upcoming',
            raw: {
                source: 'txline',
                GameState: 1,
                Participant1: 'Argentina',
                Participant2: 'Cape Verde',
            },
        }]);
        await recordScoreUpdates([{
            fixtureId: '18175918',
            homeScore: 3,
            awayScore: 2,
            status: 'final',
            source: 'txline',
            sourceUpdateId: 'arg-cpv-final',
            sourceTimestamp: new Date('2026-07-04T00:49:00.000Z'),
            raw: {
                GameState: 'scheduled',
                Action: 'game_finalised',
                normalizedScoreState: {
                    status: 'final',
                    action: 'game_finalised',
                    homeScore: 3,
                    awayScore: 2,
                },
            },
        }]);

        await upsertFixtures([{
            fixtureId: '18175918',
            sport: 'football',
            homeTeam: 'Argentina',
            awayTeam: 'Cape Verde',
            startsAt: new Date('2026-07-03T22:00:00.000Z'),
            status: 'upcoming',
            raw: {
                source: 'txline',
                GameState: 1,
                Participant1: 'Argentina',
                Participant2: 'Cape Verde',
            },
        }]);

        const proof = await getTxlineSnapshotProof('18175918');

        expect(proof.fixture).toMatchObject({
            fixtureId: '18175918',
            status: 'final',
            raw: {
                source: 'txline',
                GameState: 1,
                latestScoreUpdateId: 'arg-cpv-final',
                latestScoreState: {
                    status: 'final',
                    homeScore: 3,
                    awayScore: 2,
                },
                statusPreservedFrom: 'score_replay_final',
            },
        });
    });

    it('does not downgrade a live fixture when a stale TxLINE snapshot still reports GameState 1', async () => {
        const {
            getTxlineSnapshotProof,
            recordScoreUpdates,
            upsertFixtures,
        } = await import('../src/services/arena/arena.service');

        await upsertFixtures([{
            fixtureId: '18179999',
            sport: 'football',
            homeTeam: 'Canada',
            awayTeam: 'Morocco',
            startsAt: new Date('2026-07-04T17:00:00.000Z'),
            status: 'upcoming',
            raw: {
                source: 'txline',
                GameState: 1,
                Participant1: 'Canada',
                Participant2: 'Morocco',
            },
        }]);
        await recordScoreUpdates([{
            fixtureId: '18179999',
            homeScore: 1,
            awayScore: 0,
            status: 'live',
            source: 'txline',
            sourceUpdateId: 'can-mar-live',
            sourceTimestamp: new Date('2026-07-04T17:57:00.000Z'),
            raw: {
                GameState: 1,
                Action: 'update',
                Clock: { Running: true, Seconds: 3420 },
                normalizedScoreState: {
                    status: 'live',
                    action: 'update',
                    clock: { Running: true, Seconds: 3420 },
                    homeScore: 1,
                    awayScore: 0,
                },
            },
        }]);

        await upsertFixtures([{
            fixtureId: '18179999',
            sport: 'football',
            homeTeam: 'Canada',
            awayTeam: 'Morocco',
            startsAt: new Date('2026-07-04T17:00:00.000Z'),
            status: 'upcoming',
            raw: {
                source: 'txline',
                GameState: 1,
                Participant1: 'Canada',
                Participant2: 'Morocco',
            },
        }]);

        const proof = await getTxlineSnapshotProof('18179999');

        expect(proof.fixture).toMatchObject({
            fixtureId: '18179999',
            status: 'live',
            raw: {
                source: 'txline',
                GameState: 1,
                latestScoreUpdateId: 'can-mar-live',
                latestScoreState: {
                    status: 'live',
                    homeScore: 1,
                    awayScore: 0,
                },
                statusPreservedFrom: 'score_replay_live',
            },
        });
    });

    it('prefers a final score row over later non-final housekeeping score rows', async () => {
        const {
            getTxlineSnapshotProof,
            recordScoreUpdates,
            upsertFixtures,
        } = await import('../src/services/arena/arena.service');

        await upsertFixtures([{
            fixtureId: '18179549',
            sport: 'football',
            homeTeam: 'Colombia',
            awayTeam: 'Ghana',
            startsAt: new Date('2026-07-04T01:30:00.000Z'),
            status: 'upcoming',
            raw: {
                source: 'txline',
                GameState: 1,
                Participant1: 'Colombia',
                Participant2: 'Ghana',
            },
        }]);
        await recordScoreUpdates([
            {
                fixtureId: '18179549',
                homeScore: 1,
                awayScore: 0,
                status: 'final',
                source: 'txline',
                sourceUpdateId: '911:1037',
                sourceTimestamp: new Date('2026-07-04T03:36:00.000Z'),
                raw: {
                    GameState: 'scheduled',
                    Action: 'game_finalised',
                    normalizedScoreState: {
                        status: 'final',
                        action: 'game_finalised',
                        homeScore: 1,
                        awayScore: 0,
                    },
                },
            },
            {
                fixtureId: '18179549',
                homeScore: 1,
                awayScore: 0,
                status: 'upcoming',
                source: 'txline',
                sourceUpdateId: '912:1038',
                sourceTimestamp: new Date('2026-07-04T03:39:50.756Z'),
                raw: {
                    GameState: 'scheduled',
                    Action: 'disconnected',
                    normalizedScoreState: {
                        status: 'upcoming',
                        action: 'disconnected',
                        homeScore: 1,
                        awayScore: 0,
                    },
                },
            },
        ]);

        const proof = await getTxlineSnapshotProof('18179549');

        expect(proof.fixture).toMatchObject({
            fixtureId: '18179549',
            status: 'final',
            raw: {
                latestScoreUpdateId: '911:1037',
                latestScoreState: {
                    status: 'final',
                    action: 'game_finalised',
                    homeScore: 1,
                    awayScore: 0,
                },
            },
        });
    });

    it('excludes stale ESPN fallback fixtures from TxLINE fixture lists', async () => {
        const originalToken = process.env.TXLINE_API_TOKEN;
        const originalAutoSync = process.env.TXLINE_FIXTURE_AUTO_SYNC_ON_LIST;
        process.env.TXLINE_API_TOKEN = 'test-token';
        process.env.TXLINE_FIXTURE_AUTO_SYNC_ON_LIST = 'false';

        try {
            fixtures.push(
                {
                    id: 'fixture-fallback',
                    fixtureId: 'espn:mlb:1',
                    sport: 'baseball',
                    homeTeam: 'Fallback Home',
                    awayTeam: 'Fallback Away',
                    startsAt: new Date('2026-07-01T10:00:00.000Z'),
                    status: 'final',
                    raw: { source: 'espn_scoreboard_fallback' },
                    createdAt: new Date('2026-07-01T09:00:00.000Z'),
                    updatedAt: new Date('2026-07-01T09:00:00.000Z'),
                },
                {
                    id: 'fixture-txline',
                    fixtureId: '18175918',
                    sport: 'football',
                    homeTeam: 'Argentina',
                    awayTeam: 'Cape Verde',
                    startsAt: new Date('2026-07-03T10:00:00.000Z'),
                    status: '1',
                    raw: { source: 'txline' },
                    createdAt: new Date('2026-07-03T09:00:00.000Z'),
                    updatedAt: new Date('2026-07-03T09:00:00.000Z'),
                },
            );

            const { listTxlineFixtures } = await import('../src/services/arena/arena.service');

            const rows = await listTxlineFixtures(2);

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                fixtureId: '18175918',
                raw: { source: 'txline' },
            });
        } finally {
            if (originalToken === undefined) delete process.env.TXLINE_API_TOKEN;
            else process.env.TXLINE_API_TOKEN = originalToken;
            if (originalAutoSync === undefined) delete process.env.TXLINE_FIXTURE_AUTO_SYNC_ON_LIST;
            else process.env.TXLINE_FIXTURE_AUTO_SYNC_ON_LIST = originalAutoSync;
        }
    });
});
