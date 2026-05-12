import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (payload: any) => unknown>();
  const listenerLog = {
    info: vi.fn(),
    error: vi.fn(),
  };

  return {
    handlers,
    listenerLog,
    subscribe: vi.fn((event: string, handler: (payload: any) => unknown) => {
      handlers.set(event, handler);
    }),
    publish: vi.fn(),
    buildNegotiationOutcome: vi.fn(),
    start: vi.fn(),
    startFromPrivateEscrowIntent: vi.fn(),
    continueConfidentialSettlementAfterFunding: vi.fn(),
    getByIntentId: vi.fn(),
    processAgentSubmission: vi.fn(),
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      withContext: vi.fn(() => listenerLog),
    },
  };
});

vi.mock("../src/services/eventBus", () => ({
  eventBus: {
    subscribe: mocks.subscribe,
    publish: mocks.publish,
  },
}));

vi.mock("../src/services/dealPipeline", () => ({
  dealPipeline: {
    buildNegotiationOutcome: mocks.buildNegotiationOutcome,
    start: mocks.start,
    startFromPrivateEscrowIntent: mocks.startFromPrivateEscrowIntent,
    continueConfidentialSettlementAfterFunding: mocks.continueConfidentialSettlementAfterFunding,
  },
}));

vi.mock("../src/state/privateEscrowIntentStore", () => ({
  privateEscrowIntentStore: {
    getByIntentId: mocks.getByIntentId,
  },
}));

vi.mock("../src/services/confidentialFundingService", () => ({
  confidentialFundingService: {
    processAgentSubmission: mocks.processAgentSubmission,
  },
}));

vi.mock("../src/utils/logger", () => ({
  logger: mocks.logger,
}));

describe("escrowListener integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
  });

  async function loadListener() {
    vi.resetModules();
    return await import("../src/listeners/escrowListener");
  }

  it("subscribes to both agreement and private intent events and routes ER agreement into the canonical deal pipeline", async () => {
    const { initEscrowListener } = await loadListener();
    mocks.buildNegotiationOutcome.mockResolvedValue({
      ticketId: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      price: 1.5,
      collateralBuyer: 0.25,
      collateralSeller: 0.35,
      assetType: "SOL",
      confidence: 100,
      rollupMode: "ER",
      negotiationSource: "ER",
    });
    mocks.start.mockResolvedValue({
      success: true,
      route: "STANDARD_ESCROW",
      stage: "escrow_created",
      status: "created_awaiting_deposits",
      dealPda: "deal-pda",
      txSignatures: ["sig-1"],
    });

    initEscrowListener();
    initEscrowListener();

    expect(mocks.subscribe).toHaveBeenCalledTimes(5);
    const handler = mocks.handlers.get("agreement_detected");
    expect(handler).toBeTypeOf("function");
    expect(mocks.handlers.get("private_escrow_intent_ready")).toBeTypeOf("function");
    expect(mocks.handlers.get("release_authorized")).toBeTypeOf("function");
    expect(mocks.handlers.get("confidential_funding_submitted")).toBeTypeOf("function");
    expect(mocks.handlers.get("confidential_funding_completed")).toBeTypeOf("function");

    await handler?.({
      ticketId: "ticket-1",
      price: 1.5,
      collateral_buyer: 0.25,
      collateral_seller: 0.35,
      asset_type: "SOL",
      confidence: 100,
      buyer: "buyer-wallet",
      seller: "seller-wallet",
    });

    expect(mocks.buildNegotiationOutcome).toHaveBeenCalledWith({
      ticketId: "ticket-1",
      price: 1.5,
      collateral_buyer: 0.25,
      collateral_seller: 0.35,
      asset_type: "SOL",
      confidence: 100,
      buyer: "buyer-wallet",
      seller: "seller-wallet",
    });
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "ticket-1",
        negotiationSource: "ER",
      })
    );
    expect(mocks.publish).not.toHaveBeenCalledWith("deal_executed", {
      ticket_id: "ticket-1",
      status: "failed",
    });
  });

  it("loads a private escrow intent and routes it into the confidential pipeline entrypoint", async () => {
    const { initEscrowListener } = await loadListener();
    mocks.getByIntentId.mockResolvedValue({
      intentId: "intent-1",
      ticketId: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      sessionPda: "session-pda",
      termsHash: "hash-1",
      assetMint: "So11111111111111111111111111111111111111112",
      fundingCommitments: {
        buyerPaymentHash: "a".repeat(64),
        buyerCollateralHash: "b".repeat(64),
        sellerCollateralHash: "c".repeat(64),
      },
      status: "consensus_confirmed",
    });
    mocks.startFromPrivateEscrowIntent.mockResolvedValue({
      success: true,
      route: "CONFIDENTIAL_ESCROW",
      stage: "encrypted",
      status: "confidential_completed",
      dealPda: "deal-pda",
      txSignatures: ["sig-1", "sig-2"],
    });

    initEscrowListener();
    const handler = mocks.handlers.get("private_escrow_intent_ready");

    await handler?.({
      ticketId: "ticket-1",
      intentId: "intent-1",
      rollupMode: "PER",
      negotiationSource: "PER",
      sessionPda: "session-pda",
      termsHash: "hash-1",
      assetMint: "So11111111111111111111111111111111111111112",
      status: "consensus_confirmed",
    });

    expect(mocks.getByIntentId).toHaveBeenCalledWith("ticket-1", "intent-1");
    expect(mocks.startFromPrivateEscrowIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: "intent-1",
        ticketId: "ticket-1",
      })
    );
    expect(mocks.publish).not.toHaveBeenCalledWith("deal_executed", {
      ticket_id: "ticket-1",
      status: "failed",
    });
  });

  it("publishes a failed deal_executed event when the downstream pipeline throws", async () => {
    const { initEscrowListener } = await loadListener();
    mocks.buildNegotiationOutcome.mockResolvedValue({
      ticketId: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      price: 1.5,
      collateralBuyer: 0.25,
      collateralSeller: 0.35,
      assetType: "SOL",
      confidence: 100,
      rollupMode: "PER",
      negotiationSource: "PER",
    });
    mocks.start.mockRejectedValue(new Error("pipeline exploded"));

    initEscrowListener();
    const handler = mocks.handlers.get("agreement_detected");

    await handler?.({
      ticketId: "ticket-1",
      price: 1.5,
      collateral_buyer: 0.25,
      collateral_seller: 0.35,
      asset_type: "SOL",
      confidence: 100,
      buyer: "buyer-wallet",
      seller: "seller-wallet",
    });

    expect(mocks.publish).toHaveBeenCalledWith("deal_executed", {
      ticket_id: "ticket-1",
      status: "failed",
    });
    expect(mocks.listenerLog.error).toHaveBeenCalled();
  });

  it("publishes a failed deal_executed event when the private intent pipeline throws", async () => {
    const { initEscrowListener } = await loadListener();
    mocks.getByIntentId.mockResolvedValue({
      intentId: "intent-1",
      ticketId: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      fundingCommitments: {
        buyerPaymentHash: "a".repeat(64),
        buyerCollateralHash: "b".repeat(64),
        sellerCollateralHash: "c".repeat(64),
      },
    });
    mocks.startFromPrivateEscrowIntent.mockRejectedValue(new Error("private pipeline exploded"));

    initEscrowListener();
    const handler = mocks.handlers.get("private_escrow_intent_ready");

    await handler?.({
      ticketId: "ticket-1",
      intentId: "intent-1",
      rollupMode: "PER",
      negotiationSource: "PER",
      sessionPda: "session-pda",
      termsHash: "hash-1",
      assetMint: "So11111111111111111111111111111111111111112",
      status: "consensus_confirmed",
    });

    expect(mocks.publish).toHaveBeenCalledWith("deal_executed", {
      ticket_id: "ticket-1",
      status: "failed",
    });
    expect(mocks.listenerLog.error).toHaveBeenCalled();
  });

  it("processes confidential funding submissions and resumes the pipeline when funding completes", async () => {
    const { initEscrowListener } = await loadListener();
    mocks.processAgentSubmission.mockResolvedValue({
      ticketId: "ticket-1",
      dealPda: "deal-pda",
      allFundingRecorded: true,
    });
    mocks.continueConfidentialSettlementAfterFunding.mockResolvedValue({
      success: true,
      route: "CONFIDENTIAL_ESCROW",
      stage: "awaiting_settlement_plan_approvals",
      status: "awaiting_settlement_plan_approvals",
      dealPda: "deal-pda",
      txSignatures: ["sig-1"],
    });

    initEscrowListener();
    const submitted = mocks.handlers.get("confidential_funding_submitted");
    const completed = mocks.handlers.get("confidential_funding_completed");

    await submitted?.({
      ticketId: "ticket-1",
      agentId: "buyer-agent",
      requestId: "ticket-1:buyer:funding:1",
      transactionSignatures: ["sig-1", "sig-2"],
    });
    await completed?.({
      ticketId: "ticket-1",
      dealPda: "deal-pda",
    });

    expect(mocks.processAgentSubmission).toHaveBeenCalledWith({
      ticketId: "ticket-1",
      agentId: "buyer-agent",
      requestId: "ticket-1:buyer:funding:1",
      transactionSignatures: ["sig-1", "sig-2"],
    });
    expect(mocks.continueConfidentialSettlementAfterFunding).toHaveBeenCalledWith("ticket-1");
  });
});
