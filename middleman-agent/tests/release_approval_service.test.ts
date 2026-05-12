import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type {
  DealPipelineContext,
  SettlementAddressPlan,
} from "../src/types/dealPipeline";
import type { PreparedConfidentialSettlement } from "../src/services/releaseApprovalService";

const mocks = vi.hoisted(() => ({
  ticketFindUnique: vi.fn(),
  createInitial: vi.fn(),
  deliverStructuredToAgent: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn(),
  identityGetLatestByTicket: vi.fn(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    ticket: {
      findUnique: mocks.ticketFindUnique,
    },
  },
}));

vi.mock("../src/state/releaseApprovalStore", () => ({
  releaseApprovalStore: {
    createInitial: mocks.createInitial,
    getLatestByTicket: vi.fn(),
    markAuthorized: vi.fn(),
  },
}));

vi.mock("../src/services/outboundRouter", () => ({
  deliverStructuredToAgent: mocks.deliverStructuredToAgent,
}));

vi.mock("../src/services/eventBus", () => ({
  eventBus: {
    publish: mocks.publish,
  },
}));

vi.mock("../src/state/walletRegistry", () => ({
  walletRegistry: {
    getOrCreateAgent: vi.fn(),
    getAgentById: vi.fn(),
  },
}));

vi.mock("../src/state/confidentialIdentityStore", () => ({
  confidentialIdentityStore: {
    getLatestByTicket: mocks.identityGetLatestByTicket,
  },
}));

import { releaseApprovalService } from "../src/services/releaseApprovalService";

const dealPda = Keypair.generate().publicKey.toBase58();
const sessionPda = Keypair.generate().publicKey.toBase58();
const buyerTarget = Keypair.generate().publicKey.toBase58();
const sellerTarget = Keypair.generate().publicKey.toBase58();
const requestAccount = Keypair.generate().publicKey.toBase58();
const dwalletPda = Keypair.generate().publicKey.toBase58();

const context: DealPipelineContext = {
  ticketId: "ticket-per-1",
  buyer: "buyer-wallet",
  seller: "seller-wallet",
  price: 0,
  collateralBuyer: 0,
  collateralSeller: 0,
  assetType: "SOL",
  tokenMint: "So11111111111111111111111111111111111111112",
  confidence: 100,
  rollupMode: "PER",
  negotiationSource: "PER",
  termsVisibility: "REDACTED",
  route: "CONFIDENTIAL_ESCROW",
  executionPolicy: "CONFIDENTIAL",
  settlementPolicy: "STEALTH",
  routeReason: "test",
};

const prepared: PreparedConfidentialSettlement = {
  ticketId: "ticket-per-1",
  dealPda,
  sessionPda,
  intentId: "intent-1",
  termsHash: "a".repeat(64),
  planHash: "b".repeat(64),
  buyerSettlementTarget: buyerTarget,
  sellerSettlementTarget: sellerTarget,
  requestAccount,
  dwalletPda,
  decryptedValue: "1",
  winner: "buyer-wallet",
  txSignatures: ["sig-1"],
};

const settlementPlan: SettlementAddressPlan = {
  policy: "STEALTH",
  resolution: "resolved",
  assetMint: "So11111111111111111111111111111111111111112",
  buyerTarget: {
    role: "buyer",
    strategy: "UMBRA_STEALTH",
    baseWallet: "buyer-wallet",
    resolvedAddress: buyerTarget,
    resolvedAddressKind: "umbra_registered_receiver_wallet",
    status: "resolved",
  },
  sellerTarget: {
    role: "seller",
    strategy: "UMBRA_STEALTH",
    baseWallet: "seller-wallet",
    resolvedAddress: sellerTarget,
    resolvedAddressKind: "umbra_registered_receiver_wallet",
    status: "resolved",
  },
  notes: ["test"],
};

describe("releaseApprovalService", () => {
  beforeEach(() => {
    mocks.ticketFindUnique.mockReset();
    mocks.createInitial.mockReset();
    mocks.deliverStructuredToAgent.mockReset();
    mocks.publish.mockReset();
    mocks.identityGetLatestByTicket.mockReset();

    mocks.ticketFindUnique.mockResolvedValue({
      buyerId: "buyer-agent",
      sellerId: "seller-agent",
    });
    mocks.deliverStructuredToAgent.mockResolvedValue(undefined);
    mocks.identityGetLatestByTicket.mockResolvedValue(null);
  });

  it("keeps PER settlement-plan approval requests redacted server-side", async () => {
    const snapshot = await releaseApprovalService.initializeApprovalRequests(
      context,
      prepared,
      settlementPlan
    );

    expect(snapshot.buyerRequest.summary).toMatchObject({
      asset: "SOL",
      price: 0,
      buyerCollateral: 0,
      sellerCollateral: 0,
      redacted: true,
      localTermsRequired: true,
      actionLabel: "Approve settlement plan",
    });
    expect(snapshot.sellerRequest.summary).toMatchObject({
      asset: "SOL",
      price: 0,
      buyerCollateral: 0,
      sellerCollateral: 0,
      redacted: true,
      localTermsRequired: true,
      actionLabel: "Approve settlement plan",
    });

    expect(mocks.createInitial).toHaveBeenCalledTimes(1);
    expect(mocks.deliverStructuredToAgent).toHaveBeenCalledTimes(2);
    expect(mocks.deliverStructuredToAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: "buyer-agent",
        ticketId: "ticket-per-1",
        payload: expect.objectContaining({
          type: "RELEASE_APPROVAL_REQUEST",
          payload: expect.objectContaining({
            summary: expect.objectContaining({
              redacted: true,
              localTermsRequired: true,
            }),
          }),
        }),
      })
    );
    expect(mocks.deliverStructuredToAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agentId: "seller-agent",
        ticketId: "ticket-per-1",
        payload: expect.objectContaining({
          type: "RELEASE_APPROVAL_REQUEST",
          payload: expect.objectContaining({
            summary: expect.objectContaining({
              redacted: true,
              localTermsRequired: true,
            }),
          }),
        }),
      })
    );
  });

  it("persists per-deal confidential signer wallets when available", async () => {
    mocks.identityGetLatestByTicket.mockResolvedValue({
      buyerFundingWallet: "buyer-funding-wallet",
      sellerFundingWallet: "seller-funding-wallet",
    });

    const snapshot = await releaseApprovalService.initializeApprovalRequests(
      context,
      prepared,
      settlementPlan
    );

    expect(snapshot.buyerFundingWallet).toBe("buyer-funding-wallet");
    expect(snapshot.sellerFundingWallet).toBe("seller-funding-wallet");
  });
});
