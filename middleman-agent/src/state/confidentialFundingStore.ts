import { prisma } from "../lib/prisma";
import { appendAuditLog } from "../services/auditTrail";
import type {
  ConfidentialFundingPartyRole,
  ConfidentialFundingStateSnapshot,
  FundingPrivacyTier,
} from "../protocol/confidentialFundingProtocol";
import type { ConfidentialFundingRole } from "../protocol/privateHandoffProtocol";
import {
  isSealedPrivateMetadataEnvelope,
  revealPrivateMetadata,
  sealPrivateMetadata,
} from "../services/privateMetadataSeal";

const SNAPSHOT_EVENT = "confidential_funding_state_snapshot";

function parseSnapshot(raw: string): ConfidentialFundingStateSnapshot | null {
  try {
    const parsed = JSON.parse(raw);
    if (isSealedPrivateMetadataEnvelope(parsed, SNAPSHOT_EVENT)) {
      return revealPrivateMetadata<ConfidentialFundingStateSnapshot>(parsed);
    }
    return parsed as ConfidentialFundingStateSnapshot;
  } catch {
    return null;
  }
}

export class ConfidentialFundingStore {
  private updateQueues = new Map<string, Promise<void>>();

  private async runSerialized<T>(ticketId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.updateQueues.get(ticketId) || Promise.resolve();
    let releaseCurrent!: () => void;
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const nextQueue = previous.catch(() => undefined).then(() => currentGate);
    this.updateQueues.set(ticketId, nextQueue);

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (this.updateQueues.get(ticketId) === nextQueue) {
        this.updateQueues.delete(ticketId);
      }
    }
  }

  async save(snapshot: ConfidentialFundingStateSnapshot): Promise<void> {
    await appendAuditLog(
      snapshot.ticketId,
      SNAPSHOT_EVENT,
      sealPrivateMetadata({
        kind: SNAPSHOT_EVENT,
        ticketId: snapshot.ticketId,
        payload: snapshot,
        metadata: {
          requestIssuedAt: snapshot.requestIssuedAt,
          updatedAt: snapshot.updatedAt,
        },
      })
    );
  }

  async getLatestByTicket(ticketId: string): Promise<ConfidentialFundingStateSnapshot | null> {
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

  async createInitial(snapshot: ConfidentialFundingStateSnapshot): Promise<void> {
    await this.save(snapshot);
  }

  async update(
    ticketId: string,
    mutator: (current: ConfidentialFundingStateSnapshot) => ConfidentialFundingStateSnapshot
  ): Promise<ConfidentialFundingStateSnapshot | null> {
    return this.runSerialized(ticketId, async () => {
      const current = await this.getLatestByTicket(ticketId);
      if (!current) {
        return null;
      }

      const next = mutator(current);
      await this.save(next);
      return next;
    });
  }

  async recordFunding(
    ticketId: string,
    role: ConfidentialFundingPartyRole,
    update: {
      agentId: string;
      wallet: string;
      fundingRail?: FundingPrivacyTier;
      transactionSignatures: string[];
      observedFundingRoleAmounts?: Partial<Record<ConfidentialFundingRole, string>>;
      recordedAt: string;
      active: boolean;
    }
  ): Promise<ConfidentialFundingStateSnapshot | null> {
    return this.update(ticketId, (current) => {
      const buyerFunding = role === "buyer" ? update : current.buyerFunding;
      const sellerFunding = role === "seller" ? update : current.sellerFunding;
      return {
        ...current,
        buyerFunding,
        sellerFunding,
        fundingAmounts: {
          ...current.fundingAmounts,
          buyerPaymentLamports:
            update.observedFundingRoleAmounts?.buyer_payment ||
            current.fundingAmounts?.buyerPaymentLamports,
          buyerCollateralLamports:
            update.observedFundingRoleAmounts?.buyer_collateral ||
            current.fundingAmounts?.buyerCollateralLamports,
          sellerCollateralLamports:
            update.observedFundingRoleAmounts?.seller_collateral ||
            current.fundingAmounts?.sellerCollateralLamports,
        },
        allFundingRecorded: !!buyerFunding?.active && !!sellerFunding?.active,
        txSignatures: [
          ...current.txSignatures,
          ...update.transactionSignatures,
        ].filter((value, index, source) => source.indexOf(value) === index),
        updatedAt: new Date().toISOString(),
      };
    });
  }
}

export const confidentialFundingStore = new ConfidentialFundingStore();
