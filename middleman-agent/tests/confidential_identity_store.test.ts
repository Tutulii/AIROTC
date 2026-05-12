import { describe, expect, it, vi } from "vitest";
import { ConfidentialIdentityStore } from "../src/state/confidentialIdentityStore";
import type { ConfidentialIdentitySnapshot } from "../src/state/confidentialIdentityStore";

function makeSnapshot(
  overrides: Partial<ConfidentialIdentitySnapshot> = {}
): ConfidentialIdentitySnapshot {
  return {
    ticketId: "ticket-1",
    buyerWallet: "buyer-wallet",
    sellerWallet: "seller-wallet",
    buyerFundingWallet: "buyer-funding-1",
    sellerFundingWallet: "seller-funding-1",
    source: "test_context",
    recordedAt: new Date().toISOString(),
    notes: ["test"],
    ...overrides,
  };
}

describe("ConfidentialIdentityStore", () => {
  it("rejects confidential funding wallet reuse across tickets", async () => {
    const store = new ConfidentialIdentityStore();
    const persisted: ConfidentialIdentitySnapshot[] = [makeSnapshot()];
    const prismaModule = await import("../src/lib/prisma");
    vi.spyOn(prismaModule.prisma.auditLog, "findMany").mockResolvedValue(
      persisted.map((snapshot, index) => ({
        id: `log-${index}`,
        ticketId: snapshot.ticketId,
        event: "confidential_identity_snapshot",
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
          buyerFundingWallet: "buyer-funding-1",
          sellerFundingWallet: "seller-funding-2",
        })
      )
    ).rejects.toThrow("confidential_identity_wallet_reused:ticket-1");
  });

  it("rejects participant wallets as confidential funding identities", async () => {
    const store = new ConfidentialIdentityStore();
    const prismaModule = await import("../src/lib/prisma");
    vi.spyOn(prismaModule.prisma.auditLog, "findMany").mockResolvedValue([] as any);

    await expect(
      store.save(
        makeSnapshot({
          buyerFundingWallet: "buyer-wallet",
        })
      )
    ).rejects.toThrow("confidential_identity_wallet_must_not_equal_participant_wallet");
  });
});
