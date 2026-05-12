import { describe, expect, it, vi } from "vitest";
import { createStealthSettlementLifecycleService } from "../src/services/stealthSettlementLifecycleService";
import type { DealPipelineContext, DealPipelineStage, SettlementAddressPlan } from "../src/types/dealPipeline";

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
  rollupMode: "ER",
  negotiationSource: "ER",
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
    resolvedAddress: "buyer-stealth-wallet",
    status: "resolved",
  },
  sellerTarget: {
    role: "seller",
    strategy: "UMBRA_STEALTH",
    baseWallet: "seller-wallet",
    resolvedAddress: "seller-stealth-wallet",
    status: "resolved",
  },
  notes: ["Umbra registration verified."],
};

describe("stealthSettlementLifecycleService", () => {
  it("executes the full stealth lifecycle and reports each orchestrated stage", async () => {
    const initClient = vi.fn().mockResolvedValue(undefined);
    const ensureRegistered = vi.fn().mockResolvedValue([]);
    const ensureDealId = vi.fn().mockResolvedValue("deal-1");
    const ensureSettlement = vi.fn().mockResolvedValue({
      settlement: {
        id: "settlement-1",
        phase: "PENDING",
      },
    });
    const shieldCollateral = vi.fn().mockResolvedValue(undefined);
    const verifyBalances = vi.fn().mockResolvedValue(true);
    const executeSettlementUtxo = vi.fn().mockResolvedValue(true);
    const executeClaimUtxo = vi.fn().mockResolvedValue(true);
    const unshieldCollateral = vi.fn().mockResolvedValue(undefined);
    const getSettlement = vi
      .fn()
      .mockResolvedValueOnce({
        id: "settlement-1",
        phase: "BUYER_SHIELDED",
        buyerShieldTx: "buyer-shield-sig",
      })
      .mockResolvedValueOnce({
        id: "settlement-1",
        phase: "SHIELDED",
        buyerShieldTx: "buyer-shield-sig",
        sellerShieldTx: "seller-shield-sig",
      })
      .mockResolvedValueOnce({
        id: "settlement-1",
        phase: "BALANCES_VERIFIED",
        buyerShieldTx: "buyer-shield-sig",
        sellerShieldTx: "seller-shield-sig",
        buyerBalanceVerified: true,
        sellerBalanceVerified: true,
      })
      .mockResolvedValueOnce({
        id: "settlement-1",
        phase: "SETTLED",
        buyerShieldTx: "buyer-shield-sig",
        sellerShieldTx: "seller-shield-sig",
        buyerBalanceVerified: true,
        sellerBalanceVerified: true,
        settlementUtxoTx: "settlement-utxo-sig",
      })
      .mockResolvedValueOnce({
        id: "settlement-1",
        phase: "CLAIMED",
        buyerShieldTx: "buyer-shield-sig",
        sellerShieldTx: "seller-shield-sig",
        buyerBalanceVerified: true,
        sellerBalanceVerified: true,
        settlementUtxoTx: "settlement-utxo-sig",
        claimTx: "claim-sig",
      })
      .mockResolvedValueOnce({
        id: "settlement-1",
        phase: "BUYER_UNSHIELDED",
        buyerShieldTx: "buyer-shield-sig",
        sellerShieldTx: "seller-shield-sig",
        buyerBalanceVerified: true,
        sellerBalanceVerified: true,
        settlementUtxoTx: "settlement-utxo-sig",
        claimTx: "claim-sig",
        buyerUnshieldTx: "buyer-unshield-sig",
      })
      .mockResolvedValueOnce({
        id: "settlement-1",
        phase: "COMPLETED",
        buyerShieldTx: "buyer-shield-sig",
        sellerShieldTx: "seller-shield-sig",
        buyerBalanceVerified: true,
        sellerBalanceVerified: true,
        settlementUtxoTx: "settlement-utxo-sig",
        claimTx: "claim-sig",
        buyerUnshieldTx: "buyer-unshield-sig",
        sellerUnshieldTx: "seller-unshield-sig",
      });

    const stages: Array<{ stage: DealPipelineStage; details?: Record<string, unknown> }> = [];
    const service = createStealthSettlementLifecycleService({
      loadConfig: vi.fn().mockReturnValue({
        privateKey: "private-key",
        solanaRpcUrl: "https://rpc.test",
        network: "devnet",
        enableLegacyUmbraStealthLifecycle: true,
      }),
      loadWallet: vi.fn().mockReturnValue({
        secretKey: new Uint8Array([1, 2, 3]),
      }),
      pipelineStateStore: {
        ensureDealId,
      } as any,
      getUmbraService: vi.fn().mockReturnValue({
        initClient,
        ensureRegistered,
      }),
      createOrchestrator: vi.fn().mockReturnValue({
        ensureSettlement,
        shieldCollateral,
        verifyBalances,
        executeSettlementUtxo,
        executeClaimUtxo,
        unshieldCollateral,
        getSettlement,
      }),
    } as any);

    const result = await service.executeStealthSettlement(
      baseContext,
      stealthPlan,
      async (stage, details) => {
        stages.push({ stage, details });
      }
    );

    expect(initClient).toHaveBeenCalledTimes(1);
    expect(ensureRegistered).toHaveBeenCalledTimes(1);
    expect(ensureDealId).toHaveBeenCalledWith("ticket-1");
    expect(shieldCollateral).toHaveBeenNthCalledWith(
      1,
      "deal-1",
      "buyer",
      250000000n,
      "buyer-stealth-wallet"
    );
    expect(shieldCollateral).toHaveBeenNthCalledWith(
      2,
      "deal-1",
      "seller",
      350000000n,
      "seller-stealth-wallet"
    );
    expect(verifyBalances).toHaveBeenCalledWith("deal-1");
    expect(executeSettlementUtxo).toHaveBeenCalledWith(
      "deal-1",
      "buyer-stealth-wallet",
      1500000000n
    );
    expect(executeClaimUtxo).toHaveBeenCalledWith("deal-1");
    expect(unshieldCollateral).toHaveBeenNthCalledWith(
      1,
      "deal-1",
      "buyer",
      1500000000n,
      "buyer-stealth-wallet"
    );
    expect(unshieldCollateral).toHaveBeenNthCalledWith(
      2,
      "deal-1",
      "seller",
      350000000n,
      "seller-stealth-wallet"
    );
    expect(stages.map(({ stage }) => stage)).toEqual([
      "stealth_shielding",
      "stealth_balances_verified",
      "stealth_settling",
      "stealth_claiming",
    ]);
    expect(result).toEqual({
      dealId: "deal-1",
      settlementId: "settlement-1",
      phase: "COMPLETED",
      buyerShieldTx: "buyer-shield-sig",
      sellerShieldTx: "seller-shield-sig",
      settlementUtxoTx: "settlement-utxo-sig",
      claimTx: "claim-sig",
      buyerUnshieldTx: "buyer-unshield-sig",
      sellerUnshieldTx: "seller-unshield-sig",
    });
  });

  it("resumes idempotently from an already partially completed stealth settlement", async () => {
    const shieldCollateral = vi.fn().mockResolvedValue(undefined);
    const verifyBalances = vi.fn().mockResolvedValue(true);
    const executeSettlementUtxo = vi.fn().mockResolvedValue(true);
    const executeClaimUtxo = vi.fn().mockResolvedValue(true);
    const unshieldCollateral = vi.fn().mockResolvedValue(undefined);
    const getSettlement = vi.fn().mockResolvedValue({
      id: "settlement-1",
      phase: "COMPLETED",
      buyerShieldTx: "buyer-shield-sig",
      sellerShieldTx: "seller-shield-sig",
      buyerBalanceVerified: true,
      sellerBalanceVerified: true,
      settlementUtxoTx: "settlement-utxo-sig",
      claimTx: "claim-sig",
      buyerUnshieldTx: "buyer-unshield-sig",
      sellerUnshieldTx: "seller-unshield-sig",
    });

    const service = createStealthSettlementLifecycleService({
      loadConfig: vi.fn().mockReturnValue({
        privateKey: "private-key",
        solanaRpcUrl: "https://rpc.test",
        network: "devnet",
        enableLegacyUmbraStealthLifecycle: true,
      }),
      loadWallet: vi.fn().mockReturnValue({
        secretKey: new Uint8Array([1, 2, 3]),
      }),
      pipelineStateStore: {
        ensureDealId: vi.fn().mockResolvedValue("deal-1"),
      } as any,
      getUmbraService: vi.fn().mockReturnValue({
        initClient: vi.fn().mockResolvedValue(undefined),
        ensureRegistered: vi.fn().mockResolvedValue([]),
      }),
      createOrchestrator: vi.fn().mockReturnValue({
        ensureSettlement: vi.fn().mockResolvedValue({
          settlement: {
            id: "settlement-1",
            phase: "COMPLETED",
            buyerShieldTx: "buyer-shield-sig",
            sellerShieldTx: "seller-shield-sig",
            buyerBalanceVerified: true,
            sellerBalanceVerified: true,
            settlementUtxoTx: "settlement-utxo-sig",
            claimTx: "claim-sig",
            buyerUnshieldTx: "buyer-unshield-sig",
            sellerUnshieldTx: "seller-unshield-sig",
          },
        }),
        shieldCollateral,
        verifyBalances,
        executeSettlementUtxo,
        executeClaimUtxo,
        unshieldCollateral,
        getSettlement,
      }),
    } as any);

    const result = await service.executeStealthSettlement(baseContext, stealthPlan);

    expect(shieldCollateral).not.toHaveBeenCalled();
    expect(verifyBalances).not.toHaveBeenCalled();
    expect(executeSettlementUtxo).not.toHaveBeenCalled();
    expect(executeClaimUtxo).not.toHaveBeenCalled();
    expect(unshieldCollateral).not.toHaveBeenCalled();
    expect(getSettlement).not.toHaveBeenCalled();
    expect(result.phase).toBe("COMPLETED");
    expect(result.sellerUnshieldTx).toBe("seller-unshield-sig");
  });
});
