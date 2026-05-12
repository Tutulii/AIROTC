import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";

export class DealTracker {

  /**
   * Resolves an agent identifier (could be wallet pubkey or UUID) to a valid Agent.id.
   * Ensures the Agent record exists in the database.
   */
  private async resolveAgentId(identifier: string): Promise<string> {
    // Try by wallet first (most common from dealPhaseManager)
    let agent = await prisma.agent.findUnique({ where: { wallet: identifier } });
    if (agent) return agent.id;

    // Try by UUID (from onChainExecutionService which already resolved)
    agent = await prisma.agent.findUnique({ where: { id: identifier } });
    if (agent) return agent.id;

    // Last resort: create with identifier as wallet
    agent = await prisma.agent.create({ data: { wallet: identifier } });
    return agent.id;
  }

  public async initDeal(params: {
    ticketId: string;
    buyerId: string;
    sellerId: string;
    middlemanId: string;
    price: number;
    collateralBuyer: number;
    collateralSeller: number;
    timeout: Date;
  }) {
    logger.info("deal_created", { ticket_id: params.ticketId, price: params.price });

    // 1. Resolve all agent identifiers to valid Agent.id UUIDs
    const buyerAgentId = await this.resolveAgentId(params.buyerId);
    const sellerAgentId = await this.resolveAgentId(params.sellerId);
    const middlemanAgentId = await this.resolveAgentId(params.middlemanId);

    // 2. Now safe to create or update the Deal using the resolved UUIDs
    return await prisma.deal.upsert({
      where: { ticketId: params.ticketId },
      update: {
        price: params.price,
        collateralBuyer: params.collateralBuyer,
        collateralSeller: params.collateralSeller,
        status: "created",
        timeout: params.timeout,
      },
      create: {
        id: params.ticketId,
        buyerId: buyerAgentId,
        sellerId: sellerAgentId,
        middlemanId: middlemanAgentId,
        ticketId: params.ticketId,
        price: params.price,
        collateralBuyer: params.collateralBuyer,
        collateralSeller: params.collateralSeller,
        status: "created",
        timeout: params.timeout,
      }
    });
  }

  public async storeOnChainId(ticketId: string, dealIdOnChain: string) {
    await prisma.deal.update({
      where: { ticketId },
      data: { dealIdOnChain }
    });
    logger.info("deal_on_chain_id_stored", { ticket_id: ticketId, deal_id: dealIdOnChain });
  }

  public async updateStatus(ticketId: string, newStatus: string, error?: string) {
    const existingDeal = await prisma.deal.findUnique({ where: { ticketId } });
    if (!existingDeal) {
      logger.warn("deal_not_found_for_update", { ticket_id: ticketId, requested_status: newStatus });
      return;
    }

    logger.info("deal_status_updated", { ticket_id: ticketId, status: newStatus });
    await prisma.deal.update({
      where: { ticketId },
      data: { status: newStatus }
    });
    if (error) {
      logger.error("deal_failure", { ticket_id: ticketId, status: newStatus, error_message: error });
    }
  }

  public async getDealByTicket(ticketId: string) {
    return await prisma.deal.findUnique({
      where: { ticketId },
      include: {
        transactions: true
      }
    });
  }
}

export const dealTracker = new DealTracker();
