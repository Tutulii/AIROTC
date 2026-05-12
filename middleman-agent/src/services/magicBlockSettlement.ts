import { logger } from "../utils/logger";

/**
 * Deprecated pre-convergence adapter.
 *
 * The production stack no longer uses a dedicated MagicBlock settlement
 * orchestrator. All ER/PER execution must flow through `dealPipeline`.
 * This stub remains only to fail fast if stale imports survive elsewhere.
 */
export class MagicBlockSettlementOrchestrator {
  constructor() {
    logger.warn("deprecated_magicblock_settlement_orchestrator_constructed");
  }

  async executePrivateSettlement(): Promise<{ success: boolean; phase: string }> {
    throw new Error(
      "deprecated_magicblock_settlement_orchestrator_removed:use_deal_pipeline"
    );
  }
}
