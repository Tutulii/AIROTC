import { prisma } from "../lib/prisma";
import { Agent } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";
import { logger } from "../utils/logger";

class WalletRegistry {

  /**
   * Concurrency-safe lookup or creation of an Agent identity.
   * Reject if wallet is invalid.
   */
  public async getOrCreateAgent(wallet: string): Promise<Agent> {
    if (!wallet || wallet.trim() === "") {
      throw new Error("Invalid wallet address: cannot be empty");
    }

    // If it's already an internal UUID, return the agent directly
    if (wallet.length === 36 && wallet.includes('-')) {
        const existing = await this.getAgentById(wallet);
        if (existing) return existing;
        throw new Error(`Invalid UUID: no agent found for ${wallet}`);
    }

    // Validate wallet as a real Solana public key
    try {
      new PublicKey(wallet);
    } catch {
      throw new Error(`Invalid Solana public key format: ${wallet}`);
    }

    try {
      const agent = await prisma.agent.upsert({
        where: { wallet },
        update: {},
        create: { wallet }
      });

      logger.info("agent_resolved", { agent_id: agent.id, wallet });

      return agent;
    } catch (e: any) {
      if (e.code === 'P2002') {
        const existing = await prisma.agent.findUnique({ where: { wallet } });
        if (existing) return existing;
      }
      logger.error("agent_creation_failed", { wallet }, e);
      throw e;
    }
  }

  /**
   * Retrieves an Agent purely by UUID.
   */
  public async getAgentById(agentId: string): Promise<Agent | null> {
    return await prisma.agent.findUnique({
      where: { id: agentId }
    });
  }

  /**
   * Get the PublicKey for an agent by ID.
   */
  public async getPublicKey(agentId: string): Promise<PublicKey | null> {
    const agent = await this.getAgentById(agentId);
    if (!agent) return null;

    try {
      return new PublicKey(agent.wallet);
    } catch {
      return null;
    }
  }

  /**
   * Check if a wallet string is registered.
   */
  public async isRegistered(wallet: string): Promise<boolean> {
    const agent = await prisma.agent.findUnique({
      where: { wallet }
    });
    return !!agent;
  }

  /**
   * Update reputation after a completed trade.
   * Postponed deep implementation; just logging it to indicate 
   * Deal <-> Agent connection logic applies here logically later.
   */
  public async recordTradeComplete(agentId: string, success: boolean): Promise<void> {
    logger.info("reputation_recorded_noop", { agent_id: agentId, success });
  }

  /**
   * Get all registered agents.
   */
  public async listAgents(): Promise<Agent[]> {
    return await prisma.agent.findMany();
  }
}

export const walletRegistry = new WalletRegistry();
