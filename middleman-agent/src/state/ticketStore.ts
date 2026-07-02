import { prisma } from "../lib/prisma";
import { walletRegistry } from "./walletRegistry";
import { Ticket as TicketInterface, TicketStatus } from "../types/ticket";
import { logger } from "../utils/logger";
import type { AgreedTerms } from "../types/ticket";
import { MeridianOtcGuard } from "../services/meridianOtcGuard";

function toNumber(value: unknown, field: string): number {
  if (typeof value === "number") {
    return value;
  }
  if (value && typeof (value as { toNumber?: () => number }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`ticket_store_invalid_numeric_field:${field}`);
  }
  return parsed;
}

class TicketStore {
  public async createTicket(ticket: TicketInterface): Promise<void> {
    logger.debug("ticket_store_creating", { ticket_id: ticket.ticket_id });

    // Upsert Buyer
    const buyerAgent = await prisma.agent.upsert({
      where: { wallet: ticket.buyer },
      update: {},
      create: { wallet: ticket.buyer }
    });

    // Upsert Seller
    const sellerAgent = await prisma.agent.upsert({
      where: { wallet: ticket.seller },
      update: {},
      create: { wallet: ticket.seller }
    });

    // Create Ticket row
    await prisma.ticket.upsert({
      where: { id: ticket.ticket_id },
      update: {
        status: ticket.status,
        sellerId: sellerAgent.id,  // Update seller when counter-party joins
        rollupMode: ticket.rollup_mode ?? undefined,
        tokenMint: ticket.tokenMint,
        decimals: ticket.decimals,
        offerAsset: ticket.offer_asset,
        offerPrice: ticket.offer_price,
        offerAmount: ticket.offer_amount,
        offerCollateral: ticket.offer_collateral,
      },
      create: {
        id: ticket.ticket_id,
        buyerId: buyerAgent.id,
        sellerId: sellerAgent.id,
        rollupMode: ticket.rollup_mode || "NONE",
        tokenMint: ticket.tokenMint,
        decimals: ticket.decimals,
        offerAsset: ticket.offer_asset,
        offerPrice: ticket.offer_price,
        offerAmount: ticket.offer_amount,
        offerCollateral: ticket.offer_collateral,
        status: ticket.status
      }
    });
  }

  public async getTicket(ticket_id: string): Promise<TicketInterface | undefined> {
    const dbTicket = await prisma.ticket.findUnique({
      where: { id: ticket_id },
      include: {
        buyer: true,
        seller: true
      }
    });

    if (!dbTicket) return undefined;

    return {
      ticket_id: dbTicket.id,
      offer_id: "", // Not persisted in new schema
      buyer: dbTicket.buyer.wallet,
      seller: dbTicket.seller.wallet,
      status: dbTicket.status as TicketStatus,
      rollup_mode: (dbTicket as any).rollupMode,
      tokenMint: dbTicket.tokenMint ?? undefined,
      decimals: dbTicket.decimals ?? undefined,
      offer_asset: dbTicket.offerAsset ?? undefined,
      offer_price: dbTicket.offerPrice === null ? undefined : toNumber(dbTicket.offerPrice, "offerPrice"),
      offer_amount: dbTicket.offerAmount === null ? undefined : toNumber(dbTicket.offerAmount, "offerAmount"),
      offer_collateral: dbTicket.offerCollateral === null ? undefined : toNumber(dbTicket.offerCollateral, "offerCollateral"),
      agreed_terms:
        dbTicket.lastProposedPrice !== null &&
        dbTicket.lastCollateralBuyer !== null &&
        dbTicket.lastCollateralSeller !== null
          ? {
              price: toNumber(dbTicket.lastProposedPrice, "lastProposedPrice"),
              collateral_buyer: toNumber(dbTicket.lastCollateralBuyer, "lastCollateralBuyer"),
              collateral_seller: toNumber(dbTicket.lastCollateralSeller, "lastCollateralSeller"),
              asset_type: dbTicket.tokenMint ?? undefined,
            }
          : undefined,
      created_at: dbTicket.createdAt.toISOString()
    };
  }

  public async listTickets(): Promise<TicketInterface[]> {
    const dbTickets = await prisma.ticket.findMany({
      include: {
        buyer: true,
        seller: true
      }
    });

    return dbTickets.map(t => ({
      ticket_id: t.id,
      offer_id: "",
      buyer: t.buyer.wallet,
      seller: t.seller.wallet,
      status: t.status as TicketStatus,
      rollup_mode: (t as any).rollupMode,
      tokenMint: t.tokenMint ?? undefined,
      decimals: t.decimals ?? undefined,
      offer_asset: t.offerAsset ?? undefined,
      offer_price: t.offerPrice === null ? undefined : toNumber(t.offerPrice, "offerPrice"),
      offer_amount: t.offerAmount === null ? undefined : toNumber(t.offerAmount, "offerAmount"),
      offer_collateral: t.offerCollateral === null ? undefined : toNumber(t.offerCollateral, "offerCollateral"),
      agreed_terms:
        t.lastProposedPrice !== null &&
        t.lastCollateralBuyer !== null &&
        t.lastCollateralSeller !== null
          ? {
              price: toNumber(t.lastProposedPrice, "lastProposedPrice"),
              collateral_buyer: toNumber(t.lastCollateralBuyer, "lastCollateralBuyer"),
              collateral_seller: toNumber(t.lastCollateralSeller, "lastCollateralSeller"),
              asset_type: t.tokenMint ?? undefined,
            }
          : undefined,
      created_at: t.createdAt.toISOString()
    }));
  }

  public async recordNegotiatedTerms(ticket_id: string, terms: AgreedTerms): Promise<void> {
    const normalizedMint =
      (terms.asset_type && MeridianOtcGuard.normalizeSupportedAsset(terms.asset_type)) || undefined;

    await prisma.ticket.update({
      where: { id: ticket_id },
      data: {
        lastProposedPrice: terms.price,
        lastCollateralBuyer: terms.collateral_buyer,
        lastCollateralSeller: terms.collateral_seller,
        tokenMint:
          normalizedMint ||
          (terms.asset_type && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(terms.asset_type)
            ? terms.asset_type
            : undefined),
      },
    });

    logger.info("ticket_negotiated_terms_recorded", {
      ticket_id,
      price: terms.price,
      collateral_buyer: terms.collateral_buyer,
      collateral_seller: terms.collateral_seller,
      asset_type: terms.asset_type || "unknown",
    });
  }
}

export const ticketStore = new TicketStore();
