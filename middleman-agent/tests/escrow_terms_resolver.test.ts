import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveEscrowTermsForTicket } from "../src/services/escrowTermsResolver";
import type { Ticket } from "../src/types/ticket";

vi.mock("../src/utils/logger", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const baseTicket: Ticket = {
  ticket_id: "ticket-1",
  offer_id: "offer-1",
  buyer: "buyer-wallet",
  seller: "seller-wallet",
  status: "active",
  rollup_mode: "NONE",
  created_at: new Date("2026-07-02T00:00:00.000Z").toISOString(),
};

describe("escrow terms resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses native SOL offer amount as escrow payment when unit price was parsed as payment", () => {
    const resolved = resolveEscrowTermsForTicket(
      {
        ...baseTicket,
        offer_asset: "SOL",
        offer_amount: 0.3,
        offer_price: 1,
        offer_collateral: 0.2,
      },
      {
        price: 1,
        collateral_buyer: 0.2,
        collateral_seller: 0.2,
        asset_type: "SOL",
      },
    );

    expect(resolved).toEqual({
      price: 0.3,
      collateral_buyer: 0.2,
      collateral_seller: 0.2,
      asset_type: "SOL",
    });
  });

  it("leaves already-normalized native SOL terms unchanged", () => {
    const terms = {
      price: 0.3,
      collateral_buyer: 0.2,
      collateral_seller: 0.2,
      asset_type: "SOL",
    };

    const resolved = resolveEscrowTermsForTicket(
      {
        ...baseTicket,
        offer_asset: "SOL",
        offer_amount: 0.3,
        offer_price: 1,
      },
      terms,
    );

    expect(resolved).toBe(terms);
  });

  it("does not rewrite non-SOL token terms", () => {
    const terms = {
      price: 1,
      collateral_buyer: 0.2,
      collateral_seller: 0.2,
      asset_type: "USDC",
    };

    const resolved = resolveEscrowTermsForTicket(
      {
        ...baseTicket,
        tokenMint: "EPjFWdd5AufqSSqeM2qbmYKGs3k6m3qUqp33n97dc1w",
        offer_asset: "USDC",
        offer_amount: 0.3,
        offer_price: 1,
      },
      terms,
    );

    expect(resolved).toBe(terms);
  });
});
