import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { MeridianClient } from "../agents/sdk/MeridianClient";

describe("Marketplace-backed PER contract E2E", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps marketplace discovery public while forcing private rollup negotiation and local hydration after accept", async () => {
    const offerId = "offer-per-1";
    const ticketId = "ticket-per-1";

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { id: offerId },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: offerId,
              asset: "SOL",
              price: 5,
              amount: 1,
              mode: "sell",
              collateral: 2,
              status: "active",
              rollupMode: "PER",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ticket: { id: ticketId },
        }),
      });

    const seller = new MeridianClient({
      apiUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3001",
      keypair: Keypair.generate(),
      privateMode: true,
      strictOpaquePerMode: true,
    });
    const buyer = new MeridianClient({
      apiUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3001",
      keypair: Keypair.generate(),
      privateMode: true,
      strictOpaquePerMode: true,
    });
    vi.spyOn(seller as any, "createFreshSettlementWallet").mockResolvedValue("seller-stealth-wallet");
    vi.spyOn(buyer as any, "createFreshSettlementWallet").mockResolvedValue("buyer-stealth-wallet");

    await seller.createOffer({
      asset: "SOL",
      side: "sell",
      amount: 1,
      price: 5,
      collateral: 2,
    });
    const offers = await buyer.getOffers({ asset: "SOL", side: "sell" });
    const acceptedTicketId = await buyer.acceptOffer(offerId);

    expect(offers).toEqual([
      expect.objectContaining({
        id: offerId,
        rollupMode: "PER",
      }),
    ]);
    expect(acceptedTicketId).toBe(ticketId);

    (buyer as any).currentTicketId = ticketId;
    (buyer as any).rollupMode = "PER";
    (buyer as any).sessionPda = Keypair.generate().publicKey;

    expect(() =>
      buyer.sendMessage(ticketId, "price 5 sol and collateral 2")
    ).toThrow(/Use submitRollupTerms\(\) \/ finalizeRollupConsensus\(\) instead/);

    buyer.rememberPrivateTerms(ticketId, {
      priceLamports: 5_000_000_000,
      quantity: 1,
      assetMint: "SOL",
      collateralBuyer: 2,
      collateralSeller: 2,
    });

    (buyer as any).handleMessage({
      type: "CONFIDENTIAL_FUNDING_REQUEST",
      payload: {
        requestId: "funding-1",
        ticketId,
        role: "buyer",
        requestKind: "BUYER_FUNDING",
        summary: {
          ticketId,
          role: "buyer",
          counterparty: seller["wallet"],
          asset: "SOL",
          buyerPayment: 0,
          buyerCollateral: 0,
          sellerCollateral: 0,
          settlementMode: "Stealth settlement",
          actionLabel: "Fund confidential escrow",
          expiresAt: new Date().toISOString(),
          redacted: true,
          localTermsRequired: true,
        },
        dealPda: Keypair.generate().publicKey.toBase58(),
        sessionPda: Keypair.generate().publicKey.toBase58(),
        termsHash: "a".repeat(64),
        instructions: [
          {
            fundingRole: "buyer_payment",
            fundingHash: "b".repeat(64),
          },
          {
            fundingRole: "buyer_collateral",
            fundingHash: "c".repeat(64),
          },
        ],
        issuedAt: new Date().toISOString(),
      },
    });

    const hydratedFunding = buyer.getFundingRequest(ticketId);
    expect(hydratedFunding?.summary.redacted).toBe(false);
    expect(hydratedFunding?.summary.localTermsRequired).toBe(false);
    expect(hydratedFunding?.summary.buyerPayment).toBe(5);
    expect(hydratedFunding?.summary.buyerCollateral).toBe(2);
    expect(hydratedFunding?.summary.sellerCollateral).toBe(2);

    (buyer as any).handleMessage({
      type: "RELEASE_APPROVAL_REQUEST",
      payload: {
        requestId: "release-1",
        ticketId,
        role: "buyer",
        requestKind: "SETTLEMENT_PLAN",
        summary: {
          ticketId,
          role: "buyer",
          counterparty: seller["wallet"],
          asset: "SOL",
          price: 0,
          buyerCollateral: 0,
          sellerCollateral: 0,
          settlementMode: "Stealth settlement",
          actionLabel: "Approve settlement plan",
          expiresAt: new Date().toISOString(),
          redacted: true,
          localTermsRequired: true,
        },
        payload: {
          version: 1,
          action: "APPROVE_SETTLEMENT",
          ticketIdHash: "d".repeat(64),
          dealPda: Keypair.generate().publicKey.toBase58(),
          sessionPda: Keypair.generate().publicKey.toBase58(),
          intentIdHash: "e".repeat(64),
          role: "buyer",
          route: "CONFIDENTIAL_ESCROW",
          settlementPolicy: "STEALTH",
          termsHash: "f".repeat(64),
          planHash: "a".repeat(64),
          nonce: "1",
          expiresAt: String(Date.now() + 60_000),
          timestamp: String(Date.now()),
        },
        messageBase64: Buffer.from("release").toString("base64"),
        issuedAt: new Date().toISOString(),
      },
    });

    const hydratedRelease = buyer.getReleaseRequest(ticketId);
    expect(hydratedRelease?.summary.redacted).toBe(false);
    expect(hydratedRelease?.summary.localTermsRequired).toBe(false);
    expect(hydratedRelease?.summary.price).toBe(5);
    expect(hydratedRelease?.summary.buyerCollateral).toBe(2);
    expect(hydratedRelease?.summary.sellerCollateral).toBe(2);
  });
});
