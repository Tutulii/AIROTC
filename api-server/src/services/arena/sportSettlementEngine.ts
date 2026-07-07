import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { middlemanForwarder } from '../middlemanForwarder';
import { attachArenaTicket, serializeArenaMatch, settleArenaMatch } from './arenaMatch.service';
import { deriveOutcomesFromStoredScores, isTrustedOutcomeSource, syncOutcomeForFixture } from './outcomeBacktest';

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

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isLegacyFixtureId(value: unknown): boolean {
    const fixtureId = trimString(value);
    return Boolean(fixtureId?.startsWith('espn:') || fixtureId?.startsWith('hosted-smoke-'));
}

function isNumericTxlineFixtureId(value: unknown): boolean {
    const fixtureId = trimString(value);
    return Boolean(fixtureId && /^\d+$/.test(fixtureId));
}

function fixtureSource(fixture: any): string {
    return String(asRecord(fixture?.raw).source || '').trim().toLowerCase();
}

function isSettlementCandidate(match: any, fixture?: any | null): boolean {
    if (!trimString(match?.fixtureId) || isLegacyFixtureId(match.fixtureId)) return false;
    const source = fixtureSource(fixture);
    if (source) return source === 'txline';
    return isNumericTxlineFixtureId(match.fixtureId);
}

async function fixtureMapForMatches(matches: any[]): Promise<Map<string, any>> {
    if (!prismaAny.arenaFixture?.findMany || matches.length === 0) return new Map();
    const fixtureIds = [...new Set(matches.map((match) => trimString(match.fixtureId)).filter(Boolean))];
    if (fixtureIds.length === 0) return new Map();
    try {
        const fixtures = await prismaAny.arenaFixture.findMany({
            where: { fixtureId: { in: fixtureIds } },
        });
        return new Map(fixtures.map((fixture: any) => [fixture.fixtureId, fixture]));
    } catch {
        return new Map();
    }
}

function settlementDirectionFromOfferMode(mode: unknown): 'BUY_SELECTION' | 'SELL_SELECTION' {
    return mode === 'sell' ? 'SELL_SELECTION' : 'BUY_SELECTION';
}

function inferMakerWins(match: any, outcome: any): boolean | null {
    const makerSide = trimString(match.makerSide);
    const direction = trimString(match.direction);
    const selection = trimString(match.selection);
    const winner = trimString(outcome?.winner);
    if (!selection || !winner) return null;
    if (makerSide === 'back') return selection === winner;
    if (makerSide === 'lay') return selection !== winner;
    if (!direction) return null;
    if (direction === 'BUY_SELECTION') return selection === winner;
    if (direction === 'SELL_SELECTION') return selection !== winner;
    return null;
}

type SportSettlementAction =
    | 'release_to_maker'
    | 'refund_to_taker'
    | 'release_to_seller'
    | 'release_to_buyer';

function sellerPayoutAction(action: SportSettlementAction): boolean {
    return action === 'release_to_maker' || action === 'release_to_seller';
}

function winnerWalletForMatch(match: any, makerWins: boolean): string | null {
    return trimString(makerWins ? match.makerWallet : match.takerWallet) || null;
}

function settlementActionForWinner(match: any, makerWins: boolean): SportSettlementAction {
    const winnerWallet = winnerWalletForMatch(match, makerWins);
    const sellerWallet = trimString(match.sellerWallet);
    const buyerWallet = trimString(match.buyerWallet);
    if (winnerWallet && sellerWallet && winnerWallet === sellerWallet) return 'release_to_seller';
    if (winnerWallet && buyerWallet && winnerWallet === buyerWallet) return 'release_to_buyer';
    return makerWins ? 'release_to_maker' : 'refund_to_taker';
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

    const candidateTake = params.matchId || params.fixtureId
        ? limit
        : Math.min(Math.max(limit * 10, 100), 500);
    const candidateMatches = await prismaAny.arenaMatch.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: candidateTake,
    });
    const fixturesById = await fixtureMapForMatches(candidateMatches);
    const legacyIgnored = params.matchId
        ? []
        : candidateMatches
            .filter((match: any) => !isSettlementCandidate(match, fixturesById.get(match.fixtureId)))
            .map((match: any) => ({
                matchId: match.id,
                fixtureId: match.fixtureId,
                reason: 'non_txline_sport_fixture_ignored',
                fixtureSource: fixtureSource(fixturesById.get(match.fixtureId)) || null,
            }));
    const matches = params.matchId
        ? candidateMatches.slice(0, limit)
        : candidateMatches
            .filter((match: any) => isSettlementCandidate(match, fixturesById.get(match.fixtureId)))
            .slice(0, limit);

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
        if (!outcome || !isTrustedOutcomeSource(outcome.source)) {
            skipped.push({
                matchId: match.id,
                fixtureId: match.fixtureId,
                reason: outcome ? 'txline_outcome_source_not_trusted' : 'txline_outcome_not_found_or_not_final',
                outcomeSource: outcome?.source || null,
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

        const settlementAction = settlementActionForWinner(match, makerWins);
        const winnerWallet = winnerWalletForMatch(match, makerWins);
        let releaseTx = sellerPayoutAction(settlementAction)
            ? trimString(params.releaseTx) || trimString(match.releaseTx)
            : undefined;
        let refundTx = !sellerPayoutAction(settlementAction)
            ? trimString(params.refundTx) || trimString(match.refundTx)
            : undefined;
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
                winnerWallet,
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

            if (sellerPayoutAction(settlementAction)) {
                releaseTx = trimString(bridgeResult.tx);
            } else {
                refundTx = trimString(bridgeResult.tx);
            }
        }

        const txRecorded = Boolean(releaseTx || refundTx);
        const terminalStatus = sellerPayoutAction(settlementAction) ? 'released' : 'refunded';
        settled.push(await settleArenaMatch(match.id, {
            outcomeId: outcome.id,
            winnerWallet: winnerWallet || undefined,
            settlementAction,
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
        ignoredLegacyCount: legacyIgnored.length,
        refreshOutcomes,
        liveSync,
        outcomeRefreshes,
        settled,
        skipped,
        ignoredLegacy: legacyIgnored,
    };
}
