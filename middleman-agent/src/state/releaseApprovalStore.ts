import { prisma } from "../lib/prisma";
import { appendAuditLog } from "../services/auditTrail";
import type {
  ReleaseApprovalRecord,
  ReleaseApprovalRequestEnvelope,
  ReleaseApprovalRole,
  ReleaseApprovalStateSnapshot,
} from "../protocol/releaseApprovalProtocol";
import {
  isSealedPrivateMetadataEnvelope,
  revealPrivateMetadata,
  sealPrivateMetadata,
} from "../services/privateMetadataSeal";

const SNAPSHOT_EVENT = "release_approval_state_snapshot";

function parseSnapshot(raw: string): ReleaseApprovalStateSnapshot | null {
  try {
    const parsed = JSON.parse(raw);
    if (isSealedPrivateMetadataEnvelope(parsed, SNAPSHOT_EVENT)) {
      return revealPrivateMetadata<ReleaseApprovalStateSnapshot>(parsed);
    }
    return parsed as ReleaseApprovalStateSnapshot;
  } catch {
    return null;
  }
}

export class ReleaseApprovalStore {
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

  async save(snapshot: ReleaseApprovalStateSnapshot): Promise<void> {
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
          releaseAuthorized: snapshot.releaseAuthorized,
          releaseExecuted: snapshot.releaseExecuted,
        },
      })
    );
  }

  async getLatestByTicket(ticketId: string): Promise<ReleaseApprovalStateSnapshot | null> {
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

  async createInitial(snapshot: ReleaseApprovalStateSnapshot): Promise<void> {
    await this.save(snapshot);
  }

  async update(
    ticketId: string,
    mutator: (current: ReleaseApprovalStateSnapshot) => ReleaseApprovalStateSnapshot
  ): Promise<ReleaseApprovalStateSnapshot | null> {
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

  async recordApproval(
    ticketId: string,
    role: ReleaseApprovalRole,
    record: ReleaseApprovalRecord
  ): Promise<ReleaseApprovalStateSnapshot | null> {
    return this.update(ticketId, (current) => {
      const buyerApproval = role === "buyer" ? record : current.buyerApproval;
      const sellerApproval = role === "seller" ? record : current.sellerApproval;
      return {
        ...current,
        buyerApproval,
        sellerApproval,
        settlementPlanApproved: !!buyerApproval?.active && !!sellerApproval?.active,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async markReleaseSigned(
    ticketId: string,
    update: Pick<
      ReleaseApprovalStateSnapshot,
      "messageApprovalPda" | "approvalTxSignature" | "crossChainSignature" | "signatureScheme"
    >
  ): Promise<ReleaseApprovalStateSnapshot | null> {
    return this.update(ticketId, (current) => ({
      ...current,
      releaseAuthorized: true,
      releaseSigned: true,
      ...update,
      txSignatures: [
        ...current.txSignatures,
        update.approvalTxSignature,
      ].filter((value): value is string => !!value),
      updatedAt: new Date().toISOString(),
    }));
  }

  async markReleaseExecuted(
    ticketId: string,
    update: Pick<ReleaseApprovalStateSnapshot, "releaseTxSignature" | "winner">
  ): Promise<ReleaseApprovalStateSnapshot | null> {
    return this.update(ticketId, (current) => ({
      ...current,
      releaseExecuted: true,
      ...update,
      txSignatures: [
        ...current.txSignatures,
        update.releaseTxSignature,
      ].filter((value): value is string => !!value),
      updatedAt: new Date().toISOString(),
    }));
  }

  async markDispute(
    ticketId: string,
    role: ReleaseApprovalRole,
    record: ReleaseApprovalRecord
  ): Promise<ReleaseApprovalStateSnapshot | null> {
    return this.update(ticketId, (current) => ({
      ...current,
      disputeOpen: true,
      buyerApproval: role === "buyer" ? record : current.buyerApproval,
      sellerApproval: role === "seller" ? record : current.sellerApproval,
      buyerReleaseRequest: undefined,
      buyerReleaseConfirmation: undefined,
      settlementPlanApproved: false,
      buyerReleaseConfirmed: false,
      sellerDisputeWindowOpenedAt: undefined,
      sellerDisputeDeadlineAt: undefined,
      releaseAuthorized: false,
      updatedAt: new Date().toISOString(),
    }));
  }

  async markRevoked(
    ticketId: string,
    role: ReleaseApprovalRole,
    record: ReleaseApprovalRecord
  ): Promise<ReleaseApprovalStateSnapshot | null> {
    return this.update(ticketId, (current) => ({
      ...current,
      buyerApproval: role === "buyer" ? record : current.buyerApproval,
      sellerApproval: role === "seller" ? record : current.sellerApproval,
      buyerReleaseRequest: undefined,
      buyerReleaseConfirmation: undefined,
      settlementPlanApproved: false,
      buyerReleaseConfirmed: false,
      sellerDisputeWindowOpenedAt: undefined,
      sellerDisputeDeadlineAt: undefined,
      releaseAuthorized: false,
      updatedAt: new Date().toISOString(),
    }));
  }

  async markAuthorized(ticketId: string): Promise<ReleaseApprovalStateSnapshot | null> {
    return this.update(ticketId, (current) => ({
      ...current,
      releaseAuthorized: true,
      updatedAt: new Date().toISOString(),
    }));
  }

  async replaceRequests(
    ticketId: string,
    update: {
      buyerRequest: ReleaseApprovalRequestEnvelope;
      sellerRequest: ReleaseApprovalRequestEnvelope;
      requestIssuedAt: string;
    }
  ): Promise<ReleaseApprovalStateSnapshot | null> {
    return this.update(ticketId, (current) => ({
      ...current,
      ...update,
      updatedAt: new Date().toISOString(),
    }));
  }

  async attachBuyerReleaseRequest(
    ticketId: string,
    buyerReleaseRequest: ReleaseApprovalRequestEnvelope
  ): Promise<ReleaseApprovalStateSnapshot | null> {
    return this.update(ticketId, (current) => ({
      ...current,
      buyerReleaseRequest,
      settlementPlanApproved: !!current.buyerApproval?.active && !!current.sellerApproval?.active,
      updatedAt: new Date().toISOString(),
    }));
  }

  async markBuyerReleaseConfirmed(
    ticketId: string,
    record: ReleaseApprovalRecord,
    sellerDisputeWindowOpenedAt: string,
    sellerDisputeDeadlineAt: string
  ): Promise<ReleaseApprovalStateSnapshot | null> {
    return this.update(ticketId, (current) => ({
      ...current,
      buyerApproval: record,
      buyerReleaseConfirmation: record,
      settlementPlanApproved: !!record.active && !!current.sellerApproval?.active,
      buyerReleaseConfirmed: true,
      sellerDisputeWindowOpenedAt,
      sellerDisputeDeadlineAt,
      releaseAuthorized: false,
      updatedAt: new Date().toISOString(),
    }));
  }
}

export const releaseApprovalStore = new ReleaseApprovalStore();
