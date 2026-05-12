import { prisma } from "../lib/prisma";
import { appendAuditLogStrict } from "../services/auditTrail";
import {
  isSealedPrivateMetadataEnvelope,
  revealPrivateMetadata,
  sealPrivateMetadata,
} from "../services/privateMetadataSeal";

const SNAPSHOT_EVENT = "confidential_identity_snapshot";

export interface ConfidentialIdentitySnapshot {
  ticketId: string;
  buyerWallet: string;
  sellerWallet: string;
  buyerFundingWallet: string;
  sellerFundingWallet: string;
  source: "api_bridge" | "local_demo" | "test_context";
  recordedAt: string;
  notes?: string[];
}

function parseSnapshot(raw: string): ConfidentialIdentitySnapshot | null {
  try {
    const parsed = JSON.parse(raw);
    if (isSealedPrivateMetadataEnvelope(parsed, SNAPSHOT_EVENT)) {
      return revealPrivateMetadata<ConfidentialIdentitySnapshot>(parsed);
    }
    return parsed as ConfidentialIdentitySnapshot;
  } catch {
    return null;
  }
}

export class ConfidentialIdentityStore {
  private async assertFreshFundingWallets(
    snapshot: ConfidentialIdentitySnapshot
  ): Promise<void> {
    if (snapshot.buyerFundingWallet === snapshot.sellerFundingWallet) {
      throw new Error("confidential_identity_wallet_collision_within_ticket");
    }

    const participantWallets = new Set([snapshot.buyerWallet, snapshot.sellerWallet]);
    if (
      participantWallets.has(snapshot.buyerFundingWallet) ||
      participantWallets.has(snapshot.sellerFundingWallet)
    ) {
      throw new Error("confidential_identity_wallet_must_not_equal_participant_wallet");
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
        parsed.buyerFundingWallet,
        parsed.sellerFundingWallet,
      ]);

      if (
        usedWallets.has(snapshot.buyerFundingWallet) ||
        usedWallets.has(snapshot.sellerFundingWallet)
      ) {
        throw new Error(`confidential_identity_wallet_reused:${parsed.ticketId}`);
      }
    }
  }

  async save(snapshot: ConfidentialIdentitySnapshot): Promise<void> {
    await this.assertFreshFundingWallets(snapshot);
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

  async getLatestByTicket(ticketId: string): Promise<ConfidentialIdentitySnapshot | null> {
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

export const confidentialIdentityStore = new ConfidentialIdentityStore();
