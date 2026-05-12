/**
 * Economic Safety Layer (Level 5 Adversarial Hardening)
 *
 * Enforces economic constraints to prevent griefing, scams, and abuse:
 *   1. Minimum collateral ratio (collateral must be >= 10% of price)
 *   2. Maximum deal value per tier (reputation-gated)
 *   3. Timeout penalty tracking
 *   4. Deal cancellation cooling (rate limit rapid cancel/create cycles)
 *   5. Anti-dust attack (minimum deal value)
 */

import { logger } from "../utils/logger";
import { reputationEngine } from "./reputationEngine";

const MIN_COLLATERAL_RATIO = 0.10; // Collateral must be >= 10% of price
const MIN_DEAL_VALUE_SOL = 0.001;  // No dust deals
const MAX_CANCELS_PER_HOUR = 5;    // Rate limit cancel-create griefing

// In-memory cancel rate tracker (per agent)
const cancelTimestamps: Map<string, number[]> = new Map();

export interface EconomicValidation {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

export const economicSafety = {
    /**
     * Validate deal economics before execution.
     * Returns errors that BLOCK the deal and warnings that are advisory.
     */
    async validateDeal(params: {
        buyerAgentId: string;
        sellerAgentId: string;
        priceSol: number;
        collateralBuyerSol: number;
        collateralSellerSol: number;
    }): Promise<EconomicValidation> {
        const errors: string[] = [];
        const warnings: string[] = [];

        // 1. Minimum deal value (anti-dust)
        if (params.priceSol < MIN_DEAL_VALUE_SOL) {
            errors.push(`Deal value ${params.priceSol} SOL below minimum ${MIN_DEAL_VALUE_SOL} SOL`);
        }

        // 2. Minimum collateral ratio
        if (params.priceSol > 0) {
            const buyerRatio = params.collateralBuyerSol / params.priceSol;
            const sellerRatio = params.collateralSellerSol / params.priceSol;

            if (buyerRatio < MIN_COLLATERAL_RATIO) {
                errors.push(`Buyer collateral ratio ${(buyerRatio * 100).toFixed(1)}% below minimum ${(MIN_COLLATERAL_RATIO * 100)}%`);
            }
            if (sellerRatio < MIN_COLLATERAL_RATIO) {
                errors.push(`Seller collateral ratio ${(sellerRatio * 100).toFixed(1)}% below minimum ${(MIN_COLLATERAL_RATIO * 100)}%`);
            }
        }

        // 3. Reputation-gated deal value caps
        const buyerCheck = await reputationEngine.canParticipate(params.buyerAgentId, params.priceSol);
        if (!buyerCheck.allowed) {
            errors.push(`Buyer: ${buyerCheck.reason}`);
        }

        const sellerCheck = await reputationEngine.canParticipate(params.sellerAgentId, params.priceSol);
        if (!sellerCheck.allowed) {
            errors.push(`Seller: ${sellerCheck.reason}`);
        }

        // 4. Advisory warnings for low-reputation agents
        if (buyerCheck.tier === "untrusted" || buyerCheck.tier === "new") {
            warnings.push(`Buyer is ${buyerCheck.tier} tier — higher risk counterparty`);
        }
        if (sellerCheck.tier === "untrusted" || sellerCheck.tier === "new") {
            warnings.push(`Seller is ${sellerCheck.tier} tier — higher risk counterparty`);
        }

        if (errors.length > 0) {
            logger.warn("economic_safety_blocked", { errors, params });
        }

        return { valid: errors.length === 0, errors, warnings };
    },

    /**
     * Check cancel rate limiting for griefing prevention.
     */
    checkCancelRate(agentId: string): { allowed: boolean; reason?: string } {
        const now = Date.now();
        const hourAgo = now - 60 * 60 * 1000;

        let timestamps = cancelTimestamps.get(agentId) || [];
        timestamps = timestamps.filter(t => t > hourAgo);
        cancelTimestamps.set(agentId, timestamps);

        if (timestamps.length >= MAX_CANCELS_PER_HOUR) {
            logger.warn("cancel_rate_limit_hit", { agentId, count: timestamps.length });
            return { allowed: false, reason: `Rate limited: ${timestamps.length} cancellations in the last hour. Max: ${MAX_CANCELS_PER_HOUR}` };
        }

        timestamps.push(now);
        return { allowed: true };
    },

    /**
     * Record a timeout penalty for both parties.
     */
    async recordTimeoutPenalty(buyerAgentId: string, sellerAgentId: string): Promise<void> {
        await reputationEngine.recordTimeout(buyerAgentId);
        await reputationEngine.recordTimeout(sellerAgentId);
        logger.warn("timeout_penalty_applied", { buyer: buyerAgentId, seller: sellerAgentId });
    },
};
