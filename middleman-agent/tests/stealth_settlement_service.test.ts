import { afterEach, describe, expect, it, vi } from "vitest";
import { createStealthSettlementService } from "../src/services/stealthSettlementService";
import type { DealPipelineContext, SettlementAddressPlan } from "../src/types/dealPipeline";

const baseContext: DealPipelineContext = {
  ticketId: "ticket-1",
  buyer: "buyer-wallet",
  seller: "seller-wallet",
  price: 1.5,
  collateralBuyer: 0.25,
  collateralSeller: 0.35,
  assetType: "SOL",
  tokenMint: "So11111111111111111111111111111111111111112",
  confidence: 100,
  rollupMode: "NONE",
  negotiationSource: "OFFCHAIN",
  route: "STANDARD_ESCROW",
  executionPolicy: "STANDARD",
  settlementPolicy: "STEALTH",
  routeReason: "test",
};

const stealthPlan: SettlementAddressPlan = {
  policy: "STEALTH",
  resolution: "resolved",
  assetMint: "So11111111111111111111111111111111111111112",
  buyerTarget: {
    role: "buyer",
    strategy: "UMBRA_STEALTH",
    baseWallet: "buyer-wallet",
    resolvedAddress: "buyer-wallet",
    status: "resolved",
  },
  sellerTarget: {
    role: "seller",
    strategy: "UMBRA_STEALTH",
    baseWallet: "seller-wallet",
    resolvedAddress: "seller-wallet",
    status: "resolved",
  },
  notes: ["Umbra registration verified."],
};

describe("stealthSettlementService", () => {
  afterEach(() => {
    delete process.env.UMBRA_SETTLEMENT_LIFECYCLE_MODE;
    delete process.env.AIROTC_REQUIRE_FULL_UMBRA;
    delete process.env.AIROTC_UMBRA_LIFECYCLE_AMOUNT_LAMPORTS;
  });

  it("creates an idempotent stealth settlement record tied to the pipeline deal", async () => {
    const ensureSettlement = vi.fn().mockResolvedValue({
      settlement: {
        id: "settlement-1",
        dealId: "deal-1",
        mint: "So11111111111111111111111111111111111111112",
        phase: "PENDING",
      },
      created: true,
    });

    const service = createStealthSettlementService({
      loadConfig: vi.fn().mockReturnValue({
        privateKey: "private-key",
        solanaRpcUrl: "https://rpc.test",
        network: "devnet",
      }),
      loadWallet: vi.fn().mockReturnValue({
        secretKey: new Uint8Array([1, 2, 3]),
      }),
      pipelineStateStore: {
        ensureDealId: vi.fn().mockResolvedValue("deal-1"),
      } as any,
      getUmbraService: vi.fn().mockReturnValue({}),
      createOrchestrator: vi.fn().mockReturnValue({
        ensureSettlement,
      }),
      prepareReceiverSettlementRecord: vi.fn().mockResolvedValue({
        phase: "RECEIVER_WALLETS_READY",
        lifecycleMode: "RECEIVER_WALLET_ONLY",
      }),
      walletRegistry: { getOrCreateAgent: vi.fn() },
      deliverStructuredToAgent: vi.fn(),
    } as any);

    const result = await service.prepareStealthSettlement(baseContext, stealthPlan);

    expect(result).toEqual({
      dealId: "deal-1",
      settlementId: "settlement-1",
      mint: "So11111111111111111111111111111111111111112",
      phase: "RECEIVER_WALLETS_READY",
      created: true,
    });
    expect(ensureSettlement).toHaveBeenCalledWith(
      "deal-1",
      "So11111111111111111111111111111111111111112"
    );
  });

  it("sends explicit lifecycle requests when full Umbra mode is enabled", async () => {
    process.env.UMBRA_SETTLEMENT_LIFECYCLE_MODE = "FULL_UMBRA";
    const ensureSettlement = vi.fn().mockResolvedValue({
      settlement: {
        id: "settlement-full-1",
        dealId: "deal-full-1",
        mint: "So11111111111111111111111111111111111111112",
        phase: "PENDING",
      },
      created: false,
    });
    const deliverStructuredToAgent = vi.fn().mockResolvedValue(undefined);
    const getOrCreateAgent = vi
      .fn()
      .mockResolvedValueOnce({ id: "buyer-agent" })
      .mockResolvedValueOnce({ id: "seller-agent" });

    const service = createStealthSettlementService({
      loadConfig: vi.fn().mockReturnValue({
        privateKey: "private-key",
        solanaRpcUrl: "https://rpc.test",
        network: "devnet",
      }),
      loadWallet: vi.fn().mockReturnValue({
        secretKey: new Uint8Array([1, 2, 3]),
      }),
      pipelineStateStore: {
        ensureDealId: vi.fn().mockResolvedValue("deal-full-1"),
      } as any,
      getUmbraService: vi.fn().mockReturnValue({}),
      createOrchestrator: vi.fn().mockReturnValue({
        ensureSettlement,
      }),
      prepareReceiverSettlementRecord: vi.fn().mockResolvedValue({
        phase: "FULL_LIFECYCLE_PENDING",
        lifecycleMode: "FULL_UMBRA",
      }),
      walletRegistry: { getOrCreateAgent },
      deliverStructuredToAgent,
    } as any);

    const result = await service.prepareStealthSettlement(baseContext, stealthPlan);

    expect(result.phase).toBe("FULL_LIFECYCLE_PENDING");
    expect(getOrCreateAgent).toHaveBeenCalledWith("buyer-wallet");
    expect(getOrCreateAgent).toHaveBeenCalledWith("seller-wallet");
    expect(deliverStructuredToAgent).toHaveBeenCalledTimes(2);
    expect(deliverStructuredToAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: "buyer-agent",
        phase: "umbra_lifecycle_requested",
        payload: expect.objectContaining({
          type: "UMBRA_LIFECYCLE_REQUEST",
          payload: expect.objectContaining({
            settlementId: "settlement-full-1",
            role: "buyer",
            requiredPhases: ["SHIELD", "CREATE_UTXO", "CLAIM", "UNSHIELD"],
            amountLamports: "250000000",
            finalWalletRequired: true,
          }),
        }),
      })
    );
    expect(deliverStructuredToAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agentId: "seller-agent",
        payload: expect.objectContaining({
          payload: expect.objectContaining({
            role: "seller",
            amountLamports: "1850000000",
          }),
        }),
      })
    );
  });

  it("forces full Umbra lifecycle for strict private PER even without an env override", async () => {
    const strictPerContext: DealPipelineContext = {
      ...baseContext,
      rollupMode: "PER",
      negotiationSource: "PER",
      route: "CONFIDENTIAL_ESCROW",
      executionPolicy: "CONFIDENTIAL",
    };
    const deliverStructuredToAgent = vi.fn().mockResolvedValue(undefined);
    const getOrCreateAgent = vi
      .fn()
      .mockResolvedValueOnce({ id: "buyer-agent" })
      .mockResolvedValueOnce({ id: "seller-agent" });
    const prepareReceiverSettlementRecord = vi.fn().mockResolvedValue({
      phase: "FULL_LIFECYCLE_PENDING",
      lifecycleMode: "FULL_UMBRA",
    });

    const service = createStealthSettlementService({
      loadConfig: vi.fn().mockReturnValue({
        privateKey: "private-key",
        solanaRpcUrl: "https://rpc.test",
        network: "devnet",
        perStrictOpaqueMode: true,
        perFundingPrivacyTier: "SHIELDED_CREDIT",
        requireFullUmbraLifecycle: false,
        umbraSettlementLifecycleMode: "RECEIVER_WALLET_ONLY",
      }),
      loadWallet: vi.fn().mockReturnValue({
        secretKey: new Uint8Array([1, 2, 3]),
      }),
      pipelineStateStore: {
        ensureDealId: vi.fn().mockResolvedValue("deal-strict-per"),
      } as any,
      getUmbraService: vi.fn().mockReturnValue({}),
      createOrchestrator: vi.fn().mockReturnValue({
        ensureSettlement: vi.fn().mockResolvedValue({
          settlement: {
            id: "settlement-strict-per",
            dealId: "deal-strict-per",
            mint: "So11111111111111111111111111111111111111112",
            phase: "PENDING",
          },
          created: false,
        }),
      }),
      prepareReceiverSettlementRecord,
      walletRegistry: { getOrCreateAgent },
      deliverStructuredToAgent,
    } as any);

    const result = await service.prepareStealthSettlement(strictPerContext, stealthPlan);

    expect(result.phase).toBe("FULL_LIFECYCLE_PENDING");
    expect(prepareReceiverSettlementRecord).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycleMode: "FULL_UMBRA" })
    );
    expect(deliverStructuredToAgent).toHaveBeenCalledTimes(2);
  });

  it("supports a positive explicit Umbra lifecycle amount override for deterministic demos", async () => {
    process.env.UMBRA_SETTLEMENT_LIFECYCLE_MODE = "FULL_UMBRA";
    process.env.AIROTC_UMBRA_LIFECYCLE_AMOUNT_LAMPORTS = "12345";
    const ensureSettlement = vi.fn().mockResolvedValue({
      settlement: {
        id: "settlement-full-override",
        dealId: "deal-full-override",
        mint: "So11111111111111111111111111111111111111112",
        phase: "PENDING",
      },
      created: false,
    });
    const deliverStructuredToAgent = vi.fn().mockResolvedValue(undefined);
    const getOrCreateAgent = vi
      .fn()
      .mockResolvedValueOnce({ id: "buyer-agent" })
      .mockResolvedValueOnce({ id: "seller-agent" });

    const service = createStealthSettlementService({
      loadConfig: vi.fn().mockReturnValue({
        privateKey: "private-key",
        solanaRpcUrl: "https://rpc.test",
        network: "devnet",
      }),
      loadWallet: vi.fn().mockReturnValue({
        secretKey: new Uint8Array([1, 2, 3]),
      }),
      pipelineStateStore: {
        ensureDealId: vi.fn().mockResolvedValue("deal-full-override"),
      } as any,
      getUmbraService: vi.fn().mockReturnValue({}),
      createOrchestrator: vi.fn().mockReturnValue({
        ensureSettlement,
      }),
      prepareReceiverSettlementRecord: vi.fn().mockResolvedValue({
        phase: "FULL_LIFECYCLE_PENDING",
        lifecycleMode: "FULL_UMBRA",
      }),
      walletRegistry: { getOrCreateAgent },
      deliverStructuredToAgent,
    } as any);

    await service.prepareStealthSettlement(baseContext, stealthPlan);

    for (const call of deliverStructuredToAgent.mock.calls) {
      expect(call[0].payload.payload.amountLamports).toBe("12345");
    }
  });

  it("does not derive full-Umbra amounts from redacted placeholder PER terms", async () => {
    process.env.UMBRA_SETTLEMENT_LIFECYCLE_MODE = "FULL_UMBRA";
    const deliverStructuredToAgent = vi.fn().mockResolvedValue(undefined);
    const service = createStealthSettlementService({
      loadConfig: vi.fn().mockReturnValue({
        privateKey: "private-key",
        solanaRpcUrl: "https://rpc.test",
        network: "devnet",
      }),
      loadWallet: vi.fn().mockReturnValue({
        secretKey: new Uint8Array([1, 2, 3]),
      }),
      pipelineStateStore: {
        ensureDealId: vi.fn().mockResolvedValue("deal-redacted"),
      } as any,
      getUmbraService: vi.fn().mockReturnValue({}),
      createOrchestrator: vi.fn().mockReturnValue({
        ensureSettlement: vi.fn().mockResolvedValue({
          settlement: {
            id: "settlement-redacted",
            dealId: "deal-redacted",
            mint: "So11111111111111111111111111111111111111112",
            phase: "PENDING",
          },
          created: false,
        }),
      }),
      prepareReceiverSettlementRecord: vi.fn().mockResolvedValue({
        phase: "FULL_LIFECYCLE_PENDING",
        lifecycleMode: "FULL_UMBRA",
      }),
      walletRegistry: {
        getOrCreateAgent: vi
          .fn()
          .mockResolvedValueOnce({ id: "buyer-agent" })
          .mockResolvedValueOnce({ id: "seller-agent" }),
      },
      deliverStructuredToAgent,
    } as any);

    await service.prepareStealthSettlement(
      {
        ...baseContext,
        price: 0,
        collateralBuyer: 0,
        collateralSeller: 0,
        termsVisibility: "REDACTED",
      },
      stealthPlan
    );

    for (const call of deliverStructuredToAgent.mock.calls) {
      expect(call[0].payload.payload.amountLamports).toBeUndefined();
    }
  });

  it("fails closed when the settlement plan does not resolve a supported mint", async () => {
    const service = createStealthSettlementService({
      loadConfig: vi.fn(),
      loadWallet: vi.fn(),
      pipelineStateStore: {
        ensureDealId: vi.fn(),
      } as any,
      getUmbraService: vi.fn(),
      createOrchestrator: vi.fn(),
      prepareReceiverSettlementRecord: vi.fn(),
      walletRegistry: { getOrCreateAgent: vi.fn() },
      deliverStructuredToAgent: vi.fn(),
    } as any);

    await expect(
      service.prepareStealthSettlement(baseContext, {
        ...stealthPlan,
        assetMint: undefined,
      })
    ).rejects.toThrow("Stealth settlement requires a resolved Umbra-supported mint");
  });
});
