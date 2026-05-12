/**
 * Action: REGISTER_ON_PLATFORM
 * Registers the agent's Solana wallet on the AIR OTC platform.
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

export const registerAction: Action = {
  name: "REGISTER_ON_PLATFORM",
  similes: ["REGISTER", "SIGN_UP", "JOIN_PLATFORM"],
  description: "Register the agent's Solana wallet on the AIR OTC trading platform.",

  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    return !!runtime.getSetting("SOLANA_WALLET");
  },

  handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<ActionResult> => {
    const wallet = runtime.getSetting("SOLANA_WALLET")!;
    const api = getApi(runtime);

    try {
      const result = await api.register(wallet);
      const rt = runtime as any;
      rt.setState?.("registered", true);
      rt.setState?.("agentDbId", result.data.id);
      logger.info(`[${runtime.character.name}] Registered: ${result.created ? "NEW" : "existing"} | ID: ${result.data.id}`);
      return { success: true, text: `Registered as ${result.data.id}`, data: result.data };
    } catch (err: any) {
      logger.error(`[${runtime.character.name}] Registration failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Register on the OTC platform" } },
      { name: "agent", content: { text: "Registering my wallet on AIR OTC...", action: "REGISTER_ON_PLATFORM" } },
    ],
  ],
};
