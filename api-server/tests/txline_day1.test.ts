import { describe, expect, it, vi } from 'vitest';
import {
    clearTxlineGuestJwtCacheForTests,
    fetchFixturesSnapshot,
    fetchScoresSnapshot,
    normalizeFixturesPayload,
    normalizeOddsPayload,
    normalizeScoresPayload,
    parseSseMessages,
    readTxlineSseStream,
} from '../src/services/arena/txlineClient';
import { txlineRuntimeConfig } from '../src/services/arena/arena.service';

describe('TxLINE Day 1 snapshot normalization', () => {
    it('normalizes fixture snapshots and preserves raw proof data', () => {
        const fixtures = normalizeFixturesPayload({
            data: {
                fixtures: [
                    {
                        id: 'fixture-1',
                        sport: 'football',
                        home: { name: 'Argentina' },
                        away: { name: 'Brazil' },
                        startTime: '2026-07-01T18:00:00.000Z',
                        status: 'scheduled',
                        merkleRoot: 'root-abc',
                    },
                ],
            },
        });

        expect(fixtures).toHaveLength(1);
        expect(fixtures[0]).toMatchObject({
            fixtureId: 'fixture-1',
            sport: 'football',
            homeTeam: 'Argentina',
            awayTeam: 'Brazil',
            status: 'upcoming',
        });
        expect(fixtures[0].startsAt?.toISOString()).toBe('2026-07-01T18:00:00.000Z');
        expect(fixtures[0].raw).toHaveProperty('merkleRoot', 'root-abc');
    });

    it('maps TxLINE fixture statuses into AIR OTC buckets', () => {
        const fixtures = normalizeFixturesPayload([
            {
                FixtureId: 18175918,
                Competition: 'World Cup',
                Participant1: 'Argentina',
                Participant2: 'Cape Verde',
                GameState: 1,
                StartTime: 4102444800000,
            },
            {
                FixtureId: 18176123,
                Competition: 'World Cup',
                Participant1: 'Australia',
                Participant2: 'Egypt',
                StartTime: 4102452000000,
            },
        ]);

        expect(fixtures).toHaveLength(2);
        expect(fixtures[0]).toMatchObject({
            fixtureId: '18175918',
            status: 'upcoming',
            raw: {
                GameState: 1,
                source: 'txline',
                sourceEndpoint: '/api/fixtures/snapshot',
            },
        });
        expect(fixtures[1]).toMatchObject({
            fixtureId: '18176123',
            status: 'upcoming',
        });
        expect(fixtures[1].raw).toMatchObject({
            marketSelections: ['part1', 'draw', 'part2'],
            marketTypes: ['1X2_PARTICIPANT_RESULT'],
        });
    });

    it('treats TxLINE fixtures without GameState as live during the early post-kickoff window', () => {
        const fixtures = normalizeFixturesPayload([{
            FixtureId: 18176123,
            Competition: 'World Cup',
            Participant1: 'Australia',
            Participant2: 'Egypt',
            StartTime: Date.now() - 30 * 60 * 1000,
        }]);

        expect(fixtures).toHaveLength(1);
        expect(fixtures[0]).toMatchObject({
            fixtureId: '18176123',
            status: 'live',
        });
    });

    it('normalizes odds snapshots with implied probability', () => {
        const odds = normalizeOddsPayload({
            data: {
                odds: [
                    {
                        fixture_id: 'fixture-1',
                        marketName: 'match_winner',
                        selectionName: 'Argentina',
                        decimalOdds: '2.5',
                        update_id: 'odds-1',
                        timestamp: '2026-07-01T18:01:00.000Z',
                    },
                ],
            },
        });

        expect(odds).toHaveLength(1);
        expect(odds[0]).toMatchObject({
            fixtureId: 'fixture-1',
            market: 'match_winner',
            selection: 'Argentina',
            odds: 2.5,
            impliedProbability: 0.4,
            source: 'txline',
            sourceUpdateId: 'odds-1',
        });
        expect(odds[0].sourceTimestamp.toISOString()).toBe('2026-07-01T18:01:00.000Z');
    });

    it('normalizes score snapshots with fixture fallback', () => {
        const scores = normalizeScoresPayload({
            data: [
                {
                    score: { home: 1, away: 0 },
                    state: 'live',
                    hash: 'score-1',
                    updatedAt: '2026-07-01T18:30:00.000Z',
                },
            ],
        }, 'fixture-1');

        expect(scores).toHaveLength(1);
        expect(scores[0]).toMatchObject({
            fixtureId: 'fixture-1',
            homeScore: 1,
            awayScore: 0,
            status: 'live',
            sourceUpdateId: 'score-1',
        });
        expect(scores[0].sourceTimestamp.toISOString()).toBe('2026-07-01T18:30:00.000Z');
    });

    it('normalizes real TxLINE World Cup odds and score rows into replay-ready updates', () => {
        const fixtures = normalizeFixturesPayload([{
            FixtureId: 18172280,
            Competition: 'World Cup',
            Participant1: 'Netherlands',
            Participant2: 'Morocco',
            StartTime: 1782781200000,
        }]);
        const odds = normalizeOddsPayload([{
            FixtureId: 18172280,
            MessageId: '1835663734:00003:000073-10021-stab',
            Ts: 1782790159301,
            SuperOddsType: '1X2_PARTICIPANT_RESULT',
            MarketPeriod: 'et',
            PriceNames: ['part1', 'draw', 'part2'],
            Prices: [8947, 1289, 8874],
        }]);
        const scores = normalizeScoresPayload([{
            FixtureId: 18172280,
            GameState: 'live',
            Ts: 1782790161361,
            Clock: { Running: true, Seconds: 6107 },
            Score: {
                Participant1: { Total: { Goals: 1, Corners: 5 } },
                Participant2: { Total: { Goals: 1, Corners: 8 } },
            },
        }]);

        expect(fixtures[0]).toMatchObject({
            fixtureId: '18172280',
            homeTeam: 'Netherlands',
            awayTeam: 'Morocco',
        });
        expect(odds).toHaveLength(3);
        expect(odds[0]).toMatchObject({
            fixtureId: '18172280',
            market: '1X2_PARTICIPANT_RESULT:et',
            selection: 'part1',
            odds: 8.947,
            sourceEndpoint: '/api/odds/stream',
        });
        expect(scores[0]).toMatchObject({
            fixtureId: '18172280',
            homeScore: 1,
            awayScore: 1,
            status: 'live',
            sourceEndpoint: '/api/scores/stream',
        });
        expect(scores[0].raw.normalizedScoreState).toMatchObject({
            status: 'live',
            clock: { Running: true, Seconds: 6107 },
        });
    });

    it('normalizes single-object TxLINE SSE odds and score messages', () => {
        const odds = normalizeOddsPayload({
            FixtureId: 18179549,
            MessageId: '1836172796:00003:000019-10021-stab',
            Ts: 1783104139772,
            Bookmaker: 'TXLineStablePriceDemargined',
            SuperOddsType: '1X2_PARTICIPANT_RESULT',
            GameState: null,
            InRunning: false,
            MarketParameters: null,
            MarketPeriod: 'half=1',
            PriceNames: ['part1', 'draw', 'part2'],
            Prices: [2065, 3540, 3130],
        });
        const scores = normalizeScoresPayload({
            FixtureId: 18176123,
            GameState: 'live',
            StartTime: 1783101600000,
            Action: 'update',
            Id: 1,
            Ts: 1783101601000,
            Score: {
                Participant1: { Total: { Goals: 1 } },
                Participant2: { Total: { Goals: 0 } },
            },
        });

        expect(odds).toHaveLength(3);
        expect(odds[0]).toMatchObject({
            fixtureId: '18179549',
            market: '1X2_PARTICIPANT_RESULT:half=1',
            selection: 'part1',
            odds: 2.065,
        });
        expect(scores).toHaveLength(1);
        expect(scores[0]).toMatchObject({
            fixtureId: '18176123',
            homeScore: 1,
            awayScore: 0,
            status: 'live',
        });
    });

    it('normalizes TxLINE final score snapshots with omitted zero-goal fields', () => {
        const scores = normalizeScoresPayload({
            FixtureId: 18179552,
            GameState: 'scheduled',
            Action: 'game_finalised',
            Ts: 1783054805521,
            Score: {
                Participant1: { Total: { Goals: 2, Corners: 4 } },
                Participant2: { Total: { YellowCards: 2, Corners: 2 } },
            },
        });

        expect(scores).toHaveLength(1);
        expect(scores[0]).toMatchObject({
            fixtureId: '18179552',
            homeScore: 2,
            awayScore: 0,
            status: 'final',
        });
    });

    it('parses server-sent TxLINE messages with JSON data', () => {
        const parsed = parseSseMessages('id: odds-1\nevent: odds\ndata: {"FixtureId":18172280}\n\n');

        expect(parsed.remainder).toBe('');
        expect(parsed.messages).toHaveLength(1);
        expect(parsed.messages[0]).toEqual({
            id: 'odds-1',
            event: 'odds',
            data: { FixtureId: 18172280 },
        });
    });

    it('reads TxLINE SSE streams with the same devnet auth headers', async () => {
        const originalEnv = { ...process.env };
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('id: 1\nevent: odds\ndata: {"FixtureId":18172280}\n\n'));
                controller.close();
            },
        });
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            body,
        } as Response);
        const messages: unknown[] = [];

        try {
            clearTxlineGuestJwtCacheForTests();
            process.env.TXLINE_API_BASE_URL = 'https://txline-dev.txodds.com';
            process.env.TXLINE_API_TOKEN = 'activated-token';
            process.env.TXLINE_GUEST_JWT = 'guest-jwt';
            delete process.env.TXLINE_API_KEY;

            const count = await readTxlineSseStream('/api/odds/stream', {
                onMessage: (message) => messages.push(message),
            });

            expect(count).toBe(1);
            expect(messages).toEqual([{ id: '1', event: 'odds', data: { FixtureId: 18172280 } }]);
            expect(fetchMock).toHaveBeenCalledWith('https://txline-dev.txodds.com/api/odds/stream', expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer guest-jwt',
                    'X-Api-Token': 'activated-token',
                }),
            }));
        } finally {
            process.env = originalEnv;
            fetchMock.mockRestore();
            clearTxlineGuestJwtCacheForTests();
        }
    });

    it('exposes Day 4 config without requiring a TxLINE token during local tests', () => {
        const config = txlineRuntimeConfig();
        expect(config.day).toBe(4);
        expect(config.txlineGuestJwtMode).toMatch(/^(auto|env)$/);
        expect(config.requiredSnapshots).toContain('/api/fixtures/snapshot');
        expect(config.requiredSnapshots).toContain('/api/odds/snapshot/:fixtureId');
        expect(config.requiredSnapshots).toContain('/api/scores/snapshot/:fixtureId');
        expect(config.streamEndpoints).toContain('/api/odds/stream');
        expect(config.streamEndpoints).toContain('/api/scores/stream');
        expect(config.replayEndpoints).toContain('/v1/txline/replay/:fixtureId');
        expect(config.strategyEndpoints).toContain('/v1/txline/strategy/run/:fixtureId');
        expect(config.strategyEndpoints).toContain('/v1/txline/strategy/signals/:signalId/offer');
        expect(config.outcomeEndpoints).toContain('/v1/txline/outcomes/:fixtureId');
        expect(config.backtestEndpoints).toContain('/v1/txline/backtest');
        expect(config.demoReplayEndpoints).toContain('/v1/txline/demo-replay/seed');
        expect(config.demoReplayEndpoints).toContain('/v1/txline/demo-replay/proof');
        expect(config.proofModes).toEqual(['live_txline', 'demo_replay']);
        expect(config.scoreboardFallbackEnabled).toBe(false);
    });

    it('calls TxLINE devnet snapshots with guest JWT and activated API token headers', async () => {
        const originalEnv = { ...process.env };
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => [],
        } as Response);

        try {
            clearTxlineGuestJwtCacheForTests();
            process.env.TXLINE_API_BASE_URL = 'https://txline-dev.txodds.com';
            process.env.TXLINE_API_TOKEN = 'activated-token';
            process.env.TXLINE_GUEST_JWT = 'guest-jwt';
            delete process.env.TXLINE_API_KEY;

            await fetchFixturesSnapshot();

            expect(fetchMock).toHaveBeenCalledWith('https://txline-dev.txodds.com/api/fixtures/snapshot', expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer guest-jwt',
                    'X-Api-Token': 'activated-token',
                }),
            }));
        } finally {
            process.env = originalEnv;
            fetchMock.mockRestore();
            clearTxlineGuestJwtCacheForTests();
        }
    });

    it('does not use ESPN fixture fallback when TxLINE token is absent', async () => {
        const originalEnv = { ...process.env };
        const fetchMock = vi.spyOn(globalThis, 'fetch');

        try {
            delete process.env.TXLINE_API_TOKEN;
            delete process.env.TXLINE_API_KEY;
            delete process.env.TXLINE_GUEST_JWT;
            delete process.env.TXLINE_SCOREBOARD_FALLBACK_ENABLED;

            await expect(fetchFixturesSnapshot()).rejects.toThrow('TXLINE_API_TOKEN is required');
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            process.env = originalEnv;
            fetchMock.mockRestore();
            clearTxlineGuestJwtCacheForTests();
        }
    });

    it('does not use ESPN score fallback for old fallback fixture IDs', async () => {
        const originalEnv = { ...process.env };
        const fetchMock = vi.spyOn(globalThis, 'fetch');

        try {
            delete process.env.TXLINE_API_TOKEN;
            delete process.env.TXLINE_API_KEY;
            delete process.env.TXLINE_GUEST_JWT;
            delete process.env.TXLINE_SCOREBOARD_FALLBACK_ENABLED;

            await expect(fetchScoresSnapshot('espn:mlb:401')).rejects.toThrow('TXLINE_API_TOKEN is required');
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            process.env = originalEnv;
            fetchMock.mockRestore();
            clearTxlineGuestJwtCacheForTests();
        }
    });
});
