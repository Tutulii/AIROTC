import type { PrismaClient } from "@prisma/client";
import { logger as defaultLogger } from "../utils/logger";

type LoggerLike = Pick<typeof defaultLogger, "info" | "error">;

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "TorqueEventDelivery" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "participantRole" TEXT NOT NULL,
    "userPubkey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TorqueEventDelivery_pkey" PRIMARY KEY ("id")
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TorqueEventDelivery_idempotencyKey_key"
    ON "TorqueEventDelivery"("idempotencyKey");`,
  `CREATE INDEX IF NOT EXISTS "TorqueEventDelivery_status_nextAttemptAt_idx"
    ON "TorqueEventDelivery"("status", "nextAttemptAt");`,
  `CREATE INDEX IF NOT EXISTS "TorqueEventDelivery_ticketId_createdAt_idx"
    ON "TorqueEventDelivery"("ticketId", "createdAt");`,
  `CREATE TABLE IF NOT EXISTS "RewardTargetSnapshotRecord" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "buyerWallet" TEXT NOT NULL,
    "sellerWallet" TEXT NOT NULL,
    "buyerRewardWallet" TEXT NOT NULL,
    "sellerRewardWallet" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "notes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RewardTargetSnapshotRecord_pkey" PRIMARY KEY ("id")
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "RewardTargetSnapshotRecord_ticketId_key"
    ON "RewardTargetSnapshotRecord"("ticketId");`,
  `CREATE INDEX IF NOT EXISTS "RewardTargetSnapshotRecord_ticketId_createdAt_idx"
    ON "RewardTargetSnapshotRecord"("ticketId", "createdAt");`,
  `CREATE TABLE IF NOT EXISTS "RewardTargetReservation" (
    "address" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "participantRole" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RewardTargetReservation_pkey" PRIMARY KEY ("address")
  );`,
  `CREATE INDEX IF NOT EXISTS "RewardTargetReservation_ticketId_createdAt_idx"
    ON "RewardTargetReservation"("ticketId", "createdAt");`,
];

export async function ensureTorqueSchema(
  prisma: PrismaClient,
  logger: LoggerLike = defaultLogger
): Promise<void> {
  try {
    for (const statement of DDL_STATEMENTS) {
      await prisma.$executeRawUnsafe(statement);
    }
    logger.info("torque_schema_ready", {
      tables: [
        "TorqueEventDelivery",
        "RewardTargetSnapshotRecord",
        "RewardTargetReservation",
      ],
      mode: "startup_self_heal",
    });
  } catch (error) {
    logger.error("torque_schema_bootstrap_failed", {}, error);
    throw error;
  }
}
