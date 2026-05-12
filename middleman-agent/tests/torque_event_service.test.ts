import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTorqueEventService } from "../src/services/torqueEventService";
import type { DealPipelineStageChangedEvent } from "../src/types/events";

type StoredDelivery = {
  id: string;
  idempotencyKey: string;
  ticketId: string;
  eventName: string;
  participantRole: string;
  userPubkey: string;
  payload: any;
  payloadHash: string;
  schemaVersion: number;
  status: string;
  attemptCount: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function createMemoryTorqueDeliveryModel() {
  const records = new Map<string, StoredDelivery>();
  let counter = 0;

  return {
    records,
    async upsert({ where, update, create }: any) {
      const existing = records.get(where.idempotencyKey);
      if (existing) {
        const next: StoredDelivery = {
          ...existing,
          ...update,
          updatedAt: new Date(),
        };
        records.set(where.idempotencyKey, next);
        return next;
      }

      const created: StoredDelivery = {
        id: `delivery-${++counter}`,
        status: "queued",
        attemptCount: 0,
        lastError: null,
        lastAttemptAt: null,
        nextAttemptAt: null,
        deliveredAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...create,
      };
      records.set(where.idempotencyKey, created);
      return created;
    },
    async findMany({ where, take }: any) {
      const now = where.OR?.[1]?.nextAttemptAt?.lte as Date | undefined;
      const allowedStatuses = new Set(where.status?.in || []);
      const items = Array.from(records.values()).filter((record) => {
        if (where.ticketId && record.ticketId !== where.ticketId) {
          return false;
        }
        if (allowedStatuses.size > 0 && !allowedStatuses.has(record.status)) {
          return false;
        }
        if (!record.nextAttemptAt) {
          return true;
        }
        return now ? record.nextAttemptAt <= now : true;
      });

      items.sort((left, right) => {
        const createdDiff = left.createdAt.getTime() - right.createdAt.getTime();
        if (createdDiff !== 0) {
          return createdDiff;
        }
        return left.id.localeCompare(right.id);
      });

      return items.slice(0, take || items.length);
    },
    async update({ where, data }: any) {
      const key = Array.from(records.keys()).find(
        (idempotencyKey) => records.get(idempotencyKey)?.id === where.id
      );
      if (!key) {
        throw new Error(`missing delivery ${where.id}`);
      }
      const current = records.get(key)!;
      const next: StoredDelivery = {
        ...current,
        ...data,
        updatedAt: new Date(),
      };
      records.set(key, next);
      return next;
    },
  };
}

function makeSettledEvent(
  overrides: Partial<DealPipelineStageChangedEvent> = {}
): DealPipelineStageChangedEvent {
  return {
    ticketId: "ticket-1",
    stage: "settled",
    status: "confirmed",
    route: "CONFIDENTIAL_ESCROW",
    executionPolicy: "CONFIDENTIAL",
    settlementPolicy: "STEALTH",
    negotiationSource: "PER",
    ...overrides,
  };
}

function makeConfig() {
  return {
    enableTorqueEvents: true,
    torqueIngestUrl: "https://ingest.torque.so/events",
    torqueEventApiKey: "test-key",
    torqueRequestTimeoutMs: 1000,
    torqueRetryBaseMs: 1000,
    torqueRetryMaxMs: 5000,
    torqueRetryPollMs: 1000,
    erPlatformFeeBps: 100,
    perPlatformFeeBps: 110,
    erRewardShareOfFeeBps: 1000,
    perRewardShareOfFeeBps: 1200,
  } as any;
}

function makePerIntent(ticketId: string, agreedPriceLamports = "10000000000") {
  return {
    ticketId,
    intentId: `intent-${ticketId}`,
    sessionPda: `session-${ticketId}`,
    termsHash: `terms-${ticketId}`,
    executionTerms: {
      agreedPriceLamports,
      agreedAsset: "SOL",
      buyerCollateralLamports: "1000000000",
      sellerCollateralLamports: "1000000000",
      observedStatus: "consensusReached",
    },
  };
}

describe("torqueEventService", () => {
  const fetchMock = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.clearAllMocks();
  });

  it("queues and delivers exactly two participant events for a settled PER trade", async () => {
    const deliveryModel = createMemoryTorqueDeliveryModel();
    const now = new Date("2026-05-02T12:00:00.000Z");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const service = createTorqueEventService({
      eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn() } as any,
      loadConfig: makeConfig,
      rewardTargetStore: {
        getLatestByTicket: vi.fn().mockResolvedValue({
          ticketId: "ticket-1",
          buyerWallet: "buyer-wallet",
          sellerWallet: "seller-wallet",
          buyerRewardWallet: "buyer-reward-wallet",
          sellerRewardWallet: "seller-reward-wallet",
        }),
      },
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(undefined),
      },
      privateEscrowIntentStore: {
        getLatestByTicket: vi.fn().mockResolvedValue(makePerIntent("ticket-1")),
      },
      dealTracker: {
        getDealByTicket: vi.fn().mockResolvedValue(null),
      },
      fetchConfidentialDealFundingSnapshot: vi.fn(),
      prisma: {
        torqueEventDelivery: deliveryModel as any,
      } as any,
      fetchImpl: fetchMock as any,
      now: () => now,
      logger: logger as any,
    });

    await service.handleStageChanged(makeSettledEvent());
    await service.processPendingDeliveries();

    expect(deliveryModel.records.size).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const payloads = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(payloads).toEqual([
      expect.objectContaining({
        userPubkey: "buyer-reward-wallet",
        eventName: "air_otc_trade_reward_participant_v2",
      }),
      expect.objectContaining({
        userPubkey: "seller-reward-wallet",
        eventName: "air_otc_trade_reward_participant_v2",
      }),
    ]);

    for (const payload of payloads) {
      expect(Object.keys(payload).sort()).toEqual([
        "data",
        "eventName",
        "timestamp",
        "userPubkey",
      ]);
      expect(Object.keys(payload.data).sort()).toEqual([
        "participantRewardLamports",
        "participantRole",
        "pipelineRoute",
        "platformFeeBps",
        "platformFeeLamports",
        "rollupMode",
        "schemaVersion",
        "settlementPolicy",
        "tradeNotionalLamports",
        "tradeRef",
      ]);

      const rendered = JSON.stringify(payload);
      expect(payload.timestamp).toBe(now.getTime());
      expect(payload.data.tradeRef).not.toBe("ticket-1");
      expect(payload.data.rollupMode).toBe("PER");
      expect(payload.data.tradeNotionalLamports).toBe(10_000_000_000);
      expect(payload.data.platformFeeBps).toBe(110);
      expect(payload.data.platformFeeLamports).toBe(110_000_000);
      expect(payload.data.participantRewardLamports).toBe(6_600_000);
      expect(rendered).not.toContain("buyer-wallet");
      expect(rendered).not.toContain("seller-wallet");
      expect(rendered).not.toContain("ticket-1");
      expect(rendered).not.toContain("price");
      expect(rendered).not.toContain("collateral");
    }
  });

  it("waits for full Umbra completion before queuing Torque rewards", async () => {
    const deliveryModel = createMemoryTorqueDeliveryModel();
    const now = new Date("2026-05-02T12:00:00.000Z");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const service = createTorqueEventService({
      eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn() } as any,
      loadConfig: makeConfig,
      rewardTargetStore: {
        getLatestByTicket: vi.fn().mockResolvedValue({
          ticketId: "ticket-1",
          buyerWallet: "buyer-wallet",
          sellerWallet: "seller-wallet",
          buyerRewardWallet: "buyer-reward-wallet",
          sellerRewardWallet: "seller-reward-wallet",
        }),
      },
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(undefined),
      },
      privateEscrowIntentStore: {
        getLatestByTicket: vi.fn().mockResolvedValue(makePerIntent("ticket-1")),
      },
      dealTracker: {
        getDealByTicket: vi.fn().mockResolvedValue(null),
      },
      fetchConfidentialDealFundingSnapshot: vi.fn(),
      prisma: {
        torqueEventDelivery: deliveryModel as any,
        privateSettlement: {
          findFirst: vi.fn().mockResolvedValue({
            id: "settlement-1",
            phase: "CLAIMING",
          }),
        },
      } as any,
      fetchImpl: fetchMock as any,
      now: () => now,
      logger: logger as any,
    });

    await service.handleStageChanged(makeSettledEvent());
    expect(deliveryModel.records.size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      "torque_event_waiting_for_umbra_lifecycle",
      expect.objectContaining({ ticket_id: "ticket-1" })
    );

    await service.handleStageChanged(
      makeSettledEvent({ stage: "umbra_lifecycle_completed" })
    );
    await service.processPendingDeliveries();

    expect(deliveryModel.records.size).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to ER ticket terms when no private intent exists", async () => {
    const deliveryModel = createMemoryTorqueDeliveryModel();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const service = createTorqueEventService({
      eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn() } as any,
      loadConfig: makeConfig,
      rewardTargetStore: {
        getLatestByTicket: vi.fn().mockResolvedValue({
          ticketId: "ticket-1",
          buyerWallet: "buyer-wallet",
          sellerWallet: "seller-wallet",
          buyerRewardWallet: "buyer-reward-wallet",
          sellerRewardWallet: "seller-reward-wallet",
        }),
      },
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue({
          ticket_id: "ticket-1",
          agreed_terms: {
            price: 10,
            collateral_buyer: 1,
            collateral_seller: 1,
          },
        }),
      },
      privateEscrowIntentStore: {
        getLatestByTicket: vi.fn().mockResolvedValue(null),
      },
      dealTracker: {
        getDealByTicket: vi.fn().mockResolvedValue(null),
      },
      fetchConfidentialDealFundingSnapshot: vi.fn(),
      prisma: {
        torqueEventDelivery: deliveryModel as any,
      } as any,
      fetchImpl: fetchMock as any,
      now: () => new Date("2026-05-02T12:00:00.000Z"),
      logger: logger as any,
    });

    await service.handleStageChanged(
      makeSettledEvent({
        negotiationSource: "ER",
        route: "STANDARD_ESCROW",
        executionPolicy: "STANDARD",
        settlementPolicy: "DIRECT",
      })
    );
    await service.processPendingDeliveries();

    const payloads = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload.data.rollupMode).toBe("ER");
      expect(payload.data.tradeNotionalLamports).toBe(10_000_000_000);
      expect(payload.data.platformFeeBps).toBe(100);
      expect(payload.data.platformFeeLamports).toBe(100_000_000);
      expect(payload.data.participantRewardLamports).toBe(5_000_000);
      expect(payload.data.pipelineRoute).toBe("STANDARD_ESCROW");
      expect(payload.data.settlementPolicy).toBe("DIRECT");
    }
  });

  it("does not create duplicate queued events when settled is replayed", async () => {
    const deliveryModel = createMemoryTorqueDeliveryModel();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const service = createTorqueEventService({
      eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn() } as any,
      loadConfig: makeConfig,
      rewardTargetStore: {
        getLatestByTicket: vi.fn().mockResolvedValue({
          ticketId: "ticket-1",
          buyerWallet: "buyer-wallet",
          sellerWallet: "seller-wallet",
          buyerRewardWallet: "buyer-reward-wallet",
          sellerRewardWallet: "seller-reward-wallet",
        }),
      },
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(undefined),
      },
      privateEscrowIntentStore: {
        getLatestByTicket: vi.fn().mockResolvedValue(makePerIntent("ticket-1")),
      },
      dealTracker: {
        getDealByTicket: vi.fn().mockResolvedValue(null),
      },
      fetchConfidentialDealFundingSnapshot: vi.fn(),
      prisma: {
        torqueEventDelivery: deliveryModel as any,
      } as any,
      fetchImpl: fetchMock as any,
      now: () => new Date("2026-05-02T12:00:00.000Z"),
      logger: logger as any,
    });

    await service.handleStageChanged(makeSettledEvent());
    await service.processPendingDeliveries();
    await service.handleStageChanged(makeSettledEvent());
    await service.processPendingDeliveries();

    expect(deliveryModel.records.size).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries failed deliveries with bounded backoff and without duplicate rows", async () => {
    const deliveryModel = createMemoryTorqueDeliveryModel();
    let now = new Date("2026-05-02T12:00:00.000Z");
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
      });

    const service = createTorqueEventService({
      eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn() } as any,
      loadConfig: makeConfig,
      rewardTargetStore: {
        getLatestByTicket: vi.fn().mockResolvedValue({
          ticketId: "ticket-1",
          buyerWallet: "buyer-wallet",
          sellerWallet: "seller-wallet",
          buyerRewardWallet: "buyer-reward-wallet",
          sellerRewardWallet: "seller-reward-wallet",
        }),
      },
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(undefined),
      },
      privateEscrowIntentStore: {
        getLatestByTicket: vi.fn().mockResolvedValue(makePerIntent("ticket-1")),
      },
      dealTracker: {
        getDealByTicket: vi.fn().mockResolvedValue(null),
      },
      fetchConfidentialDealFundingSnapshot: vi.fn(),
      prisma: {
        torqueEventDelivery: deliveryModel as any,
      } as any,
      fetchImpl: fetchMock as any,
      now: () => now,
      logger: logger as any,
    });

    await service.handleStageChanged(makeSettledEvent());
    await service.processPendingDeliveries();

    expect(deliveryModel.records.size).toBe(2);
    expect(Array.from(deliveryModel.records.values()).every((record) => record.status === "failed")).toBe(true);

    now = new Date(now.getTime() + 1_001);
    await service.processPendingDeliveries();
    await service.processPendingDeliveries();

    const recordStatuses = Array.from(deliveryModel.records.values()).map((record) => ({
      participantRole: record.participantRole,
      status: record.status,
      attemptCount: record.attemptCount,
      nextAttemptAt: record.nextAttemptAt ? String(record.nextAttemptAt) : null,
      deliveredAt: record.deliveredAt ? String(record.deliveredAt) : null,
    }));
    expect(deliveryModel.records.size).toBe(2);
    expect(recordStatuses).toEqual([
      expect.objectContaining({
        status: "sent",
        attemptCount: 2,
      }),
      expect.objectContaining({
        status: "sent",
        attemptCount: 2,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("emits fresh participant reward events across repeated trades for the same buyer and seller", async () => {
    const deliveryModel = createMemoryTorqueDeliveryModel();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const rewardTargetLookup = vi.fn().mockImplementation(async (ticketId: string) => {
      if (ticketId === "ticket-1") {
        return {
          ticketId,
          buyerWallet: "buyer-wallet",
          sellerWallet: "seller-wallet",
          buyerRewardWallet: "buyer-reward-wallet-1",
          sellerRewardWallet: "seller-reward-wallet-1",
        };
      }

      return {
        ticketId,
        buyerWallet: "buyer-wallet",
        sellerWallet: "seller-wallet",
        buyerRewardWallet: "buyer-reward-wallet-2",
        sellerRewardWallet: "seller-reward-wallet-2",
      };
    });

    const service = createTorqueEventService({
      eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn() } as any,
      loadConfig: makeConfig,
      rewardTargetStore: {
        getLatestByTicket: rewardTargetLookup,
      },
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(undefined),
      },
      privateEscrowIntentStore: {
        getLatestByTicket: vi.fn().mockImplementation(async (ticketId: string) => makePerIntent(ticketId)),
      },
      dealTracker: {
        getDealByTicket: vi.fn().mockResolvedValue(null),
      },
      fetchConfidentialDealFundingSnapshot: vi.fn(),
      prisma: {
        torqueEventDelivery: deliveryModel as any,
      } as any,
      fetchImpl: fetchMock as any,
      now: () => new Date("2026-05-02T12:00:00.000Z"),
      logger: logger as any,
    });

    await service.handleStageChanged(makeSettledEvent({ ticketId: "ticket-1" }));
    await service.handleStageChanged(makeSettledEvent({ ticketId: "ticket-2" }));
    await service.processPendingDeliveries();

    const deliveredWallets = Array.from(deliveryModel.records.values()).map((record) => record.userPubkey);
    expect(deliveryModel.records.size).toBe(4);
    expect(new Set(deliveredWallets).size).toBe(4);
    expect(deliveredWallets).toEqual(
      expect.arrayContaining([
        "buyer-reward-wallet-1",
        "seller-reward-wallet-1",
        "buyer-reward-wallet-2",
        "seller-reward-wallet-2",
      ])
    );
  });

  it("recovers queued deliveries after a service restart without duplicating rows", async () => {
    const deliveryModel = createMemoryTorqueDeliveryModel();
    const rewardTargetStore = {
      getLatestByTicket: vi.fn().mockResolvedValue({
        ticketId: "ticket-1",
        buyerWallet: "buyer-wallet",
        sellerWallet: "seller-wallet",
        buyerRewardWallet: "buyer-reward-wallet",
        sellerRewardWallet: "seller-reward-wallet",
      }),
    };

    const firstService = createTorqueEventService({
      eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn() } as any,
      loadConfig: makeConfig,
      rewardTargetStore: rewardTargetStore as any,
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(undefined),
      },
      privateEscrowIntentStore: {
        getLatestByTicket: vi.fn().mockResolvedValue(makePerIntent("ticket-1")),
      },
      dealTracker: {
        getDealByTicket: vi.fn().mockResolvedValue(null),
      },
      fetchConfidentialDealFundingSnapshot: vi.fn(),
      prisma: {
        torqueEventDelivery: deliveryModel as any,
      } as any,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }) as any,
      now: () => new Date("2026-05-02T12:00:00.000Z"),
      logger: logger as any,
    });

    await firstService.handleStageChanged(makeSettledEvent());
    await firstService.processPendingDeliveries();
    expect(deliveryModel.records.size).toBe(2);
    expect(Array.from(deliveryModel.records.values()).every((record) => record.status === "failed")).toBe(true);

    const restartFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    const restartedService = createTorqueEventService({
      eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn() } as any,
      loadConfig: makeConfig,
      rewardTargetStore: rewardTargetStore as any,
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(undefined),
      },
      privateEscrowIntentStore: {
        getLatestByTicket: vi.fn().mockResolvedValue(makePerIntent("ticket-1")),
      },
      dealTracker: {
        getDealByTicket: vi.fn().mockResolvedValue(null),
      },
      fetchConfidentialDealFundingSnapshot: vi.fn(),
      prisma: {
        torqueEventDelivery: deliveryModel as any,
      } as any,
      fetchImpl: restartFetch as any,
      now: () => new Date("2026-05-02T12:00:02.000Z"),
      logger: logger as any,
    });

    await restartedService.processPendingDeliveries();

    expect(restartFetch).toHaveBeenCalledTimes(2);
    expect(deliveryModel.records.size).toBe(2);
    expect(Array.from(deliveryModel.records.values()).every((record) => record.status === "sent")).toBe(true);
  });

  it("falls back to the confidential deal account when strict PER omits sealed execution terms", async () => {
    const deliveryModel = createMemoryTorqueDeliveryModel();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const service = createTorqueEventService({
      eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn() } as any,
      loadConfig: makeConfig,
      rewardTargetStore: {
        getLatestByTicket: vi.fn().mockResolvedValue({
          ticketId: "ticket-1",
          buyerWallet: "buyer-wallet",
          sellerWallet: "seller-wallet",
          buyerRewardWallet: "buyer-reward-wallet",
          sellerRewardWallet: "seller-reward-wallet",
        }),
      },
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(undefined),
      },
      privateEscrowIntentStore: {
        getLatestByTicket: vi.fn().mockResolvedValue({
          ticketId: "ticket-1",
          intentId: "intent-ticket-1",
          sessionPda: "session-ticket-1",
          termsHash: "terms-ticket-1",
          dealPda: "7m1eHEddkyAfzzstg7uMkiD76kH2dPdVqH2p8PgbccKd",
        }),
      },
      dealTracker: {
        getDealByTicket: vi.fn().mockResolvedValue({
          ticketId: "ticket-1",
          dealIdOnChain: "7m1eHEddkyAfzzstg7uMkiD76kH2dPdVqH2p8PgbccKd",
        }),
      },
      fetchConfidentialDealFundingSnapshot: vi.fn().mockResolvedValue({
        buyerPaymentLamports: 10_000_000_000n,
        buyerCollateralLamports: 1_000_000_000n,
        sellerCollateralLamports: 1_000_000_000n,
        privateFundingRegistered: true,
        releaseExecuted: true,
      }),
      prisma: {
        torqueEventDelivery: deliveryModel as any,
      } as any,
      fetchImpl: fetchMock as any,
      now: () => new Date("2026-05-02T12:00:00.000Z"),
      logger: logger as any,
    });

    await service.handleStageChanged(makeSettledEvent());
    await service.processPendingDeliveries();

    const payloads = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload.data.tradeNotionalLamports).toBe(10_000_000_000);
      expect(payload.data.platformFeeBps).toBe(110);
      expect(payload.data.platformFeeLamports).toBe(110_000_000);
      expect(payload.data.participantRewardLamports).toBe(6_600_000);
    }
  });
});
