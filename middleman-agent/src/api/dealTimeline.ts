/**
 * Deal Timeline API (Level 5 Observability)
 *
 * Provides a complete, chronological timeline of every event
 * that occurred for a given deal. Combines audit logs, transactions,
 * phase state, and execution context into a single read-only view.
 *
 * Endpoint: GET /api/deals/:ticketId/timeline
 */

import express from "express";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";

const router = express.Router();

interface TimelineEvent {
    timestamp: string;
    type: string;
    event: string;
    details: Record<string, any>;
}

router.get("/deals/:ticketId/timeline", async (req, res) => {
    const { ticketId } = req.params;

    try {
        const timeline: TimelineEvent[] = [];

        // 1. Deal record
        const deal = await prisma.deal.findUnique({
            where: { ticketId },
            include: {
                buyer: true,
                seller: true,
                middleman: true,
            },
        });

        if (!deal) {
            return res.status(404).json({ error: "Deal not found", ticketId });
        }

        timeline.push({
            timestamp: deal.createdAt.toISOString(),
            type: "deal",
            event: "deal_created",
            details: {
                status: deal.status,
                price: deal.price,
                collateral_buyer: deal.collateralBuyer,
                collateral_seller: deal.collateralSeller,
                buyer_agent: deal.buyer?.id,
                seller_agent: deal.seller?.id,
                timeout: deal.timeout?.toISOString(),
            },
        });

        // 2. Execution context
        const execCtx = await prisma.executionContext.findUnique({
            where: { ticketId },
        });

        if (execCtx) {
            timeline.push({
                timestamp: execCtx.createdAt.toISOString(),
                type: "execution",
                event: "execution_context_created",
                details: {
                    status: execCtx.status,
                    lastStep: execCtx.lastSuccessfulStep,
                    dealPda: execCtx.dealPda,
                },
            });
        }

        // 3. Phase state
        const phaseState = await prisma.dealPhaseState.findUnique({
            where: { ticketId },
        });

        if (phaseState) {
            timeline.push({
                timestamp: phaseState.updatedAt.toISOString(),
                type: "phase",
                event: `phase_current_${phaseState.phase}`,
                details: {
                    phase: phaseState.phase,
                    buyerDeposited: phaseState.buyerDeposited,
                    sellerDeposited: phaseState.sellerDeposited,
                    paymentLocked: phaseState.paymentLocked,
                    escrowPda: phaseState.escrowPda,
                    history: phaseState.historyJson,
                },
            });
        }

        // 4. Transactions
        const transactions = await prisma.transaction.findMany({
            where: { deal: { ticketId } },
            orderBy: { createdAt: "asc" },
        });

        for (const tx of transactions) {
            timeline.push({
                timestamp: tx.createdAt.toISOString(),
                type: "transaction",
                event: `tx_${tx.type}`,
                details: {
                    type: tx.type,
                    status: tx.status,
                    signature: tx.txSignature,
                },
            });
        }

        // 5. Audit logs (hash-chain)
        const auditLogs = await prisma.auditLog.findMany({
            where: { ticketId },
            orderBy: { createdAt: "asc" },
        });

        for (const log of auditLogs) {
            timeline.push({
                timestamp: log.createdAt.toISOString(),
                type: "audit",
                event: log.event,
                details: {
                    hash: log.hash,
                    prevHash: log.prevHash,
                    payload: log.data,
                },
            });
        }

        // 6. Deposit confirmations
        const depositConfs = await prisma.depositConfirmation.findMany({
            where: { ticketId },
            orderBy: { createdAt: "asc" },
        });

        for (const dc of depositConfs) {
            if (dc.confirmed) {
                timeline.push({
                    timestamp: dc.createdAt.toISOString(),
                    type: "deposit",
                    event: `deposit_confirmed_${dc.type}`,
                    details: {
                        type: dc.type,
                        txHash: dc.txHash,
                    },
                });
            }
        }

        // Sort everything chronologically
        timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        res.json({
            ticketId,
            status: deal.status,
            total_events: timeline.length,
            timeline,
        });
    } catch (e: any) {
        logger.error("timeline_api_error", { ticketId }, e);
        res.status(500).json({ error: e.message });
    }
});

export default router;
