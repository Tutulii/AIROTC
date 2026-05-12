import { describe, expect, it, vi } from "vitest";
import { RewardTargetStore } from "../src/state/rewardTargetStore";
import type { RewardTargetSnapshot } from "../src/state/rewardTargetStore";

function makeSnapshot(overrides: Partial<RewardTargetSnapshot> = {}): RewardTargetSnapshot {
  return {
    ticketId: "ticket-1",
    buyerWallet: "buyer-wallet",
    sellerWallet: "seller-wallet",
    buyerRewardWallet: "buyer-reward-1",
    sellerRewardWallet: "seller-reward-1",
    source: "test_context",
    recordedAt: new Date().toISOString(),
    notes: ["test"],
    ...overrides,
  };
}

describe("RewardTargetStore", () => {
  function createMemoryPrisma() {
    const rewardSnapshots = new Map<string, any>();
    const rewardReservations = new Map<string, any>();
    const auditLogs: any[] = [];
    let snapshotCounter = 0;
    let auditCounter = 0;

    return {
      rewardSnapshots,
      rewardReservations,
      auditLogs,
      rewardTargetSnapshotRecord: {
        async findUnique({ where }: any) {
          return rewardSnapshots.get(where.ticketId) || null;
        },
        async create({ data }: any) {
          if (rewardSnapshots.has(data.ticketId)) {
            const error: any = new Error("duplicate ticket");
            error.code = "P2002";
            throw error;
          }
          const created = {
            id: `snapshot-${++snapshotCounter}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
            notes: data.notes === null ? null : data.notes,
          };
          rewardSnapshots.set(data.ticketId, created);
          return created;
        },
      },
      rewardTargetReservation: {
        async create({ data }: any) {
          if (rewardReservations.has(data.address)) {
            const error: any = new Error("duplicate address");
            error.code = "P2002";
            throw error;
          }
          const created = {
            ...data,
            createdAt: new Date(),
          };
          rewardReservations.set(data.address, created);
          return created;
        },
        async findMany({ where }: any) {
          const addresses = new Set(where.address?.in || []);
          return Array.from(rewardReservations.values()).filter((entry) => {
            if (!addresses.has(entry.address)) {
              return false;
            }
            if (where.NOT?.ticketId && entry.ticketId === where.NOT.ticketId) {
              return false;
            }
            return true;
          });
        },
      },
      auditLog: {
        async findFirst({ where }: any) {
          const matches = auditLogs.filter((entry) => entry.ticketId === where.ticketId);
          return matches[matches.length - 1] || null;
        },
        async findMany({ where }: any) {
          return auditLogs.filter((entry) => {
            if (where.ticketId && entry.ticketId !== where.ticketId) {
              return false;
            }
            if (where.event && entry.event !== where.event) {
              return false;
            }
            return true;
          });
        },
        async create({ data }: any) {
          const created = {
            id: `audit-${++auditCounter}`,
            createdAt: new Date(),
            ...data,
          };
          auditLogs.push(created);
          return created;
        },
      },
      async $transaction(callback: any) {
        return callback(this);
      },
    };
  }

  it("rejects reward wallet reuse across tickets", async () => {
    const prismaMock = createMemoryPrisma();
    const store = new RewardTargetStore({
      getSettlementTargetSnapshot: vi.fn().mockResolvedValue({
        buyerSettlementWallet: "buyer-settlement-1",
        sellerSettlementWallet: "seller-settlement-1",
      }),
      prisma: prismaMock as any,
    } as any);
    await store.save(makeSnapshot());

    await expect(
      store.save(
        makeSnapshot({
          ticketId: "ticket-2",
          buyerRewardWallet: "buyer-reward-1",
          sellerRewardWallet: "seller-reward-2",
        })
      )
    ).rejects.toThrow("reward_target_wallet_reused:ticket-1");
  });

  it("rejects participant wallets as reward targets", async () => {
    const prismaMock = createMemoryPrisma();
    const store = new RewardTargetStore({
      getSettlementTargetSnapshot: vi.fn().mockResolvedValue(null),
      prisma: prismaMock as any,
    } as any);

    await expect(
      store.save(
        makeSnapshot({
          buyerRewardWallet: "buyer-wallet",
        })
      )
    ).rejects.toThrow("reward_target_wallet_must_not_equal_participant_wallet");
  });

  it("rejects settlement wallets as reward targets", async () => {
    const prismaMock = createMemoryPrisma();
    const store = new RewardTargetStore({
      getSettlementTargetSnapshot: vi.fn().mockResolvedValue({
        buyerSettlementWallet: "buyer-settlement-1",
        sellerSettlementWallet: "seller-settlement-1",
      }),
      prisma: prismaMock as any,
    } as any);

    await expect(
      store.save(
        makeSnapshot({
          buyerRewardWallet: "buyer-settlement-1",
        })
      )
    ).rejects.toThrow("reward_target_wallet_must_not_equal_settlement_wallet");
  });

  it("stores snapshots durably and returns the typed record", async () => {
    const prismaMock = createMemoryPrisma();
    const store = new RewardTargetStore({
      getSettlementTargetSnapshot: vi.fn().mockResolvedValue({
        buyerSettlementWallet: "buyer-settlement-1",
        sellerSettlementWallet: "seller-settlement-1",
      }),
      prisma: prismaMock as any,
    } as any);

    const snapshot = makeSnapshot();
    await store.save(snapshot);

    const stored = await store.getLatestByTicket(snapshot.ticketId);
    expect(stored).toEqual(
      expect.objectContaining({
        ticketId: snapshot.ticketId,
        buyerRewardWallet: snapshot.buyerRewardWallet,
        sellerRewardWallet: snapshot.sellerRewardWallet,
        source: snapshot.source,
      })
    );
    expect(prismaMock.rewardReservations.size).toBe(2);
  });

  it("stores hashed reservation keys and sealed snapshot payloads at rest", async () => {
    const prismaMock = createMemoryPrisma();
    const store = new RewardTargetStore({
      getSettlementTargetSnapshot: vi.fn().mockResolvedValue({
        buyerSettlementWallet: "buyer-settlement-1",
        sellerSettlementWallet: "seller-settlement-1",
      }),
      prisma: prismaMock as any,
    } as any);

    const snapshot = makeSnapshot();
    await store.save(snapshot);

    const reservationKeys = Array.from(prismaMock.rewardReservations.keys());
    expect(reservationKeys).not.toContain(snapshot.buyerRewardWallet);
    expect(reservationKeys).not.toContain(snapshot.sellerRewardWallet);

    const storedRecord = prismaMock.rewardSnapshots.get(snapshot.ticketId);
    expect(storedRecord.buyerWallet).not.toBe(snapshot.buyerWallet);
    expect(storedRecord.sellerWallet).not.toBe(snapshot.sellerWallet);
    expect(storedRecord.buyerRewardWallet).not.toBe(snapshot.buyerRewardWallet);
    expect(storedRecord.sellerRewardWallet).not.toBe(snapshot.sellerRewardWallet);
    expect(JSON.stringify(storedRecord.notes)).not.toContain(snapshot.buyerRewardWallet);
    expect(JSON.stringify(storedRecord.notes)).not.toContain(snapshot.sellerRewardWallet);
  });

  it("treats identical repeat saves for the same ticket as idempotent", async () => {
    const prismaMock = createMemoryPrisma();
    const store = new RewardTargetStore({
      getSettlementTargetSnapshot: vi.fn().mockResolvedValue({
        buyerSettlementWallet: "buyer-settlement-1",
        sellerSettlementWallet: "seller-settlement-1",
      }),
      prisma: prismaMock as any,
    } as any);

    const snapshot = makeSnapshot();
    await store.save(snapshot);
    await store.save(snapshot);

    expect(prismaMock.rewardSnapshots.size).toBe(1);
    expect(prismaMock.rewardReservations.size).toBe(2);
    expect(prismaMock.auditLogs).toHaveLength(1);
  });
});
