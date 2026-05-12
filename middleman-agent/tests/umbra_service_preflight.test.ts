import { afterEach, describe, expect, it, vi } from "vitest";
import { UmbraService } from "../src/services/umbraService";

describe("UmbraService indexer root preflight", () => {
  const previousRequireCurrentRoot = process.env.UMBRA_REQUIRE_CURRENT_PROOF_ROOT;

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousRequireCurrentRoot === undefined) {
      delete process.env.UMBRA_REQUIRE_CURRENT_PROOF_ROOT;
    } else {
      process.env.UMBRA_REQUIRE_CURRENT_PROOF_ROOT = previousRequireCurrentRoot;
    }
  });

  it("fails before spending when the hosted indexer root is stale", async () => {
    process.env.UMBRA_REQUIRE_CURRENT_PROOF_ROOT = "true";

    const service = new UmbraService(
      new Uint8Array(64),
      "https://api.devnet.solana.com",
      "devnet"
    );
    (service as any).client = {
      fetchBatchMerkleProof: vi.fn().mockResolvedValue({
        root: Uint8Array.from(Array(32).fill(1)),
        proofs: new Map(),
      }),
      signer: { address: "11111111111111111111111111111111" },
    };
    (service as any).fetchCurrentStealthPoolRoot = vi
      .fn()
      .mockResolvedValue(Uint8Array.from(Array(32).fill(2)));

    await expect(
      service.shieldCollateral(
        "So11111111111111111111111111111111111111112",
        1n
      )
    ).rejects.toThrow("Umbra indexer root is stale before shield collateral");
  });
});
