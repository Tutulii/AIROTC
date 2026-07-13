ALTER TABLE "ArenaMatch" ADD COLUMN IF NOT EXISTS "makerVaultPda" TEXT;
ALTER TABLE "ArenaMatch" ADD COLUMN IF NOT EXISTS "takerVaultPda" TEXT;
ALTER TABLE "ArenaMatch" ADD COLUMN IF NOT EXISTS "matchCommitTx" TEXT;

ALTER TABLE "SportPosition" ALTER COLUMN "status" SET DEFAULT 'funding_required';
ALTER TABLE "SportPosition" ADD COLUMN IF NOT EXISTS "vaultPda" TEXT;
ALTER TABLE "SportPosition" ADD COLUMN IF NOT EXISTS "fundingTx" TEXT;
ALTER TABLE "SportPosition" ADD COLUMN IF NOT EXISTS "fundedLamports" TEXT;
ALTER TABLE "SportPosition" ADD COLUMN IF NOT EXISTS "fundedAt" TIMESTAMP(3);
ALTER TABLE "SportPosition" ADD COLUMN IF NOT EXISTS "fundingExpiresAt" TIMESTAMP(3);
ALTER TABLE "SportPosition" ADD COLUMN IF NOT EXISTS "cancelTx" TEXT;
ALTER TABLE "SportPosition" ADD COLUMN IF NOT EXISTS "matchedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "SportPosition_vaultPda_idx" ON "SportPosition"("vaultPda");
CREATE INDEX IF NOT EXISTS "SportPosition_fundedAt_idx" ON "SportPosition"("fundedAt");

CREATE TABLE IF NOT EXISTS "SportPositionFundingEvent" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "txSignature" TEXT,
    "lamports" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SportPositionFundingEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SportPositionFundingEvent_positionId_createdAt_idx" ON "SportPositionFundingEvent"("positionId", "createdAt");
CREATE INDEX IF NOT EXISTS "SportPositionFundingEvent_wallet_createdAt_idx" ON "SportPositionFundingEvent"("wallet", "createdAt");
CREATE INDEX IF NOT EXISTS "SportPositionFundingEvent_event_createdAt_idx" ON "SportPositionFundingEvent"("event", "createdAt");
