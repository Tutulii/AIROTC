import type { PrivacyStatus } from "./privacyService";
import type { RollupMode } from "../types/ticket";
import type {
  DealPipelineContext,
  ExecutionPolicy,
  NegotiationOutcome,
  PipelineRoute,
  SettlementPolicy,
} from "../types/dealPipeline";

export interface PipelineRoutingInput {
  outcome: NegotiationOutcome;
  privacy: PrivacyStatus;
  enableConfidentialEscrow: boolean;
}

export interface PipelineRouteSelection {
  route: PipelineRoute;
  executionPolicy: ExecutionPolicy;
  settlementPolicy: SettlementPolicy;
  routeReason: string;
}

export function inferNegotiationSource(rollupMode: RollupMode): NegotiationOutcome["negotiationSource"] {
  if (rollupMode === "PER") return "PER";
  if (rollupMode === "ER") return "ER";
  return "OFFCHAIN";
}

export function resolvePipelineRoute(input: PipelineRoutingInput): PipelineRouteSelection {
  const { outcome, privacy, enableConfidentialEscrow } = input;

  if (outcome.rollupMode === "PER" && outcome.negotiationSource === "PER" && !enableConfidentialEscrow) {
    throw new Error("per_strict_opaque_requires_confidential_escrow_enabled");
  }

  // The main OTC execution contract is diagram-driven:
  // ER/PER negotiation must converge into the same confidential + stealth spine
  // before downstream settlement. Keeping this rule centralized here prevents
  // listeners and feature branches from silently drifting into alternate routes.
  if (enableConfidentialEscrow && (outcome.rollupMode === "PER" || outcome.rollupMode === "ER")) {
    return {
      route: "CONFIDENTIAL_ESCROW",
      executionPolicy: "CONFIDENTIAL",
      settlementPolicy: "STEALTH",
      routeReason: "rollup_converges_into_unified_confidential_stealth_pipeline",
    };
  }

  if (
    enableConfidentialEscrow &&
    privacy.isPrivacyMode &&
    (privacy.privacyProtocol === "MAGICBLOCK_PER" || privacy.privacyProtocol === "UMBRA")
  ) {
    return {
      route: "CONFIDENTIAL_ESCROW",
      executionPolicy: "CONFIDENTIAL",
      settlementPolicy: "STEALTH",
      routeReason: "privacy_mode_converges_into_unified_confidential_stealth_pipeline",
    };
  }

  if (privacy.isPrivacyMode && privacy.privacyProtocol === "UMBRA") {
    return {
      route: "STANDARD_ESCROW",
      executionPolicy: "STANDARD",
      settlementPolicy: "STEALTH",
      routeReason: "umbra_privacy_routes_through_stealth_settlement_pipeline",
    };
  }

  return {
    route: "STANDARD_ESCROW",
    executionPolicy: "STANDARD",
    settlementPolicy: "DIRECT",
    routeReason: "default_standard_escrow",
  };
}

export function buildPipelineContext(
  outcome: NegotiationOutcome,
  selection: PipelineRouteSelection
): DealPipelineContext {
  return {
    ...outcome,
    ...selection,
  };
}
