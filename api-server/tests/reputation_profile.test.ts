import { beforeEach, describe, expect, it, vi } from 'vitest';

const WALLET = 'EdUWKpttdUtWWiUpWzDasouXPvZzpuMpjytteHEzuk9Y';
const COUNTERPARTY = 'A4bCoAbesNR18wwsujY5h5hwrZqJG4574tJ8uiEzLF3V';
const OTHER = '9nqd6aAWQ7DK3fj9fDpk6saaZS5yfXwJ86jgnz7Nbv9F';

const prismaMock = {
    agent: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
    },
    arenaMatch: {
        findMany: vi.fn(),
    },
    arenaOutcome: {
        findMany: vi.fn(),
    },
    arenaFixture: {
        findMany: vi.fn(),
    },
    offer: {
        findMany: vi.fn(),
    },
    agentEvent: {
        findMany: vi.fn(),
    },
};

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

describe('reputation profile service', () => {
    beforeEach(() => {
        vi.resetModules();
        prismaMock.agent.findUnique.mockReset();
        prismaMock.agent.findMany.mockReset();
        prismaMock.arenaMatch.findMany.mockReset();
        prismaMock.arenaOutcome.findMany.mockReset();
        prismaMock.arenaFixture.findMany.mockReset();
        prismaMock.arenaFixture.findMany.mockResolvedValue([]);
        prismaMock.offer.findMany.mockReset();
        prismaMock.agentEvent.findMany.mockReset();
    });

    it('computes SPORT prediction accuracy and recent track record for a wallet', async () => {
        prismaMock.agent.findUnique.mockResolvedValue({
            wallet: WALLET,
            totalDeals: 4,
            successfulDeals: 3,
            cancelledDeals: 1,
            disputedDeals: 0,
            totalVolume: '2000000000',
            avgSettlementTime: 90,
        });
        prismaMock.arenaMatch.findMany.mockResolvedValue([
            {
                id: 'match-maker-win',
                fixtureId: 'fixture-1',
                makerWallet: WALLET,
                takerWallet: COUNTERPARTY,
                offerId: 'offer-1',
                ticketId: 'ticket-1',
                marketType: '1X2',
                selection: 'part1',
                direction: 'BUY_SELECTION',
                outcomeWinner: 'part1',
                status: 'released',
                settlementAction: 'release_to_maker',
                winnerWallet: WALLET,
                settledAt: new Date('2026-07-04T10:00:00.000Z'),
                createdAt: new Date('2026-07-04T08:00:00.000Z'),
            },
            {
                id: 'match-maker-loss',
                fixtureId: 'fixture-2',
                makerWallet: WALLET,
                takerWallet: COUNTERPARTY,
                offerId: 'offer-2',
                ticketId: 'ticket-2',
                marketType: '1X2',
                selection: 'part2',
                direction: 'BUY_SELECTION',
                outcomeWinner: 'part1',
                status: 'refunded',
                settlementAction: 'refund_to_taker',
                winnerWallet: COUNTERPARTY,
                settledAt: new Date('2026-07-03T10:00:00.000Z'),
                createdAt: new Date('2026-07-03T08:00:00.000Z'),
            },
            {
                id: 'match-taker-win',
                fixtureId: 'fixture-3',
                makerWallet: OTHER,
                takerWallet: WALLET,
                offerId: 'offer-3',
                ticketId: 'ticket-3',
                marketType: '1X2',
                selection: 'part1',
                direction: 'BUY_SELECTION',
                status: 'refunded',
                settlementAction: 'refund_to_taker',
                winnerWallet: WALLET,
                settledAt: new Date('2026-07-02T10:00:00.000Z'),
                createdAt: new Date('2026-07-02T08:00:00.000Z'),
            },
            {
                id: 'match-pending',
                fixtureId: 'fixture-4',
                makerWallet: WALLET,
                takerWallet: COUNTERPARTY,
                offerId: 'offer-4',
                ticketId: 'ticket-4',
                marketType: '1X2',
                selection: 'draw',
                direction: 'BUY_SELECTION',
                status: 'ticket_attached',
                createdAt: new Date('2026-07-01T08:00:00.000Z'),
            },
        ]);
        prismaMock.arenaOutcome.findMany.mockResolvedValue([
            { id: 'outcome-3', fixtureId: 'fixture-3', winner: 'part2' },
        ]);
        prismaMock.offer.findMany.mockResolvedValue([
            { id: 'offer-1', price: 0.1, amount: 1, collateral: 0.2, asset: 'TXLINE:fixture-1:1X2:part1' },
            { id: 'offer-2', price: 0.2, amount: 1, collateral: 0.2, asset: 'TXLINE:fixture-2:1X2:part2' },
            { id: 'offer-3', price: 0.3, amount: 1, collateral: 0.2, asset: 'TXLINE:fixture-3:1X2:part1' },
        ]);
        prismaMock.agentEvent.findMany.mockResolvedValue([
            {
                id: 'event-1',
                event: 'reputation.update',
                ticketId: 'ticket-1',
                dealId: 'offer-1',
                payload: { newScore: 70 },
                createdAt: new Date('2026-07-04T10:01:00.000Z'),
            },
        ]);

        const { getReputationProfile } = await import('../src/services/reputationProfile.service');
        const profile: any = await getReputationProfile(WALLET, { recentLimit: 5 });

        expect(profile.wallet).toBe(WALLET);
        expect(profile.registered).toBe(true);
        expect(profile.algorithm.version).toBe('sport_reputation_v2');
        expect(profile.predictionReputation.evaluableSettledPredictions).toBe(3);
        expect(profile.predictionReputation.ignoredLegacyMatches).toBe(0);
        expect(profile.predictionReputation.correctPredictions).toBe(2);
        expect(profile.predictionReputation.wrongPredictions).toBe(1);
        expect(profile.predictionReputation.accuracyPct).toBe(66.67);
        expect(profile.predictionReputation.adjustedAccuracyPct).toBeLessThan(66.67);
        expect(profile.predictionReputation.pendingMatches).toBe(1);
        expect(profile.predictionReputation.roles).toEqual({ maker: 3, taker: 1 });
        expect(profile.predictionReputation.recent).toHaveLength(3);
        expect(profile.predictionReputation.recent[0]).toMatchObject({
            matchId: 'match-maker-win',
            role: 'maker',
            correct: true,
        });
        expect(profile.scoreBreakdown.predictionAccuracyRaw).toBe(66.67);
        expect(profile.riskLevel).toBe('medium');
        expect(profile.riskFlags.some((flag: any) => flag.code === 'low_sport_sample')).toBe(true);
        expect(profile.recommendedCounterpartyAction).toBe('accept_with_collateral');
        expect(profile.history).toHaveLength(1);
        expect(profile.score).toBeGreaterThan(0);
    });

    it('does not count legacy fallback SPORT rows as pending reputation matches', async () => {
        prismaMock.agent.findUnique.mockResolvedValue({
            wallet: WALLET,
            totalDeals: 5,
            successfulDeals: 5,
            cancelledDeals: 0,
            disputedDeals: 0,
            totalVolume: '1000000000',
            avgSettlementTime: 60,
        });
        prismaMock.arenaMatch.findMany.mockResolvedValue([
            {
                id: 'legacy-espn',
                fixtureId: 'espn:mlb:401815979',
                makerWallet: OTHER,
                takerWallet: WALLET,
                buyerWallet: WALLET,
                sellerWallet: OTHER,
                offerId: 'legacy-offer',
                ticketId: 'legacy-ticket',
                marketType: 'moneyline',
                selection: 'part1',
                direction: 'BUY_SELECTION',
                status: 'ticket_attached',
                createdAt: new Date('2026-07-03T08:00:00.000Z'),
            },
            {
                id: 'legacy-smoke',
                fixtureId: 'hosted-smoke-1782991171664',
                makerWallet: WALLET,
                takerWallet: COUNTERPARTY,
                offerId: 'smoke-offer',
                ticketId: 'smoke-ticket',
                marketType: '1X2',
                selection: 'part1',
                direction: 'BUY_SELECTION',
                status: 'ticket_attached',
                createdAt: new Date('2026-07-02T08:00:00.000Z'),
            },
            {
                id: 'txline-pending',
                fixtureId: '18179549',
                makerWallet: WALLET,
                takerWallet: COUNTERPARTY,
                offerId: 'real-offer',
                ticketId: 'real-ticket',
                marketType: '1X2',
                selection: 'part1',
                direction: 'BUY_SELECTION',
                status: 'ticket_attached',
                createdAt: new Date('2026-07-04T08:00:00.000Z'),
            },
        ]);
        prismaMock.arenaFixture.findMany.mockResolvedValue([
            { fixtureId: 'espn:mlb:401815979', raw: { source: 'espn_scoreboard_fallback' } },
            { fixtureId: '18179549', raw: { source: 'txline' } },
        ]);
        prismaMock.arenaOutcome.findMany.mockResolvedValue([]);
        prismaMock.offer.findMany.mockResolvedValue([]);
        prismaMock.agentEvent.findMany.mockResolvedValue([]);

        const { getReputationProfile } = await import('../src/services/reputationProfile.service');
        const profile: any = await getReputationProfile(WALLET);

        expect(profile.predictionReputation.totalMatches).toBe(1);
        expect(profile.predictionReputation.pendingMatches).toBe(1);
        expect(profile.predictionReputation.ignoredLegacyMatches).toBe(2);
        expect(profile.predictionReputation.roles).toEqual({ maker: 1, taker: 0 });
    });

    it('ramps SPORT score impact with settled sample confidence', async () => {
        prismaMock.agent.findUnique.mockResolvedValue({
            wallet: WALLET,
            totalDeals: 5,
            successfulDeals: 5,
            cancelledDeals: 0,
            disputedDeals: 0,
            totalVolume: '1000000000',
            avgSettlementTime: 60,
        });
        prismaMock.arenaMatch.findMany.mockResolvedValue([
            {
                id: 'one-correct',
                fixtureId: '18176123',
                makerWallet: WALLET,
                takerWallet: COUNTERPARTY,
                offerId: 'offer-1',
                ticketId: 'ticket-1',
                marketType: '1X2',
                selection: 'part2',
                direction: 'SELL_SELECTION',
                outcomeWinner: 'draw',
                status: 'released',
                settlementAction: 'release_to_maker',
                winnerWallet: WALLET,
                settledAt: new Date('2026-07-04T10:00:00.000Z'),
                createdAt: new Date('2026-07-04T08:00:00.000Z'),
            },
        ]);
        prismaMock.arenaFixture.findMany.mockResolvedValue([
            { fixtureId: '18176123', raw: { source: 'txline' } },
        ]);
        prismaMock.arenaOutcome.findMany.mockResolvedValue([]);
        prismaMock.offer.findMany.mockResolvedValue([
            { id: 'offer-1', price: 0.01, amount: 1, collateral: 0.2, asset: 'TXLINE:18176123:1X2:part2' },
        ]);
        prismaMock.agentEvent.findMany.mockResolvedValue([]);

        const { getReputationProfile } = await import('../src/services/reputationProfile.service');
        const profile: any = await getReputationProfile(WALLET);

        expect(profile.predictionReputation.evaluableSettledPredictions).toBe(1);
        expect(profile.scoreBreakdown.sportWeight).toBeLessThan(20);
        expect(profile.score).toBeGreaterThanOrEqual(28);
        expect(profile.algorithm.formula).toContain('Sample-weighted blend');
    });

    it('returns a safe fresh-wallet reputation instead of inventing history', async () => {
        prismaMock.agent.findUnique.mockResolvedValue(null);
        prismaMock.arenaMatch.findMany.mockResolvedValue([]);
        prismaMock.arenaOutcome.findMany.mockResolvedValue([]);
        prismaMock.offer.findMany.mockResolvedValue([]);
        prismaMock.agentEvent.findMany.mockResolvedValue([]);

        const { getReputationProfile } = await import('../src/services/reputationProfile.service');
        const profile: any = await getReputationProfile(WALLET);

        expect(profile.registered).toBe(false);
        expect(profile.score).toBe(0);
        expect(profile.tier).toBe('new');
        expect(profile.predictionReputation.evaluableSettledPredictions).toBe(0);
        expect(profile.predictionReputation.accuracy).toBeNull();
        expect(profile.riskFlags.some((flag: any) => flag.code === 'fresh_wallet')).toBe(true);
    });

    it('does not count cancelled, failed, or missing-outcome SPORT matches as prediction accuracy', async () => {
        prismaMock.agent.findUnique.mockResolvedValue(null);
        prismaMock.arenaMatch.findMany.mockResolvedValue([
            {
                id: 'cancelled',
                fixtureId: 'fixture-cancelled',
                makerWallet: WALLET,
                takerWallet: COUNTERPARTY,
                selection: 'part1',
                direction: 'BUY_SELECTION',
                outcomeWinner: 'part1',
                status: 'cancelled',
                createdAt: new Date('2026-07-04T08:00:00.000Z'),
            },
            {
                id: 'failed',
                fixtureId: 'fixture-failed',
                makerWallet: WALLET,
                takerWallet: COUNTERPARTY,
                selection: 'part1',
                direction: 'BUY_SELECTION',
                outcomeWinner: 'part1',
                status: 'failed',
                createdAt: new Date('2026-07-04T08:00:00.000Z'),
            },
            {
                id: 'missing-outcome',
                fixtureId: 'fixture-missing',
                makerWallet: WALLET,
                takerWallet: COUNTERPARTY,
                selection: 'part1',
                direction: 'BUY_SELECTION',
                status: 'released',
                createdAt: new Date('2026-07-04T08:00:00.000Z'),
            },
        ]);
        prismaMock.arenaOutcome.findMany.mockResolvedValue([]);
        prismaMock.offer.findMany.mockResolvedValue([]);
        prismaMock.agentEvent.findMany.mockResolvedValue([]);

        const { getReputationProfile } = await import('../src/services/reputationProfile.service');
        const profile: any = await getReputationProfile(WALLET);

        expect(profile.predictionReputation.evaluableSettledPredictions).toBe(0);
        expect(profile.predictionReputation.cancelledMatches).toBe(1);
        expect(profile.predictionReputation.failedMatches).toBe(1);
        expect(profile.predictionReputation.unevaluableSettledMatches).toBe(1);
        expect(profile.riskFlags.some((flag: any) => flag.code === 'missing_outcome_link')).toBe(true);
        expect(profile.riskFlags.some((flag: any) => flag.code === 'settlement_failures')).toBe(true);
    });

    it('batch reputation rejects invalid wallets and dedupes valid wallets', async () => {
        prismaMock.agent.findUnique.mockResolvedValue(null);
        prismaMock.arenaMatch.findMany.mockResolvedValue([]);
        prismaMock.arenaOutcome.findMany.mockResolvedValue([]);
        prismaMock.offer.findMany.mockResolvedValue([]);
        prismaMock.agentEvent.findMany.mockResolvedValue([]);

        const { getReputationBatch } = await import('../src/services/reputationProfile.service');
        const result: any = await getReputationBatch([WALLET, WALLET, 'not-a-wallet'], { includeHistory: false });

        expect(result.count).toBe(1);
        expect(result.data).toHaveLength(1);
        expect(result.rejected).toEqual([{ wallet: 'not-a-wallet', error: 'invalid_wallet' }]);
        expect(prismaMock.agent.findUnique).toHaveBeenCalledTimes(1);
    });

    it('leaderboard ranks wallets by confidence-adjusted SPORT reputation', async () => {
        prismaMock.arenaMatch.findMany
            .mockResolvedValueOnce([
                { makerWallet: WALLET, takerWallet: COUNTERPARTY, buyerWallet: null, sellerWallet: null },
            ])
            .mockResolvedValueOnce([
                {
                    id: 'maker-win',
                    fixtureId: 'fixture-1',
                    makerWallet: WALLET,
                    takerWallet: COUNTERPARTY,
                    offerId: 'offer-1',
                    selection: 'part1',
                    direction: 'BUY_SELECTION',
                    outcomeWinner: 'part1',
                    status: 'released',
                    settledAt: new Date('2026-07-04T10:00:00.000Z'),
                    createdAt: new Date('2026-07-04T08:00:00.000Z'),
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 'taker-loss',
                    fixtureId: 'fixture-1',
                    makerWallet: WALLET,
                    takerWallet: COUNTERPARTY,
                    offerId: 'offer-1',
                    selection: 'part1',
                    direction: 'BUY_SELECTION',
                    outcomeWinner: 'part1',
                    status: 'released',
                    settledAt: new Date('2026-07-04T10:00:00.000Z'),
                    createdAt: new Date('2026-07-04T08:00:00.000Z'),
                },
            ]);
        prismaMock.agent.findMany.mockResolvedValue([]);
        prismaMock.agent.findUnique.mockImplementation(({ where }: any) => Promise.resolve({
            wallet: where.wallet,
            totalDeals: 1,
            successfulDeals: 1,
            cancelledDeals: 0,
            disputedDeals: 0,
            totalVolume: '1000000000',
            avgSettlementTime: 60,
        }));
        prismaMock.arenaOutcome.findMany.mockResolvedValue([
            { id: 'outcome-1', fixtureId: 'fixture-1', winner: 'part1' },
        ]);
        prismaMock.offer.findMany.mockResolvedValue([
            { id: 'offer-1', price: 0.1, amount: 1, collateral: 0.2, asset: 'TXLINE:fixture-1:1X2:part1' },
        ]);
        prismaMock.agentEvent.findMany.mockResolvedValue([]);

        const { getReputationLeaderboard } = await import('../src/services/reputationProfile.service');
        const result: any = await getReputationLeaderboard({ limit: 2 });

        expect(result.data).toHaveLength(2);
        expect(result.data[0].wallet).toBe(WALLET);
        expect(result.data[0].score).toBeGreaterThan(result.data[1].score);
        expect(result.data[0].predictionReputation.evaluableSettledPredictions).toBe(1);
    });
});
