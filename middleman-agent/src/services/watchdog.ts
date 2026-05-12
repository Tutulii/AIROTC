/**
 * Autonomic Watchdog (Level 5)
 *
 * Periodically checks system health and takes corrective actions.
 * Has built-in anti-oscillation: if it fires more than MAX_ACTIONS_PER_WINDOW
 * times in a window, it throttles itself and stops making changes.
 *
 * Responsibilities:
 *   - Detect RPC failures and rotate endpoints
 *   - Detect DB connectivity issues
 *   - Force-expire stuck deals past TTL
 *   - Detect excessive circuit breaker trips
 */

import { logger } from "../utils/logger";
import { rpcManager } from "../utils/rpcManager";
import { circuitBreaker } from "../utils/circuitBreaker";
import { prisma } from "../lib/prisma";
import { SYSTEM_PAUSED } from "../api/health";

const MAX_DEAL_LIFETIME_MS = 30 * 60 * 1000; // Same as onChainExecutionService
const MAX_ACTIONS_PER_WINDOW = 10;
const ANTI_OSCILLATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

let actionTimestamps: number[] = [];

function isThrottled(): boolean {
    const now = Date.now();
    actionTimestamps = actionTimestamps.filter(t => now - t < ANTI_OSCILLATION_WINDOW_MS);
    return actionTimestamps.length >= MAX_ACTIONS_PER_WINDOW;
}

function recordAction(): void {
    actionTimestamps.push(Date.now());
}

/**
 * Run one watchdog tick. Called from heartbeat every ~60s.
 * Wire: if (tickCount % 20 === 0) await watchdogTick();
 */
export async function watchdogTick(): Promise<void> {
    if (SYSTEM_PAUSED) return; // Don't watchdog while paused

    try {
        // Anti-oscillation: if we've taken too many actions, stop
        if (isThrottled()) {
            logger.warn("watchdog_throttled", {
                message: "Too many corrective actions in window, backing off",
                actions: actionTimestamps.length,
                max: MAX_ACTIONS_PER_WINDOW,
            });
            return;
        }

        // ── CHECK 1: RPC health ──
        try {
            const conn = rpcManager.getConnection();
            await conn.getSlot("confirmed");
        } catch (e: any) {
            logger.warn("watchdog_rpc_failure_detected", { error: e.message });
            if (rpcManager.markFailure(rpcManager.getCurrentIndex())) {
                rpcManager.switchEndpoint();
                recordAction();
                logger.info("watchdog_rpc_rotated", { new_index: rpcManager.getCurrentIndex() });
            }
        }

        // ── CHECK 2: DB liveness ──
        try {
            await prisma.$queryRaw`SELECT 1`;
        } catch (e: any) {
            logger.error("watchdog_db_failure_detected", {}, e);
            // DB failure is critical — nothing we can auto-fix, but we log it
            // The health endpoint will report "down"
        }

        // ── CHECK 3: Force-expire stuck deals past TTL ──
        try {
            const ttlThreshold = new Date(Date.now() - MAX_DEAL_LIFETIME_MS);
            const stuckDeals = await prisma.dealPhaseState.findMany({
                where: {
                    phase: { notIn: ["completed", "cancelled", "refunded"] },
                    createdAt: { lt: ttlThreshold },
                },
            });

            for (const deal of stuckDeals) {
                logger.error("watchdog_deal_ttl_exceeded", {
                    ticket_id: deal.ticketId,
                    phase: deal.phase,
                    age_ms: Date.now() - deal.createdAt.getTime(),
                });
                // Force to cancelled
                await prisma.dealPhaseState.update({
                    where: { ticketId: deal.ticketId },
                    data: { phase: "cancelled" },
                });
                recordAction();
            }
        } catch (e: any) {
            logger.error("watchdog_ttl_check_failed", {}, e);
        }

        // ── CHECK 4: Circuit breaker status ──
        const cbStatus = circuitBreaker.getStatus();
        if (cbStatus.state === "DEGRADED") {
            logger.error("watchdog_circuit_permanently_degraded", {
                resetCount: cbStatus.resetCount,
                message: "System requires manual intervention",
            });
        }

    } catch (e: any) {
        // Watchdog must never crash the agent
        logger.error("watchdog_tick_error", {}, e);
    }
}
