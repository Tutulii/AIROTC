/**
 * Transaction Monitor — Stuck/Failed Deal Detection
 *
 * Background service (60s interval) that:
 * - Scans for non-terminal deals stuck beyond threshold
 * - Emits structured alerts with severity levels
 * - Pipes alerts to eventBus for dashboard consumption
 * - Logs warnings with full context for debugging
 */

import { prisma } from "../lib/prisma";
import { logger, type AlertSeverity } from "../utils/logger";
import { eventBus } from "./eventBus";

// ==========================================
// CONFIGURATION
// ==========================================

const MONITOR_INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || "60000", 10);
const STUCK_THRESHOLD_MS = parseInt(process.env.STUCK_THRESHOLD_MS || "900000", 10); // 15 min default
const CRITICAL_THRESHOLD_MS = parseInt(process.env.CRITICAL_THRESHOLD_MS || "1800000", 10); // 30 min

// ==========================================
// ALERT TYPES
// ==========================================

export interface DealAlert {
    ticketId: string;
    dealId: string | null;
    status: string;
    severity: AlertSeverity;
    message: string;
    stuckDurationMs: number;
    timestamp: number;
}

// ==========================================
// MONITOR ENGINE
// ==========================================

class TransactionMonitor {
    private intervalHandle: ReturnType<typeof setInterval> | null = null;
    private isRunning = false;

    /**
     * Start the background monitoring loop.
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;

        logger.info("transaction_monitor_started", {
            interval_ms: MONITOR_INTERVAL_MS,
            stuck_threshold_ms: STUCK_THRESHOLD_MS,
        });

        // Run immediately, then on interval
        this.scan();
        this.intervalHandle = setInterval(() => this.scan(), MONITOR_INTERVAL_MS);
    }

    /**
     * Stop the monitoring loop.
     */
    stop(): void {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
        this.isRunning = false;
        logger.info("transaction_monitor_stopped");
    }

    /**
     * Scan for stuck/stale deals.
     */
    private async scan(): Promise<void> {
        try {
            const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
            const criticalCutoff = new Date(Date.now() - CRITICAL_THRESHOLD_MS);

            // Find non-terminal deals that haven't updated recently
            const stuckDeals = await prisma.deal.findMany({
                where: {
                    status: { notIn: ["completed", "agreed", "cancelled", "refunded"] },
                    createdAt: { lt: cutoff },
                },
                select: {
                    id: true,
                    ticketId: true,
                    dealIdOnChain: true,
                    status: true,
                    createdAt: true,
                },
                take: 50, // Limit for safety
            });

            if (stuckDeals.length === 0) return;

            for (const deal of stuckDeals) {
                const stuckMs = Date.now() - deal.createdAt.getTime();
                const isCritical = deal.createdAt < criticalCutoff;

                const severity: AlertSeverity = isCritical ? "critical" : "warning";

                const alert: DealAlert = {
                    ticketId: deal.ticketId,
                    dealId: deal.dealIdOnChain,
                    status: deal.status,
                    severity,
                    message: `Deal ${deal.ticketId} stuck in "${deal.status}" for ${Math.round(stuckMs / 60000)}min`,
                    stuckDurationMs: stuckMs,
                    timestamp: Date.now(),
                };

                // Log with severity
                logger[severity === "critical" ? "error" : "warn"]("deal_stuck_alert", {
                    ticket_id: deal.ticketId,
                    deal_id: deal.dealIdOnChain || undefined,
                    severity,
                    stuck_duration_min: Math.round(stuckMs / 60000),
                    status: deal.status,
                });

                // Emit to eventBus for dashboard
                try {
                    eventBus.publish("deal_alert" as any, alert as any);
                } catch {
                    // EventBus may not have this event type registered — silent
                }
            }

            logger.info("transaction_monitor_scan_complete", {
                stuck_deals_found: stuckDeals.length,
            });
        } catch (e) {
            logger.error("transaction_monitor_scan_failed", {}, e);
        }
    }
}

export const transactionMonitor = new TransactionMonitor();
