import { beforeEach, describe, expect, it, vi } from "vitest";

const publishMock = vi.fn();
const upsertMock = vi.fn().mockResolvedValue({});
const findUniqueMock = vi.fn().mockResolvedValue(null);
const updateStatusMock = vi.fn().mockResolvedValue(undefined);
const appendAuditLogMock = vi.fn();
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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
    updateStatus: updateStatusMock,
    getDealByTicket: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../src/utils/logger", () => ({
  logger,
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    dealPhaseState: {
      upsert: upsertMock,
      findUnique: findUniqueMock,
    },
  },
}));

vi.mock("../src/services/auditTrail", () => ({
  appendAuditLog: appendAuditLogMock,
}));

vi.mock("../core/aiJudge", () => ({
  adjudicateDispute: vi.fn(),
}));

describe("dealPhaseManager terminal status sync", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    upsertMock.mockResolvedValue({});
    findUniqueMock.mockResolvedValue(null);
    updateStatusMock.mockResolvedValue(undefined);
  });

  it("persists a settled execution as a completed terminal phase", async () => {
    const { dealPhaseManager } = await import("../core/dealPhaseManager");

    dealPhaseManager.initDeal("ticket-terminal", "buyer-wallet", "seller-wallet");
    await Promise.resolve();

    publishMock.mockClear();
    upsertMock.mockClear();
    updateStatusMock.mockClear();
    appendAuditLogMock.mockClear();

    await dealPhaseManager.syncTerminalPhaseFromExecutionStatus("ticket-terminal", "settled");

    expect(publishMock).toHaveBeenCalledWith(
      "phase_changed",
      expect.objectContaining({
        ticket_id: "ticket-terminal",
        from_phase: "negotiation",
        to_phase: "completed",
      })
    );
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ticketId: "ticket-terminal" },
        update: expect.objectContaining({
          phase: "completed",
        }),
      })
    );
    expect(updateStatusMock).toHaveBeenCalledWith("ticket-terminal", "completed");
  });

  it("ignores non-terminal execution statuses", async () => {
    const { dealPhaseManager } = await import("../core/dealPhaseManager");

    dealPhaseManager.initDeal("ticket-nonterminal", "buyer-wallet", "seller-wallet");
    await Promise.resolve();

    publishMock.mockClear();
    upsertMock.mockClear();
    updateStatusMock.mockClear();

    await dealPhaseManager.syncTerminalPhaseFromExecutionStatus(
      "ticket-nonterminal",
      "created_awaiting_deposits"
    );

    expect(publishMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateStatusMock).not.toHaveBeenCalled();
  });
});
