import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createOfferFromStrategySignalMock } = vi.hoisted(() => ({
    createOfferFromStrategySignalMock: vi.fn(),
}));
const { middlemanForwarderMock } = vi.hoisted(() => ({
    middlemanForwarderMock: {
        forwardSportSettlement: vi.fn(),
        getDealStatus: vi.fn(),
    },
}));
const { webhooksMock } = vi.hoisted(() => ({
    webhooksMock: {
        dealCompleted: vi.fn(),
        dealRefunded: vi.fn(),
        matchSettled: vi.fn(),
        positionRefunded: vi.fn(),
    },
}));

const NOW = new Date('2026-07-01T09:00:00.000Z');
const fixtureRows = new Map<string, any>();
const signalRows = new Map<string, any>();
const matchRows = new Map<string, any>();
const offerRows = new Map<string, any>();
const ticketRows = new Map<string, any>();
const outcomeRowsById = new Map<string, any>();
const outcomeRowsByFixture = new Map<string, any>();
const strategyOfferRows: any[] = [];
const scoreRows: any[] = [];

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

function seedArenaRows(): void {
    fixtureRows.set('fixture-1', stored({
        id: 'arena-fixture-1',
        fixtureId: 'fixture-1',
        sport: 'football',
        homeTeam: 'Home FC',
        awayTeam: 'Away FC',
        startsAt: new Date('2026-07-01T10:00:00.000Z'),
        status: 'live',
        raw: { source: 'txline' },
    }));
    signalRows.set('signal-1', stored({
        id: 'signal-1',
        fixtureId: 'fixture-1',
        strategy: 'sharp_movement_v1',
        signalType: 'sharp_odds_movement',
        marketType: '1X2_PARTICIPANT_RESULT',
        selection: 'part1',
        direction: 'BUY_SELECTION',
        confidence: 0.92,
        oddsBefore: 2.1,
        oddsAfter: 1.8,
        oddsChangePct: -0.14,
        impliedBefore: 0.476,
        impliedAfter: 0.555,
        impliedDelta: 0.079,
        scoreContext: { homeScore: 0, awayScore: 0 },
        tradeIntent: {
            mode: 'signal_only',
            action: 'quote_buy',
            rollupMode: 'NONE',
        },
        reason: 'Home FC price shortened sharply',
        sourceEventIds: ['timeline-1', 'timeline-2'],
        signalTimestamp: new Date('2026-07-01T09:02:00.000Z'),
        dedupeKey: 'signal-dedupe',
    }));
    offerRows.set('offer-1', stored({
        id: 'offer-1',
        asset: 'TXLINE:fixture-1:1X2_PARTICIPANT_RESULT:part1',
        price: 0.1,
        amount: 1,
        collateral: 0.3,
        mode: 'buy',
        rollupMode: 'NONE',
        status: 'matched',
    }));
    ticketRows.set('ticket-1', stored({
        id: 'ticket-1',
        offerId: 'offer-1',
        buyer: 'taker-wallet',
        seller: 'maker-wallet',
        status: 'delivery',
        rollupMode: 'NONE',
        offer: offerRows.get('offer-1'),
        messages: [
            {
                id: 'message-1',
                ticketId: 'ticket-1',
                sender: 'maker-wallet',
                content: 'Arena terms accepted.',
                createdAt: NOW,
            },
        ],
    }));
    const outcome = stored({
        id: 'outcome-1',
        fixtureId: 'fixture-1',
        status: 'finished',
        homeScore: 2,
        awayScore: 1,
        winner: 'part1',
        source: 'txline',
        sourceUpdateId: 'score-final',
        sourceTimestamp: new Date('2026-07-01T11:00:00.000Z'),
        settledAt: new Date('2026-07-01T11:00:00.000Z'),
        raw: { GameState: 'finished' },
    });
    outcomeRowsById.set(outcome.id, outcome);
    outcomeRowsByFixture.set(outcome.fixtureId, outcome);
    strategyOfferRows.push(stored({
        id: 'strategy-offer-1',
        signalId: 'signal-1',
        offerId: 'offer-1',
        wallet: 'maker-wallet',
        fixtureId: 'fixture-1',
        params: {},
        dedupeKey: 'strategy-offer-dedupe',
    }));
}

const prismaMock = {
    arenaFixture: {
        findUnique: vi.fn(async ({ where }) => fixtureRows.get(where.fixtureId) || null),
        findMany: vi.fn(async ({ where }) => {
            const ids = where?.fixtureId?.in;
            if (Array.isArray(ids)) {
                return ids.map((fixtureId: string) => fixtureRows.get(fixtureId)).filter(Boolean);
            }
            return [...fixtureRows.values()];
        }),
    },
    arenaStrategySignal: {
        findUnique: vi.fn(async ({ where }) => signalRows.get(where.id) || null),
    },
    arenaMatch: {
        create: vi.fn(async ({ data }) => {
            const row = stored({
                id: `match-${matchRows.size + 1}`,
                ...clone(data),
            });
            matchRows.set(row.id, row);
            return row;
        }),
        findFirst: vi.fn(async ({ where }) => {
            for (const row of matchRows.values()) {
                if (where.id && row.id !== where.id) continue;
                if (where.offerId && row.offerId !== where.offerId) continue;
                if (where.fixtureId && row.fixtureId !== where.fixtureId) continue;
                if (where.ticketId && row.ticketId !== where.ticketId) continue;
                return row;
            }
            return null;
        }),
        findMany: vi.fn(async ({ where, take }) => {
            const rows = [...matchRows.values()].filter((row) => {
                if (where?.id && row.id !== where.id) return false;
                if (where?.fixtureId && row.fixtureId !== where.fixtureId) return false;
                if (where?.rollupMode && row.rollupMode !== where.rollupMode) return false;
                if (where?.status?.notIn?.includes(row.status)) return false;
                return true;
            });
            return rows.slice(0, take || rows.length);
        }),
        findUnique: vi.fn(async ({ where }) => matchRows.get(where.id) || null),
        update: vi.fn(async ({ where, data }) => {
            const current = matchRows.get(where.id);
            if (!current) return null;
            Object.assign(current, clone(data), { updatedAt: NOW });
            matchRows.set(where.id, current);
            return current;
        }),
    },
    ticket: {
        findUnique: vi.fn(async ({ where }) => ticketRows.get(where.id) || null),
    },
    arenaOutcome: {
        findUnique: vi.fn(async ({ where }) => {
            if (where.id) return outcomeRowsById.get(where.id) || null;
            return outcomeRowsByFixture.get(where.fixtureId) || null;
        }),
        upsert: vi.fn(async ({ where, update, create }) => {
            const current = outcomeRowsByFixture.get(where.fixtureId);
            if (current) {
                Object.assign(current, clone(update), { updatedAt: NOW });
                outcomeRowsByFixture.set(current.fixtureId, current);
                outcomeRowsById.set(current.id, current);
                return current;
            }
            const row = stored({
                id: `outcome-${outcomeRowsById.size + 1}`,
                ...clone(create),
            });
            outcomeRowsByFixture.set(row.fixtureId, row);
            outcomeRowsById.set(row.id, row);
            return row;
        }),
    },
    arenaScoreUpdate: {
        findMany: vi.fn(async ({ where }) => scoreRows.filter((row) => {
            if (where?.fixtureId && row.fixtureId !== where.fixtureId) return false;
            return true;
        })),
    },
    arenaStrategyOffer: {
        findFirst: vi.fn(async ({ where }) => strategyOfferRows.find((row) => {
            if (where.offerId) return row.offerId === where.offerId;
            if (where.signalId) return row.signalId === where.signalId;
            return false;
        }) || null),
    },
    offer: {
        findUnique: vi.fn(async ({ where }) => offerRows.get(where.id) || null),
    },
};

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

vi.mock('../src/services/arena/strategyOfferBridge', () => ({
    createOfferFromStrategySignal: createOfferFromStrategySignalMock,
}));

vi.mock('../src/services/middlemanForwarder', () => ({
    middlemanForwarder: middlemanForwarderMock,
}));

vi.mock('../src/services/webhookDelivery', () => ({
    webhooks: webhooksMock,
}));

describe('ArenaMatch lifecycle', () => {
    beforeEach(() => {
        fixtureRows.clear();
        signalRows.clear();
        matchRows.clear();
        offerRows.clear();
        ticketRows.clear();
        outcomeRowsById.clear();
        outcomeRowsByFixture.clear();
        strategyOfferRows.splice(0);
        scoreRows.splice(0);
        vi.clearAllMocks();
        createOfferFromStrategySignalMock.mockResolvedValue({
            created: true,
            signal: { id: 'signal-1', fixtureId: 'fixture-1' },
            offer: { id: 'offer-1', rollupMode: 'NONE', status: 'active' },
            bridge: { id: 'strategy-offer-1', signalId: 'signal-1', offerId: 'offer-1' },
        });
        middlemanForwarderMock.forwardSportSettlement.mockResolvedValue({
            success: true,
            tx: 'middleman-sport-tx',
            onChainAction: 'release_funds',
            status: 'completed',
        });
        middlemanForwarderMock.getDealStatus.mockResolvedValue({
            success: false,
            error: 'not_configured_for_test',
        });
        seedArenaRows();
    });

    it('connects TxLINE signal to AIR OTC offer, ticket, escrow, outcome, and release proof', async () => {
        const {
            attachArenaTicket,
            createArenaMatch,
            getArenaMatchProof,
            settleArenaMatch,
            startArenaMatch,
        } = await import('../src/services/arena/arenaMatch.service');

        const created = await createArenaMatch({
            signalId: 'signal-1',
            makerWallet: 'maker-wallet',
            takerWallet: 'taker-wallet',
        });

        expect(created).toMatchObject({
            id: 'match-1',
            fixtureId: 'fixture-1',
            signalId: 'signal-1',
            makerWallet: 'maker-wallet',
            takerWallet: 'taker-wallet',
            status: 'created',
            rollupMode: 'NONE',
            strategy: 'sharp_movement_v1',
            selection: 'part1',
        });

        const started = await startArenaMatch('match-1', {
            offerOptions: { price: 0.1, amount: 1, collateral: 0.3, mode: 'buy' },
        });
        expect(createOfferFromStrategySignalMock).toHaveBeenCalledWith(
            'signal-1',
            'maker-wallet',
            { price: 0.1, amount: 1, collateral: 0.3, mode: 'buy' }
        );
        expect(started).toMatchObject({
            match: {
                offerId: 'offer-1',
                status: 'offer_created',
            },
            bridge: {
                created: true,
            },
        });

        const attached = await attachArenaTicket('match-1', {
            ticketId: 'ticket-1',
            escrowPda: 'EscrowPda111111111111111111111111111111111',
            buyerDepositLamports: '400000000',
            sellerDepositLamports: '300000000',
            buyerDepositTx: 'buyer-deposit-tx',
            sellerDepositTx: 'seller-deposit-tx',
        });
        expect(attached).toMatchObject({
            match: {
                ticketId: 'ticket-1',
                offerId: 'offer-1',
                escrowPda: 'EscrowPda111111111111111111111111111111111',
                buyerWallet: 'taker-wallet',
                sellerWallet: 'maker-wallet',
                status: 'escrow_attached',
                buyerDepositLamports: '400000000',
                sellerDepositLamports: '300000000',
            },
            ticket: {
                id: 'ticket-1',
                rollupMode: 'NONE',
            },
        });

        const settled = await settleArenaMatch('match-1', {
            outcomeId: 'outcome-1',
            releaseTx: 'release-tx-signature',
        });
        expect(settled).toMatchObject({
            match: {
                outcomeId: 'outcome-1',
                outcomeWinner: 'part1',
                winnerWallet: 'maker-wallet',
                settlementAction: 'release_to_seller',
                settlementStatus: 'tx_recorded',
                releaseTx: 'release-tx-signature',
                status: 'settled',
            },
            decision: {
                makerWins: true,
                winnerWallet: 'maker-wallet',
                settlementAction: 'release_to_seller',
            },
        });

        const proof = await getArenaMatchProof('match-1');
        expect(proof).toMatchObject({
            completeness: {
                hasFixture: true,
                hasSignal: true,
                hasOffer: true,
                hasTicket: true,
                hasEscrow: true,
                buyerDepositConfirmed: true,
                sellerDepositConfirmed: true,
                hasOutcome: true,
                settlementRecorded: true,
                terminal: true,
            },
            links: {
                signal: { id: 'signal-1' },
                offer: { id: 'offer-1' },
                ticket: { id: 'ticket-1' },
                outcome: { id: 'outcome-1', winner: 'part1' },
            },
        });
        expect((proof.stages as any[]).map((stage) => stage.stage)).toEqual([
            'txline_signal',
            'air_otc_offer',
            'ticket',
            'escrow',
            'deposits',
            'txline_outcome',
            'settlement',
        ]);
    });

    it('records a taker refund decision when the maker signal loses', async () => {
        const { createArenaMatch, settleArenaMatch } = await import('../src/services/arena/arenaMatch.service');
        const losingOutcome = stored({
            id: 'outcome-2',
            fixtureId: 'fixture-1',
            status: 'finished',
            homeScore: 0,
            awayScore: 1,
            winner: 'part2',
            source: 'txline',
            sourceTimestamp: new Date('2026-07-01T11:00:00.000Z'),
            settledAt: new Date('2026-07-01T11:00:00.000Z'),
            raw: {},
        });
        outcomeRowsById.set(losingOutcome.id, losingOutcome);

        await createArenaMatch({
            signalId: 'signal-1',
            makerWallet: 'maker-wallet',
            takerWallet: 'taker-wallet',
        });
        const settled = await settleArenaMatch('match-1', {
            outcomeId: 'outcome-2',
            refundTx: 'refund-tx-signature',
        });

        expect(settled).toMatchObject({
            decision: {
                makerWins: false,
                winnerWallet: 'taker-wallet',
                settlementAction: 'refund_to_taker',
                settlementStatus: 'tx_recorded',
            },
            match: {
                refundTx: 'refund-tx-signature',
                status: 'settled',
            },
        });
    });

    it('settles SPORT matches from stored TxLINE outcomes', async () => {
        const { createSportMatchForOffer, runSportSettlement } = await import('../src/services/arena/sportSettlementEngine');
        const { getArenaSettlementStatusByTicket } = await import('../src/services/arena/arenaMatch.service');

        const created = await createSportMatchForOffer({
            offerId: 'offer-sport-1',
            fixtureId: 'fixture-1',
            makerWallet: 'maker-wallet',
            mode: 'buy',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
        });
        expect(created).toMatchObject({
            id: 'match-1',
            fixtureId: 'fixture-1',
            offerId: 'offer-sport-1',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
            direction: 'BUY_SELECTION',
            rollupMode: 'SPORT',
            status: 'offer_created',
        });

        matchRows.get('match-1')!.takerWallet = 'taker-wallet';
        const result = await runSportSettlement({
            fixtureId: 'fixture-1',
            releaseTx: 'sport-release-tx',
        });

        expect(result).toMatchObject({
            mode: 'SPORT',
            scanned: 1,
            settledCount: 1,
            skippedCount: 0,
            settled: [
                {
                    match: {
                        id: 'match-1',
                        outcomeId: 'outcome-1',
                        outcomeWinner: 'part1',
                        winnerWallet: 'maker-wallet',
                        settlementAction: 'release_to_maker',
                        settlementStatus: 'tx_recorded',
                        releaseTx: 'sport-release-tx',
                        status: 'released',
                    },
                    decision: {
                        makerWins: true,
                        winnerWallet: 'maker-wallet',
                        settlementAction: 'release_to_maker',
                    },
                },
            ],
        });
        expect(prismaMock.arenaMatch.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    rollupMode: 'SPORT',
                    fixtureId: 'fixture-1',
                }),
            })
        );
    });

    it('executes SPORT escrow settlement through the middleman bridge when a ticket is attached', async () => {
        const { createSportMatchForOffer, runSportSettlement } = await import('../src/services/arena/sportSettlementEngine');
        const { getArenaSettlementStatusByTicket } = await import('../src/services/arena/arenaMatch.service');

        await createSportMatchForOffer({
            offerId: 'offer-sport-1',
            fixtureId: 'fixture-1',
            makerWallet: 'maker-wallet',
            mode: 'buy',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
        });
        Object.assign(matchRows.get('match-1')!, {
            ticketId: 'ticket-1',
            takerWallet: 'taker-wallet',
            status: 'escrow_attached',
        });
        middlemanForwarderMock.forwardSportSettlement.mockResolvedValueOnce({
            success: true,
            tx: 'bridge-release-tx',
            onChainAction: 'release_funds',
            status: 'completed',
        });

        const result = await runSportSettlement({ fixtureId: 'fixture-1' });

        expect(middlemanForwarderMock.forwardSportSettlement).toHaveBeenCalledWith({
            ticketId: 'ticket-1',
            settlementAction: 'release_to_maker',
            matchId: 'match-1',
            fixtureId: 'fixture-1',
            outcomeWinner: 'part1',
            winnerWallet: 'maker-wallet',
        });
        expect(result).toMatchObject({
            mode: 'SPORT',
            settledCount: 1,
            settled: [
                {
                    match: {
                        id: 'match-1',
                        releaseTx: 'bridge-release-tx',
                        settlementAction: 'release_to_maker',
                        settlementStatus: 'tx_recorded',
                        status: 'released',
                    },
                },
            ],
        });

        await expect(getArenaSettlementStatusByTicket('ticket-1')).resolves.toMatchObject({
            ticketId: 'ticket-1',
            matchId: 'match-1',
            fixtureId: 'fixture-1',
            rollupMode: 'SPORT',
            status: 'released',
            outcomeStatus: {
                final: true,
                winner: 'part1',
            },
            settlement: {
                terminal: true,
                action: 'release_to_maker',
                status: 'tx_recorded',
                releaseTx: 'bridge-release-tx',
            },
            proof: {
                completeness: {
                    hasTicket: true,
                    hasOutcome: true,
                    settlementRecorded: true,
                    terminal: true,
                },
            },
        });
    });

    it('hydrates SPORT deposit status from middleman payment lock', async () => {
        const { createSportMatchForOffer } = await import('../src/services/arena/sportSettlementEngine');
        const { getArenaSettlementStatusByTicket } = await import('../src/services/arena/arenaMatch.service');

        await createSportMatchForOffer({
            offerId: 'offer-sport-1',
            fixtureId: 'fixture-1',
            makerWallet: 'maker-wallet',
            mode: 'buy',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
            proof: { makerSide: 'back', stakeLamports: '1000000' },
        });
        Object.assign(matchRows.get('match-1')!, {
            ticketId: 'ticket-1',
            takerWallet: 'taker-wallet',
            buyerWallet: 'maker-wallet',
            sellerWallet: 'taker-wallet',
            escrowPda: 'sport-escrow-pda',
            rollupMode: 'SPORT',
            status: 'escrow_attached',
            stakeLamports: '1000000',
        });
        middlemanForwarderMock.getDealStatus.mockResolvedValueOnce({
            success: true,
            deal: {
                ticketId: 'ticket-1',
                phase: 'awaiting_result',
                payment_locked: true,
                terms: {
                    price: 0.001,
                    collateral_buyer: 0.000000001,
                    collateral_seller: 0.001,
                    asset_type: 'SOL',
                },
            },
        });

        await expect(getArenaSettlementStatusByTicket('ticket-1')).resolves.toMatchObject({
            ticketId: 'ticket-1',
            status: 'awaiting_result',
            depositStatus: {
                escrowPda: 'sport-escrow-pda',
                buyerDepositConfirmed: true,
                sellerDepositConfirmed: true,
                fullyFunded: true,
            },
            proof: {
                completeness: {
                    buyerDepositConfirmed: true,
                    sellerDepositConfirmed: true,
                },
                stages: [
                    expect.any(Object),
                    expect.any(Object),
                    expect.any(Object),
                    expect.any(Object),
                    expect.objectContaining({
                        stage: 'deposits',
                        complete: true,
                        buyer: true,
                        seller: true,
                    }),
                    expect.any(Object),
                    expect.any(Object),
                ],
            },
        });
        expect(matchRows.get('match-1')).toMatchObject({
            status: 'awaiting_result',
            buyerDepositLamports: '1000001',
            sellerDepositLamports: '1000000',
        });
    });

    it('terminalizes SPORT matches with an already recorded release tx without retrying the middleman bridge', async () => {
        const { createSportMatchForOffer, runSportSettlement } = await import('../src/services/arena/sportSettlementEngine');
        const { getArenaSettlementStatusByTicket } = await import('../src/services/arena/arenaMatch.service');

        await createSportMatchForOffer({
            offerId: 'offer-sport-1',
            fixtureId: 'fixture-1',
            makerWallet: 'maker-wallet',
            mode: 'buy',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
        });
        Object.assign(matchRows.get('match-1')!, {
            ticketId: 'ticket-1',
            takerWallet: 'taker-wallet',
            status: 'escrow_attached',
            settlementAction: 'release_to_maker',
            settlementStatus: 'tx_recorded',
            releaseTx: 'already-recorded-release-tx',
            settledAt: new Date('2026-07-01T11:01:00.000Z'),
        });

        const result = await runSportSettlement({ fixtureId: 'fixture-1' });

        expect(middlemanForwarderMock.forwardSportSettlement).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            mode: 'SPORT',
            settledCount: 1,
            skippedCount: 0,
            settled: [
                {
                    match: {
                        id: 'match-1',
                        releaseTx: 'already-recorded-release-tx',
                        settlementAction: 'release_to_maker',
                        settlementStatus: 'tx_recorded',
                        status: 'released',
                    },
                    decision: {
                        makerWins: true,
                        winnerWallet: 'maker-wallet',
                        settlementAction: 'release_to_maker',
                    },
                },
            ],
        });

        await expect(getArenaSettlementStatusByTicket('ticket-1')).resolves.toMatchObject({
            status: 'released',
            settlement: {
                terminal: true,
                action: 'release_to_maker',
                status: 'tx_recorded',
                releaseTx: 'already-recorded-release-tx',
            },
        });
    });

    it('executes SPORT escrow refund through the middleman bridge when the maker selection loses', async () => {
        const { createSportMatchForOffer, runSportSettlement } = await import('../src/services/arena/sportSettlementEngine');

        const losingOutcome = stored({
            id: 'outcome-losing-1',
            fixtureId: 'fixture-1',
            status: 'finished',
            homeScore: 0,
            awayScore: 1,
            winner: 'part2',
            source: 'txline',
            sourceUpdateId: 'score-final-away',
            sourceTimestamp: new Date('2026-07-01T11:00:00.000Z'),
            settledAt: new Date('2026-07-01T11:00:00.000Z'),
            raw: { GameState: 'finished' },
        });
        outcomeRowsById.set(losingOutcome.id, losingOutcome);
        outcomeRowsByFixture.set(losingOutcome.fixtureId, losingOutcome);

        await createSportMatchForOffer({
            offerId: 'offer-sport-1',
            fixtureId: 'fixture-1',
            makerWallet: 'maker-wallet',
            mode: 'buy',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
        });
        Object.assign(matchRows.get('match-1')!, {
            ticketId: 'ticket-1',
            takerWallet: 'taker-wallet',
            status: 'escrow_attached',
        });
        middlemanForwarderMock.forwardSportSettlement.mockResolvedValueOnce({
            success: true,
            tx: 'bridge-refund-tx',
            onChainAction: 'settle_to_buyer',
            status: 'completed',
        });

        const result = await runSportSettlement({ fixtureId: 'fixture-1' });

        expect(middlemanForwarderMock.forwardSportSettlement).toHaveBeenCalledWith({
            ticketId: 'ticket-1',
            settlementAction: 'refund_to_taker',
            matchId: 'match-1',
            fixtureId: 'fixture-1',
            outcomeWinner: 'part2',
            winnerWallet: 'taker-wallet',
        });
        expect(result).toMatchObject({
            mode: 'SPORT',
            settledCount: 1,
            settled: [
                {
                    match: {
                        id: 'match-1',
                        refundTx: 'bridge-refund-tx',
                        winnerWallet: 'taker-wallet',
                        settlementAction: 'refund_to_taker',
                        settlementStatus: 'tx_recorded',
                        status: 'refunded',
                    },
                    decision: {
                        makerWins: false,
                        winnerWallet: 'taker-wallet',
                        settlementAction: 'refund_to_taker',
                    },
                },
            ],
        });
    });

    it('routes a winning back position to the buyer payout instruction', async () => {
        const { runSportSettlement } = await import('../src/services/arena/sportSettlementEngine');

        matchRows.set('match-position-back', stored({
            id: 'match-position-back',
            fixtureId: 'fixture-1',
            offerId: 'offer-position-back',
            ticketId: 'ticket-1',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
            direction: 'BUY_SELECTION',
            makerSide: 'back',
            makerWallet: 'maker-wallet',
            takerWallet: 'taker-wallet',
            buyerWallet: 'maker-wallet',
            sellerWallet: 'taker-wallet',
            rollupMode: 'SPORT',
            status: 'escrow_attached',
            proof: {},
        }));
        middlemanForwarderMock.forwardSportSettlement.mockResolvedValueOnce({
            success: true,
            tx: 'bridge-buyer-payout-tx',
            onChainAction: 'settle_to_buyer',
            status: 'refunded',
        });

        const result = await runSportSettlement({ matchId: 'match-position-back' });

        expect(middlemanForwarderMock.forwardSportSettlement).toHaveBeenCalledWith({
            ticketId: 'ticket-1',
            settlementAction: 'release_to_buyer',
            matchId: 'match-position-back',
            fixtureId: 'fixture-1',
            outcomeWinner: 'part1',
            winnerWallet: 'maker-wallet',
        });
        expect(result).toMatchObject({
            settledCount: 1,
            settled: [
                {
                    match: {
                        id: 'match-position-back',
                        refundTx: 'bridge-buyer-payout-tx',
                        winnerWallet: 'maker-wallet',
                        settlementAction: 'release_to_buyer',
                        status: 'refunded',
                    },
                },
            ],
        });
        expect(webhooksMock.dealCompleted).toHaveBeenCalledWith(
            'ticket-1',
            'maker-wallet',
            'taker-wallet',
            expect.objectContaining({
                mode: 'SPORT',
                matchId: 'match-position-back',
                fixtureId: 'fixture-1',
                outcomeWinner: 'part1',
                winnerWallet: 'maker-wallet',
                settlementAction: 'release_to_buyer',
            })
        );
        expect(webhooksMock.dealRefunded).not.toHaveBeenCalled();
    });

    it('void-refunds complement-backed part1 vs part2 matches when TxLINE outcome is draw', async () => {
        const { runSportSettlement } = await import('../src/services/arena/sportSettlementEngine');

        const drawOutcome = stored({
            id: 'outcome-draw-1',
            fixtureId: 'fixture-1',
            status: 'finished',
            homeScore: 1,
            awayScore: 1,
            winner: 'draw',
            source: 'txline',
            sourceUpdateId: 'score-final-draw',
            sourceTimestamp: new Date('2026-07-01T11:00:00.000Z'),
            settledAt: new Date('2026-07-01T11:00:00.000Z'),
            raw: { GameState: 'finished' },
        });
        outcomeRowsById.set(drawOutcome.id, drawOutcome);
        outcomeRowsByFixture.set(drawOutcome.fixtureId, drawOutcome);
        matchRows.set('match-complement-draw', stored({
            id: 'match-complement-draw',
            fixtureId: 'fixture-1',
            offerId: 'offer-complement-draw',
            ticketId: 'ticket-1',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
            direction: 'BUY_SELECTION',
            makerSide: 'back',
            makerWallet: 'maker-wallet',
            takerWallet: 'taker-wallet',
            buyerWallet: 'maker-wallet',
            sellerWallet: 'taker-wallet',
            rollupMode: 'SPORT',
            status: 'escrow_attached',
            proof: {
                marketModel: 'complement_back_draw_refund',
                matchKind: 'complement_back_back',
                makerSelection: 'part1',
                takerSelection: 'part2',
                drawPolicy: 'void_refund',
            },
        }));
        middlemanForwarderMock.forwardSportSettlement.mockResolvedValueOnce({
            success: true,
            tx: 'bridge-void-refund-tx',
            onChainAction: 'cancel_deal',
            status: 'cancelled',
        });

        const result = await runSportSettlement({ matchId: 'match-complement-draw' });

        expect(middlemanForwarderMock.forwardSportSettlement).toHaveBeenCalledWith({
            ticketId: 'ticket-1',
            settlementAction: 'void_refund',
            matchId: 'match-complement-draw',
            fixtureId: 'fixture-1',
            outcomeWinner: 'draw',
            winnerWallet: null,
        });
        expect(result).toMatchObject({
            settledCount: 1,
            settled: [
                {
                    match: {
                        id: 'match-complement-draw',
                        refundTx: 'bridge-void-refund-tx',
                        settlementAction: 'void_refund',
                        settlementStatus: 'tx_recorded',
                        status: 'refunded',
                    },
                    decision: {
                        makerWins: null,
                        winnerWallet: null,
                        settlementAction: 'void_refund',
                    },
                },
            ],
        });
        expect(result.settled[0].match.winnerWallet).toBeUndefined();
        expect(result.settled[0].match.proof).toMatchObject({
            drawPolicy: 'void_refund',
            makerWins: null,
            winnerWallet: null,
        });
        expect(webhooksMock.dealCompleted).toHaveBeenCalledWith(
            'ticket-1',
            'maker-wallet',
            'taker-wallet',
            expect.objectContaining({
                mode: 'SPORT',
                matchId: 'match-complement-draw',
                fixtureId: 'fixture-1',
                outcomeWinner: 'draw',
                winnerWallet: null,
                settlementAction: 'void_refund',
            })
        );
        expect(webhooksMock.dealRefunded).toHaveBeenCalledWith('ticket-1', 'maker-wallet', 'taker-wallet');
    });

    it('routes a winning lay position to the seller payout instruction', async () => {
        const { runSportSettlement } = await import('../src/services/arena/sportSettlementEngine');

        const losingSelectionOutcome = stored({
            id: 'outcome-lay-1',
            fixtureId: 'fixture-1',
            status: 'finished',
            homeScore: 0,
            awayScore: 1,
            winner: 'part2',
            source: 'txline',
            sourceUpdateId: 'score-final-away-lay',
            sourceTimestamp: new Date('2026-07-01T11:00:00.000Z'),
            settledAt: new Date('2026-07-01T11:00:00.000Z'),
            raw: { GameState: 'finished' },
        });
        outcomeRowsById.set(losingSelectionOutcome.id, losingSelectionOutcome);
        outcomeRowsByFixture.set(losingSelectionOutcome.fixtureId, losingSelectionOutcome);

        matchRows.set('match-position-lay', stored({
            id: 'match-position-lay',
            fixtureId: 'fixture-1',
            offerId: 'offer-position-lay',
            ticketId: 'ticket-1',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
            direction: 'SELL_SELECTION',
            makerSide: 'lay',
            makerWallet: 'maker-wallet',
            takerWallet: 'taker-wallet',
            buyerWallet: 'taker-wallet',
            sellerWallet: 'maker-wallet',
            rollupMode: 'SPORT',
            status: 'escrow_attached',
            proof: {},
        }));
        middlemanForwarderMock.forwardSportSettlement.mockResolvedValueOnce({
            success: true,
            tx: 'bridge-seller-payout-tx',
            onChainAction: 'release_funds',
            status: 'completed',
        });

        const result = await runSportSettlement({ matchId: 'match-position-lay' });

        expect(middlemanForwarderMock.forwardSportSettlement).toHaveBeenCalledWith({
            ticketId: 'ticket-1',
            settlementAction: 'release_to_seller',
            matchId: 'match-position-lay',
            fixtureId: 'fixture-1',
            outcomeWinner: 'part2',
            winnerWallet: 'maker-wallet',
        });
        expect(result).toMatchObject({
            settledCount: 1,
            settled: [
                {
                    match: {
                        id: 'match-position-lay',
                        releaseTx: 'bridge-seller-payout-tx',
                        winnerWallet: 'maker-wallet',
                        settlementAction: 'release_to_seller',
                        status: 'released',
                    },
                },
            ],
        });
    });

    it('skips SPORT settlement safely when no final TxLINE outcome is available', async () => {
        const { createSportMatchForOffer, runSportSettlement } = await import('../src/services/arena/sportSettlementEngine');

        outcomeRowsById.clear();
        outcomeRowsByFixture.clear();

        await createSportMatchForOffer({
            offerId: 'offer-sport-1',
            fixtureId: 'fixture-1',
            makerWallet: 'maker-wallet',
            mode: 'buy',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
        });
        Object.assign(matchRows.get('match-1')!, {
            ticketId: 'ticket-1',
            takerWallet: 'taker-wallet',
            status: 'escrow_attached',
        });

        const result = await runSportSettlement({
            fixtureId: 'fixture-1',
            liveSync: false,
        });

        expect(middlemanForwarderMock.forwardSportSettlement).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            mode: 'SPORT',
            scanned: 1,
            settledCount: 0,
            skippedCount: 1,
            skipped: [
                {
                    matchId: 'match-1',
                    fixtureId: 'fixture-1',
                    reason: 'txline_outcome_not_found_or_not_final',
                },
            ],
        });
    });

    it('skips SPORT escrow execution when the only stored outcome is from an untrusted fallback source', async () => {
        const { createSportMatchForOffer, runSportSettlement } = await import('../src/services/arena/sportSettlementEngine');

        const fallbackOutcome = stored({
            id: 'outcome-fallback-1',
            fixtureId: 'fixture-1',
            status: 'finished',
            homeScore: 9,
            awayScore: 0,
            winner: 'part1',
            source: 'espn_scoreboard_fallback',
            sourceUpdateId: 'fallback-final',
            sourceTimestamp: new Date('2026-07-01T11:00:00.000Z'),
            settledAt: new Date('2026-07-01T11:00:00.000Z'),
            raw: { GameState: 'finished' },
        });
        outcomeRowsById.clear();
        outcomeRowsByFixture.clear();
        outcomeRowsById.set(fallbackOutcome.id, fallbackOutcome);
        outcomeRowsByFixture.set(fallbackOutcome.fixtureId, fallbackOutcome);

        await createSportMatchForOffer({
            offerId: 'offer-sport-1',
            fixtureId: 'fixture-1',
            makerWallet: 'maker-wallet',
            mode: 'buy',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
        });
        Object.assign(matchRows.get('match-1')!, {
            ticketId: 'ticket-1',
            takerWallet: 'taker-wallet',
            status: 'escrow_attached',
        });

        const result = await runSportSettlement({
            fixtureId: 'fixture-1',
            liveSync: false,
        });

        expect(middlemanForwarderMock.forwardSportSettlement).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            mode: 'SPORT',
            scanned: 1,
            settledCount: 0,
            skippedCount: 1,
            skipped: [
                {
                    matchId: 'match-1',
                    fixtureId: 'fixture-1',
                    reason: 'txline_outcome_source_not_trusted',
                    outcomeSource: 'espn_scoreboard_fallback',
                },
            ],
        });
    });

    it('ignores legacy smoke and non-TxLINE SPORT rows in the default settlement sweep', async () => {
        const { runSportSettlement } = await import('../src/services/arena/sportSettlementEngine');

        fixtureRows.set('espn:wnba:401857034', stored({
            id: 'fixture-fallback-wnba',
            fixtureId: 'espn:wnba:401857034',
            sport: 'basketball',
            homeTeam: 'Fallback Home',
            awayTeam: 'Fallback Away',
            startsAt: new Date('2026-07-01T11:00:00.000Z'),
            status: 'final',
            raw: { source: 'espn_scoreboard_fallback' },
        }));
        matchRows.set('match-stale-smoke', stored({
            id: 'match-stale-smoke',
            fixtureId: 'hosted-smoke-1782991171664',
            offerId: 'offer-stale-smoke',
            makerWallet: 'maker-wallet',
            takerWallet: 'taker-wallet',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
            direction: 'BUY_SELECTION',
            rollupMode: 'SPORT',
            status: 'escrow_attached',
            proof: {},
        }));
        matchRows.set('match-stale-espn', stored({
            id: 'match-stale-espn',
            fixtureId: 'espn:wnba:401857034',
            offerId: 'offer-stale-espn',
            makerWallet: 'maker-wallet',
            takerWallet: 'taker-wallet',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
            direction: 'BUY_SELECTION',
            rollupMode: 'SPORT',
            status: 'escrow_attached',
            proof: {},
        }));

        const result = await runSportSettlement({ liveSync: false });

        expect(middlemanForwarderMock.forwardSportSettlement).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            mode: 'SPORT',
            scanned: 0,
            settledCount: 0,
            skippedCount: 0,
            ignoredLegacyCount: 2,
            ignoredLegacy: expect.arrayContaining([
                expect.objectContaining({
                    matchId: 'match-stale-smoke',
                    fixtureId: 'hosted-smoke-1782991171664',
                    reason: 'non_txline_sport_fixture_ignored',
                }),
                expect.objectContaining({
                    matchId: 'match-stale-espn',
                    fixtureId: 'espn:wnba:401857034',
                    reason: 'non_txline_sport_fixture_ignored',
                    fixtureSource: 'espn_scoreboard_fallback',
                }),
            ]),
        });
    });

    it('refreshes a final TxLINE score into an outcome before SPORT settlement', async () => {
        const { createSportMatchForOffer, runSportSettlement } = await import('../src/services/arena/sportSettlementEngine');

        outcomeRowsById.clear();
        outcomeRowsByFixture.clear();
        scoreRows.push(stored({
            id: 'score-final-1',
            fixtureId: 'fixture-1',
            homeScore: 2,
            awayScore: 1,
            status: 'finished',
            source: 'txline',
            sourceUpdateId: 'score-final-refresh',
            sourceTimestamp: new Date('2026-07-01T11:00:00.000Z'),
            raw: { GameState: 'finished' },
        }));

        await createSportMatchForOffer({
            offerId: 'offer-sport-1',
            fixtureId: 'fixture-1',
            makerWallet: 'maker-wallet',
            mode: 'buy',
            marketType: '1X2_PARTICIPANT_RESULT',
            selection: 'part1',
        });
        matchRows.get('match-1')!.takerWallet = 'taker-wallet';

        const result = await runSportSettlement({
            fixtureId: 'fixture-1',
            releaseTx: 'sport-release-tx',
            liveSync: false,
        });

        expect(prismaMock.arenaOutcome.upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { fixtureId: 'fixture-1' },
        }));
        expect(result).toMatchObject({
            mode: 'SPORT',
            scanned: 1,
            settledCount: 1,
            refreshOutcomes: true,
            liveSync: false,
            outcomeRefreshes: [
                {
                    fixtureId: 'fixture-1',
                    refreshed: true,
                },
            ],
            settled: [
                {
                    match: {
                        id: 'match-1',
                        outcomeWinner: 'part1',
                        releaseTx: 'sport-release-tx',
                        status: 'released',
                    },
                },
            ],
        });
    });
});
