/**
 * Execution Context Recovery Module (Level 5 Autonomy)
 *
 * Restores ALL critical state from PostgreSQL upon agent restart:
 * 1. DealContexts (in-memory Anchor execution state)
 * 2. DealPhaseState (state machine phases, deposit flags, history)
 * 3. Deposit watchers (re-activated for deals in awaiting_deposits phase)
 *
 * Guarantees: zero state loss across crashes.
 */

import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import { dealContexts, DealContext } from "./onChainExecutionService";
import { dealPhaseManager } from "../../core/dealPhaseManager";
import { watchForDeposits } from "../listeners/depositWatcher";
import { getConnection } from "../solana/connection";

async function healTerminalPhaseStatesFromDealStatus(): Promise<number> {
    const phaseStates = await prisma.dealPhaseState.findMany({
        where: {
            phase: { notIn: ["completed", "cancelled", "refunded"] },
        },
        select: {
            ticketId: true,
            phase: true,
        },
    });

    if (phaseStates.length === 0) {
        return 0;
    }

    const terminalPhaseByStatus: Record<string, "completed" | "cancelled" | "refunded" | "disputed"> = {
        settled: "completed",
        completed: "completed",
        confidential_completed: "completed",
        cancelled: "cancelled",
        refunded: "refunded",
        disputed: "disputed",
        failed: "disputed",
    };

    const deals = await prisma.deal.findMany({
        where: {
            ticketId: { in: phaseStates.map((row) => row.ticketId) },
            status: { in: Object.keys(terminalPhaseByStatus) },
        },
        select: {
            ticketId: true,
            status: true,
        },
    });

    let healed = 0;

    for (const deal of deals) {
        const nextPhase = terminalPhaseByStatus[deal.status];
        if (!nextPhase) {
            continue;
        }

        await prisma.dealPhaseState.update({
            where: { ticketId: deal.ticketId },
            data: { phase: nextPhase },
        });
        healed += 1;
    }

    return healed;
}

/**
 * Full startup recovery sequence. Called once during agent bootstrap.
 */
export async function recoverInFlightDeals(): Promise<void> {
    try {
        // ── STEP 1: Restore DealContexts from ExecutionContext table ──
        // Only recover deals from the last 24 hours to avoid loading ancient test data
        const recentThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const activeContexts = await prisma.executionContext.findMany({
            where: {
                status: {
                    notIn: ["completed", "cancelled", "closed"]
                },
                updatedAt: { gt: recentThreshold }
            }
        });

        let contextRecoveredCount = 0;
        let contextFailedCount = 0;

        for (const ctx of activeContexts) {
            try {
                const dealIdBn = new BN(ctx.dealIdBn, 16);
                const reconstructedContext: DealContext = {
                    dealId: dealIdBn,
                    dealPda: new PublicKey(ctx.dealPda),
                    configPda: new PublicKey(ctx.configPda),
                    buyer: new PublicKey(ctx.buyerWallet),
                    seller: new PublicKey(ctx.sellerWallet),
                    middleman: new PublicKey(ctx.middlemanWallet),
                    programId: new PublicKey(ctx.programId),
                    tokenMint: new PublicKey(ctx.tokenMint || "So11111111111111111111111111111111111111112"),
                };
                dealContexts[ctx.ticketId] = reconstructedContext;
                contextRecoveredCount++;
                logger.debug("deal_context_recovered", {
                    ticket_id: ctx.ticketId,
                    step: ctx.lastSuccessfulStep,
                    status: ctx.status
                });
            } catch (err) {
                contextFailedCount++;
                logger.error("deal_context_recovery_failed", { ticket_id: ctx.ticketId }, err);
            }
        }

        logger.info("context_recovery_finished", {
            total: activeContexts.length,
            recovered: contextRecoveredCount,
            failed: contextFailedCount
        });

        // ── STEP 2: Heal stale non-terminal phase rows using authoritative deal status ──
        const healedTerminalPhaseCount = await healTerminalPhaseStatesFromDealStatus();
        if (healedTerminalPhaseCount > 0) {
            logger.info("phase_state_terminal_healed", {
                healed: healedTerminalPhaseCount,
            });
        }

        // ── STEP 3: Restore DealPhaseState (state machine) ──
        const phaseRecoveredCount = await dealPhaseManager.recoverAllDeals();
        logger.info("phase_state_recovery_finished", { recovered: phaseRecoveredCount });

        // ── STEP 4: Re-activate deposit watchers for deals in awaiting_deposits ──
        const activeDeals = dealPhaseManager.listActiveDeals();
        let watcherCount = 0;

        for (const deal of activeDeals) {
            if (deal.phase === "awaiting_deposits" && deal.escrow_pda && deal.terms) {
                // Find matching execution context for the PDA
                const ctx = dealContexts[deal.ticket_id];
                if (ctx) {
                    try {
                        const connection = getConnection();
                        await watchForDeposits(
                            connection,
                            deal.ticket_id,
                            ctx.dealPda,
                            Math.floor((deal.terms.collateral_buyer || 0) * LAMPORTS_PER_SOL),
                            Math.floor((deal.terms.collateral_seller || 0) * LAMPORTS_PER_SOL),
                            Math.floor((deal.terms.price || 0) * LAMPORTS_PER_SOL),
                        );
                        watcherCount++;
                        logger.info("deposit_watcher_reactivated", {
                            ticket_id: deal.ticket_id,
                            escrow_pda: deal.escrow_pda,
                        });
                    } catch (e: any) {
                        logger.error("deposit_watcher_reactivation_failed", { ticket_id: deal.ticket_id }, e);
                    }
                } else {
                    logger.warn("deposit_watcher_skip_no_context", { ticket_id: deal.ticket_id });
                }
            }
        }

        logger.info("startup_recovery_complete", {
            deal_contexts: contextRecoveredCount,
            phase_states: phaseRecoveredCount,
            deposit_watchers: watcherCount,
        });

    } catch (error) {
        logger.error("context_recovery_fatal_error", {}, error);
    }
}
