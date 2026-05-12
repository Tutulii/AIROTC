import { describe, expect, it, vi } from "vitest";
import { ConfidentialFundingStore } from "../src/state/confidentialFundingStore";
import type {
  ConfidentialFundingRequestEnvelope,
  ConfidentialFundingStateSnapshot,
} from "../src/protocol/confidentialFundingProtocol";

function makeRequest(role: "buyer" | "seller"): ConfidentialFundingRequestEnvelope {
  return {
    requestId: `ticket-1:${role}:funding:1`,
    ticketId: "ticket-1",
    role,
    requestKind: role === "buyer" ? "BUYER_FUNDING" : "SELLER_FUNDING",
    summary: {
      ticketId: "ticket-1",
      role,
      counterparty: role === "buyer" ? "seller-wallet" : "buyer-wallet",
      asset: "SOL",
      buyerPayment: 1.5,
      buyerCollateral: 0.25,
      sellerCollateral: 0.35,
      settlementMode: "Stealth settlement",
      actionLabel: "Fund confidential escrow",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    dealPda: "deal-pda-1",
    sessionPda: "11111111111111111111111111111111",
    termsHash: "a".repeat(64),
    instructions:
      role === "buyer"
        ? [
            { fundingRole: "buyer_payment", fundingHash: "b".repeat(64) },
            { fundingRole: "buyer_collateral", fundingHash: "c".repeat(64) },
          ]
        : [{ fundingRole: "seller_collateral", fundingHash: "d".repeat(64) }],
    issuedAt: new Date().toISOString(),
  };
}

function makeSnapshot(): ConfidentialFundingStateSnapshot {
  return {
    ticketId: "ticket-1",
    dealPda: "deal-pda-1",
    sessionPda: "11111111111111111111111111111111",
    buyerWallet: "buyer-wallet",
    sellerWallet: "seller-wallet",
    buyerSettlementTarget: "buyer-stealth",
    sellerSettlementTarget: "seller-stealth",
    termsHash: "a".repeat(64),
    planHash: "e".repeat(64),
    requestIssuedAt: new Date().toISOString(),
    buyerRequest: makeRequest("buyer"),
    sellerRequest: makeRequest("seller"),
    allFundingRecorded: false,
    txSignatures: [],
    updatedAt: new Date().toISOString(),
  };
}

describe("ConfidentialFundingStore", () => {
  it("serializes concurrent buyer and seller funding submissions into one merged state", async () => {
    const store = new ConfidentialFundingStore();
    let latestSnapshot = makeSnapshot();
    const persistedSnapshots: ConfidentialFundingStateSnapshot[] = [];

    vi.spyOn(store, "getLatestByTicket").mockImplementation(async () =>
      JSON.parse(JSON.stringify(latestSnapshot))
    );
    vi.spyOn(store, "save").mockImplementation(async (snapshot) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      latestSnapshot = JSON.parse(JSON.stringify(snapshot));
      persistedSnapshots.push(latestSnapshot);
    });

    const [buyerState, sellerState] = await Promise.all([
      store.recordFunding("ticket-1", "buyer", {
        agentId: "buyer-agent",
        wallet: "buyer-wallet",
        transactionSignatures: ["buyer-tx-1", "buyer-tx-2"],
        recordedAt: new Date().toISOString(),
        active: true,
      }),
      store.recordFunding("ticket-1", "seller", {
        agentId: "seller-agent",
        wallet: "seller-wallet",
        transactionSignatures: ["seller-tx-1"],
        recordedAt: new Date().toISOString(),
        active: true,
      }),
    ]);

    expect(buyerState?.buyerFunding?.active).toBe(true);
    expect(sellerState?.buyerFunding?.active).toBe(true);
    expect(sellerState?.sellerFunding?.active).toBe(true);
    expect(sellerState?.allFundingRecorded).toBe(true);
    expect(latestSnapshot.allFundingRecorded).toBe(true);
    expect(latestSnapshot.txSignatures).toEqual(
      expect.arrayContaining(["buyer-tx-1", "buyer-tx-2", "seller-tx-1"])
    );
    expect(persistedSnapshots).toHaveLength(2);
  });
});
