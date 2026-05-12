import { prisma } from "../src/lib/prisma";
import { parseMessage } from "../src/services/parserService";

export interface Message {
  message_id?: string;
  ticket_id?: string;
  sender: string;
  content: string;
  timestamp: string | number;
}

class TicketStore {
  public async createTicket(ticketData: any): Promise<void> {
    console.log("[TICKET STORE] Creating ticket...");

    const buyerWallet = ticketData.buyer || "unknown_buyer";
    const sellerWallet = ticketData.seller || "unknown_seller";

    const buyerAgent = await prisma.agent.upsert({
      where: { wallet: buyerWallet },
      update: {},
      create: { wallet: buyerWallet }
    });

    const sellerAgent = await prisma.agent.upsert({
      where: { wallet: sellerWallet },
      update: {},
      create: { wallet: sellerWallet }
    });

    await prisma.ticket.upsert({
      where: { id: ticketData.id },
      update: {
        status: "open"
      },
      create: {
        id: ticketData.id,
        buyerId: buyerAgent.id,
        sellerId: sellerAgent.id,
        status: "open"
      }
    });
  }

  public async getTicket(ticketId: string): Promise<any | undefined> {
    console.log("[TICKET STORE] Fetching ticket...");
    const dbTicket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        buyer: true,
        seller: true,
        messages: {
          orderBy: { createdAt: "asc" }
        }
      }
    });

    if (!dbTicket) return undefined;

    const negotiation_history = dbTicket.messages.map(m => ({
      message: m.content,
      parsed: {
        // Pseudo-parsed data
      },
      sender: m.senderId,
      timestamp: m.createdAt.getTime()
    }));

    return {
      id: dbTicket.id,
      buyer: dbTicket.buyer.wallet,
      seller: dbTicket.seller.wallet,
      status: dbTicket.status,
      last_proposed_price: dbTicket.lastProposedPrice ?? undefined,
      last_collateral_buyer: dbTicket.lastCollateralBuyer ?? undefined,
      last_collateral_seller: dbTicket.lastCollateralSeller ?? undefined,
      negotiation_history,
      agreement_score: 0
    };
  }

  public async updateTicketMemory(ticketId: string, message: Message): Promise<void> {
    console.log("[TICKET STORE] Updating ticket...");
    const ticket = await this.getTicket(ticketId);
    if (!ticket) {
      console.log(`[ticket_memory_error] Ticket ${ticketId} not found.`);
      return;
    }

    const history = ticket.negotiation_history.map((h: any) => h.message) || [];
    const parsed = await parseMessage(message as any, history);

    let price = ticket.last_proposed_price;
    if (parsed.price !== null && parsed.price !== undefined) {
      if (price === undefined || price === 0) {
        price = parsed.price;
      } else {
        const _price = (price as number) || 1;
        const diff = Math.abs(Number(parsed.price) - _price) / _price;
        if (diff <= 2.0) price = parsed.price;
      }
    }

    let colBuy = ticket.last_collateral_buyer;
    if (parsed.collateral_buyer !== null && parsed.collateral_buyer !== undefined) colBuy = parsed.collateral_buyer;

    let colSel = ticket.last_collateral_seller;
    if (parsed.collateral_seller !== null && parsed.collateral_seller !== undefined) colSel = parsed.collateral_seller;

    await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        lastProposedPrice: price ? Number(price) : undefined,
        lastCollateralBuyer: colBuy ? Number(colBuy) : undefined,
        lastCollateralSeller: colSel ? Number(colSel) : undefined,
      }
    });

    // Ensure sender agent explicitly exists before foreign-key mapping to Message
    const senderAgent = await prisma.agent.upsert({
      where: { wallet: message.sender },
      update: {},
      create: { wallet: message.sender }
    });

    await prisma.message.create({
      data: {
        ticketId: ticketId,
        senderId: senderAgent.id,
        content: message.content
      }
    });

    console.log({
      event: "ticket_memory_updated",
      ticket_id: ticketId,
      price,
      collateral_buyer: colBuy,
      collateral_seller: colSel
    });
  }

  public async getRecentMessages(ticketId: string, limit: number): Promise<any[]> {
    const t = await this.getTicket(ticketId);
    if (!t || !t.negotiation_history) return [];
    return t.negotiation_history.slice(-limit);
  }
}

export const ticketStore = new TicketStore();

export async function runMemoryTests() {
  const ts = new TicketStore();

  await ts.createTicket({
    id: "T_TEST_1",
    buyer: "Buyer",
    seller: "Seller"
  });

  console.log("=== Msg 1: Initial Pitch ===");
  await ts.updateTicketMemory("T_TEST_1", {
    sender: "Buyer",
    content: "deal at 10 sol, both deposit 2",
    timestamp: Date.now()
  });
  console.log(await ts.getTicket("T_TEST_1"));

  console.log("=== Msg 2: Drastic Price Change (Should be rejected) ===");
  await ts.updateTicketMemory("T_TEST_1", {
    sender: "Seller",
    content: "no, deal at 20 sol",
    timestamp: Date.now()
  });
  console.log(await ts.getTicket("T_TEST_1"));

  console.log("=== Msg 3: Normal Price Change ===");
  await ts.updateTicketMemory("T_TEST_1", {
    sender: "Seller",
    content: "deal at 12 sol, both deposit 2",
    timestamp: Date.now()
  });
  console.log(await ts.getTicket("T_TEST_1"));

  console.log("=== Msg 4: Final Agreement ===");
  await ts.updateTicketMemory("T_TEST_1", {
    sender: "Buyer",
    content: "agreed",
    timestamp: Date.now()
  });
  console.log(await ts.getTicket("T_TEST_1"));

  console.log("=== History Snippet ===");
  console.log(await ts.getRecentMessages("T_TEST_1", 2));
}

if (require.main === module) {
  runMemoryTests().catch(console.error);
}
