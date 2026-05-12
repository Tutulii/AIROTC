import path from "path";
import dotenv from "dotenv";
import { describe, it, expect } from "vitest";
import axios from "axios";
import { Connection } from "@solana/web3.js";
import { loadConfig } from "../src/config";
import { createNegotiationVerifier } from "../src/services/zerionVerificationService";
import type { DealPipelineContext } from "../src/types/dealPipeline";

dotenv.config({ path: path.join(__dirname, "../.env") });

const MAINNET_RPC = process.env.ZERION_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const KNOWN_SOLANA_WALLET = "A1TMhSGzQxMr1TboBKtgixKz1sS6REASMxPo1qsyTSJd";
const ZERION_API_BASE_URL = process.env.ZERION_API_BASE_URL || "https://api.zerion.io/v1";

describe("Zerion Balance-Readiness — Live E2E", () => {
  it("lists chains and includes solana support", async () => {
    const baseConfig = loadConfig();
    const apiKey = baseConfig.zerionApiKey;
    expect(apiKey).toBeTruthy();

    const auth = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
    const response = await axios.get(`${ZERION_API_BASE_URL}/chains/`, {
      headers: {
        Accept: "application/json",
        Authorization: auth,
      },
      timeout: 20_000,
    });

    expect(Array.isArray(response.data?.data)).toBe(true);
    const hasSolana = response.data.data.some((chain: any) => chain?.id === "solana");
    expect(hasSolana).toBe(true);
  }, 30_000);

  it("verifies a known Solana wallet through Zerion primary + RPC backstop", async () => {
    const baseConfig = loadConfig();
    const verifier = createNegotiationVerifier({
      getConnection: () => new Connection(MAINNET_RPC, "confirmed"),
      withRetry: async (fn: any) => fn(),
      loadConfig: () => ({
        ...baseConfig,
        network: "mainnet-beta",
        zerionApiBaseUrl: ZERION_API_BASE_URL,
      }),
      httpGet: axios.get.bind(axios),
      validateEconomicSafety: async () => ({
        valid: true,
        errors: [],
        warnings: [],
      }),
    });

    const context: DealPipelineContext = {
      ticketId: "zerion-live-e2e",
      buyer: "8btGrSJRTMnWUn3F4a8JSxC8U1Uw5XTfNUSUq9FKfN7h",
      seller: KNOWN_SOLANA_WALLET,
      price: 0.001,
      collateralBuyer: 0,
      collateralSeller: 0.001,
      assetType: "SOL",
      confidence: 100,
      rollupMode: "NONE",
      negotiationSource: "OFFCHAIN",
      route: "STANDARD_ESCROW",
      executionPolicy: "STANDARD",
      settlementPolicy: "DIRECT",
      routeReason: "zerion_live_e2e",
    };

    const summary = await verifier.verifyNegotiationForExecution(context);

    expect(summary.assetSymbol).toBe("SOL");
    expect(summary.availableAmountRaw).toBeTruthy();
    expect(summary.requiredAmountRaw).toBeTruthy();
    expect(summary.verificationScope).toBe("balance_readiness");

    if (summary.provider === "ZERION_API") {
      expect(summary.validationSources).toEqual(["ZERION_API", "SOLANA_RPC"]);
      expect(summary.chainId).toBe("solana");
      expect(summary.verificationLevel).toBe("zerion_position_check");
      return;
    }

    expect(summary.provider).toBe("SOLANA_RPC");
    expect(summary.validationSources).toEqual(["SOLANA_RPC"]);
    expect(summary.verificationLevel).toBe("onchain_balance_check");
    expect(summary.fallbackReason).toBeTruthy();
  }, 60_000);
});
