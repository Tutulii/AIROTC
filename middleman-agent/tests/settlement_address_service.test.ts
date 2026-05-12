import { describe, expect, it, vi } from "vitest";
import { createSettlementAddressPlanner } from "../src/services/settlementAddressService";
import type { DealPipelineContext } from "../src/types/dealPipeline";

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
  settlementPolicy: "DIRECT",
  routeReason: "test",
};

describe("settlementAddressService", () => {
  it("resolves direct settlement targets without Umbra lookup", async () => {
    const planner = createSettlementAddressPlanner({
      loadConfig: vi.fn() as any,
      loadWallet: vi.fn() as any,
      getUmbraService: vi.fn() as any,
      getSettlementTargetSnapshot: vi.fn() as any,
    });

    const result = await planner.prepareSettlementAddressPlan(baseContext);

    expect(result.resolution).toBe("resolved");
    expect(result.assetMint).toBe("So11111111111111111111111111111111111111112");
    expect(result.buyerTarget.resolvedAddress).toBe("buyer-wallet");
    expect(result.buyerTarget.resolvedAddressKind).toBe("participant_wallet");
    expect(result.sellerTarget.resolvedAddress).toBe("seller-wallet");
    expect(result.sellerTarget.resolvedAddressKind).toBe("participant_wallet");
  });

  it("resolves stealth settlement only when Umbra registration is verified", async () => {
    const umbra = {
      initClient: vi.fn().mockResolvedValue(undefined),
      ensureRegistered: vi.fn().mockResolvedValue([]),
      queryUserAccount: vi
        .fn()
        .mockResolvedValueOnce({ operator: true })
        .mockResolvedValueOnce({ buyer: true })
        .mockResolvedValueOnce({ seller: true }),
    };

    const planner = createSettlementAddressPlanner({
      loadConfig: vi.fn().mockReturnValue({
        privateKey: "private-key",
        solanaRpcUrl: "https://rpc.test",
        network: "devnet",
      }),
      loadWallet: vi.fn().mockReturnValue({
        secretKey: new Uint8Array([1, 2, 3]),
      }),
      getUmbraService: vi.fn().mockReturnValue(umbra),
      getSettlementTargetSnapshot: vi.fn().mockResolvedValue({
        buyerSettlementWallet: "buyer-stealth-wallet",
        sellerSettlementWallet: "seller-stealth-wallet",
      }),
    } as any);

    const result = await planner.prepareSettlementAddressPlan({
      ...baseContext,
      settlementPolicy: "STEALTH",
    });

    expect(result.resolution).toBe("resolved");
    expect(result.assetMint).toBe("So11111111111111111111111111111111111111112");
    expect(result.buyerTarget.strategy).toBe("UMBRA_STEALTH");
    expect(result.sellerTarget.strategy).toBe("UMBRA_STEALTH");
    expect(result.buyerTarget.resolvedAddress).toBe("buyer-stealth-wallet");
    expect(result.buyerTarget.resolvedAddressKind).toBe("umbra_registered_receiver_wallet");
    expect(result.sellerTarget.resolvedAddress).toBe("seller-stealth-wallet");
    expect(result.sellerTarget.resolvedAddressKind).toBe("umbra_registered_receiver_wallet");
    expect(result.notes.some((note) => note.includes("fresh per-deal Umbra receiver wallets"))).toBe(
      true
    );
    expect(umbra.initClient).toHaveBeenCalledTimes(1);
    expect(umbra.queryUserAccount).toHaveBeenCalledTimes(3);
  });

  it("fails closed when a stealth counterparty is not Umbra-registered", async () => {
    const umbra = {
      initClient: vi.fn().mockResolvedValue(undefined),
      ensureRegistered: vi.fn().mockResolvedValue([]),
      queryUserAccount: vi
        .fn()
        .mockResolvedValueOnce({ operator: true })
        .mockResolvedValueOnce({ buyer: true })
        .mockResolvedValueOnce(null),
    };

    const planner = createSettlementAddressPlanner({
      loadConfig: vi.fn().mockReturnValue({
        privateKey: "private-key",
        solanaRpcUrl: "https://rpc.test",
        network: "devnet",
      }),
      loadWallet: vi.fn().mockReturnValue({
        secretKey: new Uint8Array([1, 2, 3]),
      }),
      getUmbraService: vi.fn().mockReturnValue(umbra),
      getSettlementTargetSnapshot: vi.fn().mockResolvedValue({
        buyerSettlementWallet: "buyer-stealth-wallet",
        sellerSettlementWallet: "seller-stealth-wallet",
      }),
    } as any);

    await expect(
      planner.prepareSettlementAddressPlan({
        ...baseContext,
        settlementPolicy: "STEALTH",
      })
    ).rejects.toThrow("Umbra registration missing");
  });

  it("self-registers the operator before resolving registered Umbra receiver wallets", async () => {
    const umbra = {
      initClient: vi.fn().mockResolvedValue(undefined),
      ensureRegistered: vi.fn().mockResolvedValue([]),
      queryUserAccount: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ buyer: true })
        .mockResolvedValueOnce({ seller: true }),
    };

    const planner = createSettlementAddressPlanner({
      loadConfig: vi.fn().mockReturnValue({
        privateKey: "private-key",
        solanaRpcUrl: "https://rpc.test",
        network: "devnet",
      }),
      loadWallet: vi.fn().mockReturnValue({
        secretKey: new Uint8Array([1, 2, 3]),
      }),
      getUmbraService: vi.fn().mockReturnValue(umbra),
      getSettlementTargetSnapshot: vi.fn().mockResolvedValue({
        buyerSettlementWallet: "buyer-stealth-wallet",
        sellerSettlementWallet: "seller-stealth-wallet",
      }),
    } as any);

    const result = await planner.prepareSettlementAddressPlan({
      ...baseContext,
      settlementPolicy: "STEALTH",
    });

    expect(result.buyerTarget.resolvedAddress).toBe("buyer-stealth-wallet");
    expect(result.sellerTarget.resolvedAddress).toBe("seller-stealth-wallet");
    expect(umbra.ensureRegistered).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the negotiated asset is not Umbra-supported", async () => {
    const planner = createSettlementAddressPlanner({
      loadConfig: vi.fn().mockReturnValue({
        privateKey: "private-key",
        solanaRpcUrl: "https://rpc.test",
        network: "devnet",
      }),
      loadWallet: vi.fn().mockReturnValue({
        secretKey: new Uint8Array([1, 2, 3]),
      }),
      getUmbraService: vi.fn(),
      getSettlementTargetSnapshot: vi.fn().mockResolvedValue({
        buyerSettlementWallet: "buyer-stealth-wallet",
        sellerSettlementWallet: "seller-stealth-wallet",
      }),
    } as any);

    await expect(
      planner.prepareSettlementAddressPlan({
        ...baseContext,
        settlementPolicy: "STEALTH",
        assetType: "BONK",
        tokenMint: "unsupported-mint",
      })
    ).rejects.toThrow("Umbra stealth settlement does not support negotiated asset");
  });

  it("fails closed when a stealth deal has no fresh per-deal settlement wallets", async () => {
    const planner = createSettlementAddressPlanner({
      loadConfig: vi.fn().mockReturnValue({
        privateKey: "private-key",
        solanaRpcUrl: "https://rpc.test",
        network: "devnet",
      }),
      loadWallet: vi.fn().mockReturnValue({
        secretKey: new Uint8Array([1, 2, 3]),
      }),
      getUmbraService: vi.fn(),
      getSettlementTargetSnapshot: vi.fn().mockResolvedValue(null),
    } as any);

    await expect(
      planner.prepareSettlementAddressPlan({
        ...baseContext,
        settlementPolicy: "STEALTH",
      })
    ).rejects.toThrow("Fresh Umbra settlement wallets are missing");
  });
});
