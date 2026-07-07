import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ticketStoreGetMock,
  getDealWithFallbackMock,
  syncTerminalPhaseMock,
  executeReleasePhaseMock,
  executeSettleToBuyerPhaseMock,
  appendAuditLogMock,
} = vi.hoisted(() => ({
  ticketStoreGetMock: vi.fn(),
  getDealWithFallbackMock: vi.fn(),
  syncTerminalPhaseMock: vi.fn(),
  executeReleasePhaseMock: vi.fn(),
  executeSettleToBuyerPhaseMock: vi.fn(),
  appendAuditLogMock: vi.fn(),
}));

vi.mock("../src/state/ticketStore", () => ({
  ticketStore: {
    getTicket: ticketStoreGetMock,
  },
}));

vi.mock("../core/dealPhaseManager", () => ({
  dealPhaseManager: {
    getDealWithFallback: getDealWithFallbackMock,
    syncTerminalPhaseFromExecutionStatus: syncTerminalPhaseMock,
  },
}));

vi.mock("../src/services/onChainExecutionService", () => ({
  executeReleasePhase: executeReleasePhaseMock,
  executeSettleToBuyerPhase: executeSettleToBuyerPhaseMock,
}));

vi.mock("../src/services/auditTrail", () => ({
  appendAuditLog: appendAuditLogMock,
}));

vi.mock("../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function fundedDeal() {
  return {
    phase: "awaiting_result",
    buyer_deposited: true,
    seller_deposited: true,
    payment_locked: true,
  };
}

describe("sportSettlementBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ticketStoreGetMock.mockResolvedValue({
      ticket_id: "ticket-sport",
      rollup_mode: "SPORT",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
    });
    getDealWithFallbackMock.mockResolvedValue(fundedDeal());
    syncTerminalPhaseMock.mockResolvedValue(undefined);
    appendAuditLogMock.mockResolvedValue(undefined);
    executeReleasePhaseMock.mockResolvedValue({
      success: true,
      tx: "release-tx",
      step: "release_funds",
    });
    executeSettleToBuyerPhaseMock.mockResolvedValue({
      success: true,
      tx: "refund-tx",
      step: "settle_to_buyer",
    });
  });

  it("rejects non-SPORT tickets", async () => {
    ticketStoreGetMock.mockResolvedValueOnce({
      ticket_id: "ticket-normal",
      rollup_mode: "NONE",
    });
    const { executeSportSettlement } = await import("../src/services/sportSettlementBridge");

    await expect(executeSportSettlement({
      ticketId: "ticket-normal",
      settlementAction: "release_to_maker",
    })).rejects.toMatchObject({
      message: "sport_ticket_rollup_mode_required",
      statusCode: 409,
    });
  });

  it("releases funded SPORT escrow when maker wins", async () => {
    const { executeSportSettlement } = await import("../src/services/sportSettlementBridge");

    const result = await executeSportSettlement({
      ticketId: "ticket-sport",
      settlementAction: "release_to_maker",
      fixtureId: "fixture-1",
      outcomeWinner: "part1",
      winnerWallet: "maker-wallet",
    });

    expect(executeReleasePhaseMock).toHaveBeenCalledWith("ticket-sport");
    expect(executeSettleToBuyerPhaseMock).not.toHaveBeenCalled();
    expect(syncTerminalPhaseMock).toHaveBeenCalledWith("ticket-sport", "completed");
    expect(result).toMatchObject({
      success: true,
      ticketId: "ticket-sport",
      settlementAction: "release_to_maker",
      onChainAction: "release_funds",
      tx: "release-tx",
      status: "completed",
    });
  });

  it("refunds funded SPORT escrow when maker loses", async () => {
    const { executeSportSettlement } = await import("../src/services/sportSettlementBridge");

    const result = await executeSportSettlement({
      ticketId: "ticket-sport",
      settlementAction: "refund_to_taker",
      fixtureId: "fixture-1",
      outcomeWinner: "part2",
      winnerWallet: "taker-wallet",
    });

    expect(executeSettleToBuyerPhaseMock).toHaveBeenCalledWith("ticket-sport");
    expect(executeReleasePhaseMock).not.toHaveBeenCalled();
    expect(syncTerminalPhaseMock).toHaveBeenCalledWith("ticket-sport", "refunded");
    expect(result).toMatchObject({
      success: true,
      ticketId: "ticket-sport",
      settlementAction: "refund_to_taker",
      onChainAction: "settle_to_buyer",
      tx: "refund-tx",
      status: "refunded",
    });
  });

  it("supports explicit seller payout action for position-aware SPORT settlement", async () => {
    const { executeSportSettlement } = await import("../src/services/sportSettlementBridge");

    const result = await executeSportSettlement({
      ticketId: "ticket-sport",
      settlementAction: "release_to_seller",
      fixtureId: "fixture-1",
      outcomeWinner: "part1",
      winnerWallet: "seller-wallet",
    });

    expect(executeReleasePhaseMock).toHaveBeenCalledWith("ticket-sport");
    expect(executeSettleToBuyerPhaseMock).not.toHaveBeenCalled();
    expect(syncTerminalPhaseMock).toHaveBeenCalledWith("ticket-sport", "completed");
    expect(result).toMatchObject({
      success: true,
      ticketId: "ticket-sport",
      settlementAction: "release_to_seller",
      onChainAction: "release_funds",
      tx: "release-tx",
      status: "completed",
    });
  });

  it("supports explicit buyer payout action for position-aware SPORT settlement", async () => {
    const { executeSportSettlement } = await import("../src/services/sportSettlementBridge");

    const result = await executeSportSettlement({
      ticketId: "ticket-sport",
      settlementAction: "release_to_buyer",
      fixtureId: "fixture-1",
      outcomeWinner: "part1",
      winnerWallet: "buyer-wallet",
    });

    expect(executeSettleToBuyerPhaseMock).toHaveBeenCalledWith("ticket-sport");
    expect(executeReleasePhaseMock).not.toHaveBeenCalled();
    expect(syncTerminalPhaseMock).toHaveBeenCalledWith("ticket-sport", "refunded");
    expect(result).toMatchObject({
      success: true,
      ticketId: "ticket-sport",
      settlementAction: "release_to_buyer",
      onChainAction: "settle_to_buyer",
      tx: "refund-tx",
      status: "refunded",
    });
  });

  it("rejects SPORT settlement before escrow funding is complete", async () => {
    getDealWithFallbackMock.mockResolvedValueOnce({
      phase: "awaiting_deposits",
      buyer_deposited: true,
      seller_deposited: false,
      payment_locked: false,
    });
    const { executeSportSettlement } = await import("../src/services/sportSettlementBridge");

    await expect(executeSportSettlement({
      ticketId: "ticket-sport",
      settlementAction: "release_to_maker",
    })).rejects.toMatchObject({
      message: "sport_escrow_not_funded",
      statusCode: 409,
    });
  });
});
