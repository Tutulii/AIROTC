/**
 * Provider: dealStatusProvider
 * Polls the middleman for current deal status and surfaces it to the LLM.
 * 
 * Follows real @elizaos/core Provider interface — returns ProviderResult.
 */
import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from "../../elizaos-core";
import { OtcApiService } from "../services/otcApiService";

export const dealStatusProvider: Provider = {
  name: "dealStatusProvider",
  description: "Provides the current deal phase, escrow status, and payment state.",
  dynamic: true,
  position: -40,

  get: async (runtime: IAgentRuntime, _message?: Memory, _state?: State): Promise<ProviderResult> => {
    const ticketId = (runtime as any).getState?.("ticketId") as string | undefined;
    if (!ticketId) return { text: "No active deal." };

    const api = (runtime as any).getState?.("__otcApi") as OtcApiService | undefined
      || new OtcApiService(
        runtime.getSetting("PLATFORM_REST_URL") || "http://localhost:8080",
        runtime.character.name,
        runtime.getSetting("BRIDGE_SECRET") || ""
      );

    try {
      const status = await api.getDealStatus(ticketId);
      const text = [
        `Ticket: ${status.ticketId}`,
        `Phase: ${status.phase}`,
        `Buyer: ${status.buyer?.substring(0, 12)}...`,
        `Seller: ${status.seller?.substring(0, 12)}...`,
        `Escrow PDA: ${status.escrow_pda || "none"}`,
        `Payment Locked: ${status.payment_locked}`,
        status.terms ? `Terms: ${status.terms.price} SOL` : "Terms: not set",
      ].join("\n");

      return {
        text,
        data: status as any,
        values: {
          phase: status.phase,
          ticketId: status.ticketId,
          paymentLocked: String(status.payment_locked),
        },
      };
    } catch (err: any) {
      return { text: `Deal status unavailable: ${err.message}` };
    }
  },
};
