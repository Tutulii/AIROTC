import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfidentialFundingStateSnapshot } from "../src/protocol/confidentialFundingProtocol";
import type { ReleaseApprovalStateSnapshot } from "../src/protocol/releaseApprovalProtocol";
import type { SettlementTargetSnapshot } from "../src/state/settlementTargetStore";
import {
  revealPrivateMetadata,
  type SealedPrivateMetadataEnvelope,
} from "../src/services/privateMetadataSeal";

const mocks = vi.hoisted(() => ({
  appendAuditLog: vi.fn(),
  appendAuditLogStrict: vi.fn(),
}));

vi.mock("../src/services/auditTrail", () => ({
  appendAuditLog: mocks.appendAuditLog,
  appendAuditLogStrict: mocks.appendAuditLogStrict,
}));

const ORIGINAL_KEY = process.env.PRIVATE_METADATA_SEAL_KEY;
const TEST_KEY = Buffer.alloc(32, 19).toString("base64");

function buildSettlementSnapshot(): SettlementTargetSnapshot {
  return {
    ticketId: "ticket-1",
    buyerWallet: "buyer-wallet",
    sellerWallet: "seller-wallet",
    buyerSettlementWallet: "buyer-stealth-wallet",
    sellerSettlementWallet: "seller-stealth-wallet",
    source: "test_context",
    recordedAt: new Date().toISOString(),
    notes: ["privacy-test"],
  };
}

function buildFundingSnapshot(): ConfidentialFundingStateSnapshot {
  return {
    ticketId: "ticket-1",
    dealPda: "deal-pda-1",
    sessionPda: "session-pda-1",
    buyerWallet: "buyer-wallet",
    sellerWallet: "seller-wallet",
    buyerSettlementTarget: "buyer-stealth-wallet",
    sellerSettlementTarget: "seller-stealth-wallet",
    termsHash: "a".repeat(64),
    planHash: "b".repeat(64),
    requestIssuedAt: new Date().toISOString(),
    buyerRequest: {
      requestId: "ticket-1:buyer:funding:1",
      ticketId: "ticket-1",
      role: "buyer",
      requestKind: "BUYER_FUNDING",
      summary: {
        ticketId: "ticket-1",
        role: "buyer",
        counterparty: "seller-wallet",
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
      dealPda: "deal-pda-1",
      sessionPda: "session-pda-1",
      termsHash: "a".repeat(64),
      instructions: [
        { fundingRole: "buyer_payment", fundingHash: "c".repeat(64) },
        { fundingRole: "buyer_collateral", fundingHash: "d".repeat(64) },
      ],
      issuedAt: new Date().toISOString(),
    },
    sellerRequest: {
      requestId: "ticket-1:seller:funding:1",
      ticketId: "ticket-1",
      role: "seller",
      requestKind: "SELLER_FUNDING",
      summary: {
        ticketId: "ticket-1",
        role: "seller",
        counterparty: "buyer-wallet",
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
      dealPda: "deal-pda-1",
      sessionPda: "session-pda-1",
      termsHash: "a".repeat(64),
      instructions: [{ fundingRole: "seller_collateral", fundingHash: "e".repeat(64) }],
      issuedAt: new Date().toISOString(),
    },
    allFundingRecorded: false,
    txSignatures: [],
    updatedAt: new Date().toISOString(),
  };
}

function buildReleaseSnapshot(): ReleaseApprovalStateSnapshot {
  return {
    ticketId: "ticket-1",
    dealPda: "deal-pda-1",
    sessionPda: "session-pda-1",
    buyerWallet: "buyer-wallet",
    sellerWallet: "seller-wallet",
    route: "CONFIDENTIAL_ESCROW",
    settlementPolicy: "STEALTH",
    termsHash: "f".repeat(64),
    planHash: "1".repeat(64),
    buyerSettlementTarget: "buyer-stealth-wallet",
    sellerSettlementTarget: "seller-stealth-wallet",
    requestIssuedAt: new Date().toISOString(),
    buyerRequest: {
      requestId: "ticket-1:buyer:1",
      ticketId: "ticket-1",
      role: "buyer",
      requestKind: "SETTLEMENT_PLAN",
      summary: {
        ticketId: "ticket-1",
        role: "buyer",
        counterparty: "seller-wallet",
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
        ticketIdHash: "2".repeat(64),
        dealPda: "deal-pda-1",
        sessionPda: "session-pda-1",
        intentIdHash: "3".repeat(64),
        role: "buyer",
        route: "CONFIDENTIAL_ESCROW",
        settlementPolicy: "STEALTH",
        termsHash: "f".repeat(64),
        planHash: "1".repeat(64),
        nonce: "1",
        expiresAt: String(Date.now() + 60_000),
        timestamp: String(Date.now()),
      },
      messageBase64: "ZmFrZQ==",
      issuedAt: new Date().toISOString(),
    },
    sellerRequest: {
      requestId: "ticket-1:seller:1",
      ticketId: "ticket-1",
      role: "seller",
      requestKind: "SETTLEMENT_PLAN",
      summary: {
        ticketId: "ticket-1",
        role: "seller",
        counterparty: "buyer-wallet",
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
        ticketIdHash: "2".repeat(64),
        dealPda: "deal-pda-1",
        sessionPda: "session-pda-1",
        intentIdHash: "3".repeat(64),
        role: "seller",
        route: "CONFIDENTIAL_ESCROW",
        settlementPolicy: "STEALTH",
        termsHash: "f".repeat(64),
        planHash: "1".repeat(64),
        nonce: "1",
        expiresAt: String(Date.now() + 60_000),
        timestamp: String(Date.now()),
      },
      messageBase64: "ZmFrZQ==",
      issuedAt: new Date().toISOString(),
    },
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

describe("PER sensitive snapshot sealing", () => {
  beforeEach(() => {
    mocks.appendAuditLog.mockReset();
    mocks.appendAuditLogStrict.mockReset();
    process.env.PRIVATE_METADATA_SEAL_KEY = TEST_KEY;
  });

  afterEach(() => {
    process.env.PRIVATE_METADATA_SEAL_KEY = ORIGINAL_KEY;
  });

  it("seals settlement, funding, and release snapshots before persisting them", async () => {
    const prismaModule = await import("../src/lib/prisma");
    vi.spyOn(prismaModule.prisma.auditLog, "findMany").mockResolvedValue([] as any);

    const [{ SettlementTargetStore }, { ConfidentialFundingStore }, { ReleaseApprovalStore }] =
      await Promise.all([
        import("../src/state/settlementTargetStore"),
        import("../src/state/confidentialFundingStore"),
        import("../src/state/releaseApprovalStore"),
      ]);

    const settlementSnapshot = buildSettlementSnapshot();
    const fundingSnapshot = buildFundingSnapshot();
    const releaseSnapshot = buildReleaseSnapshot();

    await new SettlementTargetStore().save(settlementSnapshot);
    await new ConfidentialFundingStore().save(fundingSnapshot);
    await new ReleaseApprovalStore().save(releaseSnapshot);

    const strictPersisted = mocks.appendAuditLogStrict.mock.calls[0]?.[2] as SealedPrivateMetadataEnvelope;
    const fundingPersisted = mocks.appendAuditLog.mock.calls[0]?.[2] as SealedPrivateMetadataEnvelope;
    const releasePersisted = mocks.appendAuditLog.mock.calls[1]?.[2] as SealedPrivateMetadataEnvelope;

    for (const persisted of [strictPersisted, fundingPersisted, releasePersisted]) {
      const serialized = JSON.stringify(persisted);
      expect(serialized).not.toContain("buyer-wallet");
      expect(serialized).not.toContain("seller-wallet");
      expect(serialized).not.toContain("buyer-stealth-wallet");
      expect(serialized).not.toContain("seller-stealth-wallet");
      expect(serialized).not.toContain("aaaaaaaa");
      expect(persisted.sealed).toBeDefined();
    }

    expect(revealPrivateMetadata<SettlementTargetSnapshot>(strictPersisted)).toEqual(
      settlementSnapshot
    );
    expect(revealPrivateMetadata<ConfidentialFundingStateSnapshot>(fundingPersisted)).toEqual(
      fundingSnapshot
    );
    expect(revealPrivateMetadata<ReleaseApprovalStateSnapshot>(releasePersisted)).toEqual(
      releaseSnapshot
    );
  });
});
