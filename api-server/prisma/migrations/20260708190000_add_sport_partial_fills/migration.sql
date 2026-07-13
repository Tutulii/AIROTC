ALTER TABLE "SportPosition" ADD COLUMN IF NOT EXISTS "filledLamports" TEXT;
ALTER TABLE "SportPosition" ADD COLUMN IF NOT EXISTS "remainingLamports" TEXT;
ALTER TABLE "SportPosition" ADD COLUMN IF NOT EXISTS "refundedLamports" TEXT;
ALTER TABLE "SportPosition" ADD COLUMN IF NOT EXISTS "vaultVersion" TEXT;

UPDATE "SportPosition"
SET
    "filledLamports" = COALESCE(NULLIF("filledLamports", ''), '0'),
    "remainingLamports" = CASE
        WHEN "status" IN ('funded_open', 'matching') THEN COALESCE(NULLIF("remainingLamports", ''), "stakeLamports")
        WHEN "status" = 'matched' THEN COALESCE(NULLIF("remainingLamports", ''), '0')
        ELSE COALESCE(NULLIF("remainingLamports", ''), '0')
    END,
    "refundedLamports" = COALESCE(NULLIF("refundedLamports", ''), '0'),
    "vaultVersion" = CASE
        WHEN COALESCE(NULLIF("vaultVersion", ''), '') = '' THEN 'v1'
        ELSE "vaultVersion"
    END;

ALTER TABLE "SportPosition" ALTER COLUMN "filledLamports" SET DEFAULT '0';
ALTER TABLE "SportPosition" ALTER COLUMN "filledLamports" SET NOT NULL;
ALTER TABLE "SportPosition" ALTER COLUMN "remainingLamports" SET DEFAULT '0';
ALTER TABLE "SportPosition" ALTER COLUMN "remainingLamports" SET NOT NULL;
ALTER TABLE "SportPosition" ALTER COLUMN "refundedLamports" SET DEFAULT '0';
ALTER TABLE "SportPosition" ALTER COLUMN "refundedLamports" SET NOT NULL;
ALTER TABLE "SportPosition" ALTER COLUMN "vaultVersion" SET DEFAULT 'v2';
ALTER TABLE "SportPosition" ALTER COLUMN "vaultVersion" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "SportPositionFill" (
    "id" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "selection" TEXT NOT NULL,
    "backPositionId" TEXT NOT NULL,
    "layPositionId" TEXT NOT NULL,
    "backWallet" TEXT NOT NULL,
    "layWallet" TEXT NOT NULL,
    "fillLamports" TEXT NOT NULL,
    "ticketId" TEXT,
    "escrowPda" TEXT,
    "commitTx" TEXT,
    "status" TEXT NOT NULL DEFAULT 'committing',
    "winnerWallet" TEXT,
    "releaseTx" TEXT,
    "refundTx" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    CONSTRAINT "SportPositionFill_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SportPosition_fixtureId_selection_side_status_fundedAt_idx"
    ON "SportPosition"("fixtureId", "selection", "side", "status", "fundedAt");
CREATE INDEX IF NOT EXISTS "SportPosition_fixtureId_selection_side_status_remainingLamports_idx"
    ON "SportPosition"("fixtureId", "selection", "side", "status", "remainingLamports");
CREATE INDEX IF NOT EXISTS "SportPosition_vaultVersion_idx" ON "SportPosition"("vaultVersion");

CREATE INDEX IF NOT EXISTS "SportPositionFill_fixtureId_status_createdAt_idx"
    ON "SportPositionFill"("fixtureId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "SportPositionFill_backPositionId_createdAt_idx"
    ON "SportPositionFill"("backPositionId", "createdAt");
CREATE INDEX IF NOT EXISTS "SportPositionFill_layPositionId_createdAt_idx"
    ON "SportPositionFill"("layPositionId", "createdAt");
CREATE INDEX IF NOT EXISTS "SportPositionFill_ticketId_idx" ON "SportPositionFill"("ticketId");
CREATE INDEX IF NOT EXISTS "SportPositionFill_status_createdAt_idx" ON "SportPositionFill"("status", "createdAt");
