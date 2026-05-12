-- CreateTable
CREATE TABLE "TorqueEventDelivery" (
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
);

-- CreateIndex
CREATE UNIQUE INDEX "TorqueEventDelivery_idempotencyKey_key" ON "TorqueEventDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TorqueEventDelivery_status_nextAttemptAt_idx" ON "TorqueEventDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "TorqueEventDelivery_ticketId_createdAt_idx" ON "TorqueEventDelivery"("ticketId", "createdAt");
