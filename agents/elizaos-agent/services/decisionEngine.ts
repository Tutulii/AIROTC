import {
    type Character,
    type IAgentRuntime,
    ModelType,
    type ProviderResult,
} from "@elizaos/core";
import { z } from "zod";
import {
    type AgentLoopDecision,
    type AgentLoopSnapshot,
    dealTracker,
    type AgentLoopAction,
} from "./dealTracker.js";

const DecisionSchema = z.object({
    action: z.enum([
        "WAIT",
        "POST_OFFER",
        "BROWSE_AND_ACCEPT_OFFER",
        "COMPLETE_PRIVATE_AGREEMENT",
        "AUTO_FUND_PRIVATE_DEAL",
        "SEND_ENCRYPTED_DELIVERY",
        "CHECK_ENCRYPTED_DELIVERY",
        "CONFIRM_PRIVATE_DELIVERY",
        "COMPLETE_UMBRA_LIFECYCLE",
        "STOP",
    ] satisfies [AgentLoopAction, ...AgentLoopAction[]]),
    reason: z.string().min(1),
});

function extractJsonBlock(text: string): string | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
        return fenced[1].trim();
    }

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
        return text.slice(start, end + 1);
    }

    return null;
}

function buildPrompt(character: Character, provider: ProviderResult): string {
    return [
        character.system || "",
        "",
        "You are deciding the next deterministic SDK step for an AIR OTC external agent.",
        "Return JSON only with keys action and reason.",
        "Choose the smallest safe next action. Never invent capabilities that are not in the allowed list.",
        "",
        provider.text || "",
        "",
        "Valid action values:",
        '["WAIT","POST_OFFER","BROWSE_AND_ACCEPT_OFFER","COMPLETE_PRIVATE_AGREEMENT","AUTO_FUND_PRIVATE_DEAL","SEND_ENCRYPTED_DELIVERY","CHECK_ENCRYPTED_DELIVERY","CONFIRM_PRIVATE_DELIVERY","COMPLETE_UMBRA_LIFECYCLE","STOP"]',
        "",
        "Respond with compact JSON only.",
    ].join("\n");
}

function validateOrFallback(
    raw: string,
    snapshot: AgentLoopSnapshot
): AgentLoopDecision {
    const parsed = extractJsonBlock(raw);
    if (!parsed) {
        return dealTracker.getRecommendation();
    }

    try {
        const data = DecisionSchema.parse(JSON.parse(parsed));
        const recommendation = dealTracker.getRecommendation();

        if (recommendation.action === "STOP" && data.action !== "STOP") {
            return recommendation;
        }

        return data;
    } catch {
        return dealTracker.getRecommendation();
    }
}

export async function decideNextAction(args: {
    runtime: IAgentRuntime;
    character: Character;
    provider: ProviderResult;
    snapshot: AgentLoopSnapshot;
    useLlm: boolean;
}): Promise<AgentLoopDecision> {
    if (!args.useLlm) {
        return dealTracker.getRecommendation();
    }

    const prompt = buildPrompt(args.character, args.provider);
    try {
        const output = await args.runtime.useModel(ModelType.TEXT_SMALL, {
            prompt,
            temperature: 0.1,
            maxTokens: 220,
        });

        return validateOrFallback(output, args.snapshot);
    } catch {
        return dealTracker.getRecommendation();
    }
}
