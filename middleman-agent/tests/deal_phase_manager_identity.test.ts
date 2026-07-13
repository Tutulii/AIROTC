import { beforeEach, describe, expect, it, vi } from "vitest";

const publishMock = vi.fn();
const upsertMock = vi.fn().mockResolvedValue({});
const agentFindUniqueMock = vi.fn();
const phaseFindUniqueMock = vi.fn().mockResolvedValue(null);
const onChainDealFetchMock = vi.fn();
const initDealMock = vi.fn().mockResolvedValue(undefined);
const updateStatusMock = vi.fn().mockResolvedValue(undefined);
const appendAuditLogMock = vi.fn();
const ticketStoreGetMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/services/eventBus", () => ({
  eventBus: {
    publish: publishMock,
  },
}));

vi.mock("../src/state/vectorMemoryStore", () => ({
  vectorMemoryStore: {},
}));

vi.mock("../src/state/dealTracker", () => ({
  dealTracker: {
    initDeal: initDealMock,
    updateStatus: updateStatusMock,
    getDealByTicket: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../src/state/ticketStore", () => ({
  ticketStore: {
    getTicket: ticketStoreGetMock,
  },
}));

vi.mock("../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    agent: {
      findUnique: agentFindUniqueMock,
    },
    dealPhaseState: {
      upsert: upsertMock,
      findUnique: phaseFindUniqueMock,
    },
  },
}));

vi.mock("../src/services/onChainExecutionService", () => ({
  getAnchorProgram: () => ({
    program: {
      account: {
        deal: {
          fetch: onChainDealFetchMock,
        },
      },
    },
  }),
}));

vi.mock("../src/services/auditTrail", () => ({
  appendAuditLog: appendAuditLogMock,
}));

vi.mock("../core/aiJudge", () => ({
  adjudicateDispute: vi.fn(),
}));

describe("dealPhaseManager identity authorization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    upsertMock.mockResolvedValue({});
    phaseFindUniqueMock.mockResolvedValue(null);
    onChainDealFetchMock.mockReset();
    initDealMock.mockResolvedValue(undefined);
    updateStatusMock.mockResolvedValue(undefined);
    ticketStoreGetMock.mockResolvedValue(undefined);
  });

  it("allows an authenticated buyer agent id to release a wallet-addressed Normal Mode deal", async () => {
    const buyerAgentId = "11111111-1111-4111-8111-111111111111";
    const buyerWallet = "buyer-wallet";
    const sellerWallet = "seller-wallet";

    agentFindUniqueMock.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === buyerAgentId ? { id: buyerAgentId, wallet: buyerWallet } : null
    );

    const { dealPhaseManager } = await import("../core/dealPhaseManager");
    const ticketId = "ticket-agent-id-release";

    dealPhaseManager.initDeal(ticketId, buyerWallet, sellerWallet);
    await dealPhaseManager.handleAction("CREATE_ESCROW", ticketId, buyerWallet, {
      price: 0.001,
      collateral_buyer: 0.001,
      collateral_seller: 0.001,
    });
    dealPhaseManager.setEscrowPda(ticketId, "escrow-pda-release-ok");
    await dealPhaseManager.advanceToAwaitingDeposits(ticketId);
    await dealPhaseManager.recordDeposit(ticketId, "buyer");
    await dealPhaseManager.recordDeposit(ticketId, "seller");

    const result = await dealPhaseManager.handleAction("RELEASE_FUNDS", ticketId, buyerAgentId);

    expect(result.success).toBe(true);
    expect(result.on_chain_action).toBe("release_funds");
    expect(result.new_phase).toBe("awaiting_release");
    expect(dealPhaseManager.getPhase(ticketId)).toBe("awaiting_release");
  });

  it("rejects a seller agent id attempting buyer-only release", async () => {
    const sellerAgentId = "22222222-2222-4222-8222-222222222222";
    const buyerWallet = "buyer-wallet-2";
    const sellerWallet = "seller-wallet-2";

    agentFindUniqueMock.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === sellerAgentId ? { id: sellerAgentId, wallet: sellerWallet } : null
    );

    const { dealPhaseManager } = await import("../core/dealPhaseManager");
    const ticketId = "ticket-seller-release-rejected";

    dealPhaseManager.initDeal(ticketId, buyerWallet, sellerWallet);
    await dealPhaseManager.handleAction("CREATE_ESCROW", ticketId, buyerWallet, {
      price: 0.001,
      collateral_buyer: 0.001,
      collateral_seller: 0.001,
    });
    dealPhaseManager.setEscrowPda(ticketId, "escrow-pda-release-rejected");
    await dealPhaseManager.advanceToAwaitingDeposits(ticketId);
    await dealPhaseManager.recordDeposit(ticketId, "buyer");
    await dealPhaseManager.recordDeposit(ticketId, "seller");

    const result = await dealPhaseManager.handleAction("RELEASE_FUNDS", ticketId, sellerAgentId);

    expect(result.success).toBe(false);
    expect(result.on_chain_action).toBeUndefined();
    expect(result.response.content).toBeTruthy();
    expect(dealPhaseManager.getPhase(ticketId)).toBe("delivery");
  });

  it("blocks awaiting-deposit and deposit state transitions until an escrow PDA exists", async () => {
    const buyerWallet = "buyer-wallet-no-pda";
    const sellerWallet = "seller-wallet-no-pda";
    const { dealPhaseManager } = await import("../core/dealPhaseManager");
    const ticketId = "ticket-null-pda-guard";

    dealPhaseManager.initDeal(ticketId, buyerWallet, sellerWallet);
    await dealPhaseManager.handleAction("CREATE_ESCROW", ticketId, buyerWallet, {
      price: 0.001,
      collateral_buyer: 0.001,
      collateral_seller: 0.001,
    });

    const advanceResult = await dealPhaseManager.advanceToAwaitingDeposits(ticketId);
    const depositResult = await dealPhaseManager.recordDeposit(ticketId, "buyer");
    const deal = dealPhaseManager.getDeal(ticketId);

    expect(advanceResult?.success).toBe(false);
    expect(depositResult?.success).toBe(false);
    expect(dealPhaseManager.getPhase(ticketId)).toBe("escrow_created");
    expect(deal?.escrow_pda).toBeNull();
    expect(deal?.buyer_deposited).toBe(false);
    expect(appendAuditLogMock).toHaveBeenCalledWith(
      ticketId,
      "awaiting_deposits_blocked_missing_escrow",
      expect.any(Object)
    );
    expect(appendAuditLogMock).toHaveBeenCalledWith(
      ticketId,
      "deposit_blocked_missing_escrow",
      expect.any(Object)
    );
  });

  it("keeps SPORT equal-stake escrows in awaiting_result instead of delivery after payment lock", async () => {
    const buyerWallet = "sport-buyer-wallet";
    const sellerWallet = "sport-seller-wallet";
    const ticketId = "ticket-sport-equal-stake";
    ticketStoreGetMock.mockResolvedValue({
      ticket_id: ticketId,
      buyer: buyerWallet,
      seller: sellerWallet,
      rollup_mode: "SPORT",
    });

    const { dealPhaseManager } = await import("../core/dealPhaseManager");

    dealPhaseManager.initDeal(ticketId, buyerWallet, sellerWallet);
    const createResult = await dealPhaseManager.handleAction("CREATE_ESCROW", ticketId, buyerWallet, {
      price: 3,
      collateral_buyer: 0,
      collateral_seller: 3,
    });
    dealPhaseManager.setEscrowPda(ticketId, "sport-escrow-pda");
    await dealPhaseManager.advanceToAwaitingDeposits(ticketId);
    await dealPhaseManager.recordDeposit(ticketId, "buyer");
    await dealPhaseManager.recordDeposit(ticketId, "seller");

    expect(createResult.success).toBe(true);
    expect(dealPhaseManager.getPhase(ticketId)).toBe("awaiting_deposits");
    expect(dealPhaseManager.getDeal(ticketId)?.payment_locked).toBe(false);

    const lockResult = await dealPhaseManager.recordPaymentLocked(ticketId);

    expect(lockResult?.success).toBe(true);
    expect(lockResult?.new_phase).toBe("awaiting_result");
    expect(dealPhaseManager.getPhase(ticketId)).toBe("awaiting_result");
    expect(updateStatusMock).toHaveBeenLastCalledWith(ticketId, "payment_locked");
  });

  it("heals stale terminal phase state from authoritative on-chain escrow state", async () => {
    const ticketId = "ticket-stale-cancelled";
    const escrowPda = "11111111111111111111111111111111";
    const now = new Date();

    phaseFindUniqueMock.mockResolvedValue({
      ticketId,
      phase: "cancelled",
      buyer: "buyer-wallet-3",
      seller: "seller-wallet-3",
      termsPrice: 0.001,
      termsColBuyer: 0.001,
      termsColSeller: 0.001,
      termsAssetType: "SOL",
      escrowPda,
      createdAt: now,
      updatedAt: now,
      buyerDeposited: false,
      sellerDeposited: false,
      paymentLocked: false,
      historyJson: "[]",
    });
    onChainDealFetchMock.mockResolvedValue({
      status: { paymentLocked: {} },
      buyerCollateralLocked: true,
      sellerCollateralLocked: true,
      paymentLocked: true,
    });

    const { dealPhaseManager } = await import("../core/dealPhaseManager");
    const restored = await dealPhaseManager.getDealWithFallback(ticketId);

    expect(restored?.phase).toBe("delivery");
    expect(restored?.buyer_deposited).toBe(true);
    expect(restored?.seller_deposited).toBe(true);
    expect(restored?.payment_locked).toBe(true);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ticketId },
        update: expect.objectContaining({
          phase: "delivery",
          buyerDeposited: true,
          sellerDeposited: true,
          paymentLocked: true,
        }),
      })
    );
  });
});
