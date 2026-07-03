import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { createOfferFromStrategySignal } from './strategyOfferBridge';
import { isTrustedOutcomeSource, serializeOutcome } from './outcomeBacktest';
import { serializeStrategySignal } from './strategyEngine';

const prismaAny = prisma as any;

const TERMINAL_MATCH_STATUSES = new Set(['settled', 'released', 'refunded', 'cancelled', 'failed']);

export interface CreateArenaMatchInput {
    fixtureId?: string;
    signalId?: string;
    makerWallet?: string;
    takerWallet?: string;
    buyerWallet?: string;
    sellerWallet?: string;
    rollupMode?: string;
    proof?: Record<string, unknown>;
}

export interface StartArenaMatchInput {
    offerId?: string;
    makerWallet?: string;
    offerOptions?: {
        asset?: string;
        price?: number;
        amount?: number;
        collateral?: number;
        mode?: 'buy' | 'sell';
    };
}

export interface AttachTicketInput {
    ticketId: string;
    offerId?: string;
    escrowPda?: string;
    buyerDepositLamports?: string;
    sellerDepositLamports?: string;
    buyerDepositTx?: string;
    sellerDepositTx?: string;
    buyerDepositedAt?: string;
    sellerDepositedAt?: string;
    status?: string;
    proof?: Record<string, unknown>;
}

export interface SettleArenaMatchInput {
    outcomeId?: string;
    outcomeWinner?: string;
    winnerWallet?: string;
    settlementAction?: string;
    settlementStatus?: string;
    releaseTx?: string;
    refundTx?: string;
    status?: string;
    proof?: Record<string, unknown>;
}

function httpError(message: string, statusCode: number): Error {
    const error = new Error(message);
    (error as any).statusCode = statusCode;
    return error;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function trimString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function dateValue(value: unknown): Date | undefined {
    if (!value) return undefined;
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function mergeProof(existing: unknown, patch: Record<string, unknown>): Prisma.InputJsonValue {
    return jsonValue({
        ...asRecord(existing),
        ...patch,
        updatedAt: new Date().toISOString(),
    });
}

function serializeDate(value: unknown): string | undefined {
    if (!value) return undefined;
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function serializeArenaMatch(row: any): Record<string, unknown> {
    if (!row) return {};
    return {
        id: row.id,
        fixtureId: row.fixtureId,
        signalId: row.signalId || undefined,
        strategy: row.strategy || undefined,
        marketType: row.marketType || undefined,
        selection: row.selection || undefined,
        direction: row.direction || undefined,
        signalConfidence: row.signalConfidence ?? undefined,
        makerWallet: row.makerWallet,
        takerWallet: row.takerWallet || undefined,
        buyerWallet: row.buyerWallet || undefined,
        sellerWallet: row.sellerWallet || undefined,
        offerId: row.offerId || undefined,
        ticketId: row.ticketId || undefined,
        escrowPda: row.escrowPda || undefined,
        rollupMode: row.rollupMode,
        status: row.status,
        buyerDepositLamports: row.buyerDepositLamports || undefined,
        sellerDepositLamports: row.sellerDepositLamports || undefined,
        buyerDepositTx: row.buyerDepositTx || undefined,
        sellerDepositTx: row.sellerDepositTx || undefined,
        buyerDepositedAt: serializeDate(row.buyerDepositedAt),
        sellerDepositedAt: serializeDate(row.sellerDepositedAt),
        outcomeId: row.outcomeId || undefined,
        outcomeWinner: row.outcomeWinner || undefined,
        winnerWallet: row.winnerWallet || undefined,
        settlementAction: row.settlementAction || undefined,
        settlementStatus: row.settlementStatus || undefined,
        releaseTx: row.releaseTx || undefined,
        refundTx: row.refundTx || undefined,
        settledAt: serializeDate(row.settledAt),
        proof: row.proof || {},
        lastError: row.lastError || undefined,
        startedAt: serializeDate(row.startedAt),
        createdAt: serializeDate(row.createdAt),
        updatedAt: serializeDate(row.updatedAt),
    };
}

async function loadSignal(signalId?: string): Promise<any | null> {
    if (!signalId) return null;
    return prismaAny.arenaStrategySignal.findUnique({ where: { id: signalId } });
}

async function requireMatch(matchId: string): Promise<any> {
    const match = await prismaAny.arenaMatch.findUnique({ where: { id: matchId } });
    if (!match) throw httpError('arena_match_not_found', 404);
    return match;
}

export async function createArenaMatch(input: CreateArenaMatchInput): Promise<Record<string, unknown>> {
    const signalId = trimString(input.signalId);
    const signal = await loadSignal(signalId);
    if (signalId && !signal) throw httpError('arena_signal_not_found', 404);

    const fixtureId = trimString(input.fixtureId) || signal?.fixtureId;
    const makerWallet = trimString(input.makerWallet);
    if (!fixtureId) throw httpError('arena_fixture_id_or_signal_required', 400);
    if (!makerWallet) throw httpError('arena_maker_wallet_required', 400);
    if (signal && input.fixtureId && input.fixtureId !== signal.fixtureId) {
        throw httpError('arena_signal_fixture_mismatch', 400);
    }

    let fixture: any = null;
    if (prismaAny.arenaFixture?.findUnique) {
        try {
            fixture = await prismaAny.arenaFixture.findUnique({ where: { fixtureId } });
        } catch {
            fixture = null;
        }
    }
    const row = await prismaAny.arenaMatch.create({
        data: {
            fixtureId,
            signalId: signal?.id || null,
            strategy: signal?.strategy || null,
            marketType: signal?.marketType || null,
            selection: signal?.selection || null,
            direction: signal?.direction || null,
            signalConfidence: signal?.confidence ?? null,
            makerWallet,
            takerWallet: trimString(input.takerWallet) || null,
            buyerWallet: trimString(input.buyerWallet) || null,
            sellerWallet: trimString(input.sellerWallet) || null,
            rollupMode: trimString(input.rollupMode) || 'NONE',
            status: 'created',
            proof: jsonValue({
                createdBy: 'arena_api',
                fixtureKnown: Boolean(fixture),
                ...(input.proof || {}),
            }),
        },
    });

    return serializeArenaMatch(row);
}

export async function getArenaMatch(matchId: string): Promise<Record<string, unknown>> {
    return serializeArenaMatch(await requireMatch(matchId));
}

export async function getArenaSettlementStatusByTicket(ticketIdInput: string): Promise<Record<string, unknown>> {
    const ticketId = trimString(ticketIdInput);
    if (!ticketId) throw httpError('arena_ticket_id_required', 400);

    const match = await prismaAny.arenaMatch.findFirst({ where: { ticketId } });
    if (!match) throw httpError('arena_match_not_found_for_ticket', 404);

    const proof = await getArenaMatchProof(match.id);
    const links = asRecord(proof.links);
    const outcome = asRecord(links.outcome);
    const buyerDepositConfirmed = Boolean(match.buyerDepositLamports || match.buyerDepositTx);
    const sellerDepositConfirmed = Boolean(match.sellerDepositLamports || match.sellerDepositTx);

    return {
        ticketId,
        matchId: match.id,
        fixtureId: match.fixtureId,
        rollupMode: match.rollupMode,
        status: match.status,
        depositStatus: {
            escrowPda: match.escrowPda || null,
            buyerDepositConfirmed,
            sellerDepositConfirmed,
            fullyFunded: buyerDepositConfirmed && sellerDepositConfirmed,
            buyerDepositTx: match.buyerDepositTx || null,
            sellerDepositTx: match.sellerDepositTx || null,
        },
        outcomeStatus: {
            final: Boolean(outcome.id),
            outcomeId: outcome.id || null,
            winner: outcome.winner || null,
            settledAt: outcome.settledAt || null,
        },
        settlement: {
            terminal: TERMINAL_MATCH_STATUSES.has(match.status),
            action: match.settlementAction || null,
            status: match.settlementStatus || null,
            winnerWallet: match.winnerWallet || null,
            releaseTx: match.releaseTx || null,
            refundTx: match.refundTx || null,
            settledAt: serializeDate(match.settledAt) || null,
        },
        proof,
    };
}

export async function startArenaMatch(matchId: string, input: StartArenaMatchInput = {}): Promise<Record<string, unknown>> {
    const match = await requireMatch(matchId);
    if (TERMINAL_MATCH_STATUSES.has(match.status)) throw httpError('arena_match_terminal', 409);

    let offerId = trimString(input.offerId) || match.offerId;
    let bridgeResult: Record<string, unknown> | null = null;
    if (!offerId) {
        if (!match.signalId) throw httpError('arena_match_signal_required_to_start', 400);
        bridgeResult = await createOfferFromStrategySignal(
            match.signalId,
            trimString(input.makerWallet) || match.makerWallet,
            input.offerOptions || {}
        );
        const bridge = asRecord(bridgeResult.bridge);
        const offer = asRecord(bridgeResult.offer);
        offerId = trimString(offer.id) || trimString(bridge.offerId);
    }
    if (!offerId) throw httpError('arena_offer_id_unavailable', 500);

    const row = await prismaAny.arenaMatch.update({
        where: { id: matchId },
        data: {
            offerId,
            status: 'offer_created',
            startedAt: match.startedAt || new Date(),
            lastError: null,
            proof: mergeProof(match.proof, {
                startedBy: 'arena_api',
                offerId,
                bridgeCreated: bridgeResult ? Boolean((bridgeResult as any).created) : false,
            }),
        },
    });

    return {
        match: serializeArenaMatch(row),
        bridge: bridgeResult,
    };
}

export async function attachArenaTicket(matchId: string, input: AttachTicketInput): Promise<Record<string, unknown>> {
    const match = await requireMatch(matchId);
    if (TERMINAL_MATCH_STATUSES.has(match.status)) throw httpError('arena_match_terminal', 409);
    const ticketId = trimString(input.ticketId);
    if (!ticketId) throw httpError('arena_ticket_id_required', 400);

    const ticket = await prismaAny.ticket.findUnique({
        where: { id: ticketId },
        include: { offer: true },
    });
    if (!ticket) throw httpError('arena_ticket_not_found', 404);

    const buyerWallet = ticket.buyer || match.buyerWallet || null;
    const sellerWallet = ticket.seller || match.sellerWallet || null;
    const offerId = trimString(input.offerId) || ticket.offerId || match.offerId || null;
    const inferredTaker = match.takerWallet
        || (buyerWallet && buyerWallet !== match.makerWallet ? buyerWallet : null)
        || (sellerWallet && sellerWallet !== match.makerWallet ? sellerWallet : null);
    const escrowPda = trimString(input.escrowPda) || match.escrowPda || null;

    const row = await prismaAny.arenaMatch.update({
        where: { id: matchId },
        data: {
            ticketId,
            offerId,
            buyerWallet,
            sellerWallet,
            takerWallet: inferredTaker || null,
            escrowPda,
            rollupMode: ticket.rollupMode || match.rollupMode || 'NONE',
            buyerDepositLamports: trimString(input.buyerDepositLamports) || match.buyerDepositLamports || null,
            sellerDepositLamports: trimString(input.sellerDepositLamports) || match.sellerDepositLamports || null,
            buyerDepositTx: trimString(input.buyerDepositTx) || match.buyerDepositTx || null,
            sellerDepositTx: trimString(input.sellerDepositTx) || match.sellerDepositTx || null,
            buyerDepositedAt: dateValue(input.buyerDepositedAt) || match.buyerDepositedAt || null,
            sellerDepositedAt: dateValue(input.sellerDepositedAt) || match.sellerDepositedAt || null,
            status: trimString(input.status) || (escrowPda ? 'escrow_attached' : 'ticket_attached'),
            lastError: null,
            proof: mergeProof(match.proof, {
                ticketId,
                offerId,
                escrowPda,
                ...(input.proof || {}),
            }),
        },
    });

    return {
        match: serializeArenaMatch(row),
        ticket,
    };
}

function inferMakerWins(match: any, signal: any, outcome: any): boolean | null {
    const direction = match.direction || signal?.direction;
    const selection = match.selection || signal?.selection;
    const winner = outcome?.winner || match.outcomeWinner;
    if (!direction || !selection || !winner) return null;
    if (direction === 'BUY_SELECTION') return selection === winner;
    if (direction === 'SELL_SELECTION') return selection !== winner;
    return null;
}

export async function settleArenaMatch(matchId: string, input: SettleArenaMatchInput = {}): Promise<Record<string, unknown>> {
    const match = await requireMatch(matchId);
    if (TERMINAL_MATCH_STATUSES.has(match.status)) throw httpError('arena_match_terminal', 409);

    const outcome = input.outcomeId
        ? await prismaAny.arenaOutcome.findUnique({ where: { id: input.outcomeId } })
        : await prismaAny.arenaOutcome.findUnique({ where: { fixtureId: match.fixtureId } });
    if (!outcome) throw httpError('arena_outcome_not_found', 404);

    const signal = await loadSignal(match.signalId);
    const makerWins = inferMakerWins(match, signal, outcome);
    const winnerWallet = trimString(input.winnerWallet)
        || (makerWins === true ? match.makerWallet : makerWins === false ? match.takerWallet : undefined)
        || null;
    const settlementAction = trimString(input.settlementAction)
        || (makerWins === true ? 'release_to_maker' : makerWins === false ? 'refund_to_taker' : 'manual_review');
    const releaseTx = trimString(input.releaseTx) || match.releaseTx || null;
    const refundTx = trimString(input.refundTx) || match.refundTx || null;
    const settlementStatus = trimString(input.settlementStatus)
        || (releaseTx || refundTx ? 'tx_recorded' : 'decision_recorded');

    const row = await prismaAny.arenaMatch.update({
        where: { id: matchId },
        data: {
            outcomeId: outcome.id,
            outcomeWinner: trimString(input.outcomeWinner) || outcome.winner,
            winnerWallet,
            settlementAction,
            settlementStatus,
            releaseTx,
            refundTx,
            settledAt: new Date(),
            status: trimString(input.status) || 'settled',
            lastError: null,
            proof: mergeProof(match.proof, {
                outcomeId: outcome.id,
                outcomeWinner: outcome.winner,
                makerWins,
                winnerWallet,
                settlementAction,
                settlementStatus,
                ...(input.proof || {}),
            }),
        },
    });

    return {
        match: serializeArenaMatch(row),
        outcome: serializeOutcome(outcome),
        signal: signal ? serializeStrategySignal(signal) : null,
        decision: {
            makerWins,
            winnerWallet,
            settlementAction,
            settlementStatus,
        },
    };
}

export async function getArenaMatchProof(matchId: string): Promise<Record<string, unknown>> {
    const match = await requireMatch(matchId);
    const [fixture, signal, strategyOffer, offer, ticket, outcome] = await Promise.all([
        prismaAny.arenaFixture.findUnique({ where: { fixtureId: match.fixtureId } }),
        loadSignal(match.signalId),
        match.offerId
            ? prismaAny.arenaStrategyOffer.findFirst({ where: { offerId: match.offerId } })
            : match.signalId ? prismaAny.arenaStrategyOffer.findFirst({ where: { signalId: match.signalId } }) : null,
        match.offerId ? prismaAny.offer.findUnique({ where: { id: match.offerId } }) : null,
        match.ticketId ? prismaAny.ticket.findUnique({ where: { id: match.ticketId }, include: { messages: true, offer: true } }) : null,
        match.outcomeId
            ? prismaAny.arenaOutcome.findUnique({ where: { id: match.outcomeId } })
            : prismaAny.arenaOutcome.findUnique({ where: { fixtureId: match.fixtureId } }),
    ]);

    const trustedOutcome = outcome && isTrustedOutcomeSource(outcome.source) ? outcome : null;
    const completeness = {
        hasFixture: Boolean(fixture),
        hasSignal: Boolean(signal || match.signalId),
        hasOffer: Boolean(offer || match.offerId),
        hasTicket: Boolean(ticket || match.ticketId),
        hasEscrow: Boolean(match.escrowPda),
        buyerDepositConfirmed: Boolean(match.buyerDepositLamports || match.buyerDepositTx),
        sellerDepositConfirmed: Boolean(match.sellerDepositLamports || match.sellerDepositTx),
        hasOutcome: Boolean(trustedOutcome),
        settlementRecorded: Boolean(match.settlementAction || match.settlementStatus || match.winnerWallet),
        terminal: TERMINAL_MATCH_STATUSES.has(match.status),
    };

    return {
        match: serializeArenaMatch(match),
        completeness,
        stages: [
            { stage: 'txline_signal', complete: completeness.hasSignal, id: match.signalId },
            { stage: 'air_otc_offer', complete: completeness.hasOffer, id: match.offerId },
            { stage: 'ticket', complete: completeness.hasTicket, id: match.ticketId },
            { stage: 'escrow', complete: completeness.hasEscrow, pda: match.escrowPda },
            {
                stage: 'deposits',
                complete: completeness.buyerDepositConfirmed && completeness.sellerDepositConfirmed,
                buyer: completeness.buyerDepositConfirmed,
                seller: completeness.sellerDepositConfirmed,
            },
            { stage: 'txline_outcome', complete: completeness.hasOutcome, id: trustedOutcome ? match.outcomeId || trustedOutcome.id : undefined },
            { stage: 'settlement', complete: completeness.settlementRecorded, action: match.settlementAction },
        ],
        links: {
            fixture,
            signal: signal ? serializeStrategySignal(signal) : null,
            strategyOffer,
            offer,
            ticket,
            outcome: trustedOutcome ? serializeOutcome(trustedOutcome) : null,
        },
    };
}
