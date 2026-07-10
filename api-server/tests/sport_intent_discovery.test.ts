import { beforeEach, describe, expect, it, vi } from 'vitest';

const MAKER = 'EdUWKpttdUtWWiUpWzDasouXPvZzpuMpjytteHEzuk9Y';
const TAKER = 'A4bCoAbesNR18wwsujY5h5hwrZqJG4574tJ8uiEzLF3V';
const OTHER = '9nqd6aAWQ7DK3fj9fDpk6saaZS5yfXwJ86jgnz7Nbv9F';
const NOW = new Date('2026-07-10T10:00:00.000Z');
const STARTS_AT = new Date('2026-07-10T14:00:00.000Z');

const { webhooksMock } = vi.hoisted(() => ({
    webhooksMock: {
        intentCreated: vi.fn(async () => undefined),
        intentMatchAvailable: vi.fn(async () => undefined),
        liquidityAvailable: vi.fn(async () => undefined),
    },
}));

const fixtureRows = new Map<string, any>();
const intentRows = new Map<string, any>();
const positionRows = new Map<string, any>();
let intentSeq = 0;

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

function stored<T extends Record<string, any>>(row: T): T {
    return {
        ...row,
        createdAt: row.createdAt || NOW,
        updatedAt: row.updatedAt || NOW,
    };
}

function matchesWhere(row: any, where: any): boolean {
    if (!where) return true;
    if (where.OR && !where.OR.some((branch: any) => matchesWhere(row, branch))) return false;
    if (where.id && row.id !== where.id) return false;
    if (where.wallet && typeof where.wallet === 'string' && row.wallet !== where.wallet) return false;
    if (where.wallet?.not && row.wallet === where.wallet.not) return false;
    if (where.agentWallet && typeof where.agentWallet === 'string' && row.agentWallet !== where.agentWallet) return false;
    if (where.agentWallet?.not && row.agentWallet === where.agentWallet.not) return false;
    if (where.fixtureId && row.fixtureId !== where.fixtureId) return false;
    if (where.selection && row.selection !== where.selection) return false;
    if (where.side && row.side !== where.side) return false;
    if (where.status?.in && !where.status.in.includes(row.status)) return false;
    if (where.status && typeof where.status === 'string' && row.status !== where.status) return false;
    if (where.remainingLamports?.not !== undefined && row.remainingLamports === where.remainingLamports.not) return false;
    if (where.expiresAt?.gt && !(new Date(row.expiresAt).getTime() > new Date(where.expiresAt.gt).getTime())) return false;
    if (where.expiresAt?.lte && !(new Date(row.expiresAt).getTime() <= new Date(where.expiresAt.lte).getTime())) return false;
    return true;
}

const prismaMock = {
    arenaFixture: {
        findUnique: vi.fn(async ({ where }) => fixtureRows.get(where.fixtureId) || null),
    },
    sportPosition: {
        findMany: vi.fn(async ({ where, take }) => [...positionRows.values()]
            .filter((row) => matchesWhere(row, where))
            .sort((a, b) => new Date(a.fundedAt || a.createdAt).getTime() - new Date(b.fundedAt || b.createdAt).getTime())
            .slice(0, take || 100)),
    },
    sportIntent: {
        create: vi.fn(async ({ data }) => {
            const row = stored({ id: `intent-${++intentSeq}`, ...clone(data) });
            intentRows.set(row.id, row);
            return row;
        }),
        upsert: vi.fn(async ({ where, create, update }) => {
            const existing = [...intentRows.values()].find(
                (row) => row.wallet === where.wallet_clientIntentId.wallet
                    && row.clientIntentId === where.wallet_clientIntentId.clientIntentId,
            );
            const row = stored({
                ...(existing || {}),
                ...(existing ? clone(update) : clone(create)),
                id: existing?.id || `intent-${++intentSeq}`,
            });
            intentRows.set(row.id, row);
            return row;
        }),
        findMany: vi.fn(async ({ where, take }) => [...intentRows.values()]
            .filter((row) => matchesWhere(row, where))
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id))
            .slice(0, take || 100)),
        findUnique: vi.fn(async ({ where }) => intentRows.get(where.id) || null),
        update: vi.fn(async ({ where, data }) => {
            const row = intentRows.get(where.id);
            if (!row) throw new Error('intent_not_found');
            Object.assign(row, clone(data), { updatedAt: NOW });
            return row;
        }),
        updateMany: vi.fn(async ({ where, data }) => {
            let count = 0;
            for (const row of intentRows.values()) {
                if (matchesWhere(row, where)) {
                    Object.assign(row, clone(data), { updatedAt: NOW });
                    count += 1;
                }
            }
            return { count };
        }),
    },
};

vi.mock('../src/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('../src/lib/logger', () => ({
    logger: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}));
vi.mock('../src/services/webhookDelivery', () => ({ webhooks: webhooksMock }));

describe('SPORT intent discovery', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        vi.resetModules();
        vi.clearAllMocks();
        fixtureRows.clear();
        intentRows.clear();
        positionRows.clear();
        intentSeq = 0;
        process.env.SPORT_COMPLEMENT_BACK_MATCHING_ENABLED = 'true';
        fixtureRows.set('18179552', {
            fixtureId: '18179552',
            status: 'upcoming',
            startsAt: STARTS_AT,
            raw: { source: 'txline' },
        });
    });

    it('creates an intent and immediately reports existing compatible liquidity', async () => {
        positionRows.set('position-1', stored({
            id: 'position-1',
            fixtureId: '18179552',
            selection: 'part1',
            side: 'lay',
            status: 'funded_open',
            agentWallet: MAKER,
            stakeLamports: '100000000',
            remainingLamports: '100000000',
            fundedAt: NOW,
            expiresAt: STARTS_AT,
        }));

        const { createSportIntent } = await import('../src/services/sportIntent.service');
        const result: any = await createSportIntent(TAKER, {
            fixtureId: '18179552',
            selection: 'part1',
            side: 'back',
            stakeSol: 0.05,
            clientIntentId: 'wc-18179552-part1',
        });

        expect(result.matchingLiquidityCount).toBe(1);
        expect(result.matchingLiquidity[0]).toMatchObject({
            positionId: 'position-1',
            fillLamports: '50000000',
        });
        expect(webhooksMock.intentCreated).toHaveBeenCalledWith(TAKER, expect.objectContaining({
            intentId: 'intent-1',
            matchingLiquidityCount: 1,
        }));
        expect(webhooksMock.intentMatchAvailable).toHaveBeenCalledWith(TAKER, expect.objectContaining({
            intentId: 'intent-1',
            matchingLiquidityCount: 1,
        }));
        expect(webhooksMock.liquidityAvailable).toHaveBeenCalledWith(TAKER, expect.objectContaining({
            intentId: 'intent-1',
        }));
    });

    it('finds complement back-vs-back liquidity for opposite selections', async () => {
        positionRows.set('position-2', stored({
            id: 'position-2',
            fixtureId: '18179552',
            selection: 'part2',
            side: 'back',
            status: 'funded_open',
            agentWallet: MAKER,
            stakeLamports: '200000000',
            remainingLamports: '200000000',
            fundedAt: NOW,
            expiresAt: STARTS_AT,
        }));

        const { findSportMatchingLiquidity } = await import('../src/services/sportIntent.service');
        const result: any = await findSportMatchingLiquidity(TAKER, {
            fixtureId: '18179552',
            selection: 'part1',
            side: 'back',
            stakeSol: 0.1,
        });

        expect(result.count).toBe(1);
        expect(result.positions[0]).toMatchObject({
            positionId: 'position-2',
            selection: 'part2',
            side: 'back',
            fillLamports: '100000000',
        });
    });

    it('pushes intent and liquidity events when a new funded position appears', async () => {
        intentRows.set('intent-1', stored({
            id: 'intent-1',
            wallet: TAKER,
            fixtureId: '18179552',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part2',
            side: 'back',
            stakeLamports: '50000000',
            status: 'active',
            expiresAt: STARTS_AT,
        }));
        const position = stored({
            id: 'position-3',
            fixtureId: '18179552',
            selection: 'part1',
            side: 'back',
            status: 'funded_open',
            agentWallet: MAKER,
            stakeLamports: '100000000',
            remainingLamports: '100000000',
            fundedAt: NOW,
            expiresAt: STARTS_AT,
        });

        const { notifySportIntentsForPosition } = await import('../src/services/sportIntent.service');
        const result: any = await notifySportIntentsForPosition(position);

        expect(result.notified).toBe(1);
        expect(webhooksMock.intentMatchAvailable).toHaveBeenCalledWith(TAKER, expect.objectContaining({
            intentId: 'intent-1',
            matchingLiquidityCount: 1,
        }));
        expect(webhooksMock.liquidityAvailable).toHaveBeenCalledWith(TAKER, expect.objectContaining({
            intentId: 'intent-1',
            fixtureId: '18179552',
        }));
        expect(intentRows.get('intent-1')?.lastNotifiedAt).toBeTruthy();
    });

    it('cancels only the owning wallet intent', async () => {
        intentRows.set('intent-1', stored({
            id: 'intent-1',
            wallet: OTHER,
            fixtureId: '18179552',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
            side: 'back',
            status: 'active',
            expiresAt: STARTS_AT,
        }));

        const { cancelSportIntent } = await import('../src/services/sportIntent.service');
        await expect(cancelSportIntent(TAKER, 'intent-1')).rejects.toMatchObject({
            message: 'sport_intent_wallet_mismatch',
        });
        const cancelled: any = await cancelSportIntent(OTHER, 'intent-1');
        expect(cancelled.cancelled).toBe(true);
        expect(cancelled.intent.status).toBe('cancelled');
    });
});
