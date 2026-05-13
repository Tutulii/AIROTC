import type {
    IAgentRuntime,
    Memory,
    Provider,
    ProviderResult,
    State,
} from "@elizaos/core";
import { buildSnapshotSummary, dealTracker } from "../services/dealTracker.js";

export async function buildAirotcProviderResult(): Promise<ProviderResult> {
    const snapshot = dealTracker.getSnapshot();
    const recommendation = dealTracker.getRecommendation();

    return {
        text: [
            "AIR OTC external agent state:",
            buildSnapshotSummary(snapshot),
            "",
            `Safe next action candidate: ${recommendation.action}`,
            `Reason: ${recommendation.reason}`,
        ].join("\n"),
        values: {
            role: snapshot.role,
            phase: snapshot.currentPhase,
            ticketId: snapshot.activeTicketId ?? "",
            wallet: snapshot.wallet ?? "",
        },
        data: {
            snapshot,
            recommendation,
        },
    };
}

export const airotcProvider: Provider = {
    name: "air-otc-state",
    description: "Live AIR OTC external-agent state, market snapshot, and recommended safe next action.",
    dynamic: true,
    get: async (_runtime: IAgentRuntime, _message: Memory, _state: State) => {
        return buildAirotcProviderResult();
    },
};
