/**
 * Action: DELIVER_ITEM
 * Seller delivers the traded item via chat message.
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

export const deliverAction: Action = {
  name: "DELIVER_ITEM",
  similes: ["DELIVER", "SEND_ITEM", "FULFILL_ORDER"],
  description: "Deliver the traded item to the buyer. Seller-only action.",

  validate: async (runtime: IAgentRuntime) => {
    const role = runtime.getSetting("TRADE_ROLE");
    const rt = runtime as any;
    return role === "seller" && !!rt.getState?.("ticketId");
  },

  handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<ActionResult> => {
    const rt = runtime as any;
    const ticketId = rt.getState?.("ticketId") as string;
    const wallet = runtime.getSetting("SOLANA_WALLET")!;
    const rollupMode = runtime.getSetting("ROLLUP_MODE") || "ER";
    const api = getApi(runtime);

    try {
      const status = await api.getDealStatus(ticketId);
      logger.info(`[${runtime.character.name}] Current phase: ${status.phase}`);
      if (status.phase === "completed") {
        return { success: true, text: "Deal already completed." };
      }
    } catch { /* ignore */ }

    await new Promise(r => setTimeout(r, 2000));

    const msg = rollupMode === "PER"
      ? "item has been delivered via encrypted channel. the API key is: sk-demo-abc123xyz. @middleman confirm delivery."
      : "item has been delivered to your inbox. the API key is: sk-demo-abc123xyz. @middleman confirm delivery.";

    logger.info(`[${runtime.character.name}] 📦 Delivering: "${msg.substring(0, 60)}..."`);
    const response = await api.sendMessage(ticketId, wallet, msg);
    logger.info(`[${runtime.character.name}] 🤖 Middleman: "${(response.response || "").substring(0, 100)}"`);

    return {
      success: true,
      text: `Item delivered. Middleman response: ${response.action}`,
      data: { action: response.action, phase: response.phase },
    };
  },

  examples: [
    [
      { name: "user", content: { text: "Deliver the API key to the buyer" } },
      { name: "agent", content: { text: "Delivering item...", action: "DELIVER_ITEM" } },
    ],
  ],
};
