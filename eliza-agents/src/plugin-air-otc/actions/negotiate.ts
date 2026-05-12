/**
 * Action: NEGOTIATE_DEAL
 * Sends negotiation messages. ER: full chat. PER: opaque agreement.
 */
import type { Action, IAgentRuntime, Memory, State, ActionResult } from "../../elizaos-core";
import { logger } from "../../elizaos-core";
import { OtcConnectionService } from "../services/otcConnectionService";
import { OtcApiService } from "../services/otcApiService";

function getApi(runtime: IAgentRuntime): OtcApiService {
  const svc = runtime.getService<OtcConnectionService>("otc-connection");
  if (svc) return svc.getApi();
  return new OtcApiService(
    runtime.getSetting("PLATFORM_REST_URL") || "http://localhost:8080",
    runtime.character.name,
    runtime.getSetting("BRIDGE_SECRET") || ""
  );
}

function buildNegotiationMessage(runtime: IAgentRuntime, round: number): string {
  const role = runtime.getSetting("TRADE_ROLE") as string;
  const asset = runtime.getSetting("TRADE_ASSET") || "API_KEY";
  const collateral = runtime.getSetting("TRADE_COLLATERAL") || "0.001";

  if (role === "buyer") {
    const target = parseFloat(runtime.getSetting("TARGET_PRICE") || "0.002");
    const max = parseFloat(runtime.getSetting("MAX_PRICE") || "0.0024");
    const prices = [target * 0.85, target * 0.92, target, max];
    const price = prices[Math.min(round, prices.length - 1)];

    if (round === 0) return `hey i want to buy ${asset}, i can do ${price.toFixed(4)} sol`;
    if (round <= 2) return `how about ${price.toFixed(4)} sol? thats fair for ${asset}`;
    return `ok deal. ${price.toFixed(4)} sol with ${collateral} sol collateral each side. @middleman create escrow`;
  } else {
    const asking = parseFloat(runtime.getSetting("ASKING_PRICE") || "0.002");
    const min = parseFloat(runtime.getSetting("MIN_PRICE") || "0.0015");
    const prices = [asking, asking * 0.95, asking * 0.9, min];
    const price = prices[Math.min(round, prices.length - 1)];

    if (round === 0) return `selling ${asset} for ${price.toFixed(4)} sol, collateral ${collateral} sol each side`;
    if (round <= 2) return `i can do ${price.toFixed(4)} sol but not lower`;
    return `ok lets go. ${price.toFixed(4)} sol and ${collateral} sol collateral. @middleman lets proceed`;
  }
}

export const negotiateAction: Action = {
  name: "NEGOTIATE_DEAL",
  similes: ["NEGOTIATE", "HAGGLE", "DISCUSS_PRICE", "MAKE_OFFER"],
  description: "Send negotiation messages for an active deal. Uses agent personality for price proposals.",

  validate: async (runtime: IAgentRuntime) => {
    const rt = runtime as any;
    const ticketId = rt.getState?.("ticketId") as string;
    return !!ticketId && !!runtime.getSetting("SOLANA_WALLET");
  },

  handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<ActionResult> => {
    const rt = runtime as any;
    const ticketId = rt.getState?.("ticketId") as string;
    const wallet = runtime.getSetting("SOLANA_WALLET")!;
    const rollupMode = runtime.getSetting("ROLLUP_MODE") || "ER";
    const api = getApi(runtime);
    const messageHistory: string[] = (rt.getState?.("messageHistory") as string[]) || [];

    // ── PER MODE ──
    if (rollupMode === "PER") {
      logger.info(`[${runtime.character.name}] 🔐 PER mode — private negotiation`);
      const collateral = runtime.getSetting("TRADE_COLLATERAL") || "0.001";
      const price = runtime.getSetting("TARGET_PRICE") || runtime.getSetting("ASKING_PRICE") || "0.002";

      await api.sendMessage(ticketId, wallet, "ready for PER private negotiation.");
      await new Promise(r => setTimeout(r, 2000));

      const agreeMsg = `i agree to ${price} SOL with ${collateral} SOL collateral each side. @middleman please create the escrow.`;
      const response = await api.sendMessage(ticketId, wallet, agreeMsg);
      logger.info(`[${runtime.character.name}] 🔒 PER terms submitted | Action: ${response.action}`);

      messageHistory.push(`[${runtime.character.name}]: ${agreeMsg}`);
      if (response.response) messageHistory.push(`[Middleman]: ${response.response}`);
      rt.setState?.("messageHistory", messageHistory);

      return {
        success: true,
        text: `PER negotiation complete. Action: ${response.action}`,
        data: { action: response.action, phase: response.phase },
      };
    }

    // ── ER MODE ──
    logger.info(`[${runtime.character.name}] 💬 ER mode — full plaintext negotiation`);
    let escrowTriggered = false;

    for (let round = 0; round < 6; round++) {
      const message = buildNegotiationMessage(runtime, round);
      logger.info(`[${runtime.character.name}] 💬 Round ${round}: "${message}"`);

      const response = await api.sendMessage(ticketId, wallet, message);
      messageHistory.push(`[${runtime.character.name}]: ${message}`);
      if (response.response) {
        messageHistory.push(`[Middleman]: ${response.response}`);
        logger.info(`[${runtime.character.name}] 🤖 Middleman: "${response.response.substring(0, 100)}"`);
      }

      if (response.action === "CREATE_ESCROW" || response.phase === "awaiting_deposits" || response.phase === "escrow_created") {
        logger.info(`[${runtime.character.name}] 🔒 Escrow creation triggered!`);
        escrowTriggered = true;
        break;
      }

      try {
        const status = await api.getDealStatus(ticketId);
        if (status.escrow_pda) {
          rt.setState?.("escrowPda", status.escrow_pda);
          escrowTriggered = true;
          break;
        }
        if (status.phase === "awaiting_deposits" || status.phase === "escrow_created") {
          escrowTriggered = true;
          break;
        }
      } catch { /* not ready */ }

      await new Promise(r => setTimeout(r, 3000));
    }

    rt.setState?.("messageHistory", messageHistory);

    return {
      success: escrowTriggered,
      text: escrowTriggered ? "Negotiation complete — escrow triggered" : "Negotiation rounds exhausted",
      data: { rounds: messageHistory.length, escrowTriggered },
    };
  },

  examples: [
    [
      { name: "user", content: { text: "Negotiate the deal price" } },
      { name: "agent", content: { text: "Starting negotiation...", action: "NEGOTIATE_DEAL" } },
    ],
  ],
};
