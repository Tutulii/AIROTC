import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKER = 'EdUWKpttdUtWWiUpWzDasouXPvZzpuMpjytteHEzuk9Y';
const TAKER = 'A4bCoAbesNR18wwsujY5h5hwrZqJG4574tJ8uiEzLF3V';
const OTHER = '9nqd6aAWQ7DK3fj9fDpk6saaZS5yfXwJ86jgnz7Nbv9F';
const NOW = new Date('2026-07-07T10:00:00.000Z');
const STARTS_AT = new Date('2026-07-07T12:00:00.000Z');

const {
    middlemanForwarderMock,
    attachSportTicketByOfferMock,
    webhooksMock,
} = vi.hoisted(() => ({
    middlemanForwarderMock: {
        forwardOfferAccepted: vi.fn(),
    },
    attachSportTicketByOfferMock: vi.fn(),
    webhooksMock: {
        dealMatched: vi.fn(),
    },
}));

const fixtureRows = new Map<string, any>();
const sportPositionRows = new Map<string, any>();
const offerRows = new Map<string, any>();
const ticketRows = new Map<string, any>();
const arenaMatchRows = new Map<string, any>();
let positionSeq = 0;
let offerSeq = 0;
let ticketSeq = 0;
let matchSeq = 0;

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
    if (where.id && row.id !== where.id) return false;
    if (where.fixtureId && row.fixtureId !== where.fixtureId) return false;
    if (where.selection && row.selection !== where.selection) return false;
    if (where.stakeLamports && row.stakeLamports !== where.stakeLamports) return false;
    if (where.side && row.side !== where.side) return false;
    if (where.status && row.status !== where.status) return false;
    if (where.agentWallet?.not && row.agentWallet === where.agentWallet.not) return false;
    if (where.agentWallet && typeof where.agentWallet === 'string' && row.agentWallet !== where.agentWallet) return false;
    if (where.expiresAt?.gt && !(new Date(row.expiresAt).getTime() > new Date(where.expiresAt.gt).getTime())) return false;
    if (where.expiresAt?.lte && !(new Date(row.expiresAt).getTime() <= new Date(where.expiresAt.lte).getTime())) return false;
    return true;
}

const tx = {
    agent: {
        upsert: vi.fn(async ({ where, create }) => ({ id: `agent-${where.wallet || create.wallet}`, wallet: where.wallet || create.wallet })),
    },
    sportPosition: {
        updateMany: vi.fn(async ({ where, data }) => {
            let count = 0;
            for (const row of sportPositionRows.values()) {
                if (matchesWhere(row, where)) {
                    Object.assign(row, clone(data), { updatedAt: NOW });
                    count += 1;
                }
            }
            return { count };
        }),
        findUnique: vi.fn(async ({ where }) => {
            if (where.id) return sportPositionRows.get(where.id) || null;
            const unique = where.agentWallet_clientOrderId;
            if (unique) {
                return [...sportPositionRows.values()].find(
                    (row) => row.agentWallet === unique.agentWallet && row.clientOrderId === unique.clientOrderId
                ) || null;
            }
            return null;
        }),
        findFirst: vi.fn(async ({ where, orderBy }) => {
            const rows = [...sportPositionRows.values()]
                .filter((row) => matchesWhere(row, where))
                .sort((a, b) => {
                    const created = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
                    return created || a.id.localeCompare(b.id);
                });
            return rows[0] || null;
        }),
        findMany: vi.fn(async ({ where, take }) => {
            return [...sportPositionRows.values()]
                .filter((row) => matchesWhere(row, where))
                .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id))
                .slice(0, take || 100);
        }),
        create: vi.fn(async ({ data }) => {
            const row = stored({
                id: `position-${++positionSeq}`,
                ...clone(data),
            });
            sportPositionRows.set(row.id, row);
            return row;
        }),
        update: vi.fn(async ({ where, data }) => {
            const row = sportPositionRows.get(where.id);
            if (!row) throw new Error('position_not_found');
            Object.assign(row, clone(data), { updatedAt: NOW });
            return row;
        }),
        deleteMany: vi.fn(async ({ where }) => {
            let count = 0;
            for (const row of [...sportPositionRows.values()]) {
                if (matchesWhere(row, where)) {
                    sportPositionRows.delete(row.id);
                    count += 1;
                }
            }
            return { count };
        }),
    },
    offer: {
        create: vi.fn(async ({ data }) => {
            const row = stored({ id: `offer-${++offerSeq}`, ...clone(data) });
            offerRows.set(row.id, row);
            return row;
        }),
        deleteMany: vi.fn(async ({ where }) => {
            if (where.id) offerRows.delete(where.id);
            return { count: 1 };
        }),
    },
    ticket: {
        create: vi.fn(async ({ data }) => {
            const row = stored({ id: `ticket-${++ticketSeq}`, ...clone(data) });
            ticketRows.set(row.id, row);
            return row;
        }),
        deleteMany: vi.fn(async ({ where }) => {
            if (where.id) ticketRows.delete(where.id);
            return { count: 1 };
        }),
    },
    arenaMatch: {
        create: vi.fn(async ({ data }) => {
            const row = stored({ id: `match-${++matchSeq}`, ...clone(data) });
            arenaMatchRows.set(row.id, row);
            return row;
        }),
        deleteMany: vi.fn(async ({ where }) => {
            if (where.id) arenaMatchRows.delete(where.id);
            return { count: 1 };
        }),
    },
    arenaFixture: {
        findUnique: vi.fn(async ({ where }) => fixtureRows.get(where.fixtureId) || null),
    },
};

const prismaMock = {
    ...tx,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
};

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

vi.mock('../src/services/middlemanForwarder', () => ({
    middlemanForwarder: middlemanForwarderMock,
}));

vi.mock('../src/services/arena/sportSettlementEngine', () => ({
    attachSportTicketByOffer: attachSportTicketByOfferMock,
}));

vi.mock('../src/services/webhookDelivery', () => ({
    webhooks: webhooksMock,
}));

describe('SPORT position layer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        vi.resetModules();
        vi.clearAllMocks();
        fixtureRows.clear();
        sportPositionRows.clear();
        offerRows.clear();
        ticketRows.clear();
        arenaMatchRows.clear();
        positionSeq = 0;
        offerSeq = 0;
        ticketSeq = 0;
        matchSeq = 0;
        fixtureRows.set('18198205', stored({
            id: 'fixture-1',
            fixtureId: '18198205',
            status: 'upcoming',
            startsAt: STARTS_AT,
            raw: { source: 'txline' },
        }));
        middlemanForwarderMock.forwardOfferAccepted.mockResolvedValue({
            success: true,
            middlemanTicketId: 'ticket-1',
            phase: 'awaiting_deposits',
            dealPda: 'sport-escrow-pda',
            depositInstructions: { escrowPda: 'sport-escrow-pda' },
        });
        attachSportTicketByOfferMock.mockResolvedValue({
            match: { id: 'match-1', escrowPda: 'sport-escrow-pda', status: 'escrow_attached' },
        });
        webhooksMock.dealMatched.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('queues an unmatched position with exact lamports and fixture expiry', async () => {
        const { postSportPosition } = await import('../src/services/sportPosition.service');

        const result: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            stakeSol: '0.03',
            clientOrderId: 'order-1',
        });

        expect(result).toMatchObject({
            matched: false,
            status: 'open',
            reason: 'no_equal_stake_counterparty',
            position: {
                fixtureId: '18198205',
                selection: 'part1',
                side: 'back',
                stakeLamports: '30000000',
                clientOrderId: 'order-1',
            },
        });
        expect(result.position.expiresAt).toBe(STARTS_AT.toISOString());
        expect(middlemanForwarderMock.forwardOfferAccepted).not.toHaveBeenCalled();
    });

    it('FIFO matches same fixture, same selection, equal stake, opposite side and creates a SPORT ticket', async () => {
        const { postSportPosition } = await import('../src/services/sportPosition.service');
        await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part2',
            side: 'lay',
            stakeSol: '0.05',
            clientOrderId: 'maker-lay',
        });

        const result: any = await postSportPosition(TAKER, {
            fixtureId: '18198205',
            selection: 'part2',
            side: 'back',
            stakeSol: '0.05',
            clientOrderId: 'taker-back',
        });

        expect(result).toMatchObject({
            matched: true,
            position: {
                agentWallet: TAKER,
                side: 'back',
                matchedPositionId: 'position-1',
            },
            counterpartyPosition: {
                agentWallet: MAKER,
                side: 'lay',
                matchedPositionId: 'position-2',
            },
            offer: {
                asset: 'TXLINE:18198205:1X2_PARTICIPANT_RESULT:part2',
                price: 0.05,
                amount: 1,
                rollupMode: 'SPORT',
                fixtureId: '18198205',
                selection: 'part2',
            },
            ticket: {
                buyer: TAKER,
                seller: MAKER,
                rollupMode: 'SPORT',
            },
            sportEscrow: {
                mathOnly: true,
                dealPda: 'sport-escrow-pda',
            },
        });
        expect(arenaMatchRows.get('match-1')).toMatchObject({
            makerPositionId: 'position-1',
            takerPositionId: 'position-2',
            makerSide: 'lay',
            stakeLamports: '50000000',
            buyerWallet: TAKER,
            sellerWallet: MAKER,
        });
        expect(middlemanForwarderMock.forwardOfferAccepted).toHaveBeenCalledWith(expect.objectContaining({
            buyerWallet: TAKER,
            sellerWallet: MAKER,
            price: 0.05,
            amount: 1,
            collateral: 0,
            rollupMode: 'SPORT',
        }));
    });

    it('does not match different stake or same side positions', async () => {
        const { postSportPosition } = await import('../src/services/sportPosition.service');
        await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'draw',
            side: 'back',
            stakeSol: '0.05',
        });
        const differentStake: any = await postSportPosition(TAKER, {
            fixtureId: '18198205',
            selection: 'draw',
            side: 'lay',
            stakeSol: '0.02',
        });
        const sameSide: any = await postSportPosition(OTHER, {
            fixtureId: '18198205',
            selection: 'draw',
            side: 'back',
            stakeSol: '0.05',
        });

        expect(differentStake.matched).toBe(false);
        expect(sameSide.matched).toBe(false);
        expect(middlemanForwarderMock.forwardOfferAccepted).not.toHaveBeenCalled();
    });

    it('directly accepts one open position by creating the opposite side', async () => {
        const { postSportPosition, acceptSportPosition } = await import('../src/services/sportPosition.service');
        const posted: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            side: 'back',
            stakeSol: '0.04',
        });

        const result: any = await acceptSportPosition(TAKER, posted.position.id, {
            clientOrderId: 'lazy-accept',
        });

        expect(result).toMatchObject({
            matched: true,
            position: {
                agentWallet: TAKER,
                side: 'lay',
                clientOrderId: 'lazy-accept',
            },
            counterpartyPosition: {
                agentWallet: MAKER,
                side: 'back',
            },
            ticket: {
                buyer: MAKER,
                seller: TAKER,
            },
        });
    });

    it('rejects positions after the fixture acceptance window closes', async () => {
        vi.setSystemTime(new Date('2026-07-07T11:59:30.000Z'));
        const { postSportPosition } = await import('../src/services/sportPosition.service');

        await expect(postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            stakeSol: '0.03',
        })).rejects.toMatchObject({
            message: 'sport_fixture_position_window_closed',
            statusCode: 409,
        });
    });
});
