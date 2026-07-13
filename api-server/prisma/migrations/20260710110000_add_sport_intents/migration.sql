CREATE TABLE IF NOT EXISTS "SportIntent" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "marketType" TEXT NOT NULL DEFAULT '1X2_PARTICIPANT_RESULT',
    "selection" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "stakeLamports" TEXT,
    "minStakeLamports" TEXT,
    "maxStakeLamports" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "note" TEXT,
    "clientIntentId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SportIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SportIntent_wallet_clientIntentId_key" ON "SportIntent"("wallet", "clientIntentId");
CREATE INDEX IF NOT EXISTS "SportIntent_fixtureId_selection_side_status_createdAt_idx" ON "SportIntent"("fixtureId", "selection", "side", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "SportIntent_wallet_status_createdAt_idx" ON "SportIntent"("wallet", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "SportIntent_expiresAt_status_idx" ON "SportIntent"("expiresAt", "status");
