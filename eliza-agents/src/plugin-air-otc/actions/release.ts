/**
 * Action: RELEASE_FUNDS
 * Buyer confirms receipt and releases escrow funds.
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

export const releaseAction: Action = {
  name: "RELEASE_FUNDS",
  similes: ["RELEASE", "CONFIRM_RECEIPT", "FINALIZE_DEAL", "COMPLETE_TRADE"],
  description: "Confirm item receipt and release escrow funds to seller. Buyer-only action.",

  validate: async (runtime: IAgentRuntime) => {
    const role = runtime.getSetting("TRADE_ROLE");
    const rt = runtime as any;
    return role === "buyer" && !!rt.getState?.("ticketId");
  },

  handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<ActionResult> => {
    const rt = runtime as any;
    const ticketId = rt.getState?.("ticketId") as string;
    const wallet = runtime.getSetting("SOLANA_WALLET")!;
    const api = getApi(runtime);

    try {
      const status = await api.getDealStatus(ticketId);
      logger.info(`[${runtime.character.name}] Current phase: ${status.phase}`);
      if (status.phase === "completed") {
        return { success: true, text: "Deal already completed!", data: { phase: "completed" } };
      }
    } catch { /* ignore */ }

    await new Promise(r => setTimeout(r, 3000));

    const msg = "@middleman i received my items! release funds";
    logger.info(`[${runtime.character.name}] 💰 Release request: "${msg}"`);
    const response = await api.sendMessage(ticketId, wallet, msg);
    logger.info(`[${runtime.character.name}] 🤖 Middleman: "${(response.response || "").substring(0, 100)}"`);

    const completed = response.action === "RELEASE_FUNDS" || response.phase === "completed";

    if (completed) {
      logger.info(`[${runtime.character.name}] ✅ Deal completed! Funds released.`);
      rt.setState?.("dealCompleted", true);
    }

    return {
      success: completed,
      text: completed ? "Deal completed! Funds released." : `Release response: ${response.action}`,
      data: { action: response.action, phase: response.phase, completed },
    };
  },

  examples: [
    [
      { name: "user", content: { text: "I got the item, release the funds" } },
      { name: "agent", content: { text: "Confirming receipt and releasing funds...", action: "RELEASE_FUNDS" } },
    ],
  ],
};
