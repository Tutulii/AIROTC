import { prisma } from "../lib/prisma";
import { appendAuditLogStrict } from "../services/auditTrail";
import {
  isSealedPrivateMetadataEnvelope,
  revealPrivateMetadata,
  sealPrivateMetadata,
} from "../services/privateMetadataSeal";

const SNAPSHOT_EVENT = "settlement_target_snapshot";

export interface SettlementTargetSnapshot {
  ticketId: string;
  buyerWallet: string;
  sellerWallet: string;
  buyerSettlementWallet: string;
  sellerSettlementWallet: string;
  source: "api_bridge" | "local_demo" | "test_context";
  recordedAt: string;
  notes?: string[];
}

function parseSnapshot(raw: string): SettlementTargetSnapshot | null {
  try {
    const parsed = JSON.parse(raw);
    if (isSealedPrivateMetadataEnvelope(parsed, SNAPSHOT_EVENT)) {
      return revealPrivateMetadata<SettlementTargetSnapshot>(parsed);
    }
    return parsed as SettlementTargetSnapshot;
  } catch {
    return null;
  }
}

export class SettlementTargetStore {
  private async assertFreshWallets(snapshot: SettlementTargetSnapshot): Promise<void> {
    if (snapshot.buyerSettlementWallet === snapshot.sellerSettlementWallet) {
      throw new Error("settlement_target_wallet_collision_within_ticket");
    }

    const participantWallets = new Set([
      snapshot.buyerWallet,
      snapshot.sellerWallet,
    ]);
    if (
      participantWallets.has(snapshot.buyerSettlementWallet) ||
      participantWallets.has(snapshot.sellerSettlementWallet)
    ) {
      throw new Error("settlement_target_wallet_must_not_equal_participant_wallet");
    }

    const logs = await prisma.auditLog.findMany({
      where: {
        event: SNAPSHOT_EVENT,
        NOT: {
          ticketId: snapshot.ticketId,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 5000,
    });

    for (const log of logs) {
      const parsed = parseSnapshot(log.data);
      if (!parsed) {
        continue;
      }

      const usedWallets = new Set([
        parsed.buyerSettlementWallet,
        parsed.sellerSettlementWallet,
      ]);

      if (
        usedWallets.has(snapshot.buyerSettlementWallet) ||
        usedWallets.has(snapshot.sellerSettlementWallet)
      ) {
        throw new Error(`settlement_target_wallet_reused:${parsed.ticketId}`);
      }
    }
  }

  async save(snapshot: SettlementTargetSnapshot): Promise<void> {
    await this.assertFreshWallets(snapshot);
    await appendAuditLogStrict(
      snapshot.ticketId,
      SNAPSHOT_EVENT,
      sealPrivateMetadata({
        kind: SNAPSHOT_EVENT,
        ticketId: snapshot.ticketId,
        payload: snapshot,
        metadata: {
          source: snapshot.source,
          recordedAt: snapshot.recordedAt,
        },
      })
    );
  }

  async getLatestByTicket(ticketId: string): Promise<SettlementTargetSnapshot | null> {
    const logs = await prisma.auditLog.findMany({
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

export const settlementTargetStore = new SettlementTargetStore();
