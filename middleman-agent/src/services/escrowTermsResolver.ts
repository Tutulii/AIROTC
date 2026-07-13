import { NATIVE_MINT } from "@solana/spl-token";
import type { AgreedTerms, Ticket } from "../types/ticket";
import { logger } from "../utils/logger";

const EPSILON = 1e-9;

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function isNativeSolTicket(ticket: Ticket): boolean {
  if (ticket.tokenMint && ticket.tokenMint !== NATIVE_MINT.toBase58()) {
    return false;
  }

  const asset = (ticket.offer_asset || ticket.agreed_terms?.asset_type || "").trim().toUpperCase();
  return !asset || asset === "SOL" || asset === "NATIVE_SOL";
}

export function resolveEscrowTermsForTicket(
  ticket: Ticket,
  terms: AgreedTerms,
): AgreedTerms {
  if (!isNativeSolTicket(ticket)) {
    return terms;
  }

  const offerAmount = ticket.offer_amount;
  const offerPrice = ticket.offer_price;
  if (!isFinitePositive(offerAmount) || !isFinitePositive(offerPrice)) {
    return terms;
  }

  if (sameNumber(terms.price, offerAmount)) {
    return terms;
  }

  const parsedUnitPriceAsPayment =
    sameNumber(terms.price, offerPrice)
    && !sameNumber(offerPrice, offerAmount)
    && offerAmount < offerPrice;

  if (!parsedUnitPriceAsPayment) {
    return terms;
  }

  logger.warn("escrow_payment_amount_resolved", {
    ticket_id: ticket.ticket_id,
    source: "native_sol_offer_amount",
    previous_price: terms.price,
    resolved_price: offerAmount,
    offer_price: offerPrice,
    offer_amount: offerAmount,
  });

  return {
    ...terms,
    price: offerAmount,
    asset_type: ticket.offer_asset || terms.asset_type,
  };
}
