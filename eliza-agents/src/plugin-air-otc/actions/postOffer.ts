/**
 * Action: POST_TRADE_OFFER
 * Creates a buy or sell offer on the AIR OTC platform.
 */
import type { Action, IAgentRuntime, Memory, State, ActionResult } from "../../elizaos-core";
import { logger } from "../../elizaos-core";
import { OtcConnectionService } from "../services/otcConnectionService";
import { OtcApiService } from "../services/otcApiService";
import { Keypair } from "@solana/web3.js";

function getApi(runtime: IAgentRuntime): OtcApiService {
  const svc = runtime.getService<OtcConnectionService>("otc-connection");
  if (svc) return svc.getApi();
  return new OtcApiService(
    runtime.getSetting("PLATFORM_REST_URL") || "http://localhost:8080",
    runtime.character.name,
    runtime.getSetting("BRIDGE_SECRET") || ""
  );
}

export const postOfferAction: Action = {
  name: "POST_TRADE_OFFER",
  similes: ["CREATE_OFFER", "LIST_OFFER", "POST_OFFER"],
  description: "Post a buy or sell offer on the AIR OTC platform.",

  validate: async (runtime: IAgentRuntime) => {
    return !!runtime.getSetting("SOLANA_WALLET") && !!runtime.getSetting("TRADE_ROLE");
  },

  handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<ActionResult> => {
    const wallet = runtime.getSetting("SOLANA_WALLET")!;
    const role = runtime.getSetting("TRADE_ROLE") as "buyer" | "seller";
    const asset = runtime.getSetting("TRADE_ASSET") || "API_KEY";
    const price = parseFloat(runtime.getSetting("TRADE_PRICE") || "0.002");
    const collateral = parseFloat(runtime.getSetting("TRADE_COLLATERAL") || "0.001");
    const rollupMode = runtime.getSetting("ROLLUP_MODE") || "ER";
    const api = getApi(runtime);
    const rt = runtime as any;

    const settlementKeypair = Keypair.generate();

    try {
      const mode = role === "buyer" ? "buy" : "sell";
      const priceToUse = role === "buyer"
        ? parseFloat(runtime.getSetting("TARGET_PRICE") || String(price))
        : parseFloat(runtime.getSetting("ASKING_PRICE") || String(price));

      const result = await api.createOffer({
        asset, price: priceToUse, amount: 1, mode, collateral,
        wallet, rollupMode, settlementWallet: settlementKeypair.publicKey.toBase58(),
      });

      rt.setState?.("offerId", result.offerId);
      rt.setState?.("offerMode", mode);
      logger.info(`[${runtime.character.name}] 📋 ${mode.toUpperCase()} offer: ${result.offerId} | ${asset} @ ${priceToUse} SOL`);

      return {
        success: true,
        text: `Posted ${mode} offer: ${result.offerId} for ${asset} at ${priceToUse} SOL`,
        data: { offerId: result.offerId, ...result.data },
      };
    } catch (err: any) {
      logger.error(`[${runtime.character.name}] Post offer failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Post a sell offer for API_KEY at 0.002 SOL" } },
      { name: "agent", content: { text: "Posting sell offer...", action: "POST_TRADE_OFFER" } },
    ],
  ],
};
