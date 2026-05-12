/**
 * Agent Reputation Engine (Level 5 Adversarial Hardening)
 *
 * Tracks agent behavior across deals and computes a reputation score.
 * Used for:
 *   - Deal value limits (low-rep agents get lower caps)
 *   - Trust-weighted AI Judge decisions
 *   - Auto-banning repeat offenders
 *
 * Score formula: starts at 50, +5 per completed deal, -10 per failed,
 * -15 per dispute lost, -8 per timeout. Clamped to [0, 100].
 *
 * Tiers: new (0-25), untrusted (25-40), standard (40-60),
 *        trusted (60-80), elite (80-100)
 */

import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";

export type ReputationTier = "banned" | "new" | "untrusted" | "standard" | "trusted" | "elite";

const TIER_THRESHOLDS: { min: number; tier: ReputationTier }[] = [
    { min: 80, tier: "elite" },
    { min: 60, tier: "trusted" },
    { min: 40, tier: "standard" },
    { min: 25, tier: "untrusted" },
    { min: 0, tier: "new" },
];

const DEAL_VALUE_CAPS: Record<ReputationTier, number> = {
    banned: 0,
    new: 0.5,       // 0.5 SOL max
    untrusted: 2,   // 2 SOL max
    standard: 10,   // 10 SOL max
    trusted: 50,    // 50 SOL max
    elite: Infinity, // No cap
};

function computeTier(score: number): ReputationTier {
    if (score <= 0) return "banned";
    for (const t of TIER_THRESHOLDS) {
        if (score >= t.min) return t.tier;
    }
    return "new";
}

function clampScore(score: number): number {
    return Math.max(0, Math.min(100, score));
}

/**
 * Resolves an agent identifier (wallet pubkey or UUID) to a valid Agent.id.
 * Ensures the Agent record exists in the database.
 */
async function resolveAgentId(identifier: string): Promise<string> {
    // Try by wallet first
    let agent = await prisma.agent.findUnique({ where: { wallet: identifier } });
    if (agent) return agent.id;

    // Try by UUID
    agent = await prisma.agent.findUnique({ where: { id: identifier } });
    if (agent) return agent.id;

    // Last resort: create with identifier as wallet
    agent = await prisma.agent.create({ data: { wallet: identifier } });
    return agent.id;
}

export const reputationEngine = {
    /**
     * Get or create an agent's reputation record.
     * Handles both wallet pubkeys and UUIDs as agentId.
     */
    async getReputation(agentId: string) {
        // First resolve the identifier to a valid Agent.id
        const resolvedId = await resolveAgentId(agentId);

        let rep = await prisma.agentReputation.findUnique({ where: { agentId: resolvedId } });
        if (!rep) {
            rep = await prisma.agentReputation.create({
                data: { agentId: resolvedId, reputationScore: 50, tier: "new" },
            });
        }
        return rep;
    },

    /**
     * Record a completed deal — +5 reputation.
     */
    async recordCompletion(agentId: string): Promise<void> {
        const rep = await this.getReputation(agentId);
        const newScore = clampScore(rep.reputationScore + 5);
        const newTier = computeTier(newScore);
        await prisma.agentReputation.update({
            where: { agentId: rep.agentId },
            data: {
                completedDeals: { increment: 1 },
                reputationScore: newScore,
                tier: newTier,
            },
        });
        logger.info("reputation_updated", { agentId: rep.agentId, delta: +5, newScore, newTier, reason: "deal_completed" });
    },

    /**
     * Record a failed deal — -10 reputation.
     */
    async recordFailure(agentId: string): Promise<void> {
        const rep = await this.getReputation(agentId);
        const newScore = clampScore(rep.reputationScore - 10);
        const newTier = computeTier(newScore);
        await prisma.agentReputation.update({
            where: { agentId: rep.agentId },
            data: {
                failedDeals: { increment: 1 },
                reputationScore: newScore,
                tier: newTier,
            },
        });
        logger.info("reputation_updated", { agentId: rep.agentId, delta: -10, newScore, newTier, reason: "deal_failed" });
    },

    /**
     * Record a dispute loss — -15 reputation.
     */
    async recordDisputeLoss(agentId: string): Promise<void> {
        const rep = await this.getReputation(agentId);
        const newScore = clampScore(rep.reputationScore - 15);
        const newTier = computeTier(newScore);
        await prisma.agentReputation.update({
            where: { agentId: rep.agentId },
            data: {
                disputesLost: { increment: 1 },
                reputationScore: newScore,
                tier: newTier,
            },
        });
        logger.warn("reputation_updated", { agentId: rep.agentId, delta: -15, newScore, newTier, reason: "dispute_lost" });
    },

    /**
     * Record a timeout — -8 reputation.
     */
    async recordTimeout(agentId: string): Promise<void> {
        const rep = await this.getReputation(agentId);
        const newScore = clampScore(rep.reputationScore - 8);
        const newTier = computeTier(newScore);
        await prisma.agentReputation.update({
            where: { agentId: rep.agentId },
            data: {
                timeoutsCount: { increment: 1 },
                reputationScore: newScore,
                tier: newTier,
            },
        });
        logger.warn("reputation_updated", { agentId: rep.agentId, delta: -8, newScore, newTier, reason: "timeout" });
    },

    /**
     * Check if an agent is allowed to participate in a deal of given value.
     */
    async canParticipate(agentId: string, dealValueSol: number): Promise<{
        allowed: boolean;
        reason?: string;
        tier: ReputationTier;
        maxAllowed: number;
    }> {
        const rep = await this.getReputation(agentId);
        const tier = computeTier(rep.reputationScore);
        const maxAllowed = DEAL_VALUE_CAPS[tier];

        if (tier === "banned") {
            return { allowed: false, reason: "Agent is banned due to repeated violations", tier, maxAllowed: 0 };
        }

        if (dealValueSol > maxAllowed) {
            return {
                allowed: false,
                reason: `Deal value ${dealValueSol} SOL exceeds ${tier} tier cap of ${maxAllowed} SOL. Complete more deals to increase your limit.`,
                tier,
                maxAllowed,
            };
        }

        return { allowed: true, tier, maxAllowed };
    },

    /**
     * Get the deal value cap for an agent's current tier.
     */
    async getDealCap(agentId: string): Promise<number> {
        const rep = await this.getReputation(agentId);
        const tier = computeTier(rep.reputationScore);
        return DEAL_VALUE_CAPS[tier];
    },
};
