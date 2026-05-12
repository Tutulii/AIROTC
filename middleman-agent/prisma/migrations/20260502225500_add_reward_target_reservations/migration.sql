-- CreateTable
CREATE TABLE "RewardTargetSnapshotRecord" (
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
);

-- CreateTable
CREATE TABLE "RewardTargetReservation" (
    "address" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "participantRole" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardTargetReservation_pkey" PRIMARY KEY ("address")
);

-- CreateIndex
CREATE UNIQUE INDEX "RewardTargetSnapshotRecord_ticketId_key" ON "RewardTargetSnapshotRecord"("ticketId");

-- CreateIndex
CREATE INDEX "RewardTargetSnapshotRecord_ticketId_createdAt_idx" ON "RewardTargetSnapshotRecord"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "RewardTargetReservation_ticketId_createdAt_idx" ON "RewardTargetReservation"("ticketId", "createdAt");
