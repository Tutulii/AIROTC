/**
 * Liveness Enforcer (Level 5 Autonomy)
 *
 * Detects deals that have stalled (no progress for 5+ minutes)
 * and emits a force_recovery event to unstick them.
 *
 * Guarantees: no deal can silently stall forever.
 */

import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import { eventBus } from "./eventBus";

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes with no progress

/**
 * Checks for deals that haven't been updated in STALE_THRESHOLD_MS
 * and publishes force_recovery events for each.
 * Wire into heartbeat: if (tickCount % 20 === 0) await enforceLiveness();
 */
export async function enforceLiveness(): Promise<void> {
    try {
        const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
        const stuckDeals = await prisma.dealPhaseState.findMany({
            where: {
                phase: { notIn: ["completed", "cancelled", "refunded"] },
                updatedAt: { lt: staleThreshold },
            },
        });

        // Filter out test/debug deals to reduce log noise
        const realStuckDeals = stuckDeals.filter(
            (d) => !d.ticketId.startsWith("TCK-TEST") && !d.ticketId.startsWith("SOUL-SIM")
        );

        for (const deal of realStuckDeals) {
            logger.warn("liveness_stuck_detected", {
                ticket_id: deal.ticketId,
                phase: deal.phase,
                lastUpdate: deal.updatedAt.toISOString(),
                staleDurationMs: Date.now() - deal.updatedAt.getTime(),
            });

            eventBus.publish("force_recovery", { ticketId: deal.ticketId });
        }

        if (realStuckDeals.length > 0) {
            logger.info("liveness_enforcer_tick", { stuck_count: realStuckDeals.length });
        }
    } catch (e: any) {
        // Liveness enforcer must never crash the agent
        logger.error("liveness_enforcer_error", {}, e);
    }
}
