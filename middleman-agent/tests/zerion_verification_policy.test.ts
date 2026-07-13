import { describe, expect, it, vi } from "vitest";
import { createNegotiationVerifier } from "../src/services/zerionVerificationService";
import { UMBRA_SUPPORTED_MINTS } from "../src/services/umbraService";
import type { DealPipelineContext } from "../src/types/dealPipeline";

const baseContext: DealPipelineContext = {
  ticketId: "zerion-policy-test",
  buyer: "8btGrSJRTMnWUn3F4a8JSxC8U1Uw5XTfNUSUq9FKfN7h",
  seller: "A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd",
  price: 0.001,
  collateralBuyer: 0,
  collateralSeller: 0.001,
  assetType: "SOL",
  confidence: 100,
  rollupMode: "ER",
  negotiationSource: "ER",
  route: "CONFIDENTIAL_ESCROW",
  executionPolicy: "CONFIDENTIAL",
  settlementPolicy: "STEALTH",
  routeReason: "test",
};

function buildDeps(overrides?: {
  network?: "devnet" | "mainnet-beta";
  zerionVerificationMode?: "hybrid" | "strict" | "rpc_only";
  zerionApiKey?: string | undefined;
  httpGetImpl?: () => Promise<any>;
  validateEconomicSafety?: ReturnType<typeof vi.fn>;
}) {
  return {
    getConnection: () =>
      ({
        getBalanceAndContext: vi.fn().mockResolvedValue({
          value: 5_000_000,
          context: { slot: 123 },
        }),
      }) as any,
    withRetry: async (fn: any) => fn(),
    loadConfig: () =>
      ({
        network: overrides?.network ?? "devnet",
        zerionApiKey: overrides?.zerionApiKey,
        zerionApiBaseUrl: "https://api.zerion.io/v1",
        zerionVerificationMode: overrides?.zerionVerificationMode ?? "hybrid",
      }) as any,
    httpGet: overrides?.httpGetImpl ?? vi.fn(),
    validateEconomicSafety:
      overrides?.validateEconomicSafety ??
      vi.fn().mockResolvedValue({
        valid: true,
        errors: [],
        warnings: [],
      }),
  };
}

describe("Zerion verification policy", () => {
  it("uses RPC fallback on devnet in hybrid mode", async () => {
    const verifier = createNegotiationVerifier(
      buildDeps({
        network: "devnet",
        zerionVerificationMode: "hybrid",
        zerionApiKey: "redacted",
      }) as any
    );

    const summary = await verifier.verifyNegotiationForExecution(baseContext);

    expect(summary.provider).toBe("SOLANA_RPC");
    expect(summary.verificationScope).toBe("balance_readiness");
    expect(summary.validationSources).toEqual(["SOLANA_RPC"]);
    expect(summary.fallbackReason).toBe("zerion_api_not_supported_for_runtime_network");
    expect(summary.reason).toBe("rpc_balance_check_used_on_non_mainnet_runtime");
  });

  it("fails closed on devnet when strict Zerion verification is requested", async () => {
    const verifier = createNegotiationVerifier(
      buildDeps({
        network: "devnet",
        zerionVerificationMode: "strict",
        zerionApiKey: "redacted",
      }) as any
    );

    await expect(verifier.verifyNegotiationForExecution(baseContext)).rejects.toThrow(
      "zerion_verification_required"
    );
  });

  it("fails closed on mainnet when strict mode is enabled but no Zerion key is configured", async () => {
    const verifier = createNegotiationVerifier(
      buildDeps({
        network: "mainnet-beta",
        zerionVerificationMode: "strict",
        zerionApiKey: undefined,
      }) as any
    );

    await expect(verifier.verifyNegotiationForExecution(baseContext)).rejects.toThrow(
      "zerion_verification_required"
    );
  });

  it("accepts Zerion as primary on mainnet when strict mode succeeds", async () => {
    const verifier = createNegotiationVerifier(
      buildDeps({
        network: "mainnet-beta",
        zerionVerificationMode: "strict",
        zerionApiKey: "redacted",
        httpGetImpl: async () => ({
          data: {
            data: [
              {
                attributes: {
                  quantity: {
                    int: "5000000",
                    decimals: 9,
                  },
                  updated_at_block: 456,
                  fungible_info: {
                    symbol: "SOL",
                    implementations: [],
                  },
                },
                relationships: {
                  chain: {
                    data: {
                      id: "solana",
                    },
                  },
                },
              },
            ],
          },
        }),
      }) as any
    );

    const summary = await verifier.verifyNegotiationForExecution({
      ...baseContext,
      routeReason: "strict-mainnet",
    });

    expect(summary.provider).toBe("ZERION_API");
    expect(summary.verificationScope).toBe("balance_readiness");
    expect(summary.validationSources).toEqual(["ZERION_API", "SOLANA_RPC"]);
    expect(summary.reason).toBe("zerion_strict_verification_confirmed_by_rpc_backstop");
  });

  it("uses SPORT equal-stake collateral policy for math-only SPORT escrows", async () => {
    const validateEconomicSafety = vi.fn().mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
    });
    const verifier = createNegotiationVerifier(
      buildDeps({
        network: "devnet",
        zerionVerificationMode: "hybrid",
        zerionApiKey: "redacted",
        validateEconomicSafety,
      }) as any
    );

    await verifier.verifyNegotiationForExecution({
      ...baseContext,
      rollupMode: "SPORT",
      negotiationSource: "OFFCHAIN",
      collateralBuyer: 0.000000001,
      collateralSeller: 0.001,
    });

    expect(validateEconomicSafety).toHaveBeenCalledWith(
      expect.objectContaining({
        priceSol: 0.001,
        collateralBuyerSol: 0.000000001,
        collateralSellerSol: 0.001,
        collateralPolicy: "sport_equal_stake",
      })
    );
  });

  it("resolves SPORT TxLINE synthetic markets as SOL-backed escrow assets", async () => {
    const verifier = createNegotiationVerifier(
      buildDeps({
        network: "devnet",
        zerionVerificationMode: "hybrid",
        zerionApiKey: "redacted",
      }) as any
    );

    const summary = await verifier.verifyNegotiationForExecution({
      ...baseContext,
      rollupMode: "SPORT",
      negotiationSource: "OFFCHAIN",
      assetType: "TXLINE:18202701:1X2_PARTICIPANT_RESULT:part1",
      collateralBuyer: 0.000000001,
      collateralSeller: 0.001,
    });

    expect(summary.provider).toBe("SOLANA_RPC");
    expect(summary.assetMint).toBe(UMBRA_SUPPORTED_MINTS.wSOL);
    expect(summary.assetResolution).toBe("native_sol");
    expect(summary.reason).toBe("rpc_balance_check_used_on_non_mainnet_runtime");
  });
});
