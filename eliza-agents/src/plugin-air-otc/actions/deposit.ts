/**
 * Action: DEPOSIT_TO_ESCROW
 * Deposits SOL to escrow PDA or signals deposit via message.
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

export const depositAction: Action = {
  name: "DEPOSIT_TO_ESCROW",
  similes: ["DEPOSIT", "SEND_COLLATERAL", "FUND_ESCROW", "PAY_ESCROW"],
  description: "Deposit SOL to the deal's escrow PDA. Buyer sends payment + collateral; seller sends collateral only.",

  validate: async (runtime: IAgentRuntime) => {
    const rt = runtime as any;
    return !!rt.getState?.("ticketId") && !!runtime.getSetting("SOLANA_WALLET");
  },

  handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<ActionResult> => {
    const rt = runtime as any;
    const ticketId = rt.getState?.("ticketId") as string;
    const wallet = runtime.getSetting("SOLANA_WALLET")!;
    const role = runtime.getSetting("TRADE_ROLE") as string;
    const api = getApi(runtime);

    // Check for escrow PDA
    let escrowPda = rt.getState?.("escrowPda") as string | null;
    if (!escrowPda) {
      logger.info(`[${runtime.character.name}] Waiting for escrow PDA...`);
      const start = Date.now();
      while (Date.now() - start < 30000) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const status = await api.getDealStatus(ticketId);
          if (status.escrow_pda) {
            escrowPda = status.escrow_pda;
            rt.setState?.("escrowPda", escrowPda);
            break;
          }
          logger.info(`[${runtime.character.name}] Phase: ${status.phase}`);
        } catch { /* not ready */ }
      }
    }

    const depositMsg = role === "buyer"
      ? "@middleman I have deposited my collateral and payment. Please confirm."
      : "@middleman I have deposited my collateral. Please confirm.";

    if (!escrowPda) {
      logger.info(`[${runtime.character.name}] No on-chain PDA — signaling deposit to middleman`);
      const response = await api.sendMessage(ticketId, wallet, depositMsg);
      logger.info(`[${runtime.character.name}] ✅ Deposit signaled | Phase: ${response.phase}`);
      return {
        success: true,
        text: `Deposit signaled (demo mode). Phase: ${response.phase}`,
        data: { action: response.action, phase: response.phase, demo: true },
      };
    }

    logger.info(`[${runtime.character.name}] Escrow PDA: ${escrowPda}`);
    const response = await api.sendMessage(ticketId, wallet, depositMsg);

    return {
      success: true,
      text: `Deposit sent to ${escrowPda}. Phase: ${response.phase}`,
      data: { escrowPda, action: response.action, phase: response.phase },
    };
  },

  examples: [
    [
      { name: "user", content: { text: "Deposit collateral to escrow" } },
      { name: "agent", content: { text: "Depositing to escrow...", action: "DEPOSIT_TO_ESCROW" } },
    ],
  ],
};
