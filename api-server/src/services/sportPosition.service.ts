import { Prisma } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { middlemanForwarder } from './middlemanForwarder';
import { attachSportTicketByOffer } from './arena/sportSettlementEngine';
import { serializeArenaMatch } from './arena/arenaMatch.service';
import { webhooks } from './webhookDelivery';

const prismaAny = prisma as any;
const SPORT_MARKET_TYPE = '1X2_PARTICIPANT_RESULT';
const LAMPORTS_PER_SOL = 1_000_000_000n;
const DEFAULT_POSITION_ACCEPT_BUFFER_SECONDS = 60;

type SportSide = 'back' | 'lay';
type SportSelection = 'part1' | 'draw' | 'part2';
type SportPositionStatus = 'open' | 'matched' | 'expired' | 'cancelled' | 'all';

interface MatchArtifacts {
    position: any;
    counterpartyPosition: any;
    offer: any;
    ticket: any;
    arenaMatch: any;
    createdByDirectAccept?: boolean;
}

interface MiddlemanAttachResult {
    arenaMatch?: Record<string, unknown> | null;
    sportEscrow?: Record<string, unknown> | null;
}

function httpError(message: string, statusCode = 400): Error {
    return Object.assign(new Error(message), { statusCode });
}

function trimString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function validateWallet(value: unknown): string {
    const wallet = trimString(value);
    if (!wallet) throw httpError('wallet_required', 401);
    try {
        new PublicKey(wallet);
    } catch {
        throw httpError('invalid_wallet', 400);
    }
    return wallet;
}

function normalizeSelection(value: unknown): SportSelection {
    const selection = trimString(value)?.toLowerCase();
    if (selection === 'part1' || selection === 'draw' || selection === 'part2') {
        return selection;
    }
    throw httpError('sport_selection_must_be_part1_draw_or_part2', 400);
}

function normalizeSide(value: unknown): SportSide {
    const side = trimString(value)?.toLowerCase() || 'back';
    if (side === 'back' || side === 'lay') return side;
    throw httpError('sport_side_must_be_back_or_lay', 400);
}

function normalizePositionStatus(value: unknown, fallback: SportPositionStatus): SportPositionStatus {
    const status = trimString(value)?.toLowerCase() || fallback;
    if (status === 'open' || status === 'matched' || status === 'expired' || status === 'cancelled' || status === 'all') {
        return status;
    }
    throw httpError('sport_position_status_invalid', 400);
}

function oppositeSide(side: SportSide): SportSide {
    return side === 'back' ? 'lay' : 'back';
}

function sideToDirection(side: SportSide): 'BUY_SELECTION' | 'SELL_SELECTION' {
    return side === 'back' ? 'BUY_SELECTION' : 'SELL_SELECTION';
}

function sideToOfferMode(side: SportSide): 'buy' | 'sell' {
    return side === 'back' ? 'buy' : 'sell';
}

function positionAsset(fixtureId: string, selection: string): string {
    return `TXLINE:${fixtureId}:${SPORT_MARKET_TYPE}:${selection}`;
}

function normalizeClientOrderId(value: unknown): string | null {
    const clientOrderId = trimString(value);
    if (!clientOrderId) return null;
    if (clientOrderId.length > 128) throw httpError('clientOrderId_too_long', 400);
    return clientOrderId;
}

function solToLamports(value: unknown): bigint {
    const raw = typeof value === 'number' ? value.toString() : trimString(value);
    if (!raw || !/^\d+(\.\d{1,9})?$/.test(raw)) {
        throw httpError('stakeSol_must_have_at_most_9_decimals', 400);
    }
    const [whole, fraction = ''] = raw.split('.');
    return (BigInt(whole) * LAMPORTS_PER_SOL) + BigInt(fraction.padEnd(9, '0'));
}

function lamportsToSolNumber(lamports: string | bigint): number {
    return Number(typeof lamports === 'bigint' ? lamports : BigInt(lamports)) / Number(LAMPORTS_PER_SOL);
}

function stakeBounds(): { min: bigint; max: bigint } {
    const min = solToLamports(process.env.SPORT_POSITION_MIN_SOL || '0.001');
    const max = solToLamports(process.env.SPORT_POSITION_MAX_SOL || '10');
    return { min, max };
}

function validateStake(value: unknown): string {
    const lamports = solToLamports(value);
    const { min, max } = stakeBounds();
    if (lamports < min) throw httpError('stakeSol_below_minimum', 400);
    if (lamports > max) throw httpError('stakeSol_above_maximum', 400);
    return lamports.toString();
}

function kickoffBufferMs(): number {
    const seconds = Number(process.env.SPORT_POSITION_ACCEPT_BUFFER_SECONDS || DEFAULT_POSITION_ACCEPT_BUFFER_SECONDS);
    return Math.max(0, Number.isFinite(seconds) ? seconds : DEFAULT_POSITION_ACCEPT_BUFFER_SECONDS) * 1000;
}

function fixtureSource(fixture: any): string {
    return String(asRecord(fixture?.raw).source || '').trim().toLowerCase();
}

function isNumericFixtureId(value: string): boolean {
    return /^\d+$/.test(value);
}

async function requireOpenTxlineFixture(fixtureId: string, now = new Date()): Promise<any> {
    const fixture = await prismaAny.arenaFixture.findUnique({ where: { fixtureId } });
    if (!fixture) throw httpError('sport_fixture_not_found', 404);
    const source = fixtureSource(fixture);
    if (source && source !== 'txline') throw httpError('sport_fixture_must_be_txline_source', 400);
    if (!source && !isNumericFixtureId(fixtureId)) throw httpError('sport_fixture_must_be_txline_source', 400);
    if (fixture.status !== 'upcoming') throw httpError('sport_fixture_not_open_for_positions', 409);
    if (!fixture.startsAt) throw httpError('sport_fixture_missing_start_time', 409);
    const cutoff = new Date(fixture.startsAt).getTime() - kickoffBufferMs();
    if (now.getTime() >= cutoff) throw httpError('sport_fixture_position_window_closed', 409);
    return fixture;
}

async function expireOpenPositions(tx: any, now = new Date()): Promise<void> {
    await tx.sportPosition.updateMany({
        where: { status: 'open', expiresAt: { lte: now } },
        data: { status: 'expired' },
    });
}

function serializePosition(row: any): Record<string, unknown> {
    if (!row) return {};
    return {
        id: row.id,
        fixtureId: row.fixtureId,
        selection: row.selection,
        side: row.side,
        stakeLamports: row.stakeLamports,
        stakeSol: lamportsToSolNumber(row.stakeLamports),
        agentWallet: row.agentWallet,
        status: row.status,
        matchedPositionId: row.matchedPositionId || null,
        matchId: row.matchId || null,
        offerId: row.offerId || null,
        ticketId: row.ticketId || null,
        expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt,
        clientOrderId: row.clientOrderId || null,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    };
}

function serializeTicket(ticket: any): Record<string, unknown> | null {
    if (!ticket) return null;
    return {
        id: ticket.id,
        offerId: ticket.offerId,
        buyer: ticket.buyer,
        seller: ticket.seller,
        status: ticket.status,
        rollupMode: ticket.rollupMode,
        createdAt: ticket.createdAt instanceof Date ? ticket.createdAt.toISOString() : ticket.createdAt,
    };
}

function matchedResponse(artifacts: MatchArtifacts, attach: MiddlemanAttachResult = {}): Record<string, unknown> {
    return {
        matched: true,
        position: serializePosition(artifacts.position),
        counterpartyPosition: serializePosition(artifacts.counterpartyPosition),
        offer: {
            id: artifacts.offer.id,
            asset: artifacts.offer.asset,
            price: artifacts.offer.price,
            amount: artifacts.offer.amount,
            rollupMode: artifacts.offer.rollupMode,
            fixtureId: artifacts.offer.fixtureId,
            marketType: artifacts.offer.marketType,
            selection: artifacts.offer.selection,
            status: artifacts.offer.status,
        },
        ticket: serializeTicket(artifacts.ticket),
        ticketId: artifacts.ticket.id,
        arenaMatch: attach.arenaMatch || serializeArenaMatch(artifacts.arenaMatch),
        sportEscrow: attach.sportEscrow || null,
    };
}

async function createMatchedArtifacts(tx: any, params: {
    makerPosition: any;
    takerPosition: any;
    fixture: any;
}): Promise<MatchArtifacts> {
    const maker = params.makerPosition;
    const taker = params.takerPosition;
    const makerSide = maker.side as SportSide;
    const mode = sideToOfferMode(makerSide);
    const stakeSol = lamportsToSolNumber(maker.stakeLamports);
    const makerAgent = await tx.agent.upsert({
        where: { wallet: maker.agentWallet },
        update: {},
        create: { wallet: maker.agentWallet },
    });
    await tx.agent.upsert({
        where: { wallet: taker.agentWallet },
        update: {},
        create: { wallet: taker.agentWallet },
    });

    const offer = await tx.offer.create({
        data: {
            creatorId: makerAgent.id,
            asset: positionAsset(maker.fixtureId, maker.selection),
            price: stakeSol,
            amount: 1,
            mode,
            rollupMode: 'SPORT',
            collateral: 0,
            tokenMint: null,
            tokenDecimals: 9,
            fixtureId: maker.fixtureId,
            marketType: SPORT_MARKET_TYPE,
            selection: maker.selection,
            status: 'matched',
        },
    });
    const buyerWallet = mode === 'buy' ? maker.agentWallet : taker.agentWallet;
    const sellerWallet = mode === 'buy' ? taker.agentWallet : maker.agentWallet;
    const ticket = await tx.ticket.create({
        data: {
            offerId: offer.id,
            buyer: buyerWallet,
            seller: sellerWallet,
            status: 'negotiating',
            rollupMode: 'SPORT',
        },
    });
    const arenaMatch = await tx.arenaMatch.create({
        data: {
            fixtureId: maker.fixtureId,
            offerId: offer.id,
            ticketId: ticket.id,
            marketType: SPORT_MARKET_TYPE,
            selection: maker.selection,
            direction: sideToDirection(makerSide),
            makerPositionId: maker.id,
            takerPositionId: taker.id,
            makerSide,
            stakeLamports: maker.stakeLamports,
            makerWallet: maker.agentWallet,
            takerWallet: taker.agentWallet,
            buyerWallet,
            sellerWallet,
            rollupMode: 'SPORT',
            status: 'ticket_attached',
            startedAt: new Date(),
            proof: jsonValue({
                createdBy: 'sport_position_layer',
                fixtureKnown: Boolean(params.fixture),
                fixtureStartsAt: params.fixture?.startsAt || null,
                settlementSource: 'txline',
                marketModel: 'binary_back_lay',
                makerPositionId: maker.id,
                takerPositionId: taker.id,
                makerSide,
                stakeLamports: maker.stakeLamports,
            }),
        },
    });
    const [position, counterpartyPosition] = await Promise.all([
        tx.sportPosition.update({
            where: { id: taker.id },
            data: {
                status: 'matched',
                matchedPositionId: maker.id,
                matchId: arenaMatch.id,
                offerId: offer.id,
                ticketId: ticket.id,
            },
        }),
        tx.sportPosition.update({
            where: { id: maker.id },
            data: {
                status: 'matched',
                matchedPositionId: taker.id,
                matchId: arenaMatch.id,
                offerId: offer.id,
                ticketId: ticket.id,
            },
        }),
    ]);
    return {
        position,
        counterpartyPosition,
        offer,
        ticket,
        arenaMatch,
    };
}

async function attachEscrowOrCompensate(artifacts: MatchArtifacts): Promise<MiddlemanAttachResult> {
    const result = await middlemanForwarder.forwardOfferAccepted({
        ticketId: artifacts.ticket.id,
        buyerWallet: artifacts.ticket.buyer,
        sellerWallet: artifacts.ticket.seller,
        asset: artifacts.offer.asset,
        price: Number(artifacts.offer.price),
        amount: Number(artifacts.offer.amount),
        collateral: 0,
        tokenMint: null,
        rollupMode: 'SPORT',
    });

    if (!result.success) {
        await prisma.$transaction(async (tx) => {
            await (tx as any).arenaMatch.deleteMany({ where: { id: artifacts.arenaMatch.id } });
            await tx.ticket.deleteMany({ where: { id: artifacts.ticket.id } });
            await tx.offer.deleteMany({ where: { id: artifacts.offer.id } });
            if (artifacts.createdByDirectAccept) {
                await (tx as any).sportPosition.deleteMany({ where: { id: artifacts.position.id } });
            }
            await (tx as any).sportPosition.updateMany({
                where: {
                    id: {
                        in: artifacts.createdByDirectAccept
                            ? [artifacts.counterpartyPosition.id]
                            : [artifacts.position.id, artifacts.counterpartyPosition.id],
                    },
                },
                data: {
                    status: 'open',
                    matchedPositionId: null,
                    matchId: null,
                    offerId: null,
                    ticketId: null,
                },
            });
        });
        throw httpError(result.error || 'sport_middleman_forward_failed', 502);
    }

    const attachResult = await attachSportTicketByOffer({
        offerId: artifacts.offer.id,
        ticketId: artifacts.ticket.id,
        escrowPda: result.dealPda || null,
    });
    const arenaMatch = (attachResult as any).match || attachResult;
    const sportEscrow = {
        mathOnly: true,
        phase: result.phase || null,
        dealPda: result.dealPda || null,
        depositInstructions: result.depositInstructions || null,
        note: 'SPORT position settlement is deterministic: equal stake, no economic collateral, no delivery step, TxLINE final outcome decides payout.',
    };

    webhooks.dealMatched(artifacts.ticket.id, artifacts.ticket.buyer, artifacts.ticket.seller, artifacts.offer)
        .catch((error: any) => {
            logger.warn('sport_position_deal_matched_webhook_failed', {
                ticketId: artifacts.ticket.id,
                error: error?.message,
            });
        });

    return { arenaMatch, sportEscrow };
}

export async function postSportPosition(walletInput: string, input: {
    fixtureId?: unknown;
    selection?: unknown;
    side?: unknown;
    stakeSol?: unknown;
    clientOrderId?: unknown;
}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const fixtureId = trimString(input.fixtureId);
    if (!fixtureId) throw httpError('fixtureId_required', 400);
    const selection = normalizeSelection(input.selection);
    const side = normalizeSide(input.side);
    const stakeLamports = validateStake(input.stakeSol);
    const clientOrderId = normalizeClientOrderId(input.clientOrderId);
    const now = new Date();
    const fixture = await requireOpenTxlineFixture(fixtureId, now);

    const artifacts = await prisma.$transaction(async (tx) => {
        await expireOpenPositions(tx, now);
        if (clientOrderId) {
            const existing = await (tx as any).sportPosition.findUnique({
                where: { agentWallet_clientOrderId: { agentWallet: wallet, clientOrderId } },
            });
            if (existing) return { existing };
        }

        const counterparty = await (tx as any).sportPosition.findFirst({
            where: {
                fixtureId,
                selection,
                stakeLamports,
                side: oppositeSide(side),
                status: 'open',
                expiresAt: { gt: now },
                agentWallet: { not: wallet },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const position = await (tx as any).sportPosition.create({
            data: {
                fixtureId,
                selection,
                side,
                stakeLamports,
                agentWallet: wallet,
                status: 'open',
                expiresAt: fixture.startsAt,
                clientOrderId,
            },
        });
        if (!counterparty) {
            return { position };
        }
        const claimed = await (tx as any).sportPosition.updateMany({
            where: { id: counterparty.id, status: 'open' },
            data: { status: 'matched' },
        });
        if (claimed.count !== 1) {
            return { position };
        }
        return createMatchedArtifacts(tx, {
            makerPosition: counterparty,
            takerPosition: position,
            fixture,
        });
    });

    if ((artifacts as any).existing) {
        const existing = (artifacts as any).existing;
        return {
            matched: existing.status === 'matched',
            idempotent: true,
            position: serializePosition(existing),
            reason: existing.status === 'open' ? 'existing_open_position' : undefined,
        };
    }
    if (!(artifacts as any).ticket) {
        return {
            matched: false,
            status: 'open',
            reason: 'no_equal_stake_counterparty',
            position: serializePosition((artifacts as any).position),
        };
    }

    const attach = await attachEscrowOrCompensate(artifacts as MatchArtifacts);
    return matchedResponse(artifacts as MatchArtifacts, attach);
}

export async function acceptSportPosition(walletInput: string, positionIdInput: unknown, input: {
    clientOrderId?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const positionId = trimString(positionIdInput);
    if (!positionId) throw httpError('position_id_required', 400);
    const clientOrderId = normalizeClientOrderId(input.clientOrderId);
    const now = new Date();

    const artifacts = await prisma.$transaction(async (tx) => {
        await expireOpenPositions(tx, now);
        const makerPosition = await (tx as any).sportPosition.findUnique({ where: { id: positionId } });
        if (!makerPosition) throw httpError('sport_position_not_found', 404);
        if (makerPosition.status !== 'open') throw httpError('position_not_available', 409);
        if (makerPosition.agentWallet === wallet) throw httpError('cannot_accept_own_position', 403);
        const fixture = await (tx as any).arenaFixture.findUnique({ where: { fixtureId: makerPosition.fixtureId } });
        if (!fixture) throw httpError('sport_fixture_not_found', 404);
        await requireOpenTxlineFixture(makerPosition.fixtureId, now);

        const claimed = await (tx as any).sportPosition.updateMany({
            where: { id: makerPosition.id, status: 'open' },
            data: { status: 'matched' },
        });
        if (claimed.count !== 1) throw httpError('position_not_available', 409);

        const takerPosition = await (tx as any).sportPosition.create({
            data: {
                fixtureId: makerPosition.fixtureId,
                selection: makerPosition.selection,
                side: oppositeSide(makerPosition.side as SportSide),
                stakeLamports: makerPosition.stakeLamports,
                agentWallet: wallet,
                status: 'open',
                expiresAt: makerPosition.expiresAt,
                clientOrderId,
            },
        });

        const artifacts = await createMatchedArtifacts(tx, {
            makerPosition,
            takerPosition,
            fixture,
        });
        artifacts.createdByDirectAccept = true;
        return artifacts;
    });

    const attach = await attachEscrowOrCompensate(artifacts as MatchArtifacts);
    return matchedResponse(artifacts as MatchArtifacts, attach);
}

export async function listSportPositions(options: {
    fixtureId?: unknown;
    status?: unknown;
    limit?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const fixtureId = trimString(options.fixtureId);
    const status = normalizePositionStatus(options.status, 'open');
    const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 50), 1), 100);
    const where: Record<string, unknown> = {};
    if (fixtureId) where.fixtureId = fixtureId;
    if (status !== 'all') where.status = status;
    const positions = await prismaAny.sportPosition.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
    });
    return {
        count: positions.length,
        positions: positions.map(serializePosition),
    };
}

export async function listMySportPositions(walletInput: string, options: {
    status?: unknown;
    limit?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const status = normalizePositionStatus(options.status, 'all');
    const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 100), 1), 200);
    const positions = await prismaAny.sportPosition.findMany({
        where: {
            agentWallet: wallet,
            ...(status && status !== 'all' ? { status } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
    });
    return {
        wallet,
        count: positions.length,
        positions: positions.map(serializePosition),
    };
}

export async function listMySportTickets(walletInput: string, options: {
    limit?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 100), 1), 200);
    const matches = await prismaAny.arenaMatch.findMany({
        where: {
            rollupMode: 'SPORT',
            OR: [
                { makerWallet: wallet },
                { takerWallet: wallet },
                { buyerWallet: wallet },
                { sellerWallet: wallet },
            ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
    });
    return {
        wallet,
        count: matches.length,
        tickets: matches.map(serializeArenaMatch),
    };
}
