import { prisma } from "../lib/prisma";
import { ParsedSignals } from "../types/negotiation";
import { NegotiationSignals } from "../../core/middlemanBrain";
import { logger } from "../utils/logger";

export class NegotiationStore {

  /**
   * Translates NLP parsed intelligence directly into a structural Database entry.
   */
  public async addNegotiationStep(ticketId: string, parsed: ParsedSignals, sender: string, rawText: string) {
    logger.debug("negotiation_step_stored", { ticket_id: ticketId, sender });

    const agreementScore = (parsed.agreement_score ?? 0) >= 40 || parsed.agreement_signal ? 90 : (parsed.price ? 50 : 10);

    const doInsert = () => prisma.negotiation.create({
      data: {
        ticketId,
        proposedPrice: parsed.price ? parseFloat(String(parsed.price)) : null,
        collateralBuyer: parsed.collateral_buyer ? parseFloat(String(parsed.collateral_buyer)) : null,
        collateralSeller: parsed.collateral_seller ? parseFloat(String(parsed.collateral_seller)) : null,
        proposedBy: sender,
        agreementScore,
        rawText
      }
    });

    try {
      return await doInsert();
    } catch (e: any) {
      if (e.code === 'P2003' || e.code === 'P2025') {
        // FK violation → ticket not yet in middleman DB.
        // The forward bridge REST endpoint is likely still creating it.
        // Wait briefly and retry once.
        logger.warn("negotiation_step_fk_retry", {
          ticket_id: ticketId, sender,
          reason: "Ticket not yet created — retrying in 1.5s"
        });
        await new Promise(r => setTimeout(r, 1500));
        try {
          return await doInsert();
        } catch (retryErr: any) {
          logger.warn("negotiation_step_fk_skip", {
            ticket_id: ticketId, sender,
            reason: "Retry also failed — skipping (non-blocking)"
          });
          return null;
        }
      }
      throw e;
    }
  }

  /**
   * Retrieves the comprehensive historical track of relational negotiation signals.
   */
  public async getNegotiationHistory(ticketId: string) {
    return await prisma.negotiation.findMany({
      where: { ticketId },
      orderBy: { createdAt: "asc" }
    });
  }

  /**
   * Generates downstream metrics required for executing NLP intent intelligence natively via scanning postgres rows.
   */
  public async getLatestSignals(ticketId: string): Promise<NegotiationSignals> {
    const history = await this.getNegotiationHistory(ticketId);

    const matchCount = history.length;
    const senders = new Set(history.map((h: any) => h.proposedBy));
    const bothPartiesPresent = senders.size >= 2;

    let latestPrice: number | null = null;
    let latestColBuyer: number | null = null;
    let latestColSeller: number | null = null;
    let agreementSignalCount = 0;

    const lastPriceBySender: Record<string, number> = {};

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    const trueBuyerId = ticket?.buyerId;
    const trueSellerId = ticket?.sellerId;

    let buyerConfirmed = false;
    let sellerConfirmed = false;

    for (const step of history) {
      if (step.proposedPrice !== null) {
        latestPrice = step.proposedPrice;
        lastPriceBySender[step.proposedBy] = step.proposedPrice;
      } else if (latestPrice && step.agreementScore >= 80) {
        lastPriceBySender[step.proposedBy] = latestPrice;
      }
      if (step.collateralBuyer !== null) latestColBuyer = step.collateralBuyer;
      if (step.collateralSeller !== null) latestColSeller = step.collateralSeller;
      if (step.agreementScore >= 80) {
        agreementSignalCount++;
        // Bilateral tracking: Who sent the >80 signal?
        if (trueBuyerId && step.proposedBy === trueBuyerId) buyerConfirmed = true;
        if (trueSellerId && step.proposedBy === trueSellerId) sellerConfirmed = true;
      }
    }

    const prices = Object.values(lastPriceBySender);
    const priceConverged = prices.length >= 2 && new Set(prices).size === 1;

    let agreementScore = 10;
    if (priceConverged && bothPartiesPresent && agreementSignalCount >= 2 && latestPrice && latestColBuyer && latestColSeller) {
      agreementScore = 100;
    } else if (priceConverged) {
      agreementScore = 80;
    } else if (history.length > 0 && history[history.length - 1].agreementScore >= 80) {
      agreementScore = 50;
    }

    return {
      price: latestPrice,
      collateral_buyer: latestColBuyer,
      collateral_seller: latestColSeller,
      agreement_score: agreementScore,
      both_parties_present: bothPartiesPresent,
      price_converged: priceConverged,
      message_count: matchCount,
      last_sender: history.length > 0 ? history[history.length - 1].proposedBy : "",
      buyer_confirmed: buyerConfirmed,
      seller_confirmed: sellerConfirmed,
    };
  }
}

export const negotiationStore = new NegotiationStore();
