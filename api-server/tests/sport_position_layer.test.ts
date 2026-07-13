import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

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
            forwardExpiredSportPositionRefund: vi.fn(),
            forwardSportPositionFunding: vi.fn(),
        },
    attachSportTicketByOfferMock: vi.fn(),
    webhooksMock: {
        dealMatched: vi.fn(),
        positionFunded: vi.fn(),
        positionFilled: vi.fn(),
        positionExpired: vi.fn(),
        positionRefunded: vi.fn(),
        matchAwaitingResult: vi.fn(),
    },
}));

const fixtureRows = new Map<string, any>();
const sportPositionRows = new Map<string, any>();
const sportPositionFillRows = new Map<string, any>();
const sportFundingSessionRows = new Map<string, any>();
const outcomeRows = new Map<string, any>();
const offerRows = new Map<string, any>();
const ticketRows = new Map<string, any>();
const arenaMatchRows = new Map<string, any>();
const fundingEventRows: any[] = [];
let positionSeq = 0;
let fillSeq = 0;
let offerSeq = 0;
let ticketSeq = 0;
let matchSeq = 0;
let fundingEventSeq = 0;

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
    if (where.fixtureId && row.fixtureId !== where.fixtureId) return false;
    if (where.selection && row.selection !== where.selection) return false;
    if (where.stakeLamports && row.stakeLamports !== where.stakeLamports) return false;
    if (where.remainingLamports?.not !== undefined && row.remainingLamports === where.remainingLamports.not) return false;
    if (where.remainingLamports && typeof where.remainingLamports === 'string' && row.remainingLamports !== where.remainingLamports) return false;
    if (where.vaultVersion && row.vaultVersion !== where.vaultVersion) return false;
    if (where.side && row.side !== where.side) return false;
    if (where.status?.in && !where.status.in.includes(row.status)) return false;
    if (where.status && typeof where.status === 'string' && row.status !== where.status) return false;
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
    sportPositionFill: {
        create: vi.fn(async ({ data }) => {
            const row = stored({
                id: `fill-${++fillSeq}`,
                ...clone(data),
            });
            sportPositionFillRows.set(row.id, row);
            return row;
        }),
        update: vi.fn(async ({ where, data }) => {
            const row = sportPositionFillRows.get(where.id);
            if (!row) throw new Error('fill_not_found');
            Object.assign(row, clone(data), { updatedAt: NOW });
            return row;
        }),
        updateMany: vi.fn(async ({ where, data }) => {
            let count = 0;
            for (const row of sportPositionFillRows.values()) {
                if (matchesWhere(row, where)) {
                    Object.assign(row, clone(data), { updatedAt: NOW });
                    count += 1;
                }
            }
            return { count };
        }),
        findMany: vi.fn(async ({ where, take }) => {
            return [...sportPositionFillRows.values()]
                .filter((row) => matchesWhere(row, where))
                .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id))
                .slice(0, take || 100);
        }),
    },
    sportFundingSession: {
        findUnique: vi.fn(async ({ where }) => {
            if (where.wallet) return sportFundingSessionRows.get(where.wallet) || null;
            return null;
        }),
        upsert: vi.fn(async ({ where, create, update }) => {
            const existing = sportFundingSessionRows.get(where.wallet);
            const row = stored({
                ...(existing || {}),
                ...(existing ? clone(update) : clone(create)),
                id: existing?.id || `funding-session-${where.wallet}`,
                wallet: where.wallet,
            });
            sportFundingSessionRows.set(where.wallet, row);
            return row;
        }),
        update: vi.fn(async ({ where, data }) => {
            const row = sportFundingSessionRows.get(where.wallet);
            if (!row) throw new Error('sport_funding_session_not_found');
            Object.assign(row, clone(data), { updatedAt: NOW });
            return row;
        }),
        deleteMany: vi.fn(async ({ where }) => {
            let count = 0;
            if (where.wallet && sportFundingSessionRows.delete(where.wallet)) count = 1;
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
    arenaOutcome: {
        findUnique: vi.fn(async ({ where }) => outcomeRows.get(where.fixtureId) || null),
    },
    sportPositionFundingEvent: {
        create: vi.fn(async ({ data }) => {
            const row = stored({ id: `funding-event-${++fundingEventSeq}`, ...clone(data) });
            fundingEventRows.push(row);
            return row;
        }),
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
        sportPositionFillRows.clear();
        sportFundingSessionRows.clear();
        outcomeRows.clear();
        offerRows.clear();
        ticketRows.clear();
        arenaMatchRows.clear();
        fundingEventRows.length = 0;
        positionSeq = 0;
        fillSeq = 0;
        offerSeq = 0;
        ticketSeq = 0;
        matchSeq = 0;
        fundingEventSeq = 0;
        process.env.SPORT_POSITION_VERIFY_FUNDING_ONCHAIN = 'false';
        process.env.SPORT_POSITION_ALLOW_SERVER_RECORDED_FUNDING = 'true';
        process.env.SPORT_POSITION_FUNDING_BALANCE_CHECK = 'false';
        process.env.SPORT_PARTIAL_FILL_ENABLED = 'true';
        process.env.SPORT_FUNDING_SESSION_ENCRYPTION_KEY = 'test-sport-funding-session-secret';
        delete process.env.SPORT_POSITION_ENABLE_RAW_PDA_FUNDING;
        delete process.env.SPORT_POSITION_VAULT_MODE;
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
            tx: 'sport-commit-tx',
            depositInstructions: {
                escrowPda: 'sport-escrow-pda',
                buyer: {
                    wallet: TAKER,
                    stake: 0.05,
                    payment: 0.05,
                    collateral: 0.000000001,
                    protocolDustLamports: 1,
                    total: 0.050000001,
                },
                seller: {
                    wallet: MAKER,
                    stake: 0.05,
                    collateral: 0,
                    total: 0.05,
                },
            },
        });
        middlemanForwarderMock.forwardExpiredSportPositionRefund.mockResolvedValue({
            success: true,
            tx: 'expired-refund-tx',
            closeTx: 'expired-close-tx',
            refundedLamports: '40000000',
            closed: true,
        });
        middlemanForwarderMock.forwardSportPositionFunding.mockResolvedValue({
            success: true,
            initTx: 'sport-position-init-tx',
            fundingTx: 'sport-position-fund-tx',
            tx: 'sport-position-fund-tx',
            vaultPda: '6N77J7cCsKq75kyQJJKE6qQqpZ43aT4dpXkhwcZfCLWK',
            ownerWallet: MAKER,
        });
        attachSportTicketByOfferMock.mockResolvedValue({
            match: { id: 'match-1', escrowPda: 'sport-escrow-pda', status: 'escrow_attached' },
        });
        webhooksMock.dealMatched.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
            delete process.env.SPORT_POSITION_FUNDING_BALANCE_CHECK;
            delete process.env.SPORT_FUNDING_SESSION_ENCRYPTION_KEY;
    });

    it('creates a funding-required position draft with vault instructions and keeps it off the public book', async () => {
        const { listSportPositions, listMySportPositions, postSportPosition } = await import('../src/services/sportPosition.service');

        const result: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            stakeSol: '0.03',
            clientOrderId: 'order-1',
        });

        expect(result).toMatchObject({
            matched: false,
            status: 'funding_required',
            reason: 'stake_must_be_locked_before_position_is_public',
            position: {
                fixtureId: '18198205',
                selection: 'part1',
                side: 'back',
                stakeLamports: '30000000',
                status: 'funding_required',
                clientOrderId: 'order-1',
                vaultVersion: 'v2',
                fundingWindow: {
                    expiresAt: '2026-07-07T11:00:00.000Z',
                    appliesToStatus: 'funding_required',
                    expired: false,
                },
                liquidityWindow: {
                    expiresAt: STARTS_AT.toISOString(),
                    appliesToStatus: ['funded_open', 'partially_filled'],
                    expired: false,
                },
                autoRefundEligibleAt: null,
            },
            fundingInstructions: {
                type: 'sport_position_prefund',
                vaultVersion: 'v2',
                amountLamports: '30000000',
                ownerWallet: MAKER,
                transferEnabled: false,
                expiresAt: '2026-07-07T11:00:00.000Z',
                pdaDerivation: {
                    vaultVersion: 'v2',
                    seedPrefix: 'sport_position_v2',
                    seedHashAlgorithm: 'sha256',
                    seedHashInput: 'positionId',
                },
                balanceCheck: {
                    checked: false,
                    reason: 'disabled',
                },
            },
        });
        expect(result.position.vaultPda).toEqual(expect.any(String));
        expect(result.position.expiresAt).toBe(STARTS_AT.toISOString());
        expect(middlemanForwarderMock.forwardOfferAccepted).not.toHaveBeenCalled();
        expect(fundingEventRows[0]).toMatchObject({
            positionId: 'position-1',
            wallet: MAKER,
            event: 'funding_required',
            lamports: '30000000',
        });

        await expect(listSportPositions({ status: 'funding_required' })).resolves.toMatchObject({
            count: 0,
            positions: [],
        });
        await expect(listSportPositions({ status: 'all' })).resolves.toMatchObject({
            count: 0,
            positions: [],
        });
        await expect(listMySportPositions(MAKER, { status: 'funding_required' })).resolves.toMatchObject({
            count: 1,
            positions: [expect.objectContaining({ id: result.position.id, status: 'funding_required' })],
        });
    });

    it('returns compact fixture and result summaries without raw TxLINE replay payloads', async () => {
        outcomeRows.set('18198205', stored({
            id: 'outcome-1',
            fixtureId: '18198205',
            status: 'final',
            homeScore: 2,
            awayScore: 0,
            winner: 'part1',
            source: 'txline_score',
            sourceTimestamp: new Date('2026-07-07T14:00:00.000Z'),
            settledAt: new Date('2026-07-07T14:01:00.000Z'),
            raw: { proof: 'stored-outcome' },
        }));
        const {
            getSportFixtureSummary,
            getSportResultSummary,
        } = await import('../src/services/sportPosition.service');

        await expect(getSportFixtureSummary('18198205')).resolves.toMatchObject({
            fixtureId: '18198205',
            marketSelections: ['part1', 'draw', 'part2'],
            latestScore: {
                homeScore: 2,
                awayScore: 0,
                label: '2-0',
            },
            result: {
                settled: true,
                winner: 'part1',
                score: '2-0',
            },
            rawIncluded: false,
        });
        await expect(getSportResultSummary('18198205')).resolves.toMatchObject({
            fixtureId: '18198205',
            settled: true,
            winner: 'part1',
            score: '2-0',
            rawIncluded: false,
        });
    });

    it('rejects funding confirmation in production when no verifier or server-recorded mode is configured', async () => {
        const originalNodeEnv = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = 'production';
            delete process.env.SPORT_POSITION_ALLOW_SERVER_RECORDED_FUNDING;
            const { confirmSportPositionFunding, postSportPosition } = await import('../src/services/sportPosition.service');
            const draft: any = await postSportPosition(MAKER, {
                fixtureId: '18198205',
                selection: 'part1',
                stakeSol: '0.03',
            });

            await expect(confirmSportPositionFunding(MAKER, draft.position.id, {
                fundingTx: 'unverified-tx',
            })).rejects.toMatchObject({
                message: 'sport_position_funding_verification_not_configured',
                statusCode: 503,
            });
        } finally {
            if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = originalNodeEnv;
            process.env.SPORT_POSITION_ALLOW_SERVER_RECORDED_FUNDING = 'true';
        }
    });

    it('executes on-chain funding through middleman and confirms the position', async () => {
        const { executeSportPositionFunding, postSportPosition } = await import('../src/services/sportPosition.service');
        const draft: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            side: 'back',
            stakeSol: '0.03',
        });

        const result: any = await executeSportPositionFunding(MAKER, draft.position.id, {
            walletKeypair: 'test-secret-keypair',
        });

        expect(middlemanForwarderMock.forwardSportPositionFunding).toHaveBeenCalledWith({
            positionId: draft.position.id,
            ownerWallet: MAKER,
            ownerKeypair: 'test-secret-keypair',
            fixtureId: '18198205',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
            side: 'back',
            stakeLamports: '30000000',
            expiresAtUnix: Math.floor(new Date(draft.position.fundingExpiresAt).getTime() / 1000),
            vaultPda: draft.position.vaultPda,
        });
        expect(result).toMatchObject({
            executed: true,
            initTx: 'sport-position-init-tx',
            fundingTx: 'sport-position-fund-tx',
            tx: 'sport-position-fund-tx',
            positionId: draft.position.id,
            confirmation: {
                matched: false,
                status: 'funded_open',
                position: {
                    fundingWindow: {
                        expiresAt: '2026-07-07T11:00:00.000Z',
                        appliesToStatus: 'funding_required',
                        expired: false,
                    },
                    liquidityWindow: {
                        expiresAt: STARTS_AT.toISOString(),
                        appliesToStatus: ['funded_open', 'partially_filled'],
                        expired: false,
                    },
                    autoRefundEligibleAt: STARTS_AT.toISOString(),
                },
            },
        });
        expect(sportPositionRows.get(draft.position.id)).toMatchObject({
            status: 'funded_open',
            fundingTx: 'sport-position-fund-tx',
            fundedLamports: '30000000',
            remainingLamports: '30000000',
        });
        expect(fundingEventRows.map((event) => event.event)).toEqual(
            expect.arrayContaining(['funding_execution_started', 'funding_executed', 'funded_open'])
        );
    });

    it('registers an encrypted funding session and executes funding without passing the keypair again', async () => {
        const keypair = nacl.sign.keyPair();
        const wallet = bs58.encode(keypair.publicKey);
        fixtureRows.set('18198206', stored({
            id: 'fixture-2',
            fixtureId: '18198206',
            status: 'upcoming',
            startsAt: STARTS_AT,
            raw: { source: 'txline' },
        }));
        const {
            clearSportFundingSession,
            executeSportPositionFunding,
            getSportFundingSessionStatus,
            postSportPosition,
            registerSportFundingSession,
        } = await import('../src/services/sportPosition.service');

        const registered: any = await registerSportFundingSession(wallet, {
            walletKeypair: bs58.encode(keypair.secretKey),
            ttlSeconds: 900,
        });
        expect(registered).toMatchObject({
            registered: true,
            wallet,
            active: true,
            storage: 'api_encrypted_postgres',
        });
        expect(registered.encryptedSecretKey).toBeUndefined();
        expect(registered.iv).toBeUndefined();
        expect(registered.authTag).toBeUndefined();

        await expect(getSportFundingSessionStatus(wallet)).resolves.toMatchObject({
            wallet,
            active: true,
            storage: 'api_encrypted_postgres',
        });

        const draft: any = await postSportPosition(wallet, {
            fixtureId: '18198206',
            selection: 'part2',
            side: 'back',
            stakeSol: '0.01',
        });

        const result: any = await executeSportPositionFunding(wallet, draft.position.id);
        expect(result).toMatchObject({
            executed: true,
            positionId: draft.position.id,
            fundingTx: 'sport-position-fund-tx',
        });
        expect(middlemanForwarderMock.forwardSportPositionFunding).toHaveBeenCalledWith(
            expect.objectContaining({
                positionId: draft.position.id,
                ownerWallet: wallet,
                ownerKeypair: bs58.encode(keypair.secretKey),
                stakeLamports: '10000000',
            })
        );
        await expect(clearSportFundingSession(wallet)).resolves.toMatchObject({
            wallet,
            cleared: true,
            storage: 'api_encrypted_postgres',
        });
        await expect(getSportFundingSessionStatus(wallet)).resolves.toMatchObject({
            wallet,
            active: false,
        });
    });

    it('creates and funds a SPORT position in one call through a registered funding session', async () => {
        const keypair = nacl.sign.keyPair();
        const wallet = bs58.encode(keypair.publicKey);
        fixtureRows.set('18198207', stored({
            id: 'fixture-3',
            fixtureId: '18198207',
            status: 'upcoming',
            startsAt: STARTS_AT,
            raw: { source: 'txline' },
        }));
        const {
            createAndFundSportPosition,
            registerSportFundingSession,
        } = await import('../src/services/sportPosition.service');

        await registerSportFundingSession(wallet, {
            walletKeypair: bs58.encode(keypair.secretKey),
            ttlSeconds: 900,
        });
        const result: any = await createAndFundSportPosition(wallet, {
            fixtureId: '18198207',
            selection: 'part1',
            side: 'back',
            stakeSol: '0.01',
            clientOrderId: 'one-click-position',
        });

        expect(result).toMatchObject({
            success: true,
            status: 'funded_open',
            fixtureId: '18198207',
            selection: 'part1',
            side: 'back',
            stakeSol: 0.01,
            fundingTx: 'sport-position-fund-tx',
            matched: false,
            message: 'Ready to match!',
        });
        expect(result.positionId).toMatch(/^position-/);
        expect(middlemanForwarderMock.forwardSportPositionFunding).toHaveBeenCalledWith(
            expect.objectContaining({
                ownerWallet: wallet,
                ownerKeypair: bs58.encode(keypair.secretKey),
                stakeLamports: '10000000',
            })
        );
        expect(webhooksMock.positionFunded).toHaveBeenCalledWith(wallet, expect.objectContaining({
            positionId: result.positionId,
            fixtureId: '18198207',
            status: 'funded_open',
        }));
    });

    it('leaves a draft retryable when middleman funding execution fails', async () => {
        middlemanForwarderMock.forwardSportPositionFunding.mockResolvedValueOnce({
            success: false,
            error: 'owner_balance_too_low_for_position_funding',
        });
        const { executeSportPositionFunding, postSportPosition } = await import('../src/services/sportPosition.service');
        const draft: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'draw',
            side: 'lay',
            stakeSol: '0.02',
        });

        await expect(executeSportPositionFunding(MAKER, draft.position.id, {
            walletKeypair: 'bad-or-empty-keypair',
        })).rejects.toMatchObject({
            message: 'owner_balance_too_low_for_position_funding',
            statusCode: 502,
        });
        expect(sportPositionRows.get(draft.position.id)).toMatchObject({
            status: 'funding_required',
        });
        expect(sportPositionRows.get(draft.position.id).fundingTx).toBeUndefined();
        expect(fundingEventRows.map((event) => event.event)).toEqual(
            expect.arrayContaining(['funding_execution_started', 'funding_execution_failed'])
        );
    });

    it('FIFO matches only after both exact equal-stake opposite positions are funded', async () => {
        const { confirmSportPositionFunding, postSportPosition } = await import('../src/services/sportPosition.service');
        const maker: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part2',
            side: 'lay',
            stakeSol: '0.05',
            clientOrderId: 'maker-lay',
        });
        const makerFunded: any = await confirmSportPositionFunding(MAKER, maker.position.id, {
            fundingTx: 'maker-funding-tx',
        });
        expect(makerFunded).toMatchObject({
            matched: false,
            status: 'funded_open',
            reason: 'waiting_for_opposite_side_liquidity',
        });
        expect(middlemanForwarderMock.forwardOfferAccepted).not.toHaveBeenCalled();

        const taker: any = await postSportPosition(TAKER, {
            fixtureId: '18198205',
            selection: 'part2',
            side: 'back',
            stakeSol: '0.05',
            clientOrderId: 'taker-back',
        });
        const result: any = await confirmSportPositionFunding(TAKER, taker.position.id, {
            fundingTx: 'taker-funding-tx',
        });

        expect(result).toMatchObject({
            matched: true,
            position: {
                agentWallet: TAKER,
                side: 'back',
                status: 'filled',
                filledLamports: '50000000',
                remainingLamports: '0',
            },
            counterpartyPosition: {
                agentWallet: MAKER,
                side: 'lay',
                status: 'filled',
                filledLamports: '50000000',
                remainingLamports: '0',
            },
            fill: {
                id: 'fill-1',
                fillLamports: '50000000',
                ticketId: 'ticket-1',
                escrowPda: 'sport-escrow-pda',
                commitTx: 'sport-commit-tx',
                status: 'awaiting_result',
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
                status: 'awaiting_result',
                rollupMode: 'SPORT',
            },
            sportEscrow: {
                mathOnly: true,
                dealPda: 'sport-escrow-pda',
                depositInstructions: null,
                prefundedPositionVaults: {
                    stakeLamports: '50000000',
                    fillId: 'fill-1',
                },
            },
        });
        expect(JSON.stringify(result.sportEscrow)).not.toContain('collateral');
        expect(arenaMatchRows.get('match-1')).toMatchObject({
            makerPositionId: 'position-1',
            takerPositionId: 'position-2',
            makerSide: 'lay',
            stakeLamports: '50000000',
            makerVaultPda: expect.any(String),
            takerVaultPda: expect.any(String),
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
            sportPositionVaults: expect.objectContaining({
                fillId: 'fill-1',
                fillLamports: '50000000',
                vaultVersion: 'v2',
            }),
        }));
    });

    it('partially fills different stake sizes and keeps the maker remainder open', async () => {
        const { confirmSportPositionFunding, postSportPosition } = await import('../src/services/sportPosition.service');
        const maker: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'draw',
            side: 'back',
            stakeSol: '0.05',
        });
        await confirmSportPositionFunding(MAKER, maker.position.id, { fundingTx: 'maker-draw-tx' });
        const differentStake: any = await postSportPosition(TAKER, {
            fixtureId: '18198205',
            selection: 'draw',
            side: 'lay',
            stakeSol: '0.02',
        });
        const differentStakeFunded: any = await confirmSportPositionFunding(TAKER, differentStake.position.id, {
            fundingTx: 'taker-draw-tx',
        });
        expect(differentStakeFunded).toMatchObject({
            matched: true,
            fill: {
                fillLamports: '20000000',
                status: 'awaiting_result',
            },
            position: {
                agentWallet: TAKER,
                status: 'filled',
                filledLamports: '20000000',
                remainingLamports: '0',
            },
            counterpartyPosition: {
                agentWallet: MAKER,
                status: 'partially_filled',
                filledLamports: '20000000',
                remainingLamports: '30000000',
            },
        });
        expect(sportPositionRows.get(maker.position.id)).toMatchObject({
            status: 'partially_filled',
            filledLamports: '20000000',
            remainingLamports: '30000000',
        });
        expect(sportPositionFillRows.get('fill-1')).toMatchObject({
            backPositionId: maker.position.id,
            layPositionId: differentStake.position.id,
            fillLamports: '20000000',
            status: 'awaiting_result',
        });

        const sameSide: any = await postSportPosition(OTHER, {
            fixtureId: '18198205',
            selection: 'draw',
            side: 'back',
            stakeSol: '0.05',
        });
        const sameSideFunded: any = await confirmSportPositionFunding(OTHER, sameSide.position.id, {
            fundingTx: 'other-draw-tx',
        });

        expect(sameSideFunded.matched).toBe(false);
        expect(middlemanForwarderMock.forwardOfferAccepted).toHaveBeenCalledTimes(1);
    });

    it('fills one large position across two smaller opposite positions', async () => {
        const { confirmSportPositionFunding, postSportPosition } = await import('../src/services/sportPosition.service');
        const maker: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            side: 'back',
            stakeSol: '0.03',
        });
        await confirmSportPositionFunding(MAKER, maker.position.id, { fundingTx: 'maker-3-tx' });

        const firstLay: any = await postSportPosition(TAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            side: 'lay',
            stakeSol: '0.01',
        });
        const firstFill: any = await confirmSportPositionFunding(TAKER, firstLay.position.id, { fundingTx: 'lay-1-tx' });
        expect(firstFill.fill.fillLamports).toBe('10000000');
        expect(sportPositionRows.get(maker.position.id)).toMatchObject({
            status: 'partially_filled',
            filledLamports: '10000000',
            remainingLamports: '20000000',
        });

        const secondLay: any = await postSportPosition(OTHER, {
            fixtureId: '18198205',
            selection: 'part1',
            side: 'lay',
            stakeSol: '0.02',
        });
        const secondFill: any = await confirmSportPositionFunding(OTHER, secondLay.position.id, { fundingTx: 'lay-2-tx' });

        expect(secondFill.fill.fillLamports).toBe('20000000');
        expect(sportPositionRows.get(maker.position.id)).toMatchObject({
            status: 'filled',
            filledLamports: '30000000',
            remainingLamports: '0',
        });
        expect([...sportPositionFillRows.values()].map((fill) => fill.fillLamports)).toEqual(['10000000', '20000000']);
        expect(middlemanForwarderMock.forwardOfferAccepted).toHaveBeenCalledTimes(2);
    });

    it('matches complementary backed selections with draw-refund proof', async () => {
        const { confirmSportPositionFunding, postSportPosition } = await import('../src/services/sportPosition.service');
        const part1Back: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            side: 'back',
            stakeSol: '0.03',
        });
        await confirmSportPositionFunding(MAKER, part1Back.position.id, { fundingTx: 'maker-part1-back-tx' });

        const part2Back: any = await postSportPosition(TAKER, {
            fixtureId: '18198205',
            selection: 'part2',
            side: 'back',
            stakeSol: '0.01',
        });
        const result: any = await confirmSportPositionFunding(TAKER, part2Back.position.id, { fundingTx: 'taker-part2-back-tx' });

        expect(result).toMatchObject({
            matched: true,
            fill: {
                fillLamports: '10000000',
                status: 'awaiting_result',
            },
            position: {
                agentWallet: TAKER,
                selection: 'part2',
                side: 'back',
                status: 'filled',
                remainingLamports: '0',
            },
            counterpartyPosition: {
                agentWallet: MAKER,
                selection: 'part1',
                side: 'back',
                status: 'partially_filled',
                remainingLamports: '20000000',
            },
            ticket: {
                buyer: MAKER,
                seller: TAKER,
                status: 'awaiting_result',
            },
        });
        expect(arenaMatchRows.get('match-1')).toMatchObject({
            makerPositionId: part1Back.position.id,
            takerPositionId: part2Back.position.id,
            selection: 'part1',
            makerSide: 'back',
            buyerWallet: MAKER,
            sellerWallet: TAKER,
            proof: expect.objectContaining({
                marketModel: 'complement_back_draw_refund',
                matchKind: 'complement_back_back',
                makerSelection: 'part1',
                takerSelection: 'part2',
                drawPolicy: 'void_refund',
            }),
        });
        expect(sportPositionFillRows.get('fill-1')).toMatchObject({
            backPositionId: part1Back.position.id,
            layPositionId: part2Back.position.id,
            backWallet: MAKER,
            layWallet: TAKER,
            fillLamports: '10000000',
            status: 'awaiting_result',
        });
        expect(middlemanForwarderMock.forwardOfferAccepted).toHaveBeenCalledWith(expect.objectContaining({
            buyerWallet: MAKER,
            sellerWallet: TAKER,
            sportPositionVaults: expect.objectContaining({
                buyerPositionId: part1Back.position.id,
                sellerPositionId: part2Back.position.id,
                fillLamports: '10000000',
            }),
        }));
    });

    it('lists position fills and wallet fills for restart recovery', async () => {
        const {
            confirmSportPositionFunding,
            listMySportFills,
            listSportPositionFills,
            postSportPosition,
        } = await import('../src/services/sportPosition.service');
        const maker: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            side: 'back',
            stakeSol: '0.03',
        });
        await confirmSportPositionFunding(MAKER, maker.position.id, { fundingTx: 'maker-fill-read-tx' });
        const taker: any = await postSportPosition(TAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            side: 'lay',
            stakeSol: '0.01',
        });
        await confirmSportPositionFunding(TAKER, taker.position.id, { fundingTx: 'taker-fill-read-tx' });

        await expect(listSportPositionFills(MAKER, maker.position.id)).resolves.toMatchObject({
            count: 1,
            fills: [
                {
                    id: 'fill-1',
                    fillLamports: '10000000',
                    ticketId: 'ticket-1',
                    escrowPda: 'sport-escrow-pda',
                    commitTx: 'sport-commit-tx',
                    status: 'awaiting_result',
                },
            ],
        });
        await expect(listMySportFills(TAKER)).resolves.toMatchObject({
            wallet: TAKER,
            count: 1,
            fills: [
                {
                    id: 'fill-1',
                    layWallet: TAKER,
                    fillLamports: '10000000',
                },
            ],
        });
    });

    it('directly accepts one funded position by creating an opposite funding-required draft', async () => {
        const { postSportPosition, acceptSportPosition, confirmSportPositionFunding } = await import('../src/services/sportPosition.service');
        const posted: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            side: 'back',
            stakeSol: '0.04',
        });
        await confirmSportPositionFunding(MAKER, posted.position.id, { fundingTx: 'maker-part1-tx' });

        const result: any = await acceptSportPosition(TAKER, posted.position.id, {
            clientOrderId: 'lazy-accept',
        });

        expect(result).toMatchObject({
            matched: false,
            status: 'funding_required',
            position: {
                agentWallet: TAKER,
                side: 'lay',
                clientOrderId: 'lazy-accept',
            },
            acceptedPosition: {
                agentWallet: MAKER,
                side: 'back',
            },
        });
        expect(result.fundingInstructions.amountLamports).toBe('40000000');
    });

    it('direct accept can request a smaller partial stake than maker remaining liquidity', async () => {
        const { postSportPosition, acceptSportPosition, confirmSportPositionFunding } = await import('../src/services/sportPosition.service');
        const posted: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part2',
            side: 'back',
            stakeSol: '0.05',
        });
        await confirmSportPositionFunding(MAKER, posted.position.id, { fundingTx: 'maker-lazy-partial-tx' });

        const result: any = await acceptSportPosition(TAKER, posted.position.id, {
            clientOrderId: 'lazy-partial',
            stakeSol: '0.02',
        });

        expect(result).toMatchObject({
            matched: false,
            status: 'funding_required',
            position: {
                agentWallet: TAKER,
                side: 'lay',
                stakeLamports: '20000000',
                vaultVersion: 'v2',
            },
        });
        expect(result.fundingInstructions.amountLamports).toBe('20000000');
    });

    it('rejects cancelling after a funded match but allows cancelling before match', async () => {
        const { cancelSportPosition, confirmSportPositionFunding, postSportPosition } = await import('../src/services/sportPosition.service');
        const posted: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            side: 'back',
            stakeSol: '0.04',
        });
        await confirmSportPositionFunding(MAKER, posted.position.id, { fundingTx: 'maker-cancel-tx' });

        const cancelled: any = await cancelSportPosition(MAKER, posted.position.id, {});
        expect(cancelled).toMatchObject({
            cancelled: true,
            refundRequired: true,
            position: { status: 'cancelled' },
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

    it('autonomously refunds an expired funded unmatched position through the middleman bridge', async () => {
        const {
            confirmSportPositionFunding,
            postSportPosition,
            sweepExpiredSportPositionRefunds,
        } = await import('../src/services/sportPosition.service');
        const posted: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'part1',
            side: 'back',
            stakeSol: '0.04',
        });
        await confirmSportPositionFunding(MAKER, posted.position.id, { fundingTx: 'maker-expire-tx' });

        vi.setSystemTime(new Date('2026-07-07T12:01:00.000Z'));
        const result: any = await sweepExpiredSportPositionRefunds({
            now: new Date('2026-07-07T12:01:00.000Z'),
        });

        expect(result).toMatchObject({
            mode: 'SPORT',
            scanned: 1,
            refundedCount: 1,
            skippedCount: 0,
            refunded: [
                {
                    positionId: posted.position.id,
                    wallet: MAKER,
                    refundedLamports: '40000000',
                    refundTx: 'expired-refund-tx',
                    closeTx: 'expired-close-tx',
                    status: 'cancelled',
                },
            ],
        });
        expect(middlemanForwarderMock.forwardExpiredSportPositionRefund).toHaveBeenCalledWith({
            positionId: posted.position.id,
            ownerWallet: MAKER,
            vaultPda: expect.any(String),
            closeIfNoCommittedStake: true,
        });
        expect(sportPositionRows.get(posted.position.id)).toMatchObject({
            status: 'cancelled',
            remainingLamports: '0',
            refundedLamports: '40000000',
            cancelTx: 'expired-refund-tx',
        });
        expect(fundingEventRows.map((event) => event.event)).toContain('expired_remaining_refund_started');
        expect(fundingEventRows.map((event) => event.event)).toContain('expired_remaining_refunded');
    });

    it('autonomously refunds only the unmatched remainder on an expired partially-filled position', async () => {
        const {
            confirmSportPositionFunding,
            postSportPosition,
            sweepExpiredSportPositionRefunds,
        } = await import('../src/services/sportPosition.service');
        const maker: any = await postSportPosition(MAKER, {
            fixtureId: '18198205',
            selection: 'draw',
            side: 'back',
            stakeSol: '0.05',
        });
        await confirmSportPositionFunding(MAKER, maker.position.id, { fundingTx: 'maker-partial-expire-tx' });
        const taker: any = await postSportPosition(TAKER, {
            fixtureId: '18198205',
            selection: 'draw',
            side: 'lay',
            stakeSol: '0.02',
        });
        await confirmSportPositionFunding(TAKER, taker.position.id, { fundingTx: 'taker-partial-expire-tx' });
        middlemanForwarderMock.forwardExpiredSportPositionRefund.mockResolvedValueOnce({
            success: true,
            tx: 'partial-expired-refund-tx',
            refundedLamports: '30000000',
            closed: false,
        });

        vi.setSystemTime(new Date('2026-07-07T12:01:00.000Z'));
        const result: any = await sweepExpiredSportPositionRefunds({
            now: new Date('2026-07-07T12:01:00.000Z'),
        });

        expect(result).toMatchObject({
            scanned: 1,
            refundedCount: 1,
            refunded: [
                {
                    positionId: maker.position.id,
                    refundedLamports: '30000000',
                    status: 'filled',
                },
            ],
        });
        expect(middlemanForwarderMock.forwardExpiredSportPositionRefund).toHaveBeenCalledWith({
            positionId: maker.position.id,
            ownerWallet: MAKER,
            vaultPda: expect.any(String),
            closeIfNoCommittedStake: false,
        });
        expect(sportPositionRows.get(maker.position.id)).toMatchObject({
            status: 'filled',
            filledLamports: '20000000',
            remainingLamports: '0',
            refundedLamports: '30000000',
            cancelTx: 'partial-expired-refund-tx',
        });
        expect(sportPositionFillRows.get('fill-1')).toMatchObject({
            fillLamports: '20000000',
            status: 'awaiting_result',
        });
    });
});
