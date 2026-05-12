import { beforeEach, describe, expect, it, vi } from "vitest";

type Role = "buyer" | "seller";
type Participant = {
  settlementId: string;
  role: Role;
  phase: string;
  shieldTx?: string;
  utxoTx?: string;
  claimTx?: string;
  unshieldTx?: string;
  finalWallet?: string;
};

const { prisma, tx, state } = vi.hoisted(() => {
  const state = {
    settlement: {
      id: "settlement-e2e",
      lifecycleMode: "FULL_UMBRA",
      phase: "FULL_LIFECYCLE_PENDING",
    },
    participants: new Map<string, Participant>(),
    participantKey(settlementId: string, role: Role) {
      return `${settlementId}:${role}`;
    },
  };

  const tx = {
    privateSettlement: {
      update: vi.fn(async ({ data }: any) => {
        state.settlement = { ...state.settlement, ...data };
        return state.settlement;
      }),
      findUnique: vi.fn(async () => state.settlement),
    },
    privateSettlementParticipant: {
      upsert: vi.fn(),
      findUnique: vi.fn(async ({ where }: any) => {
        const { settlementId, role } = where.settlementId_role;
        return state.participants.get(state.participantKey(settlementId, role));
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const { settlementId, role } = where.settlementId_role;
        const key = state.participantKey(settlementId, role);
        const existing = state.participants.get(key);
        const updated = { ...existing, ...data };
        state.participants.set(key, updated);
        return updated;
      }),
    },
  };

  const prisma = {
    $transaction: vi.fn(async (callback: any) => callback(tx)),
    privateSettlement: {
      update: vi.fn(async ({ data }: any) => {
        state.settlement = { ...state.settlement, ...data };
        return state.settlement;
      }),
    },
    privateSettlementParticipant: {
      findMany: vi.fn(async ({ where }: any) => {
        const settlementId = where.settlementId;
        return Array.from(state.participants.values()).filter(
          (participant) => participant.settlementId === settlementId
        );
      }),
    },
  };

  return { prisma, tx, state };
});

vi.mock("../src/lib/prisma", () => ({ prisma }));

import { recordUmbraParticipantSubmission } from "../src/services/umbraSettlementV2";

const finalWallet = "11111111111111111111111111111111";

function txSig(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function resetState() {
  vi.clearAllMocks();
  state.settlement = {
    id: "settlement-e2e",
    lifecycleMode: "FULL_UMBRA",
    phase: "FULL_LIFECYCLE_PENDING",
  };
  state.participants = new Map([
    [
      state.participantKey("settlement-e2e", "buyer"),
      {
        settlementId: "settlement-e2e",
        role: "buyer",
        phase: "PENDING",
      },
    ],
    [
      state.participantKey("settlement-e2e", "seller"),
      {
        settlementId: "settlement-e2e",
        role: "seller",
        phase: "PENDING",
      },
    ],
  ]);
}

async function submit(role: Role, phase: "SHIELD" | "CREATE_UTXO" | "CLAIM" | "UNSHIELD", sigSeed: string) {
  return recordUmbraParticipantSubmission({
    settlementId: "settlement-e2e",
    role,
    phase,
    txSignature: txSig(sigSeed),
    amountLamports: "1000",
    finalWallet: phase === "UNSHIELD" ? finalWallet : undefined,
  });
}

describe("full pipeline Umbra lifecycle E2E state machine", () => {
  beforeEach(() => {
    resetState();
  });

  it("requires ordered shield, UTXO, claim, and unshield evidence before completion", async () => {
    await expect(submit("buyer", "CLAIM", "2")).rejects.toThrow(
      "Umbra claim requires a prior UTXO creation transaction"
    );

    expect(await submit("buyer", "SHIELD", "3")).toEqual({
      settlementPhase: "SETTLING",
      participantPhase: "SHIELDED",
    });
    expect(await submit("buyer", "CREATE_UTXO", "4")).toEqual({
      settlementPhase: "CLAIMING",
      participantPhase: "UTXO_CREATED",
    });
    expect(await submit("buyer", "CLAIM", "5")).toEqual({
      settlementPhase: "UNSHIELDING",
      participantPhase: "CLAIMED",
    });
    expect(await submit("buyer", "UNSHIELD", "6")).toEqual({
      settlementPhase: "UNSHIELDING",
      participantPhase: "UNSHIELDED",
    });

    expect(await submit("seller", "SHIELD", "7")).toEqual({
      settlementPhase: "UNSHIELDING",
      participantPhase: "SHIELDED",
    });
    expect(await submit("seller", "CREATE_UTXO", "8")).toEqual({
      settlementPhase: "UNSHIELDING",
      participantPhase: "UTXO_CREATED",
    });
    expect(await submit("seller", "CLAIM", "9")).toEqual({
      settlementPhase: "UNSHIELDING",
      participantPhase: "CLAIMED",
    });
    expect(await submit("seller", "UNSHIELD", "A")).toEqual({
      settlementPhase: "COMPLETED",
      participantPhase: "UNSHIELDED",
    });

    expect(state.settlement.phase).toBe("COMPLETED");
    expect((state.settlement as any).completedAt).toBeInstanceOf(Date);
    expect(state.participants.get("settlement-e2e:buyer")?.finalWallet).toBe(finalWallet);
    expect(state.participants.get("settlement-e2e:seller")?.finalWallet).toBe(finalWallet);
  });
});
