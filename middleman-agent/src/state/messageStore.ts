import { prisma } from "../lib/prisma";
import { Message } from "../types/message";
import { logger } from "../utils/logger";

class MessageStore {
  public async addMessage(message: Message): Promise<void> {
    const ticketId = message.ticket_id;
    if (!ticketId) {
      logger.error("message_store_rejected", { reason: "missing_ticket_id" });
      return;
    }

    // 1. Ensure ticket exists
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) {
      logger.warn("message_store_skipped", { ticket_id: ticketId, reason: "ticket_not_found" });
      return;
    }

    // 2. Ensure sender agent exists
    const senderWallet = message.sender || "unknown";
    const senderAgent = await prisma.agent.upsert({
      where: { wallet: senderWallet },
      update: {},
      create: { wallet: senderWallet }
    });

    // 3. Insert message into DB
    await prisma.message.create({
      data: {
        ticketId: ticketId,
        senderId: senderAgent.id,
        content: message.content
      }
    });

    logger.debug("message_stored", { ticket_id: ticketId, sender: senderAgent.id });
  }

  public async getMessages(ticket_id: string): Promise<Message[]> {
    const dbMessages = await prisma.message.findMany({
      where: { ticketId: ticket_id },
      orderBy: { createdAt: "asc" },
      include: { ticket: true, sender: true }
    });

    return dbMessages.map(m => ({
      message_id: m.id,
      ticket_id: m.ticketId,
      sender: m.sender.wallet,
      content: m.content,
      timestamp: m.createdAt.toISOString()
    }));
  }

  public async getRecentMessages(ticket_id: string, limit: number): Promise<Message[]> {
    const dbMessages = await prisma.message.findMany({
      where: { ticketId: ticket_id },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { ticket: true, sender: true }
    });

    // Reverse to maintain chronological order
    const ordered = dbMessages.reverse();

    return ordered.map(m => ({
      message_id: m.id,
      ticket_id: m.ticketId,
      sender: m.sender.wallet,
      content: m.content,
      timestamp: m.createdAt.toISOString()
    }));
  }
}

export const messageStore = new MessageStore();
