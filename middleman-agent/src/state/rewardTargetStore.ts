import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { settlementTargetStore } from "./settlementTargetStore";
import {
  computePrivateMetadataLookupHash,
  isSealedPrivateMetadataEnvelope,
  revealPrivateMetadata,
  sealPrivateMetadata,
  type SealedPrivateMetadataEnvelope,
} from "../services/privateMetadataSeal";

const SNAPSHOT_EVENT = "reward_target_snapshot";

export interface RewardTargetSnapshot {
  ticketId: string;
  buyerWallet: string;
  sellerWallet: string;
  buyerRewardWallet: string;
  sellerRewardWallet: string;
  source: "api_bridge" | "local_demo" | "test_context";
  recordedAt: string;
  notes?: string[];
}

interface RewardTargetStoreDeps {
  getSettlementTargetSnapshot: typeof settlementTargetStore.getLatestByTicket;
  prisma: RewardTargetStorePrismaClient;
}

function parseSnapshot(raw: string): RewardTargetSnapshot | null {
  try {
    const parsed = JSON.parse(raw);
    if (isSealedPrivateMetadataEnvelope(parsed, SNAPSHOT_EVENT)) {
      return revealPrivateMetadata<RewardTargetSnapshot>(parsed);
    }
    return parsed as RewardTargetSnapshot;
  } catch {
    return null;
  }
}

const defaultDeps: RewardTargetStoreDeps = {
  getSettlementTargetSnapshot: (ticketId) => settlementTargetStore.getLatestByTicket(ticketId),
  prisma: prisma as unknown as RewardTargetStorePrismaClient,
};

type RewardTargetSnapshotRecord = {
  ticketId: string;
  buyerWallet: string;
  sellerWallet: string;
  buyerRewardWallet: string;
  sellerRewardWallet: string;
  source: string;
  recordedAt: Date;
  notes: Prisma.JsonValue | null;
};

interface RewardTargetStoreAuditLog {
  findFirst(args: any): Promise<{ hash?: string | null } | null>;
  findMany(args: any): Promise<Array<{ data: string }>>;
  create(args: any): Promise<unknown>;
}

interface RewardTargetStoreReservationModel {
  create(args: any): Promise<unknown>;
  findMany(args: any): Promise<Array<{ ticketId: string }>>;
}

interface RewardTargetStoreSnapshotModel {
  findUnique(args: any): Promise<RewardTargetSnapshotRecord | null>;
  create(args: any): Promise<RewardTargetSnapshotRecord>;
}

interface RewardTargetStorePrismaTransaction {
  rewardTargetReservation: RewardTargetStoreReservationModel;
  rewardTargetSnapshotRecord: RewardTargetStoreSnapshotModel;
  auditLog: RewardTargetStoreAuditLog;
}

interface RewardTargetStorePrismaClient extends RewardTargetStorePrismaTransaction {
  $transaction<T>(callback: (tx: RewardTargetStorePrismaTransaction) => Promise<T>): Promise<T>;
}

function stringifyPayload(
  ticketId: string,
  event: string,
  data: unknown,
  timestamp: number,
  prevHash: string
): string {
  return JSON.stringify({ ticketId, event, data, timestamp, prevHash });
}

function computeHash(payload: string): string {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function getSealedEnvelopeFromNotes(notes: Prisma.JsonValue | null): SealedPrivateMetadataEnvelope | null {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) {
    return null;
  }

  const candidate = (notes as Record<string, unknown>).sealedRewardTargetSnapshot;
  if (!isSealedPrivateMetadataEnvelope(candidate, SNAPSHOT_EVENT)) {
    return null;
  }

  return candidate;
}

export class RewardTargetStore {
  constructor(private readonly deps: RewardTargetStoreDeps = defaultDeps) {}

  private hashAddress(address: string): string {
    return computePrivateMetadataLookupHash("reward_target_address", address);
  }

  private hashRecordField(label: string, value: string): string {
    return computePrivateMetadataLookupHash(`reward_target_record:${label}`, value);
  }

  private async assertFreshWallets(snapshot: RewardTargetSnapshot): Promise<void> {
    if (snapshot.buyerRewardWallet === snapshot.sellerRewardWallet) {
      throw new Error("reward_target_wallet_collision_within_ticket");
    }

    const participantWallets = new Set([snapshot.buyerWallet, snapshot.sellerWallet]);
    if (
      participantWallets.has(snapshot.buyerRewardWallet) ||
      participantWallets.has(snapshot.sellerRewardWallet)
    ) {
      throw new Error("reward_target_wallet_must_not_equal_participant_wallet");
    }

    const settlementTargets = await this.deps.getSettlementTargetSnapshot(snapshot.ticketId);
    if (settlementTargets) {
      const usedSettlementWallets = new Set([
        settlementTargets.buyerSettlementWallet,
        settlementTargets.sellerSettlementWallet,
      ]);
      if (
        usedSettlementWallets.has(snapshot.buyerRewardWallet) ||
        usedSettlementWallets.has(snapshot.sellerRewardWallet)
      ) {
        throw new Error("reward_target_wallet_must_not_equal_settlement_wallet");
      }
    }

  }

  private normalizeStoredSnapshot(record: RewardTargetSnapshotRecord): RewardTargetSnapshot {
    const sealedEnvelope = getSealedEnvelopeFromNotes(record.notes);
    if (sealedEnvelope) {
      return revealPrivateMetadata<RewardTargetSnapshot>(sealedEnvelope);
    }

    return {
      ticketId: record.ticketId,
      buyerWallet: record.buyerWallet,
      sellerWallet: record.sellerWallet,
      buyerRewardWallet: record.buyerRewardWallet,
      sellerRewardWallet: record.sellerRewardWallet,
      source: record.source as RewardTargetSnapshot["source"],
      recordedAt: record.recordedAt.toISOString(),
      notes: Array.isArray(record.notes) ? (record.notes as string[]) : undefined,
    };
  }

  private isSameSnapshot(left: RewardTargetSnapshot, right: RewardTargetSnapshot): boolean {
    return (
      left.ticketId === right.ticketId &&
      left.buyerWallet === right.buyerWallet &&
      left.sellerWallet === right.sellerWallet &&
      left.buyerRewardWallet === right.buyerRewardWallet &&
      left.sellerRewardWallet === right.sellerRewardWallet &&
      left.source === right.source &&
      JSON.stringify(left.notes || []) === JSON.stringify(right.notes || [])
    );
  }

  private async appendSnapshotAuditLogTx(
    tx: Pick<RewardTargetStorePrismaTransaction, "auditLog">,
    snapshot: RewardTargetSnapshot
  ): Promise<void> {
    const prev = await tx.auditLog.findFirst({
      where: { ticketId: snapshot.ticketId },
      orderBy: { createdAt: "desc" },
    });
    const prevHash = prev?.hash || "GENESIS";
    const timestamp = Date.now();
    const sealedSnapshot = sealPrivateMetadata({
      kind: SNAPSHOT_EVENT,
      ticketId: snapshot.ticketId,
      payload: snapshot,
      metadata: {
        source: snapshot.source,
        recordedAt: snapshot.recordedAt,
      },
    });
    const payload = stringifyPayload(
      snapshot.ticketId,
      SNAPSHOT_EVENT,
      sealedSnapshot,
      timestamp,
      prevHash
    );
    const hash = computeHash(payload);

    await tx.auditLog.create({
      data: {
        ticketId: snapshot.ticketId,
        event: SNAPSHOT_EVENT,
        data: JSON.stringify(sealedSnapshot),
        hash,
        prevHash,
      },
    });
  }

  private async findReusedWalletTicket(addresses: string[], excludeTicketId: string): Promise<string | null> {
    const hashedAddresses = addresses.map((address) => this.hashAddress(address));
    const matches = await this.deps.prisma.rewardTargetReservation.findMany({
      where: {
        address: {
          in: [...addresses, ...hashedAddresses],
        },
        NOT: {
          ticketId: excludeTicketId,
        },
      },
      orderBy: {
        createdAt: "asc",
      },
      take: 1,
    });

    return matches[0]?.ticketId || null;
  }

  async save(snapshot: RewardTargetSnapshot): Promise<void> {
    await this.assertFreshWallets(snapshot);
    const reusedTicketId = await this.findReusedWalletTicket(
      [snapshot.buyerRewardWallet, snapshot.sellerRewardWallet],
      snapshot.ticketId
    );
    if (reusedTicketId) {
      throw new Error(`reward_target_wallet_reused:${reusedTicketId}`);
    }
    const existing = await this.getLatestByTicket(snapshot.ticketId);
    if (existing) {
      if (this.isSameSnapshot(existing, snapshot)) {
        return;
      }
      throw new Error("reward_target_snapshot_ticket_conflict");
    }

    try {
      await this.deps.prisma.$transaction(async (tx) => {
        await tx.rewardTargetReservation.create({
          data: {
            address: this.hashAddress(snapshot.buyerRewardWallet),
            ticketId: snapshot.ticketId,
            participantRole: "buyer",
          },
        });
        await tx.rewardTargetReservation.create({
          data: {
            address: this.hashAddress(snapshot.sellerRewardWallet),
            ticketId: snapshot.ticketId,
            participantRole: "seller",
          },
        });
        await tx.rewardTargetSnapshotRecord.create({
          data: {
            ticketId: snapshot.ticketId,
            buyerWallet: this.hashRecordField("buyerWallet", snapshot.buyerWallet),
            sellerWallet: this.hashRecordField("sellerWallet", snapshot.sellerWallet),
            buyerRewardWallet: this.hashRecordField(
              "buyerRewardWallet",
              snapshot.buyerRewardWallet
            ),
            sellerRewardWallet: this.hashRecordField(
              "sellerRewardWallet",
              snapshot.sellerRewardWallet
            ),
            source: snapshot.source,
            recordedAt: new Date(snapshot.recordedAt),
            notes: {
              sealedRewardTargetSnapshot: sealPrivateMetadata({
                kind: SNAPSHOT_EVENT,
                ticketId: snapshot.ticketId,
                payload: snapshot,
                metadata: {
                  source: snapshot.source,
                  recordedAt: snapshot.recordedAt,
                },
              }),
            },
          },
        });
        await this.appendSnapshotAuditLogTx(tx, snapshot);
      });
    } catch (error: any) {
      if (error?.code === "P2002") {
        const reusedTicketIdAfterConflict = await this.findReusedWalletTicket(
          [snapshot.buyerRewardWallet, snapshot.sellerRewardWallet],
          snapshot.ticketId
        );
        if (reusedTicketIdAfterConflict) {
          throw new Error(`reward_target_wallet_reused:${reusedTicketIdAfterConflict}`);
        }
        const existingAfterConflict = await this.getLatestByTicket(snapshot.ticketId);
        if (existingAfterConflict) {
          if (this.isSameSnapshot(existingAfterConflict, snapshot)) {
            return;
          }
          throw new Error("reward_target_snapshot_ticket_conflict");
        }
      }
      throw error;
    }
  }

  async getLatestByTicket(ticketId: string): Promise<RewardTargetSnapshot | null> {
    const stored = await this.deps.prisma.rewardTargetSnapshotRecord.findUnique({
      where: { ticketId },
    });
    if (stored) {
      return this.normalizeStoredSnapshot(stored);
    }

    const logs = await this.deps.prisma.auditLog.findMany({
      where: {
        ticketId,
        event: SNAPSHOT_EVENT,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    });

    for (const log of logs) {
      const parsed = parseSnapshot(log.data);
      if (parsed) {
        return parsed;
      }
    }

    return null;
  }
}

export const rewardTargetStore = new RewardTargetStore();
