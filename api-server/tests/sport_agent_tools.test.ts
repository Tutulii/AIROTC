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
    },
    arenaOutcome: {
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
        prismaMock.arenaOutcome.findMany.mockReset();
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

    it('saves a strategy template and creates a SPORT offer from it', async () => {
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

        const tx = {
            agent: { upsert: vi.fn().mockResolvedValue({ id: 'agent-1', wallet: WALLET }) },
            arenaFixture: { findUnique: vi.fn().mockResolvedValue({ fixtureId: '18179549' }) },
            offer: {
                create: vi.fn().mockResolvedValue({
                    id: 'offer-1',
                    creatorId: 'agent-1',
                    asset: 'TXLINE:18179549:1X2:part1',
                    mode: 'sell',
                    amount: 1,
                    price: 0.1,
                    collateral: 0.2,
                    rollupMode: 'SPORT',
                    fixtureId: '18179549',
                    marketType: '1X2',
                    selection: 'part1',
                    createdAt: new Date('2026-07-04T08:01:00.000Z'),
                    updatedAt: new Date('2026-07-04T08:01:00.000Z'),
                }),
            },
            arenaMatch: {
                create: vi.fn().mockResolvedValue({
                    id: 'match-1',
                    fixtureId: '18179549',
                    offerId: 'offer-1',
                    strategy: 'template:standard_sell',
                    marketType: '1X2',
                    selection: 'part1',
                    direction: 'SELL_SELECTION',
                    makerWallet: WALLET,
                    rollupMode: 'SPORT',
                    status: 'offer_created',
                    proof: {},
                    createdAt: new Date('2026-07-04T08:01:00.000Z'),
                    updatedAt: new Date('2026-07-04T08:01:00.000Z'),
                }),
            },
        };
        prismaMock.$transaction.mockImplementation((fn: any) => fn(tx));

        const {
            createSportOfferFromTemplate,
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
        });

        expect(template.name).toBe('standard_sell');
        expect(tx.offer.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                asset: 'TXLINE:18179549:1X2:part1',
                rollupMode: 'SPORT',
                fixtureId: '18179549',
            }),
        }));
        expect(result.offer.id).toBe('offer-1');
        expect(result.arenaMatch.strategy).toBe('template:standard_sell');
    });

    it('discovers active SPORT agents with reputation attached', async () => {
        prismaMock.offer.findMany.mockResolvedValue([
            {
                id: 'offer-1',
                creator: { wallet: WALLET },
                fixtureId: '18179549',
                marketType: '1X2',
                selection: 'part1',
                mode: 'sell',
                amount: 1,
                price: 0.1,
                collateral: 0.2,
                createdAt: new Date('2026-07-04T08:00:00.000Z'),
            },
            {
                id: 'legacy-offer',
                creator: { wallet: OTHER },
                fixtureId: 'espn:mlb:401815979',
                marketType: 'moneyline',
                selection: 'part1',
                mode: 'sell',
                amount: 1,
                price: 0.1,
                collateral: 0.2,
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
            settledSportMatches: 3,
            markets: ['1X2'],
        });
    });
});
