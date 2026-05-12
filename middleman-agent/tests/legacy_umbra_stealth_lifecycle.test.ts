import { describe, expect, it, vi } from "vitest";
import { createDealPipeline } from "../src/services/dealPipeline";

const umbraPrivacy = {
  isPrivacyMode: true,
  privacyProtocol: "UMBRA" as const,
  termsHash: "hash",
  termsRevealed: false,
  canReveal: false,
};

const stealthPlan = {
  policy: "STEALTH" as const,
  resolution: "resolved" as const,
  assetMint: "So11111111111111111111111111111111111111112",
  buyerTarget: {
    role: "buyer" as const,
    strategy: "UMBRA_STEALTH" as const,
    baseWallet: "buyer-wallet",
    resolvedAddress: "buyer-wallet",
    resolvedAddressKind: "umbra_registered_receiver_wallet" as const,
    status: "resolved" as const,
  },
  sellerTarget: {
    role: "seller" as const,
    strategy: "UMBRA_STEALTH" as const,
    baseWallet: "seller-wallet",
    resolvedAddress: "seller-wallet",
    resolvedAddressKind: "umbra_registered_receiver_wallet" as const,
    status: "resolved" as const,
  },
  notes: ["Umbra registration verified."],
};

function buildDeps(overrides?: Partial<Record<string, any>>) {
  return {
    loadConfig: () =>
      ({
        enableConfidentialEscrow: false,
        enableLegacyUmbraStealthLifecycle: false,
      } as any),
    ticketStore: {
      getTicket: vi.fn().mockResolvedValue({
        ticket_id: "ticket-umbra-1",
        offer_id: "offer-umbra-1",
        buyer: "buyer-wallet",
        seller: "seller-wallet",
        status: "active",
        rollup_mode: "NONE",
        created_at: new Date().toISOString(),
      }),
      recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
    },
    privateEscrowIntentStore: {
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    dealTracker: {
      initDeal: vi.fn().mockResolvedValue(undefined),
      storeOnChainId: vi.fn().mockResolvedValue(undefined),
      updateStatus: vi.fn().mockResolvedValue(undefined),
    },
    getPrivacyStatus: vi.fn().mockResolvedValue(umbraPrivacy),
    pipelineStateStore: {
      markStage: vi.fn().mockResolvedValue(undefined),
      markRouteSelected: vi.fn().mockResolvedValue(undefined),
      getLatestStage: vi.fn().mockResolvedValue(null),
    },
    eventBus: {
      publish: vi.fn(),
    },
    appendAuditLog: vi.fn().mockResolvedValue(undefined),
    executeCreateDealPhase: vi.fn(),
    isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
    initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
    executeConfidentialDeal: vi.fn(),
    prepareConfidentialSettlementAfterFunding: vi.fn(),
    authorizeConfidentialRelease: vi.fn(),
    executeConfidentialRelease: vi.fn(),
    confidentialFundingService: {
      initializeFundingRequests: vi.fn(),
      getLatestState: vi.fn(),
    },
    releaseApprovalService: {
      initializeApprovalRequests: vi.fn(),
      getLatestState: vi.fn(),
      maybeAuthorizeRelease: vi.fn(),
      markReleaseSigned: vi.fn(),
      markReleaseExecuted: vi.fn(),
    },
    verifyNegotiationForExecution: vi.fn().mockResolvedValue({
      verificationLevel: "policy_only",
      provider: "SOLANA_RPC",
      verificationScope: "balance_readiness",
      sellerWallet: "seller-wallet",
      checkedAt: new Date().toISOString(),
      reason: "umbra_privacy_mode",
    }),
    prepareSettlementAddressPlan: vi.fn().mockResolvedValue(stealthPlan),
    prepareStealthSettlement: vi.fn().mockResolvedValue({
      dealId: "deal-1",
      settlementId: "settlement-1",
      mint: stealthPlan.assetMint,
      phase: "PENDING",
      created: true,
    }),
    executeStealthSettlement: vi.fn().mockResolvedValue({
      dealId: "deal-1",
      settlementId: "settlement-1",
      phase: "COMPLETED",
      buyerShieldTx: "buyer-shield",
      sellerShieldTx: "seller-shield",
      settlementUtxoTx: "settlement-utxo",
      claimTx: "claim-tx",
      buyerUnshieldTx: "buyer-unshield",
      sellerUnshieldTx: "seller-unshield",
    }),
    activateStandardEscrowLifecycle: vi.fn(),
    magicBlockSessions: {
      finalizePrivateTicket: vi.fn(),
      completeTicketSession: vi.fn(),
      fetchLivePrivateHandoffProof: vi.fn(),
    },
    ...overrides,
  };
}

describe("legacy Umbra stealth lifecycle", () => {
  it("fails closed by default for standalone standard stealth routing", async () => {
    const deps = buildDeps();
    const pipeline = createDealPipeline(deps as any);

    await expect(
      pipeline.start({
        ticketId: "ticket-umbra-1",
        buyer: "buyer-wallet",
        seller: "seller-wallet",
        price: 1.5,
        collateralBuyer: 0.25,
        collateralSeller: 0.35,
        assetType: "SOL",
        confidence: 100,
        rollupMode: "NONE",
        negotiationSource: "OFFCHAIN",
      })
    ).rejects.toThrow("legacy_umbra_stealth_lifecycle_test_only");

    expect(deps.executeStealthSettlement).not.toHaveBeenCalled();
  });

  it("runs only when the legacy standalone Umbra lifecycle is explicitly re-enabled in test mode", async () => {
    vi.stubEnv("NODE_ENV", "test");
    try {
      const deps = buildDeps({
        loadConfig: () =>
          ({
            enableConfidentialEscrow: false,
            enableLegacyUmbraStealthLifecycle: true,
          } as any),
      });
      const pipeline = createDealPipeline(deps as any);

      const result = await pipeline.start({
        ticketId: "ticket-umbra-1",
        buyer: "buyer-wallet",
        seller: "seller-wallet",
        price: 1.5,
        collateralBuyer: 0.25,
        collateralSeller: 0.35,
        assetType: "SOL",
        confidence: 100,
        rollupMode: "NONE",
        negotiationSource: "OFFCHAIN",
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("settled");
      expect(deps.executeStealthSettlement).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still fails closed outside test mode even if the legacy flag is manually enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const deps = buildDeps({
        loadConfig: () =>
          ({
            enableConfidentialEscrow: false,
            enableLegacyUmbraStealthLifecycle: true,
          } as any),
      });
      const pipeline = createDealPipeline(deps as any);

      await expect(
        pipeline.start({
          ticketId: "ticket-umbra-1",
          buyer: "buyer-wallet",
          seller: "seller-wallet",
          price: 1.5,
          collateralBuyer: 0.25,
          collateralSeller: 0.35,
          assetType: "SOL",
          confidence: 100,
          rollupMode: "NONE",
          negotiationSource: "OFFCHAIN",
        })
      ).rejects.toThrow("legacy_umbra_stealth_lifecycle_test_only");

      expect(deps.executeStealthSettlement).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
