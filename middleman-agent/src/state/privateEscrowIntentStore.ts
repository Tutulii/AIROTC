import { prisma } from "../lib/prisma";
import { appendAuditLogStrict } from "../services/auditTrail";
import type { AttestedEscrowIntent } from "../types/dealPipeline";
import { sealPrivateExecutionTerms } from "../services/privateExecutionTerms";
import {
  isSealedPrivateMetadataEnvelope,
  revealPrivateMetadata,
  sealPrivateMetadata,
} from "../services/privateMetadataSeal";

const INTENT_EVENT = "per_attested_escrow_intent_snapshot";

function parseIntent(raw: string): AttestedEscrowIntent | null {
  try {
    const parsed = JSON.parse(raw);
    if (isSealedPrivateMetadataEnvelope(parsed, INTENT_EVENT)) {
      return revealPrivateMetadata<AttestedEscrowIntent>(parsed);
    }
    return parsed as AttestedEscrowIntent;
  } catch {
    return null;
  }
}

class PrivateEscrowIntentStore {
  private normalize(intent: AttestedEscrowIntent): AttestedEscrowIntent {
    if (!intent.executionTerms || intent.sealedExecutionTerms) {
      return intent;
    }

    return {
      ...intent,
      sealedExecutionTerms: sealPrivateExecutionTerms({
        ticketId: intent.ticketId,
        intentId: intent.intentId,
        sessionPda: intent.sessionPda,
        termsHash: intent.termsHash,
        executionTerms: intent.executionTerms,
      }),
      executionTerms: undefined,
    };
  }

  async save(intent: AttestedEscrowIntent): Promise<void> {
    const normalized = this.normalize(intent);
    await appendAuditLogStrict(
      normalized.ticketId,
      INTENT_EVENT,
      sealPrivateMetadata({
        kind: INTENT_EVENT,
        ticketId: normalized.ticketId,
        payload: normalized,
        metadata: {
          intentId: normalized.intentId,
          status: normalized.status,
          updatedAt: normalized.updatedAt,
        },
      })
    );
  }

  async getLatestByTicket(ticketId: string): Promise<AttestedEscrowIntent | null> {
    const logs = await prisma.auditLog.findMany({
      where: {
        ticketId,
        event: INTENT_EVENT,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 10,
    });

    for (const log of logs) {
      const parsed = parseIntent(log.data);
      if (parsed) {
        return parsed;
      }
    }

    return null;
  }

  async getByIntentId(
    ticketId: string,
    intentId: string
  ): Promise<AttestedEscrowIntent | null> {
    const logs = await prisma.auditLog.findMany({
      where: {
        ticketId,
        event: INTENT_EVENT,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 25,
    });

    for (const log of logs) {
      const parsed = parseIntent(log.data);
      if (parsed?.intentId === intentId) {
        return parsed;
      }
    }

    return null;
  }

  async updateStatus(
    ticketId: string,
    intentId: string,
    next: Pick<AttestedEscrowIntent, "status" | "dealPda"> & { updatedAt?: string }
  ): Promise<AttestedEscrowIntent | null> {
    const current = await this.getByIntentId(ticketId, intentId);
    if (!current) {
      return null;
    }

    const updated: AttestedEscrowIntent = {
      ...current,
      status: next.status,
      dealPda: next.dealPda ?? current.dealPda,
      updatedAt: next.updatedAt || new Date().toISOString(),
    };

    await this.save(updated);
    return updated;
  }
}

export const privateEscrowIntentStore = new PrivateEscrowIntentStore();
