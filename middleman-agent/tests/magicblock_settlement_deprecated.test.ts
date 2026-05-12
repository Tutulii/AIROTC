import { describe, expect, it } from "vitest";
import { MagicBlockSettlementOrchestrator } from "../src/services/magicBlockSettlement";

describe("MagicBlockSettlementOrchestrator", () => {
  it("fails fast because the unified deal pipeline is the only supported production route", async () => {
    const orchestrator = new MagicBlockSettlementOrchestrator();

    await expect(
      orchestrator.executePrivateSettlement()
    ).rejects.toThrow("deprecated_magicblock_settlement_orchestrator_removed");
  });
});
