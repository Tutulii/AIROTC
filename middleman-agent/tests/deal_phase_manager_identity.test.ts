import { beforeEach, describe, expect, it, vi } from "vitest";

const publishMock = vi.fn();
const upsertMock = vi.fn().mockResolvedValue({});
const agentFindUniqueMock = vi.fn();
const initDealMock = vi.fn().mockResolvedValue(undefined);
const updateStatusMock = vi.fn().mockResolvedValue(undefined);
const appendAuditLogMock = vi.fn();

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
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
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
    initDealMock.mockResolvedValue(undefined);
    updateStatusMock.mockResolvedValue(undefined);
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
    await dealPhaseManager.advanceToAwaitingDeposits(ticketId);
    await dealPhaseManager.recordDeposit(ticketId, "buyer");
    await dealPhaseManager.recordDeposit(ticketId, "seller");

    const result = await dealPhaseManager.handleAction("RELEASE_FUNDS", ticketId, buyerAgentId);

    expect(result.success).toBe(true);
    expect(result.on_chain_action).toBe("release_funds");
    expect(dealPhaseManager.getPhase(ticketId)).toBe("completed");
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
    await dealPhaseManager.advanceToAwaitingDeposits(ticketId);
    await dealPhaseManager.recordDeposit(ticketId, "buyer");
    await dealPhaseManager.recordDeposit(ticketId, "seller");

    const result = await dealPhaseManager.handleAction("RELEASE_FUNDS", ticketId, sellerAgentId);

    expect(result.success).toBe(false);
    expect(result.on_chain_action).toBeUndefined();
    expect(result.response.content).toContain("Only the buyer");
    expect(dealPhaseManager.getPhase(ticketId)).toBe("delivery");
  });
});
