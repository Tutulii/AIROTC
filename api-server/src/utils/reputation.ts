import { logger } from '../lib/logger';
export interface AgentReputationStats {
    totalDeals: number;
    successfulDeals: number;
    cancelledDeals: number;
    disputedDeals: number;
    totalVolume: string; // lamports
    avgSettlementTime: number; // seconds
}

export const getTier = (score: number, totalDeals: number): string => {
    if (totalDeals === 0) return "new";
    if (score > 80) return "elite";
    if (score > 60) return "trusted";
    if (score > 40) return "neutral";
    return "risky";
};

export const calculateReputation = (agent: AgentReputationStats, options: { log?: boolean } = {}): number => {
    const shouldLog = options.log !== false;

    // Zero Activity Penalty
    if (agent.totalDeals === 0) {
        return 5;
    }

    // 1. Normalized Metrics
    const successRate = agent.successfulDeals / agent.totalDeals;
    const disputeRate = agent.disputedDeals / agent.totalDeals;

    const volume = Number(agent.totalVolume);
    const safeVolume = isNaN(volume) ? 0 : Math.max(0, volume);
    const volumeScore = Math.log10(safeVolume + 1);

    // 2. Confidence Multiplier
    const confidence = Math.min(1, Math.log10(agent.totalDeals + 1) / 2);

    // 3. Speed Score
    const speedScore = 1 / (1 + agent.avgSettlementTime / 600);

    // 4. Core Score Formula
    const baseScore =
        (successRate * 50) +
        ((1 - disputeRate) * 25) +
        (volumeScore * 15) +
        (speedScore * 10);

    // 5. Apply Confidence
    let finalScore = baseScore * confidence;

    // 6. Penalty Rules
    if (disputeRate > 0.2) {
        finalScore *= 0.7;
    }

    // 7. Normalization
    finalScore = Math.max(0, Math.min(100, finalScore));
    const roundedScore = Math.round(finalScore);

    // 8. Demo Logging
    if (shouldLog) {
        logger.info("info", { detail: `[REPUTATION ENGINE]` });
        logger.info("info", { detail: `Deals: ${agent.totalDeals} | Volume: ${agent.totalVolume}` });
        logger.info("info", { detail: `Score: ${roundedScore} → Tier: ${getTier(roundedScore, agent.totalDeals)}` });
    }

    return roundedScore;
};

export const calculateVisibleReputation = (agent: AgentReputationStats): number => {
    if (agent.totalDeals === 0) return 0;
    return calculateReputation(agent, { log: false });
};
