import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config";
import { prisma } from "../lib/prisma";
import type { SettlementAddressPlan } from "../types/dealPipeline";
import { UMBRA_PROGRAM_IDS } from "./umbraService";
import { withRetry } from "../utils/retry";

export type UmbraSettlementLifecycleMode = "RECEIVER_WALLET_ONLY" | "FULL_UMBRA";
export type UmbraParticipantRole = "buyer" | "seller";
export type UmbraParticipantSubmissionPhase =
  | "SHIELD"
  | "CREATE_UTXO"
  | "CLAIM"
  | "UNSHIELD";

export interface ReceiverSettlementRecordInput {
  dealId: string;
  mint: string;
  settlementId: string;
  settlementPlan: SettlementAddressPlan;
  lifecycleMode?: UmbraSettlementLifecycleMode;
}

export interface UmbraParticipantSubmissionInput {
  settlementId: string;
  role: UmbraParticipantRole;
  phase: UmbraParticipantSubmissionPhase;
  txSignature: string;
  amountLamports?: string | bigint | number;
  finalWallet?: string;
}

export interface ReceiverSettlementRecordResult {
  phase: string;
  lifecycleMode: UmbraSettlementLifecycleMode;
}

const VALID_TX_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/;

function assertPublicKey(value: string, label: string): void {
  try {
    new PublicKey(value);
  } catch {
    throw new Error(`${label} must be a valid Solana public key`);
  }
}

function assertTxSignature(value: string): void {
  if (value === "sdk_fallback_tx") {
    throw new Error("Umbra lifecycle evidence cannot use sdk_fallback_tx");
  }
  if (!VALID_TX_SIGNATURE.test(value)) {
    throw new Error("Umbra lifecycle txSignature must be a base58 Solana signature");
  }
}

function shouldVerifyUmbraEvidence(): boolean {
  return process.env.NODE_ENV !== "test" && process.env.UMBRA_VERIFY_TX_EVIDENCE !== "false";
}

function resolveUmbraProgramId(network: string): string {
  return network === "mainnet-beta" ? UMBRA_PROGRAM_IDS.mainnet : UMBRA_PROGRAM_IDS.devnet;
}

function parsedInstructionProgramId(instruction: any): string | null {
  const programId = instruction?.programId;
  if (!programId) return null;
  if (typeof programId === "string") return programId;
  if (typeof programId.toBase58 === "function") return programId.toBase58();
  return String(programId);
}

async function verifyUmbraTransactionEvidence(input: UmbraParticipantSubmissionInput): Promise<void> {
  if (!shouldVerifyUmbraEvidence()) return;

  const config = loadConfig();
  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const tx = await withRetry(
    async () => {
      const parsed = await connection.getParsedTransaction(input.txSignature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!parsed) {
        throw new Error(`temporarily unavailable: Umbra lifecycle transaction ${input.txSignature} was not found on Solana`);
      }
      return parsed;
    },
    {
      label: "umbra_verify_tx_evidence",
      step: input.phase,
    }
  );

  if (tx.meta?.err) {
    throw new Error(`Umbra lifecycle transaction ${input.txSignature} failed on-chain`);
  }

  const expectedProgramId = resolveUmbraProgramId(config.network);
  const topLevelProgramIds = tx.transaction.message.instructions
    .map(parsedInstructionProgramId)
    .filter((value): value is string => !!value);
  const innerProgramIds = (tx.meta?.innerInstructions || [])
    .flatMap((group) => group.instructions || [])
    .map(parsedInstructionProgramId)
    .filter((value): value is string => !!value);
  const programIds = new Set([...topLevelProgramIds, ...innerProgramIds]);

  if (!programIds.has(expectedProgramId)) {
    throw new Error(
      `Umbra lifecycle transaction ${input.txSignature} does not invoke expected Umbra program ${expectedProgramId}`
    );
  }
}

function lamportsToString(value: string | bigint | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error("amountLamports must be non-negative");
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("amountLamports must be a non-negative safe integer");
    }
    return String(value);
  }
  if (!/^\d+$/.test(value)) {
    throw new Error("amountLamports must be a decimal lamport string");
  }
  return value;
}

function participantTarget(
  settlementPlan: SettlementAddressPlan,
  role: UmbraParticipantRole
): { baseWallet: string; receiverWallet: string } {
  const target = role === "buyer" ? settlementPlan.buyerTarget : settlementPlan.sellerTarget;
  if (target.strategy !== "UMBRA_STEALTH") {
    throw new Error(`${role} settlement target is not an Umbra stealth target`);
  }
  if (!target.resolvedAddress) {
    throw new Error(`${role} settlement target is missing a resolved Umbra receiver wallet`);
  }
  assertPublicKey(target.baseWallet, `${role}.baseWallet`);
  assertPublicKey(target.resolvedAddress, `${role}.resolvedAddress`);
  return {
    baseWallet: target.baseWallet,
    receiverWallet: target.resolvedAddress,
  };
}

async function updateAggregateSettlementCompletion(settlementId: string): Promise<string> {
  const participants = await prisma.privateSettlementParticipant.findMany({
    where: { settlementId },
  });
  const buyer = participants.find((participant) => participant.role === "buyer");
  const seller = participants.find((participant) => participant.role === "seller");

  if (buyer?.unshieldTx && seller?.unshieldTx) {
    await prisma.privateSettlement.update({
      where: { id: settlementId },
      data: {
        phase: "COMPLETED",
        completedAt: new Date(),
        error: null,
      },
    });
    return "COMPLETED";
  }

  if (buyer?.claimTx || seller?.claimTx) return "UNSHIELDING";
  if (buyer?.utxoTx || seller?.utxoTx) return "CLAIMING";
  if (buyer?.shieldTx || seller?.shieldTx) return "SETTLING";
  return "FULL_LIFECYCLE_PENDING";
}

export async function prepareReceiverSettlementRecord(
  input: ReceiverSettlementRecordInput
): Promise<ReceiverSettlementRecordResult> {
  if (input.settlementPlan.policy !== "STEALTH") {
    throw new Error("Umbra receiver settlement can only be prepared for STEALTH settlement policy");
  }
  if (input.settlementPlan.resolution !== "resolved") {
    throw new Error("Umbra receiver settlement requires resolved settlement targets");
  }

  const buyer = participantTarget(input.settlementPlan, "buyer");
  const seller = participantTarget(input.settlementPlan, "seller");
  const lifecycleMode = input.lifecycleMode || "RECEIVER_WALLET_ONLY";
  const phase =
    lifecycleMode === "FULL_UMBRA"
      ? "FULL_LIFECYCLE_PENDING"
      : "RECEIVER_WALLETS_READY";

  await prisma.$transaction(async (tx) => {
    await tx.privateSettlement.update({
      where: { id: input.settlementId },
      data: {
        phase,
        lifecycleMode,
        completedAt: null,
        error: null,
      },
    });

    for (const [role, target] of [
      ["buyer", buyer],
      ["seller", seller],
    ] as const) {
      await tx.privateSettlementParticipant.upsert({
        where: {
          settlementId_role: {
            settlementId: input.settlementId,
            role,
          },
        },
        update: {
          dealId: input.dealId,
          mint: input.mint,
          sourceWallet: target.baseWallet,
          receiverWallet: target.receiverWallet,
          error: null,
        },
        create: {
          settlementId: input.settlementId,
          dealId: input.dealId,
          role,
          mint: input.mint,
          sourceWallet: target.baseWallet,
          receiverWallet: target.receiverWallet,
        },
      });
    }
  });

  return { phase, lifecycleMode };
}

export async function recordUmbraParticipantSubmission(
  input: UmbraParticipantSubmissionInput
): Promise<{ settlementPhase: string; participantPhase: string }> {
  assertTxSignature(input.txSignature);
  const amountLamports = lamportsToString(input.amountLamports);
  if (input.finalWallet) {
    assertPublicKey(input.finalWallet, "finalWallet");
  }
  await verifyUmbraTransactionEvidence(input);

  const result = await prisma.$transaction(async (tx) => {
    const settlement = await tx.privateSettlement.findUnique({
      where: { id: input.settlementId },
    });
    if (!settlement) {
      throw new Error(`Private settlement ${input.settlementId} not found`);
    }
    if (settlement.lifecycleMode !== "FULL_UMBRA") {
      throw new Error("Umbra lifecycle submissions require lifecycleMode=FULL_UMBRA");
    }
    if (settlement.phase === "COMPLETED") {
      throw new Error("Umbra lifecycle is already completed");
    }
    if (settlement.phase === "FAILED") {
      throw new Error("Umbra lifecycle is already failed");
    }

    const participant = await tx.privateSettlementParticipant.findUnique({
      where: {
        settlementId_role: {
          settlementId: input.settlementId,
          role: input.role,
        },
      },
    });
    if (!participant) {
      throw new Error(`Umbra participant ${input.role} not found for settlement ${input.settlementId}`);
    }

    const update: Record<string, unknown> = {
      verified: true,
      error: null,
    };
    const aggregateUpdate: Record<string, unknown> = {
      error: null,
    };

    if (input.phase === "SHIELD") {
      update.phase = "SHIELDED";
      update.shieldTx = input.txSignature;
      if (amountLamports) update.shieldAmountLamports = amountLamports;
      aggregateUpdate.phase = "SETTLING";
      aggregateUpdate[input.role === "buyer" ? "buyerShieldTx" : "sellerShieldTx"] = input.txSignature;
      if (amountLamports) {
        aggregateUpdate[input.role === "buyer" ? "buyerShieldAmount" : "sellerShieldAmount"] = Number(amountLamports);
      }
    }

    if (input.phase === "CREATE_UTXO") {
      if (!participant.shieldTx) {
        throw new Error("Umbra UTXO creation requires a prior shield transaction");
      }
      update.phase = "UTXO_CREATED";
      update.utxoTx = input.txSignature;
      if (amountLamports) update.settlementAmountLamports = amountLamports;
      aggregateUpdate.phase = "CLAIMING";
      aggregateUpdate.settlementUtxoTx = input.txSignature;
    }

    if (input.phase === "CLAIM") {
      if (!participant.utxoTx) {
        throw new Error("Umbra claim requires a prior UTXO creation transaction");
      }
      update.phase = "CLAIMED";
      update.claimTx = input.txSignature;
      aggregateUpdate.phase = "UNSHIELDING";
      aggregateUpdate.claimTx = input.txSignature;
    }

    if (input.phase === "UNSHIELD") {
      if (!participant.claimTx) {
        throw new Error("Umbra unshield requires a prior claim transaction");
      }
      update.phase = "UNSHIELDED";
      update.unshieldTx = input.txSignature;
      if (amountLamports) update.unshieldAmountLamports = amountLamports;
      if (input.finalWallet) update.finalWallet = input.finalWallet;
      aggregateUpdate.phase = "UNSHIELDING";
      aggregateUpdate[input.role === "buyer" ? "buyerUnshieldTx" : "sellerUnshieldTx"] = input.txSignature;
    }

    const updated = await tx.privateSettlementParticipant.update({
      where: {
        settlementId_role: {
          settlementId: input.settlementId,
          role: input.role,
        },
      },
      data: update,
    });
    await tx.privateSettlement.update({
      where: { id: input.settlementId },
      data: aggregateUpdate,
    });

    return updated.phase;
  });

  const settlementPhase = await updateAggregateSettlementCompletion(input.settlementId);
  return {
    settlementPhase,
    participantPhase: result,
  };
}
