/**
 * Action: ACCEPT_TRADE_OFFER
 * Browses available offers and accepts one matching criteria.
 */
import type { Action, IAgentRuntime, Memory, State, ActionResult } from "../../elizaos-core";
import { logger } from "../../elizaos-core";
import { OtcConnectionService } from "../services/otcConnectionService";
import { OtcApiService, Offer } from "../services/otcApiService";
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

export const acceptOfferAction: Action = {
  name: "ACCEPT_TRADE_OFFER",
  similes: ["ACCEPT_OFFER", "QUICK_BUY", "TAKE_OFFER", "BROWSE_AND_BUY"],
  description: "Browse available offers on the platform and accept one matching criteria.",

  validate: async (runtime: IAgentRuntime) => {
    return !!runtime.getSetting("SOLANA_WALLET");
  },

  handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<ActionResult> => {
    const wallet = runtime.getSetting("SOLANA_WALLET")!;
    const role = runtime.getSetting("TRADE_ROLE") as string;
    const maxPrice = parseFloat(runtime.getSetting("MAX_PRICE") || "0.003");
    const api = getApi(runtime);
    const rt = runtime as any;

    try {
      const targetMode = role === "buyer" ? "sell" : "buy";
      const { data: offers } = await api.listOffers({ mode: targetMode });
      logger.info(`[${runtime.character.name}] Found ${offers.length} ${targetMode} offers`);

      const matching = offers
        .filter((o: Offer) => o.status === "active" && o.price <= maxPrice && o.creator.wallet !== wallet)
        .sort((a: Offer, b: Offer) => b.id.localeCompare(a.id));

      if (matching.length === 0) {
        logger.warn(`[${runtime.character.name}] No matching offers found`);
        return { success: false, error: "No matching offers available" };
      }

      const match = matching[0];
      logger.info(`[${runtime.character.name}] 🎯 Found: ${match.id} | ${match.asset} @ ${match.price} SOL`);

      const settlementKeypair = Keypair.generate();
      const { ticket } = await api.acceptOffer(match.id, wallet, settlementKeypair.publicKey.toBase58());

      rt.setState?.("ticketId", ticket.id);
      rt.setState?.("counterparty", role === "buyer" ? ticket.seller : ticket.buyer);
      logger.info(`[${runtime.character.name}] ✅ Accepted! Ticket: ${ticket.id}`);

      return {
        success: true,
        text: `Accepted offer ${match.id}. Ticket: ${ticket.id}`,
        data: { ticketId: ticket.id, offerId: match.id, ...ticket },
      };
    } catch (err: any) {
      logger.error(`[${runtime.character.name}] Accept offer failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Browse and accept a sell offer" } },
      { name: "agent", content: { text: "Browsing offers...", action: "ACCEPT_TRADE_OFFER" } },
    ],
  ],
};
