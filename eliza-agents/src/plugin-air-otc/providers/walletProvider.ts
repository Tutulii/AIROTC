/**
 * Provider: otcWalletProvider
 * Exposes the agent's Solana wallet address and trade state to the LLM context.
 * 
 * Follows real @elizaos/core Provider interface — returns ProviderResult.
 */
import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from "../../elizaos-core";

export const walletProvider: Provider = {
  name: "otcWalletProvider",
  description: "Provides the agent's Solana wallet address and current deal state.",
  dynamic: true,
  position: -50,

  get: async (runtime: IAgentRuntime, _message?: Memory, _state?: State): Promise<ProviderResult> => {
    const wallet = runtime.getSetting("SOLANA_WALLET") || "not configured";
    const role = runtime.getSetting("TRADE_ROLE") || "unknown";
    const rollupMode = runtime.getSetting("ROLLUP_MODE") || "ER";

    const text = [
      `Wallet: ${wallet.substring(0, 12)}...`,
      `Role: ${role}`,
      `Mode: ${rollupMode}`,
    ].join("\n");

    return {
      text,
      data: { wallet, role, rollupMode },
      values: { wallet, role, rollupMode },
    };
  },
};
