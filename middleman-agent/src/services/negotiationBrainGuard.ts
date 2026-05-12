import type { DealPipelineStage, PipelineStageRecord } from "../types/dealPipeline";

const POST_NEGOTIATION_CHAT_ONLY_STAGES = new Set<DealPipelineStage>([
  "awaiting_settlement_plan_approvals",
  "awaiting_buyer_release_confirmation",
  "seller_dispute_window",
  "awaiting_release_approvals",
  "release_authorized",
  "release_signed",
  "release_pending",
  "settled",
]);

export function shouldSkipNegotiationBrainAnalysis(
  latestStage: PipelineStageRecord | null
): boolean {
  return Boolean(
    latestStage &&
      latestStage.status === "confirmed" &&
      POST_NEGOTIATION_CHAT_ONLY_STAGES.has(latestStage.stage)
  );
}

