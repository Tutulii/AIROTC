import { describe, expect, it } from "vitest";
import {
  buildNormalModeProofBundle,
  computeNormalModeTermsHash,
  finalizeNormalModeProofBundle,
} from "../src/services/normalModeProofBundle";

const baseInput = {
  offerId: "offer-normal",
  ticketId: "ticket-normal",
  buyerWallet: "buyer-wallet",
  sellerWallet: "seller-wallet",
  escrowAddress: "escrow-pda",
  escrowProgramId: "escrow-program",
  terms: {
    asset: "SOL" as const,
    amountRaw: "1000000000",
    priceRaw: "50000000",
    collateralBuyerRaw: "5000000",
    collateralSellerRaw: "5000000",
  },
};

describe("normal mode proof bundle", () => {
  it("builds a happy-path proof bundle with all required invariants passing", () => {
    const bundle = buildNormalModeProofBundle({
      ...baseInput,
      scenario: "happy_path",
      generatedAt: "2026-05-31T00:00:00.000Z",
    });

    expect(bundle.mode).toBe("NORMAL_SOL_ESCROW");
    expect(bundle.evidenceScope).toBe("deterministic_devnet_harness");
    expect(bundle.route).toEqual({
      settlementRail: "SOL_ESCROW",
      privacyTier: "PUBLIC_SOL",
      confidentialComputeProvider: "NONE",
      rollupMode: "NONE",
      escrowRoute: "STANDARD_ESCROW",
      payoutRoute: "DIRECT",
      advancedProvidersInvoked: false,
    });
    expect(bundle.termsHash).toBe(computeNormalModeTermsHash(baseInput.terms));
    expect(bundle.evidence.release?.status).toBe("passed");
    expect(bundle.evidence.refund).toBeUndefined();
    expect(bundle.verdict).toBe("PASS_NORMAL_MODE_PROOF");
    expect(bundle.invariants.every((entry) => entry.passed)).toBe(true);
  });

  it("builds a refund proof bundle with terminal escrow and ticket state aligned", () => {
    const bundle = buildNormalModeProofBundle({
      ...baseInput,
      scenario: "timeout_refund",
    });

    expect(bundle.evidence.refund?.status).toBe("passed");
    expect(bundle.evidence.release).toBeUndefined();
    expect(bundle.finalState).toEqual({
      escrowState: "refunded",
      ticketState: "refunded",
    });
    expect(bundle.verdict).toBe("PASS_NORMAL_MODE_PROOF");
  });

  it("blocks if the provider-free Normal Mode route is mutated", () => {
    const bundle = buildNormalModeProofBundle({
      ...baseInput,
      scenario: "happy_path",
    });
    const mutated = finalizeNormalModeProofBundle({
      ...bundle,
      route: {
        ...bundle.route,
        confidentialComputeProvider: "ARCIUM" as any,
        advancedProvidersInvoked: true as false,
      },
    });

    expect(mutated.verdict).toBe("BLOCKED_NORMAL_MODE_PROOF");
    expect(mutated.blockers).toContain("normal_mode_route_is_standard_direct");
  });
});
