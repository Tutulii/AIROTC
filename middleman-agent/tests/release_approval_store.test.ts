import { describe, expect, it, vi } from "vitest";
import {
  ReleaseApprovalStore,
} from "../src/state/releaseApprovalStore";
import type {
  ReleaseApprovalRecord,
  ReleaseApprovalRequestEnvelope,
  ReleaseApprovalStateSnapshot,
} from "../src/protocol/releaseApprovalProtocol";

function makeRequest(role: "buyer" | "seller"): ReleaseApprovalRequestEnvelope {
  return {
    requestId: `ticket-1:${role}:1`,
    ticketId: "ticket-1",
    role,
    requestKind: "SETTLEMENT_PLAN",
    summary: {
      ticketId: "ticket-1",
      role,
      counterparty: role === "buyer" ? "seller-wallet" : "buyer-wallet",
      asset: "SOL",
      price: 1.5,
      buyerCollateral: 0.25,
      sellerCollateral: 0.35,
      settlementMode: "Stealth settlement",
      actionLabel: "Approve settlement plan",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    payload: {
      version: 1,
      action: "APPROVE_SETTLEMENT",
      ticketIdHash: "a".repeat(64),
      dealPda: "11111111111111111111111111111111",
      sessionPda: "11111111111111111111111111111111",
      intentIdHash: "b".repeat(64),
      role,
      route: "CONFIDENTIAL_ESCROW",
      settlementPolicy: "STEALTH",
      termsHash: "c".repeat(64),
      planHash: "d".repeat(64),
      nonce: "1",
      expiresAt: String(Date.now() + 60_000),
      timestamp: String(Date.now()),
    },
    messageBase64: "ZmFrZQ==",
    issuedAt: new Date().toISOString(),
  };
}

function makeSnapshot(): ReleaseApprovalStateSnapshot {
  return {
    ticketId: "ticket-1",
    dealPda: "deal-pda-1",
    sessionPda: "session-pda-1",
    buyerWallet: "buyer-wallet",
    sellerWallet: "seller-wallet",
    route: "CONFIDENTIAL_ESCROW",
    settlementPolicy: "STEALTH",
    termsHash: "c".repeat(64),
    planHash: "d".repeat(64),
    buyerSettlementTarget: "buyer-stealth",
    sellerSettlementTarget: "seller-stealth",
    requestIssuedAt: new Date().toISOString(),
    buyerRequest: makeRequest("buyer"),
    sellerRequest: makeRequest("seller"),
    settlementPlanApproved: false,
    buyerReleaseConfirmed: false,
    disputeOpen: false,
    releaseAuthorized: false,
    releaseSigned: false,
    releaseExecuted: false,
    txSignatures: [],
    updatedAt: new Date().toISOString(),
  };
}

function makeRecord(role: "buyer" | "seller"): ReleaseApprovalRecord {
  return {
    agentId: `${role}-agent`,
    wallet: `${role}-wallet`,
    action: "APPROVE_SETTLEMENT",
    signatureBase64: "ZmFrZQ==",
    txSignature: `${role}-tx`,
    approvalPda: `${role}-approval-pda`,
    recordedAt: new Date().toISOString(),
    nonce: "1",
    active: true,
  };
}

describe("ReleaseApprovalStore", () => {
  it("serializes concurrent buyer and seller approvals into one merged settlement state", async () => {
    const store = new ReleaseApprovalStore();
    let latestSnapshot = makeSnapshot();
    const persistedSnapshots: ReleaseApprovalStateSnapshot[] = [];

    vi.spyOn(store, "getLatestByTicket").mockImplementation(async () =>
      JSON.parse(JSON.stringify(latestSnapshot))
    );
    vi.spyOn(store, "save").mockImplementation(async (snapshot) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      latestSnapshot = JSON.parse(JSON.stringify(snapshot));
      persistedSnapshots.push(latestSnapshot);
    });

    const [buyerState, sellerState] = await Promise.all([
      store.recordApproval("ticket-1", "buyer", makeRecord("buyer")),
      store.recordApproval("ticket-1", "seller", makeRecord("seller")),
    ]);

    expect(buyerState?.buyerApproval?.active).toBe(true);
    expect(sellerState?.buyerApproval?.active).toBe(true);
    expect(sellerState?.sellerApproval?.active).toBe(true);
    expect(sellerState?.settlementPlanApproved).toBe(true);
    expect(latestSnapshot.buyerApproval?.active).toBe(true);
    expect(latestSnapshot.sellerApproval?.active).toBe(true);
    expect(latestSnapshot.settlementPlanApproved).toBe(true);
    expect(persistedSnapshots).toHaveLength(2);
  });
});
