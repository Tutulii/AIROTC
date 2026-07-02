import { beforeEach, describe, expect, it, vi } from 'vitest';

const txState = {
    existingBridge: null as any,
};

const signalRow = {
    id: 'signal-1',
    fixtureId: '18175981',
    strategy: 'sharp_movement_v1',
    signalType: 'sharp_odds_movement',
    marketType: '1X2_PARTICIPANT_RESULT:half=1',
    selection: 'part1',
    direction: 'BUY_SELECTION',
    confidence: 1,
    oddsBefore: 1.741,
    oddsAfter: 1.739,
    oddsChangePct: -0.001149,
    impliedBefore: 0.574383,
    impliedAfter: 0.575043,
    impliedDelta: 0.00066,
    scoreContext: { status: 'live' },
    tradeIntent: {
        mode: 'signal_only',
        action: 'quote_buy',
        fixtureId: '18175981',
        marketType: '1X2_PARTICIPANT_RESULT:half=1',
        selection: 'part1',
        confidence: 1,
        rollupMode: 'NONE',
        maxStakeSol: 0.05,
    },
    reason: 'part1 shortened in 1X2_PARTICIPANT_RESULT:half=1',
    sourceEventIds: ['timeline-1', 'timeline-2'],
    signalTimestamp: new Date('2026-06-30T05:31:00.000Z'),
    dedupeKey: 'signal-dedupe',
    createdAt: new Date('2026-06-30T05:31:01.000Z'),
};

const txMock = {
    arenaStrategyOffer: {
        findUnique: vi.fn(async () => txState.existingBridge),
        create: vi.fn(async ({ data }) => ({
            id: 'strategy-offer-1',
            createdAt: new Date('2026-06-30T05:32:00.000Z'),
            ...data,
        })),
    },
    agent: {
        upsert: vi.fn(async () => ({ id: 'agent-1', wallet: 'seller-wallet' })),
    },
    offer: {
        create: vi.fn(async ({ data }) => ({
            id: 'offer-1',
            status: 'active',
            createdAt: new Date('2026-06-30T05:32:00.000Z'),
            updatedAt: new Date('2026-06-30T05:32:00.000Z'),
            ...data,
            creator: { wallet: 'seller-wallet' },
        })),
        findUnique: vi.fn(async () => ({
            id: 'offer-1',
            asset: 'TXLINE:18175981:1X2_PARTICIPANT_RESULT:half=1:part1',
            price: 0.01,
            amount: 1,
            collateral: 0.01,
            mode: 'buy',
            rollupMode: 'NONE',
            status: 'active',
            creator: { wallet: 'seller-wallet' },
        })),
    },
};

const prismaMock = {
    arenaStrategySignal: {
        findUnique: vi.fn(async ({ where }) => where.id === 'signal-1' ? signalRow : null),
    },
    $transaction: vi.fn(async (callback: any) => callback(txMock)),
};

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

describe('TxLINE Day 3 strategy offer bridge', () => {
    beforeEach(() => {
        txState.existingBridge = null;
        vi.clearAllMocks();
    });

    it('creates a Normal Mode AIR OTC offer from a stored strategy signal', async () => {
        const { createOfferFromStrategySignal } = await import('../src/services/arena/strategyOfferBridge');

        const result = await createOfferFromStrategySignal('signal-1', 'seller-wallet');

        expect(txMock.offer.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    asset: 'TXLINE:18175981:1X2_PARTICIPANT_RESULT:half=1:part1',
                    price: 0.01,
                    amount: 1,
                    collateral: 0.01,
                    mode: 'buy',
                    rollupMode: 'NONE',
                    tokenMint: null,
                    tokenDecimals: 9,
                }),
            })
        );
        expect(txMock.arenaStrategyOffer.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    signalId: 'signal-1',
                    offerId: 'offer-1',
                    wallet: 'seller-wallet',
                    fixtureId: '18175981',
                }),
            })
        );
        expect(result).toMatchObject({
            created: true,
            offer: {
                id: 'offer-1',
                rollupMode: 'NONE',
                status: 'active',
            },
            bridge: {
                signalId: 'signal-1',
                offerId: 'offer-1',
            },
        });
    });

    it('returns the existing linked offer when the same signal was already bridged', async () => {
        txState.existingBridge = {
            id: 'strategy-offer-1',
            signalId: 'signal-1',
            offerId: 'offer-1',
            wallet: 'seller-wallet',
            fixtureId: '18175981',
            params: {},
            dedupeKey: 'dedupe',
            createdAt: new Date('2026-06-30T05:32:00.000Z'),
        };
        const { createOfferFromStrategySignal } = await import('../src/services/arena/strategyOfferBridge');

        const result = await createOfferFromStrategySignal('signal-1', 'seller-wallet');

        expect(txMock.offer.create).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            created: false,
            offer: {
                id: 'offer-1',
                rollupMode: 'NONE',
            },
            bridge: {
                signalId: 'signal-1',
                offerId: 'offer-1',
            },
        });
    });
});
