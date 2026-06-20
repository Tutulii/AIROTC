import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ticketFindUnique: vi.fn(),
  agentUpsert: vi.fn(),
  dealUpsert: vi.fn(),
  transactionFindFirst: vi.fn(),
  transactionUpdate: vi.fn(),
  transactionCreate: vi.fn(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    ticket: {
      findUnique: mocks.ticketFindUnique,
    },
    agent: {
      upsert: mocks.agentUpsert,
    },
    deal: {
      upsert: mocks.dealUpsert,
    },
    transaction: {
      findFirst: mocks.transactionFindFirst,
      update: mocks.transactionUpdate,
      create: mocks.transactionCreate,
    },
  },
}));

vi.mock("../src/utils/logger", () => ({
  logger: {
    debug: mocks.loggerDebug,
    info: mocks.loggerInfo,
    error: mocks.loggerError,
  },
}));

import { executionStore } from "../src/state/executionStore";

const realSignature =
  "5z9Ekcp7LteKcgZPFNMxm8uz7ieC4znXky6aGrRnjrEAJRMyxCEXnT4TRn9upsyJMeBMVm7z4kj2BoLH7TtdP5jW";

describe("executionStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ticketFindUnique.mockResolvedValue({
      id: "ticket-id",
      buyerId: "buyer-id",
      sellerId: "seller-id",
    });
    mocks.agentUpsert.mockResolvedValue({ id: "middleman-id", wallet: "system" });
    mocks.dealUpsert.mockImplementation(({ where }: { where: { ticketId: string } }) => ({
      id: where.ticketId,
    }));
    mocks.transactionFindFirst.mockResolvedValue(null);
    mocks.transactionUpdate.mockResolvedValue({});
    mocks.transactionCreate.mockResolvedValue({});
  });

  it("does not store synthetic recovery markers as unique transaction signatures", async () => {
    await executionStore.markSuccess("ticket-recovered-1", "create_deal", "recovered_tx");
    await executionStore.markSuccess("ticket-recovered-2", "create_deal", "recovered_tx");

    expect(mocks.transactionCreate).toHaveBeenNthCalledWith(1, {
      data: {
        dealId: "ticket-recovered-1",
        type: "create_deal",
        status: "confirmed",
        txSignature: null,
      },
    });
    expect(mocks.transactionCreate).toHaveBeenNthCalledWith(2, {
      data: {
        dealId: "ticket-recovered-2",
        type: "create_deal",
        status: "confirmed",
        txSignature: null,
      },
    });
  });

  it("stores real chain signatures for confirmed execution steps", async () => {
    await executionStore.markSuccess("ticket-real", "create_deal", realSignature);

    expect(mocks.transactionCreate).toHaveBeenCalledWith({
      data: {
        dealId: "ticket-real",
        type: "create_deal",
        status: "confirmed",
        txSignature: realSignature,
      },
    });
  });

  it("does not erase an existing real signature with a synthetic marker", async () => {
    mocks.transactionFindFirst.mockResolvedValue({
      id: "tx-existing",
      txSignature: realSignature,
    });

    await executionStore.markSuccess("ticket-real", "create_deal", "unknown_tx");

    expect(mocks.transactionUpdate).toHaveBeenCalledWith({
      where: { id: "tx-existing" },
      data: { status: "confirmed" },
    });
  });
});
