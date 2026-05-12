import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resumeTicket: vi.fn(),
  startFromPrivateEscrowIntent: vi.fn(),
  listRecoverablePipelines: vi.fn(),
  finalizePrivateTicket: vi.fn(),
  completeTicketSession: vi.fn(),
  updateStatus: vi.fn(),
  appendAuditLog: vi.fn(),
  publish: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  getLatestByTicket: vi.fn(),
}));

vi.mock("../src/services/dealPipeline", () => ({
  dealPipeline: {
    resumeTicket: mocks.resumeTicket,
    startFromPrivateEscrowIntent: mocks.startFromPrivateEscrowIntent,
  },
}));

vi.mock("../src/state/pipelineStateStore", () => ({
  pipelineStateStore: {
    listRecoverablePipelines: mocks.listRecoverablePipelines,
  },
}));

vi.mock("../src/services/magicBlockSessionManager", () => ({
  magicBlockSessions: {
    finalizePrivateTicket: mocks.finalizePrivateTicket,
    completeTicketSession: mocks.completeTicketSession,
  },
}));

vi.mock("../src/state/dealTracker", () => ({
  dealTracker: {
    updateStatus: mocks.updateStatus,
  },
}));

vi.mock("../src/services/auditTrail", () => ({
  appendAuditLog: mocks.appendAuditLog,
}));

vi.mock("../src/services/eventBus", () => ({
  eventBus: {
    publish: mocks.publish,
  },
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    deal: {
      findMany: mocks.findMany,
    },
    ticket: {
      findUnique: mocks.findUnique,
    },
  },
}));

vi.mock("../src/state/privateEscrowIntentStore", () => ({
  privateEscrowIntentStore: {
    getLatestByTicket: mocks.getLatestByTicket,
  },
}));

import {
  recoverPendingDealPipelines,
  recoverPendingPrivateSessionFinalizations,
} from "../src/services/pipelineRecoveryService";

describe("pipelineRecoveryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(null);
    mocks.getLatestByTicket.mockResolvedValue(null);
  });

  it("resumes only recoverable pipelines that successfully restart", async () => {
    mocks.listRecoverablePipelines.mockResolvedValue([
      {
        ticketId: "ticket-1",
        stage: "verified",
        status: "confirmed",
        createdAt: new Date().toISOString(),
      },
      {
        ticketId: "ticket-2",
        stage: "settlement_address_ready",
        status: "confirmed",
        createdAt: new Date().toISOString(),
      },
    ]);
    mocks.resumeTicket.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error("boom"));

    const recovered = await recoverPendingDealPipelines();

    expect(recovered).toBe(1);
    expect(mocks.resumeTicket).toHaveBeenCalledTimes(2);
    expect(mocks.resumeTicket).toHaveBeenNthCalledWith(1, "ticket-1");
    expect(mocks.resumeTicket).toHaveBeenNthCalledWith(2, "ticket-2");
  });

  it("finalizes pending private sessions and emits completion after recovery", async () => {
    mocks.findMany.mockResolvedValue([
      {
        ticketId: "ticket-1",
        status: "pending_confidential_session_close",
        createdAt: new Date(),
      },
    ]);
    mocks.finalizePrivateTicket.mockResolvedValue("commit-sig-1");
    mocks.updateStatus.mockResolvedValue(undefined);
    mocks.appendAuditLog.mockResolvedValue(undefined);

    const finalized = await recoverPendingPrivateSessionFinalizations();

    expect(finalized).toBe(1);
    expect(mocks.finalizePrivateTicket).toHaveBeenCalledWith("ticket-1");
    expect(mocks.completeTicketSession).toHaveBeenCalledWith("ticket-1");
    expect(mocks.updateStatus).toHaveBeenCalledWith("ticket-1", "completed_confidential");
    expect(mocks.appendAuditLog).toHaveBeenCalledWith(
      "ticket-1",
      "deal_pipeline_private_session_finalize_recovered",
      expect.objectContaining({ commitSignature: "commit-sig-1" })
    );
    expect(mocks.publish).toHaveBeenCalledWith("deal_executed", {
      ticket_id: "ticket-1",
      status: "confidential_completed",
    });
  });

  it("restores settled status when only PER session close was still pending", async () => {
    mocks.findMany.mockResolvedValue([
      {
        ticketId: "ticket-2",
        status: "settled_pending_session_close",
        createdAt: new Date(),
      },
    ]);
    mocks.finalizePrivateTicket.mockResolvedValue("commit-sig-2");
    mocks.updateStatus.mockResolvedValue(undefined);
    mocks.appendAuditLog.mockResolvedValue(undefined);

    const finalized = await recoverPendingPrivateSessionFinalizations();

    expect(finalized).toBe(1);
    expect(mocks.finalizePrivateTicket).toHaveBeenCalledWith("ticket-2");
    expect(mocks.completeTicketSession).toHaveBeenCalledWith("ticket-2");
    expect(mocks.updateStatus).toHaveBeenCalledWith("ticket-2", "settled");
    expect(mocks.appendAuditLog).toHaveBeenCalledWith(
      "ticket-2",
      "deal_pipeline_private_session_finalize_recovered",
      expect.objectContaining({
        commitSignature: "commit-sig-2",
        recoveredStatus: "settled",
      })
    );
    expect(mocks.publish).toHaveBeenCalledWith("deal_executed", {
      ticket_id: "ticket-2",
      status: "settled",
    });
  });
});
