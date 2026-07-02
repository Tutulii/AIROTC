import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { middlemanForwarder } from '../middlemanForwarder';
import { attachArenaTicket, serializeArenaMatch, settleArenaMatch } from './arenaMatch.service';
import { deriveOutcomesFromStoredScores, syncOutcomeForFixture } from './outcomeBacktest';

const prismaAny = prisma as any;
const SPORT_TERMINAL_STATUSES = ['settled', 'released', 'refunded', 'cancelled', 'failed'];
const SPORT_SETTLEMENT_LIVE_SYNC_ENABLED =
    (process.env.SPORT_SETTLEMENT_LIVE_SYNC_ENABLED || (process.env.NODE_ENV === 'test' ? 'false' : 'true')).toLowerCase() !== 'false';

function jsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function trimString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function settlementDirectionFromOfferMode(mode: unknown): 'BUY_SELECTION' | 'SELL_SELECTION' {
    return mode === 'sell' ? 'SELL_SELECTION' : 'BUY_SELECTION';
}

function inferMakerWins(match: any, outcome: any): boolean | null {
    const direction = trimString(match.direction);
    const selection = trimString(match.selection);
    const winner = trimString(outcome?.winner);
    if (!direction || !selection || !winner) return null;
    if (direction === 'BUY_SELECTION') return selection === winner;
    if (direction === 'SELL_SELECTION') return selection !== winner;
    return null;
}

async function refreshOutcomeForFixture(fixtureId: string, liveSync: boolean): Promise<Record<string, unknown>> {
    const attempts: Array<Record<string, unknown>> = [];

    if (liveSync) {
        try {
            const synced = await syncOutcomeForFixture(fixtureId);
            attempts.push({ source: 'txline_snapshot', success: true, result: synced });
            if ((synced as any).stored) {
                return { fixtureId, refreshed: true, attempts };
            }
        } catch (error: any) {
            attempts.push({
                source: 'txline_snapshot',
                success: false,
                error: error?.message || 'txline_snapshot_sync_failed',
            });
        }
    }

    try {
        const derived = await deriveOutcomesFromStoredScores(fixtureId);
        attempts.push({ source: 'stored_scores', success: true, result: derived });
        return {
            fixtureId,
            refreshed: Number((derived as any).storedOutcomes || 0) > 0,
            attempts,
        };
    } catch (error: any) {
        attempts.push({
            source: 'stored_scores',
            success: false,
            error: error?.message || 'stored_score_derivation_failed',
        });
    }

    return { fixtureId, refreshed: false, attempts };
}

export async function createSportMatchForOffer(params: {
    offerId: string;
    fixtureId: string;
    makerWallet: string;
    mode: string;
    marketType?: string | null;
    selection?: string | null;
    proof?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
    const offerId = trimString(params.offerId);
    const fixtureId = trimString(params.fixtureId);
    const makerWallet = trimString(params.makerWallet);
    const selection = trimString(params.selection);
    if (!offerId) throw Object.assign(new Error('sport_offer_id_required'), { statusCode: 400 });
    if (!fixtureId) throw Object.assign(new Error('sport_fixture_id_required'), { statusCode: 400 });
    if (!makerWallet) throw Object.assign(new Error('sport_maker_wallet_required'), { statusCode: 400 });
    if (!selection) throw Object.assign(new Error('sport_selection_required'), { statusCode: 400 });

    const existing = await prismaAny.arenaMatch.findFirst({ where: { offerId } });
    if (existing) return serializeArenaMatch(existing);

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
            offerId,
            marketType: trimString(params.marketType) || null,
            selection,
            direction: settlementDirectionFromOfferMode(params.mode),
            makerWallet,
            rollupMode: 'SPORT',
            status: 'offer_created',
            startedAt: new Date(),
            proof: jsonValue({
                createdBy: 'sport_offer',
                fixtureKnown: Boolean(fixture),
                settlementSource: 'txline',
                ...(params.proof || {}),
            }),
        },
    });
    return serializeArenaMatch(row);
}

export async function attachSportTicketByOffer(params: {
    offerId: string;
    ticketId: string;
    escrowPda?: string | null;
}): Promise<Record<string, unknown>> {
    const offerId = trimString(params.offerId);
    const ticketId = trimString(params.ticketId);
    if (!offerId) throw Object.assign(new Error('sport_offer_id_required'), { statusCode: 400 });
    if (!ticketId) throw Object.assign(new Error('sport_ticket_id_required'), { statusCode: 400 });

    const match = await prismaAny.arenaMatch.findFirst({ where: { offerId } });
    if (!match) throw Object.assign(new Error('sport_arena_match_not_found'), { statusCode: 404 });

    return attachArenaTicket(match.id, {
        ticketId,
        offerId,
        escrowPda: trimString(params.escrowPda),
        status: trimString(params.escrowPda) ? 'escrow_attached' : 'ticket_attached',
        proof: {
            attachedBy: 'sport_offer_accept',
        },
    });
}

export async function runSportSettlement(params: {
    matchId?: string;
    fixtureId?: string;
    limit?: number;
    releaseTx?: string;
    refundTx?: string;
    refreshOutcomes?: boolean;
    liveSync?: boolean;
} = {}): Promise<Record<string, unknown>> {
    const limit = Math.min(Math.max(Math.floor(Number(params.limit) || 50), 1), 100);
    const refreshOutcomes = params.refreshOutcomes !== false;
    const liveSync = params.liveSync ?? SPORT_SETTLEMENT_LIVE_SYNC_ENABLED;
    const where: Record<string, unknown> = {
        rollupMode: 'SPORT',
        status: { notIn: SPORT_TERMINAL_STATUSES },
    };
    if (params.matchId) where.id = params.matchId;
    if (params.fixtureId) where.fixtureId = params.fixtureId;

    const matches = await prismaAny.arenaMatch.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
    });

    const settled = [];
    const skipped = [];
    const outcomeRefreshes = [];
    for (const match of matches) {
        let outcomeRefresh: Record<string, unknown> | null = null;
        if (refreshOutcomes) {
            outcomeRefresh = await refreshOutcomeForFixture(match.fixtureId, liveSync);
            outcomeRefreshes.push(outcomeRefresh);
        }

        const outcome = await prismaAny.arenaOutcome.findUnique({ where: { fixtureId: match.fixtureId } });
        if (!outcome) {
            skipped.push({
                matchId: match.id,
                fixtureId: match.fixtureId,
                reason: 'txline_outcome_not_found_or_not_final',
                outcomeRefresh,
            });
            continue;
        }

        const makerWins = inferMakerWins(match, outcome);
        if (makerWins === null) {
            skipped.push({
                matchId: match.id,
                fixtureId: match.fixtureId,
                reason: 'sport_settlement_manual_review_required',
                outcomeRefresh,
            });
            continue;
        }

        const settlementAction = makerWins ? 'release_to_maker' : 'refund_to_taker';
        let releaseTx = settlementAction === 'release_to_maker' ? trimString(params.releaseTx) : undefined;
        let refundTx = settlementAction === 'refund_to_taker' ? trimString(params.refundTx) : undefined;
        let bridgeResult: Awaited<ReturnType<typeof middlemanForwarder.forwardSportSettlement>> | null = null;

        if (!releaseTx && !refundTx) {
            if (!match.ticketId) {
                skipped.push({
                    matchId: match.id,
                    fixtureId: match.fixtureId,
                    reason: 'sport_ticket_not_attached',
                    outcomeRefresh,
                });
                continue;
            }

            bridgeResult = await middlemanForwarder.forwardSportSettlement({
                ticketId: match.ticketId,
                settlementAction,
                matchId: match.id,
                fixtureId: match.fixtureId,
                outcomeWinner: outcome.winner,
                winnerWallet: makerWins ? match.makerWallet : match.takerWallet,
            });

            if (!bridgeResult.success) {
                skipped.push({
                    matchId: match.id,
                    fixtureId: match.fixtureId,
                    ticketId: match.ticketId,
                    reason: 'sport_escrow_execution_failed',
                    error: bridgeResult.error || 'unknown_error',
                    outcomeRefresh,
                });
                continue;
            }

            if (settlementAction === 'release_to_maker') {
                releaseTx = trimString(bridgeResult.tx);
            } else {
                refundTx = trimString(bridgeResult.tx);
            }
        }

        const txRecorded = Boolean(releaseTx || refundTx);
        const terminalStatus = settlementAction === 'release_to_maker' ? 'released' : 'refunded';
        settled.push(await settleArenaMatch(match.id, {
            outcomeId: outcome.id,
            releaseTx,
            refundTx,
            status: txRecorded || bridgeResult?.success ? terminalStatus : 'settled',
            settlementStatus: txRecorded
                ? 'tx_recorded'
                : bridgeResult?.success ? 'escrow_executed' : 'txline_decision_recorded',
            proof: {
                settledBy: 'sport_settlement_engine',
                settlementSource: 'txline',
                escrowExecution: bridgeResult ? {
                    success: bridgeResult.success,
                    onChainAction: bridgeResult.onChainAction || null,
                    status: bridgeResult.status || null,
                    tx: bridgeResult.tx || null,
                } : null,
                outcomeRefresh,
            },
        }));
    }

    return {
        mode: 'SPORT',
        scanned: matches.length,
        settledCount: settled.length,
        skippedCount: skipped.length,
        refreshOutcomes,
        liveSync,
        outcomeRefreshes,
        settled,
        skipped,
    };
}
