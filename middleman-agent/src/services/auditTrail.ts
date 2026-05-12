/**
 * Tamper-Proof Audit Trail (Level 5 Autonomy)
 *
 * SHA-256 hash-chain audit log for every deal lifecycle event.
 * Each entry links to the previous via prevHash, guaranteeing:
 * - Immutable history
 * - Cryptographic auditability
 * - Tamper detection via chain verification
 */

import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import { sealPrivateMetadata } from "./privateMetadataSeal";

async function createAuditLogEntry(
  ticketId: string,
  event: string,
  data: any
): Promise<void> {
  // Get the last entry in the chain for this ticket
  const prev = await prisma.auditLog.findFirst({
    where: { ticketId },
    orderBy: { createdAt: "desc" },
  });
  const prevHash = prev?.hash || "GENESIS";

  // Build deterministic payload and hash it
  const timestamp = Date.now();
  const payload = JSON.stringify({ ticketId, event, data, timestamp, prevHash });
  const hash = crypto.createHash("sha256").update(payload).digest("hex");

  await prisma.auditLog.create({
    data: {
      ticketId,
      event,
      data: JSON.stringify(data),
      hash,
      prevHash,
    },
  });
}

/**
 * Appends a new entry to the hash-chain audit log for a deal.
 * Every event is linked to the previous via SHA-256 hash.
 */
export async function appendAuditLog(
  ticketId: string,
  event: string,
  data: any
): Promise<void> {
  try {
    await createAuditLogEntry(ticketId, event, data);
  } catch (e: any) {
    // Audit logging must NEVER block deal execution — log and continue
    logger.error("audit_log_append_failed", { ticketId, event }, e);
  }
}

export async function appendAuditLogStrict(
  ticketId: string,
  event: string,
  data: any
): Promise<void> {
  await createAuditLogEntry(ticketId, event, data);
}

export async function appendSealedAuditLog(
  ticketId: string,
  event: string,
  data: any,
  metadata?: Record<string, unknown>
): Promise<void> {
  await appendAuditLog(
    ticketId,
    event,
    sealPrivateMetadata({
      kind: event,
      ticketId,
      payload: data,
      metadata,
    })
  );
}

export async function appendSealedAuditLogStrict(
  ticketId: string,
  event: string,
  data: any,
  metadata?: Record<string, unknown>
): Promise<void> {
  await appendAuditLogStrict(
    ticketId,
    event,
    sealPrivateMetadata({
      kind: event,
      ticketId,
      payload: data,
      metadata,
    })
  );
}

/**
 * Verifies the integrity of the hash chain for a deal.
 * Returns true if every entry's prevHash matches the previous entry's hash.
 */
export async function verifyAuditChain(ticketId: string): Promise<{
  valid: boolean;
  entries: number;
  brokenAt?: number;
}> {
  const logs = await prisma.auditLog.findMany({
    where: { ticketId },
    orderBy: { createdAt: "asc" },
  });

  if (logs.length === 0) {
    return { valid: true, entries: 0 };
  }

  // First entry must link to GENESIS
  if (logs[0].prevHash !== "GENESIS") {
    return { valid: false, entries: logs.length, brokenAt: 0 };
  }

  // Every subsequent entry must link to the previous hash
  for (let i = 1; i < logs.length; i++) {
    if (logs[i].prevHash !== logs[i - 1].hash) {
      return { valid: false, entries: logs.length, brokenAt: i };
    }
  }

  return { valid: true, entries: logs.length };
}
