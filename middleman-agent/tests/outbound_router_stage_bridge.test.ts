import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const subscriptions = new Map<string, (payload: any) => Promise<void> | void>();
  return {
    subscriptions,
    subscribe: vi.fn((event: string, handler: (payload: any) => Promise<void> | void) => {
      subscriptions.set(event, handler);
    }),
    sendToAgent: vi.fn().mockReturnValue(true),
    ticketFindUnique: vi.fn(),
    outboundFindUnique: vi.fn(),
    outboundCount: vi.fn(),
    outboundCreate: vi.fn(),
    outboundUpdateMany: vi.fn(),
    outboundFindMany: vi.fn(),
    agentFindUnique: vi.fn(),
    getDeal: vi.fn(),
    canAcceptNewWork: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(),
    wrapMessage: vi.fn((content: string) => content),
    getInnerMonologue: vi.fn(() => "focused"),
  };
});

vi.mock("../src/services/eventBus", () => ({
  eventBus: {
    subscribe: mocks.subscribe,
  },
}));

vi.mock("../src/gateway/sessionManager", () => ({
  sessionManager: {
    sendToAgent: mocks.sendToAgent,
    getSubscribers: vi.fn(() => []),
  },
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    ticket: {
      findUnique: mocks.ticketFindUnique,
    },
    outboundMessage: {
      findUnique: mocks.outboundFindUnique,
      count: mocks.outboundCount,
      create: mocks.outboundCreate,
      updateMany: mocks.outboundUpdateMany,
      findMany: mocks.outboundFindMany,
      deleteMany: vi.fn(),
    },
    agent: {
      findUnique: mocks.agentFindUnique,
    },
  },
}));

vi.mock("../src/utils/logger", () => ({
  logger: {
    info: mocks.info,
    debug: mocks.debug,
    error: mocks.error,
    warn: mocks.warn,
    withContext: mocks.withContext,
  },
}));

vi.mock("../src/utils/shutdownManager", () => ({
  shutdownManager: {
    canAcceptNewWork: mocks.canAcceptNewWork,
  },
}));

vi.mock("../../core/dealPhaseManager", () => ({
  dealPhaseManager: {
    getDeal: mocks.getDeal,
  },
}));

vi.mock("../src/services/soulEngine", () => ({
  soulEngine: {
    wrapMessage: mocks.wrapMessage,
    getInnerMonologue: mocks.getInnerMonologue,
    updateMood: vi.fn(),
  },
}));

import { initOutboundRouter, stopOutboxProcessor } from "../src/services/outboundRouter";

describe("outbound router pipeline-stage bridge", () => {
  beforeEach(() => {
    mocks.subscriptions.clear();
    mocks.subscribe.mockClear();
    mocks.sendToAgent.mockClear();
    mocks.ticketFindUnique.mockReset();
    mocks.outboundFindUnique.mockReset();
    mocks.outboundCount.mockReset();
    mocks.outboundCreate.mockReset();
    mocks.outboundUpdateMany.mockReset();
    mocks.outboundFindMany.mockReset();
    mocks.agentFindUnique.mockReset();
    mocks.getDeal.mockReset();
    mocks.canAcceptNewWork.mockReset();
    mocks.info.mockClear();
    mocks.debug.mockClear();
    mocks.error.mockClear();
    mocks.warn.mockClear();
    mocks.withContext.mockReset();
    mocks.wrapMessage.mockClear();
    mocks.getInnerMonologue.mockClear();

    mocks.ticketFindUnique.mockResolvedValue({
      buyerId: "buyer-agent",
      sellerId: "seller-agent",
    });
    mocks.outboundFindUnique.mockResolvedValue(null);
    mocks.outboundCount.mockResolvedValue(0);
    mocks.outboundCreate.mockResolvedValue(undefined);
    mocks.outboundUpdateMany.mockResolvedValue(undefined);
    mocks.outboundFindMany.mockResolvedValue([]);
    mocks.agentFindUnique.mockResolvedValue(null);
    mocks.getDeal.mockReturnValue(null);
    mocks.canAcceptNewWork.mockReturnValue(false);
    mocks.withContext.mockImplementation(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }));
  });

  afterEach(() => {
    stopOutboxProcessor();
  });

  it("forwards deal_pipeline_stage_changed to both agents as a phase update", async () => {
    initOutboundRouter();

    const handler = mocks.subscriptions.get("deal_pipeline_stage_changed");
    expect(handler).toBeTypeOf("function");

    await handler?.({
      ticketId: "ticket-stage-1",
      stage: "awaiting_buyer_release_confirmation",
      status: "confirmed",
      route: "CONFIDENTIAL_ESCROW",
      executionPolicy: "CONFIDENTIAL",
      settlementPolicy: "STEALTH",
      negotiationSource: "PER",
    });

    expect(mocks.sendToAgent).toHaveBeenCalledTimes(2);
    expect(mocks.sendToAgent).toHaveBeenNthCalledWith(
      1,
      "buyer-agent",
      expect.objectContaining({
        type: "middleman_message",
        ticket_id: "ticket-stage-1",
        phase: "awaiting_buyer_release_confirmation",
        content: expect.stringContaining("Deal phase updated"),
      })
    );
    expect(mocks.sendToAgent).toHaveBeenNthCalledWith(
      2,
      "seller-agent",
      expect.objectContaining({
        type: "middleman_message",
        ticket_id: "ticket-stage-1",
        phase: "awaiting_buyer_release_confirmation",
        content: expect.stringContaining("Deal phase updated"),
      })
    );
  });

  it("treats settled deal_executed updates as best-effort and skips durable outbox writes when agents are offline", async () => {
    mocks.sendToAgent.mockReturnValue(false);

    initOutboundRouter();

    const handler = mocks.subscriptions.get("deal_executed");
    expect(handler).toBeTypeOf("function");

    await handler?.({
      ticket_id: "ticket-stage-2",
      status: "settled",
    });

    expect(mocks.sendToAgent).toHaveBeenCalledTimes(2);
    expect(mocks.outboundCreate).not.toHaveBeenCalled();
    expect(mocks.outboundUpdateMany).not.toHaveBeenCalled();
  });

  it("treats terminal phase_changed updates as best-effort and skips durable outbox writes when agents are offline", async () => {
    mocks.sendToAgent.mockReturnValue(false);

    initOutboundRouter();

    const handler = mocks.subscriptions.get("phase_changed");
    expect(handler).toBeTypeOf("function");

    await handler?.({
      ticket_id: "ticket-stage-3",
      from_phase: "negotiation",
      to_phase: "completed",
      triggered_by: "system",
      action: "OBSERVE",
    });

    expect(mocks.sendToAgent).toHaveBeenCalledTimes(2);
    expect(mocks.outboundCreate).not.toHaveBeenCalled();
    expect(mocks.outboundUpdateMany).not.toHaveBeenCalled();
  });
});
