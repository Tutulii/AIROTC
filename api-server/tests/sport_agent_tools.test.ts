import { beforeEach, describe, expect, it, vi } from 'vitest';

const WALLET = 'EdUWKpttdUtWWiUpWzDasouXPvZzpuMpjytteHEzuk9Y';
const COUNTERPARTY = 'A4bCoAbesNR18wwsujY5h5hwrZqJG4574tJ8uiEzLF3V';
const OTHER = '9nqd6aAWQ7DK3fj9fDpk6saaZS5yfXwJ86jgnz7Nbv9F';

const prismaMock = {
    agent: {
        upsert: vi.fn(),
    },
    offer: {
        findMany: vi.fn(),
    },
    arenaMatch: {
        findMany: vi.fn(),
    },
    arenaFixture: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
    },
    arenaOutcome: {
        findMany: vi.fn(),
    },
    sportPosition: {
        findMany: vi.fn(),
    },
    agentStrategyTemplate: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        upsert: vi.fn(),
        deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
};

const reputationProfileMock = vi.fn();

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

vi.mock('../src/services/reputationProfile.service', () => ({
    getReputationProfile: reputationProfileMock,
}));

describe('SPORT agent tools service', () => {
    beforeEach(() => {
        vi.resetModules();
        reputationProfileMock.mockReset();
        prismaMock.agent.upsert.mockReset();
        prismaMock.offer.findMany.mockReset();
        prismaMock.arenaMatch.findMany.mockReset();
        prismaMock.arenaFixture.findMany.mockReset();
        prismaMock.arenaFixture.findUnique.mockReset();
        prismaMock.arenaOutcome.findMany.mockReset();
        prismaMock.sportPosition.findMany.mockReset();
        prismaMock.agentStrategyTemplate.findMany.mockReset();
        prismaMock.agentStrategyTemplate.findUnique.mockReset();
        prismaMock.agentStrategyTemplate.upsert.mockReset();
        prismaMock.agentStrategyTemplate.deleteMany.mockReset();
        prismaMock.$transaction.mockReset();
        prismaMock.arenaFixture.findMany.mockResolvedValue([]);
    });

    it('returns my SPORT history with legacy fallback rows ignored and market analytics computed', async () => {
        prismaMock.arenaMatch.findMany.mockResolvedValue([
            {
                id: 'match-win',
                fixtureId: '18176123',
                offerId: 'offer-1',
                ticketId: 'ticket-1',
                makerWallet: WALLET,
                takerWallet: COUNTERPARTY,
                marketType: '1X2',
                selection: 'part2',
                direction: 'SELL_SELECTION',
                status: 'released',
                outcomeWinner: 'draw',
                settlementAction: 'release_to_maker',
                winnerWallet: WALLET,
                settledAt: new Date('2026-07-04T10:00:00.000Z'),
                createdAt: new Date('2026-07-04T08:00:00.000Z'),
            },
            {
                id: 'legacy-pending',
                fixtureId: 'espn:mlb:401815979',
                offerId: 'offer-legacy',
                ticketId: 'ticket-legacy',
                makerWallet: OTHER,
                takerWallet: WALLET,
                marketType: 'moneyline',
                selection: 'part1',
                direction: 'BUY_SELECTION',
                status: 'ticket_attached',
                createdAt: new Date('2026-07-03T08:00:00.000Z'),
            },
        ]);
        prismaMock.arenaFixture.findMany.mockResolvedValue([
            {
                fixtureId: '18176123',
                homeTeam: 'Australia',
                awayTeam: 'Egypt',
                status: 'final',
                startsAt: new Date('2026-07-03T18:00:00.000Z'),
                raw: { source: 'txline' },
            },
            {
                fixtureId: 'espn:mlb:401815979',
                homeTeam: 'Baltimore Orioles',
                awayTeam: 'Chicago White Sox',
                status: 'final',
                raw: { source: 'espn_scoreboard_fallback' },
            },
        ]);
        prismaMock.arenaOutcome.findMany.mockResolvedValue([]);
        prismaMock.offer.findMany.mockResolvedValue([
            { id: 'offer-1', price: 0.1, amount: 2 },
        ]);

        const { listMySportTrades } = await import('../src/services/sportAgentTools.service');
        const history: any = await listMySportTrades(WALLET);

        expect(history.summary.totalTrades).toBe(1);
        expect(history.summary.ignoredLegacyMatches).toBe(1);
        expect(history.summary.correct).toBe(1);
        expect(history.summary.rawAccuracyPct).toBe(100);
        expect(history.summary.netEstimatedPnlSol).toBe(0.2);
        expect(history.marketPerformance).toEqual([
            expect.objectContaining({ key: '1X2', total: 1, correct: 1, accuracyPct: 100 }),
        ]);
        expect(history.trades[0]).toMatchObject({
            matchId: 'match-win',
            result: 'correct',
            fixture: { homeTeam: 'Australia', awayTeam: 'Egypt', source: 'txline' },
        });
    });

    it('saves a strategy template and creates a prefunded SPORT position draft from it', async () => {
        prismaMock.agent.upsert.mockResolvedValue({ id: 'agent-1', wallet: WALLET });
        prismaMock.agentStrategyTemplate.upsert.mockResolvedValue({
            id: 'template-1',
            wallet: WALLET,
            name: 'standard_sell',
            description: 'Standard sell offer',
            enabled: true,
            defaults: {
                mode: 'sell',
                amount: 1,
                price: 0.1,
                collateral: 0.2,
                marketType: '1X2',
                selection: 'part1',
                asset: null,
            },
            createdAt: new Date('2026-07-04T08:00:00.000Z'),
            updatedAt: new Date('2026-07-04T08:00:00.000Z'),
        });
        prismaMock.agentStrategyTemplate.findUnique.mockResolvedValue({
            id: 'template-1',
            wallet: WALLET,
            name: 'standard_sell',
            enabled: true,
            defaults: {
                mode: 'sell',
                amount: 1,
                price: 0.1,
                collateral: 0.2,
                marketType: '1X2',
                selection: 'part1',
                asset: null,
            },
        });
        prismaMock.arenaFixture.findUnique.mockResolvedValue({
            fixtureId: '18179549',
            status: 'upcoming',
            startsAt: new Date('2099-07-04T10:00:00.000Z'),
            raw: { source: 'txline' },
        });

        const tx = {
            arenaFixture: {
                findUnique: vi.fn().mockResolvedValue({
                    fixtureId: '18179549',
                    status: 'upcoming',
                    startsAt: new Date('2099-07-04T10:00:00.000Z'),
                    raw: { source: 'txline' },
                }),
            },
            sportPosition: {
                findUnique: vi.fn().mockResolvedValue(null),
                updateMany: vi.fn().mockResolvedValue({ count: 0 }),
                create: vi.fn().mockResolvedValue({
                    id: 'position-1',
                    fixtureId: '18179549',
                    selection: 'part1',
                    side: 'lay',
                    stakeLamports: '100000000',
                    agentWallet: WALLET,
                    status: 'funding_required',
                    expiresAt: new Date('2099-07-04T10:00:00.000Z'),
                    fundingExpiresAt: new Date('2099-07-04T08:10:00.000Z'),
                    clientOrderId: 'template:standard_sell:18179549:part1:test',
                    createdAt: new Date('2026-07-04T08:01:00.000Z'),
                    updatedAt: new Date('2026-07-04T08:01:00.000Z'),
                }),
                update: vi.fn().mockImplementation(({ data }) => Promise.resolve({
                    id: 'position-1',
                    fixtureId: '18179549',
                    selection: 'part1',
                    side: 'lay',
                    stakeLamports: '100000000',
                    agentWallet: WALLET,
                    status: 'funding_required',
                    vaultPda: data.vaultPda,
                    expiresAt: new Date('2099-07-04T10:00:00.000Z'),
                    fundingExpiresAt: new Date('2099-07-04T08:10:00.000Z'),
                    clientOrderId: 'template:standard_sell:18179549:part1:test',
                    createdAt: new Date('2026-07-04T08:01:00.000Z'),
                    updatedAt: new Date('2026-07-04T08:01:00.000Z'),
                })),
            },
            sportPositionFundingEvent: {
                create: vi.fn().mockResolvedValue({ id: 'event-1' }),
            },
        };
        prismaMock.$transaction.mockImplementation((fn: any) => fn(tx));

        const {
            createSportPositionFromPreset,
            createSportOfferFromTemplate,
            listStrategyPresets,
            upsertStrategyTemplate,
        } = await import('../src/services/sportAgentTools.service');

        const template: any = await upsertStrategyTemplate(WALLET, {
            name: 'standard_sell',
            description: 'Standard sell offer',
            defaults: {
                mode: 'sell',
                amount: 1,
                price: 0.1,
                collateral: 0.2,
                marketType: '1X2',
                selection: 'part1',
            },
        });
        const result: any = await createSportOfferFromTemplate(WALLET, 'standard_sell', {
            fixtureId: '18179549',
            overrides: { clientOrderId: 'template:standard_sell:18179549:part1:test' },
        });

        expect(template.name).toBe('standard_sell');
        expect(tx.sportPosition.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                fixtureId: '18179549',
                side: 'lay',
                stakeLamports: '100000000',
                status: 'funding_required',
            }),
        }));
        expect(result.position.id).toBe('position-1');
        expect(result.position.status).toBe('funding_required');
        expect(result.fundingInstructions.amountLamports).toBe('100000000');
        expect(result.deprecatedOfferFlow).toBe(false);

        const presets: any = listStrategyPresets();
        expect(presets.data.map((preset: any) => preset.name)).toEqual(
            expect.arrayContaining(['favorite_back', 'underdog_layer', 'draw_hedge'])
        );

        const presetResult: any = await createSportPositionFromPreset(WALLET, 'underdog_layer', {
            fixtureId: '18179549',
            overrides: {
                selection: 'part2',
                stakeSol: 0.08,
                clientOrderId: 'preset:underdog_layer:18179549:part2:test',
            },
        });
        expect(tx.sportPosition.create).toHaveBeenLastCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                fixtureId: '18179549',
                selection: 'part2',
                side: 'lay',
                stakeLamports: '80000000',
                status: 'funding_required',
            }),
        }));
        expect(presetResult.preset.name).toBe('underdog_layer');
    });

    it('discovers active SPORT agents with reputation attached', async () => {
        prismaMock.sportPosition.findMany.mockResolvedValue([
            {
                id: 'position-1',
                agentWallet: WALLET,
                fixtureId: '18179549',
                selection: 'part1',
                side: 'lay',
                stakeLamports: '100000000',
                status: 'funded_open',
                fundedAt: new Date('2026-07-04T08:00:00.000Z'),
                createdAt: new Date('2026-07-04T08:00:00.000Z'),
            },
            {
                id: 'legacy-position',
                agentWallet: OTHER,
                fixtureId: 'espn:mlb:401815979',
                selection: 'part1',
                side: 'lay',
                stakeLamports: '100000000',
                status: 'funded_open',
                fundedAt: new Date('2026-07-04T08:30:00.000Z'),
                createdAt: new Date('2026-07-04T08:30:00.000Z'),
            },
        ]);
        prismaMock.arenaMatch.findMany.mockResolvedValue([
            {
                makerWallet: WALLET,
                takerWallet: COUNTERPARTY,
                fixtureId: '18179549',
                marketType: '1X2',
                status: 'released',
                createdAt: new Date('2026-07-04T08:00:00.000Z'),
                updatedAt: new Date('2026-07-04T09:00:00.000Z'),
            },
            {
                makerWallet: OTHER,
                takerWallet: COUNTERPARTY,
                fixtureId: 'espn:mlb:401815979',
                marketType: 'moneyline',
                status: 'ticket_attached',
                createdAt: new Date('2026-07-04T08:00:00.000Z'),
                updatedAt: new Date('2026-07-04T10:00:00.000Z'),
            },
        ]);
        prismaMock.arenaFixture.findMany.mockResolvedValue([
            { fixtureId: '18179549', raw: { source: 'txline' } },
            { fixtureId: 'espn:mlb:401815979', raw: { source: 'espn_scoreboard_fallback' } },
        ]);
        reputationProfileMock.mockImplementation((wallet: string) => Promise.resolve({
            wallet,
            score: wallet === WALLET ? 77 : 44,
            tier: wallet === WALLET ? 'trusted' : 'neutral',
            riskLevel: 'low',
            trustSummary: 'ok',
            recommendedCounterpartyAction: 'accept',
            predictionReputation: {
                evaluableSettledPredictions: wallet === WALLET ? 3 : 0,
                accuracyPct: wallet === WALLET ? 66.67 : null,
                adjustedAccuracyPct: wallet === WALLET ? 35 : null,
            },
        }));

        const { discoverSportAgents } = await import('../src/services/sportAgentTools.service');
        const result: any = await discoverSportAgents({ minSettledPredictions: 1 });

        expect(result.count).toBe(1);
        expect(result.ignoredLegacyOffers).toBe(1);
        expect(result.ignoredLegacyMatches).toBe(1);
        expect(result.data[0]).toMatchObject({
            wallet: WALLET,
            score: 77,
            activeSportOffers: 1,
            activeSportPositions: 1,
            settledSportMatches: 3,
            markets: expect.arrayContaining(['1X2_PARTICIPANT_RESULT']),
            activeOfferSamples: [
                expect.objectContaining({
                    positionId: 'position-1',
                    stake: 0.1,
                    stakeModel: 'equal_stake',
                }),
            ],
        });
        expect(result.data[0].activeOfferSamples[0].collateral).toBeUndefined();
    });
});
