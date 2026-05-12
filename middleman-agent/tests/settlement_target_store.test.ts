import { describe, expect, it, vi } from "vitest";
import { SettlementTargetStore } from "../src/state/settlementTargetStore";
import type { SettlementTargetSnapshot } from "../src/state/settlementTargetStore";

function makeSnapshot(overrides: Partial<SettlementTargetSnapshot> = {}): SettlementTargetSnapshot {
  return {
    ticketId: "ticket-1",
    buyerWallet: "buyer-wallet",
    sellerWallet: "seller-wallet",
    buyerSettlementWallet: "buyer-stealth-1",
    sellerSettlementWallet: "seller-stealth-1",
    source: "test_context",
    recordedAt: new Date().toISOString(),
    notes: ["test"],
    ...overrides,
  };
}

describe("SettlementTargetStore", () => {
  it("rejects settlement wallet reuse across tickets", async () => {
    const store = new SettlementTargetStore();
    const persisted: SettlementTargetSnapshot[] = [makeSnapshot()];
    const prismaModule = await import("../src/lib/prisma");
    vi.spyOn(prismaModule.prisma.auditLog, "findMany").mockResolvedValue(
      persisted.map((snapshot, index) => ({
        id: `log-${index}`,
        ticketId: snapshot.ticketId,
        event: "settlement_target_snapshot",
        data: JSON.stringify(snapshot),
        hash: "",
        prevHash: null,
        createdAt: new Date(),
      })) as any
    );

    await expect(
      store.save(
        makeSnapshot({
          ticketId: "ticket-2",
          buyerSettlementWallet: "buyer-stealth-1",
          sellerSettlementWallet: "seller-stealth-2",
        })
      )
    ).rejects.toThrow("settlement_target_wallet_reused:ticket-1");
  });

  it("rejects participant wallets as settlement targets", async () => {
    const store = new SettlementTargetStore();
    const prismaModule = await import("../src/lib/prisma");
    vi.spyOn(prismaModule.prisma.auditLog, "findMany").mockResolvedValue([] as any);

    await expect(
      store.save(
        makeSnapshot({
          buyerSettlementWallet: "buyer-wallet",
        })
      )
    ).rejects.toThrow("settlement_target_wallet_must_not_equal_participant_wallet");
  });
});
