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
};

const { prisma, tx, state } = vi.hoisted(() => {
  const state = {
    settlement: {
      id: "settlement-soak-0",
      lifecycleMode: "FULL_UMBRA",
      phase: "FULL_LIFECYCLE_PENDING",
    },
    participants: new Map<string, Participant>(),
    seenTxs: new Set<string>(),
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
        for (const txField of ["shieldTx", "utxoTx", "claimTx", "unshieldTx"]) {
          if (data[txField]) {
            if (state.seenTxs.has(data[txField])) {
              throw new Error(`duplicate tx evidence in soak: ${data[txField]}`);
            }
            state.seenTxs.add(data[txField]);
          }
        }
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
const phaseOrder = ["SHIELD", "CREATE_UTXO", "CLAIM", "UNSHIELD"] as const;
const seeds = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function txSig(index: number): string {
  let value = index;
  let encoded = "";
  while (value > 0) {
    encoded = seeds[value % seeds.length] + encoded;
    value = Math.floor(value / seeds.length);
  }
  return `${(encoded || "1").padStart(8, "1")}${"1".repeat(56)}`;
}

function resetSettlement(settlementId: string) {
  state.settlement = {
    id: settlementId,
    lifecycleMode: "FULL_UMBRA",
    phase: "FULL_LIFECYCLE_PENDING",
  };
  state.participants = new Map([
    [
      state.participantKey(settlementId, "buyer"),
      { settlementId, role: "buyer", phase: "PENDING" },
    ],
    [
      state.participantKey(settlementId, "seller"),
      { settlementId, role: "seller", phase: "PENDING" },
    ],
  ]);
}

describe("full pipeline Umbra lifecycle soak", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.seenTxs = new Set();
  });

  it("completes 20 sequential full Umbra lifecycle settlements without stuck states or duplicate evidence", async () => {
    let txIndex = 1;

    for (let iteration = 0; iteration < 20; iteration += 1) {
      const settlementId = `settlement-soak-${iteration}`;
      resetSettlement(settlementId);

      for (const role of ["buyer", "seller"] as const) {
        for (const phase of phaseOrder) {
          const result = await recordUmbraParticipantSubmission({
            settlementId,
            role,
            phase,
            txSignature: txSig(txIndex++),
            amountLamports: "1000",
            finalWallet: phase === "UNSHIELD" ? finalWallet : undefined,
          });
          expect(result.participantPhase).toMatch(
            /SHIELDED|UTXO_CREATED|CLAIMED|UNSHIELDED/
          );
        }
      }

      expect(state.settlement.phase).toBe("COMPLETED");
      expect(state.participants.get(`${settlementId}:buyer`)?.unshieldTx).toBeTruthy();
      expect(state.participants.get(`${settlementId}:seller`)?.unshieldTx).toBeTruthy();
    }

    expect(state.seenTxs.size).toBe(20 * 2 * phaseOrder.length);
  });
});
