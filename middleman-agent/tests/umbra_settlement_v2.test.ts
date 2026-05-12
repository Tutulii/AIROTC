import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, tx } = vi.hoisted(() => {
  const tx = {
    privateSettlement: {
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    privateSettlementParticipant: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (callback: any) => callback(tx)),
    privateSettlement: {
      update: vi.fn(),
    },
    privateSettlementParticipant: {
      findMany: vi.fn(),
    },
  };

  return { prisma, tx };
});

vi.mock("../src/lib/prisma", () => ({ prisma }));

import {
  prepareReceiverSettlementRecord,
  recordUmbraParticipantSubmission,
} from "../src/services/umbraSettlementV2";

const validWallet = "11111111111111111111111111111111";
const validTx = "5".repeat(64);

const settlementPlan = {
  policy: "STEALTH",
  resolution: "resolved",
  assetMint: "So11111111111111111111111111111111111111112",
  buyerTarget: {
    role: "buyer",
    strategy: "UMBRA_STEALTH",
    baseWallet: validWallet,
    resolvedAddress: validWallet,
    status: "resolved",
  },
  sellerTarget: {
    role: "seller",
    strategy: "UMBRA_STEALTH",
    baseWallet: validWallet,
    resolvedAddress: validWallet,
    status: "resolved",
  },
  notes: [],
} as any;

describe("umbraSettlementV2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks receiver wallets ready without pretending the full Umbra lifecycle completed", async () => {
    const result = await prepareReceiverSettlementRecord({
      dealId: "deal-1",
      settlementId: "settlement-1",
      mint: "So11111111111111111111111111111111111111112",
      settlementPlan,
    });

    expect(result).toEqual({
      phase: "RECEIVER_WALLETS_READY",
      lifecycleMode: "RECEIVER_WALLET_ONLY",
    });
    expect(tx.privateSettlement.update).toHaveBeenCalledWith({
      where: { id: "settlement-1" },
      data: {
        phase: "RECEIVER_WALLETS_READY",
        lifecycleMode: "RECEIVER_WALLET_ONLY",
        completedAt: null,
        error: null,
      },
    });
    expect(tx.privateSettlementParticipant.upsert).toHaveBeenCalledTimes(2);
  });

  it("fails closed on fake Umbra lifecycle transaction evidence", async () => {
    await expect(
      recordUmbraParticipantSubmission({
        settlementId: "settlement-1",
        role: "buyer",
        phase: "SHIELD",
        txSignature: "sdk_fallback_tx",
      })
    ).rejects.toThrow("sdk_fallback_tx");
  });

  it("records participant submissions only for full lifecycle settlements", async () => {
    tx.privateSettlement.findUnique.mockResolvedValue({
      id: "settlement-1",
      lifecycleMode: "FULL_UMBRA",
      phase: "FULL_LIFECYCLE_PENDING",
    });
    tx.privateSettlementParticipant.findUnique.mockResolvedValue({
      settlementId: "settlement-1",
      role: "buyer",
      phase: "PENDING",
    });
    tx.privateSettlementParticipant.update.mockResolvedValue({
      phase: "SHIELDED",
    });
    prisma.privateSettlementParticipant.findMany.mockResolvedValue([
      { role: "buyer", shieldTx: validTx },
      { role: "seller" },
    ]);

    const result = await recordUmbraParticipantSubmission({
      settlementId: "settlement-1",
      role: "buyer",
      phase: "SHIELD",
      txSignature: validTx,
      amountLamports: "1000",
    });

    expect(result).toEqual({
      settlementPhase: "SETTLING",
      participantPhase: "SHIELDED",
    });
    expect(tx.privateSettlementParticipant.update).toHaveBeenCalledWith({
      where: {
        settlementId_role: {
          settlementId: "settlement-1",
          role: "buyer",
        },
      },
      data: {
        verified: true,
        error: null,
        phase: "SHIELDED",
        shieldTx: validTx,
        shieldAmountLamports: "1000",
      },
    });
  });
});
