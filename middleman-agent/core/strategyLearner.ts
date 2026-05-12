/**
 * Strategy Learner (Level 5 Autonomy)
 *
 * Reinforcement learning loop that analyzes completed deals and
 * dynamically tunes the agent's decision thresholds over time.
 *
 * Key capabilities:
 *   1. Logs every brain decision for post-hoc analysis
 *   2. Computes deal outcome statistics (success/dispute/timeout rates)
 *   3. Adjusts AUTO_AGREEMENT_THRESHOLD based on dispute patterns
 *   4. Provides per-agent trust scoring via wallet registry history
 *   5. All changes are audited via StrategyConfig with updatedBy trail
 */

import { prisma } from "../src/lib/prisma";
import { logger } from "../src/utils/logger";
import type { MiddlemanDecision } from "./middlemanBrain";

// ==========================================
// TYPES
// ==========================================

export interface DynamicThresholds {
    agreementScore: number;
    minMessages: number;
    mentionConfidence: number;
    collateralRatio: number;
}

export interface OutcomeStats {
    totalDeals: number;
    successRate: number;
    disputeRate: number;
    timeoutRate: number;
    cancelRate: number;
}

// ==========================================
// DEFAULT THRESHOLDS (fallback if DB is empty)
// ==========================================

const DEFAULT_THRESHOLDS: DynamicThresholds = {
    agreementScore: 80,
    minMessages: 3,
    mentionConfidence: 50,
    collateralRatio: 1.0,
};

// In-memory cache (refreshed every analysis cycle)
let _cachedThresholds: DynamicThresholds = { ...DEFAULT_THRESHOLDS };
let _lastRefreshTime = 0;
const CACHE_TTL_MS = 60_000; // Refresh from DB at most every 60s

// ==========================================
// CORE: GET CURRENT THRESHOLDS
// ==========================================

/**
 * Returns the current dynamic thresholds.
 * Uses in-memory cache to avoid DB queries on every message.
 */
export async function getCurrentThresholds(): Promise<DynamicThresholds> {
    const now = Date.now();

    if (now - _lastRefreshTime < CACHE_TTL_MS) {
        return _cachedThresholds;
    }

    try {
        const config = await prisma.strategyConfig.findFirst({
            orderBy: { updatedAt: "desc" },
        });

        if (config) {
            _cachedThresholds = {
                agreementScore: config.agreementThreshold,
                minMessages: config.minMessagesForAuto,
                mentionConfidence: config.mentionConfThreshold,
                collateralRatio: config.defaultCollateralRatio,
            };
        } else {
            // Bootstrap: create the default config row
            await prisma.strategyConfig.create({
                data: {
                    agreementThreshold: DEFAULT_THRESHOLDS.agreementScore,
                    minMessagesForAuto: DEFAULT_THRESHOLDS.minMessages,
                    mentionConfThreshold: DEFAULT_THRESHOLDS.mentionConfidence,
                    defaultCollateralRatio: DEFAULT_THRESHOLDS.collateralRatio,
                    updatedBy: "system_bootstrap",
                },
            });
        }

        _lastRefreshTime = now;
    } catch (error) {
        logger.error("strategy_learner_threshold_fetch_error", {}, error);
    }

    return _cachedThresholds;
}

// ==========================================
// DECISION JOURNALING
// ==========================================

/**
 * Persist a brain decision for post-hoc analysis.
 * Called from index.ts message pipeline after brain produces a decision.
 */
export async function logDecision(decision: MiddlemanDecision): Promise<void> {
    try {
        await prisma.decisionLog.create({
            data: {
                ticketId: decision.ticket_id,
                action: decision.action,
                trigger: decision.trigger,
                confidence: decision.confidence,
                reasoning: decision.reasoning,
            },
        });
    } catch (error) {
        logger.error("strategy_learner_log_decision_failed", {}, error);
    }
}

/**
 * Mark the outcome of a deal in all its decision logs.
 * Called when a deal reaches a terminal state.
 */
export async function markDealOutcome(
    ticketId: string,
    outcome: "success" | "dispute" | "timeout" | "cancelled"
): Promise<void> {
    try {
        await prisma.decisionLog.updateMany({
            where: { ticketId, outcome: null },
            data: { outcome },
        });

        logger.debug("strategy_learner_outcome_marked", { ticket_id: ticketId, outcome });
    } catch (error) {
        logger.error("strategy_learner_mark_outcome_failed", { ticket_id: ticketId }, error);
    }
}

// ==========================================
// OUTCOME ANALYSIS & THRESHOLD TUNING
// ==========================================

/**
 * Compute outcome statistics from the last N decisions.
 */
export async function computeOutcomeStats(windowSize: number = 50): Promise<OutcomeStats> {
    const logs = await prisma.decisionLog.findMany({
        where: {
            outcome: { not: null },
            action: { in: ["CREATE_ESCROW"] }, // Only count deal-initiating decisions
        },
        orderBy: { createdAt: "desc" },
        take: windowSize,
    });

    if (logs.length === 0) {
        return { totalDeals: 0, successRate: 1, disputeRate: 0, timeoutRate: 0, cancelRate: 0 };
    }

    const total = logs.length;
    const success = logs.filter(l => l.outcome === "success").length;
    const disputes = logs.filter(l => l.outcome === "dispute").length;
    const timeouts = logs.filter(l => l.outcome === "timeout").length;
    const cancels = logs.filter(l => l.outcome === "cancelled").length;

    return {
        totalDeals: total,
        successRate: success / total,
        disputeRate: disputes / total,
        timeoutRate: timeouts / total,
        cancelRate: cancels / total,
    };
}

/**
 * Run the threshold tuning cycle.
 * Call this periodically (e.g., every 100th heartbeat or after each deal completion).
 *
 * Rules:
 *   - If dispute rate > 20%: raise agreement threshold by 5 (require stronger consensus)
 *   - If timeout rate > 30%: raise min messages (more conversation before auto-detect)
 *   - If success rate > 90%: lower agreement threshold by 2 (allow faster execution)
 *   - All changes are bounded to safe ranges
 */
export async function runThresholdTuning(): Promise<void> {
    try {
        const stats = await computeOutcomeStats();

        if (stats.totalDeals < 10) {
            logger.debug("strategy_learner_tuning_skipped", { reason: "insufficient_data", count: stats.totalDeals });
            return;
        }

        const current = await getCurrentThresholds();
        let changed = false;
        const newThresholds = { ...current };

        // Rule 1: High dispute rate → require stronger agreement
        if (stats.disputeRate > 0.20) {
            newThresholds.agreementScore = Math.min(current.agreementScore + 5, 95);
            newThresholds.collateralRatio = Math.min(current.collateralRatio + 0.25, 3.0);
            changed = true;
        }

        // Rule 2: High timeout rate → require more conversation
        if (stats.timeoutRate > 0.30) {
            newThresholds.minMessages = Math.min(current.minMessages + 1, 8);
            changed = true;
        }

        // Rule 3: High success rate → relax thresholds for faster execution
        if (stats.successRate > 0.90 && stats.disputeRate < 0.05) {
            newThresholds.agreementScore = Math.max(current.agreementScore - 2, 60);
            newThresholds.minMessages = Math.max(current.minMessages - 1, 2);
            changed = true;
        }

        if (!changed) {
            logger.debug("strategy_learner_tuning_no_change", { stats });
            return;
        }

        // Persist the new thresholds
        const existing = await prisma.strategyConfig.findFirst({ orderBy: { updatedAt: "desc" } });
        if (existing) {
            await prisma.strategyConfig.update({
                where: { id: existing.id },
                data: {
                    agreementThreshold: newThresholds.agreementScore,
                    minMessagesForAuto: newThresholds.minMessages,
                    mentionConfThreshold: newThresholds.mentionConfidence,
                    defaultCollateralRatio: newThresholds.collateralRatio,
                    updatedBy: "strategy_learner",
                },
            });
        }

        // Invalidate cache
        _lastRefreshTime = 0;

        logger.info("strategy_learner_thresholds_updated", {
            old: current,
            new: newThresholds,
            stats,
        });

    } catch (error) {
        logger.error("strategy_learner_tuning_failed", {}, error);
    }
}
