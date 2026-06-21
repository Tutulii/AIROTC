import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";

const REAL_SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/;

function normalizeTxSignature(txSignature?: string | null): string | null {
  const value = typeof txSignature === "string" ? txSignature.trim() : "";
  if (!value || value === "unknown_tx" || value === "recovered_tx") {
    return null;
  }
  return REAL_SOLANA_SIGNATURE_RE.test(value) ? value : null;
}

class ExecutionStore {

  private async getOrCreateDealId(ticketId: string): Promise<string> {
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new Error("Cannot track execution for nonexistent ticket");

    // Ensure a "system" middleman agent exists
    const middlemanAgent = await prisma.agent.upsert({
      where: { wallet: "system" },
      update: {},
      create: { wallet: "system" }
    });

    const deal = await prisma.deal.upsert({
      where: { ticketId: ticketId },
      update: {},
      create: {
        id: ticketId,
        ticketId: ticketId,
        buyerId: ticket.buyerId,
        sellerId: ticket.sellerId,
        middlemanId: middlemanAgent.id,
        price: 0,
        collateralBuyer: 0,
        collateralSeller: 0,
        status: "pending_execution",
        timeout: new Date()
      }
    });

    return deal.id;
  }

  public async beginExecution(ticketId: string, stepType: string = "create_deal"): Promise<boolean> {
    logger.debug("execution_duplicate_check", { ticket_id: ticketId, step: stepType });
    const dealId = await this.getOrCreateDealId(ticketId);

    const existing = await prisma.transaction.findFirst({
      where: { dealId, type: stepType }
    });

    if (existing && (existing.status === "confirmed" || existing.status === "pending")) {
      return false;
    }

    logger.info("execution_record_created", { ticket_id: ticketId, step: stepType });

    if (existing && existing.status === "failed") {
      await prisma.transaction.update({
        where: { id: existing.id },
        data: { status: "pending" }
      });
      return true;
    }

    await prisma.transaction.create({
      data: { dealId, type: stepType, status: "pending" }
    });
    return true;
  }

  public async markSuccess(ticketId: string, stepType: string = "create_deal", txSignature: string | null = "unknown_tx"): Promise<void> {
    const dealId = await this.getOrCreateDealId(ticketId);
    const normalizedTxSignature = normalizeTxSignature(txSignature);
    logger.info("execution_tx_confirmed", {
      ticket_id: ticketId,
      step: stepType,
      tx: normalizedTxSignature,
      tx_input: txSignature,
    });

    const tx = await prisma.transaction.findFirst({
      where: { dealId, type: stepType },
      orderBy: { createdAt: "desc" }
    });

    if (tx) {
      const updateData =
        normalizedTxSignature || !normalizeTxSignature(tx.txSignature)
          ? { status: "confirmed", txSignature: normalizedTxSignature }
          : { status: "confirmed" };
      await prisma.transaction.update({
        where: { id: tx.id },
        data: updateData
      });
      return;
    }

    await prisma.transaction.create({
      data: { dealId, type: stepType, status: "confirmed", txSignature: normalizedTxSignature }
    });
  }

  public async markFailed(ticketId: string, stepType: string = "create_deal", errorMsg?: string): Promise<void> {
    const dealId = await this.getOrCreateDealId(ticketId);
    logger.error("execution_tx_failed", { ticket_id: ticketId, step: stepType, error_message: errorMsg });

    const tx = await prisma.transaction.findFirst({
      where: { dealId, type: stepType, status: "pending" }
    });

    if (tx) {
      await prisma.transaction.update({
        where: { id: tx.id },
        data: { status: "failed" }
      });
    }
  }

  public async hasExecuted(ticketId: string): Promise<boolean> {
    const dealId = await this.getOrCreateDealId(ticketId);
    const tx = await prisma.transaction.findFirst({
      where: { dealId, type: "create_deal", status: "confirmed" }
    });
    return !!tx;
  }

  public async markExecuted(ticketId: string): Promise<void> {
    await this.markSuccess(ticketId, "create_deal");
  }
}

export const executionStore = new ExecutionStore();
