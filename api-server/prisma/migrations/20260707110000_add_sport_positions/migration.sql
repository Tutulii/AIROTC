ALTER TABLE "ArenaMatch" ADD COLUMN IF NOT EXISTS "makerPositionId" TEXT;
ALTER TABLE "ArenaMatch" ADD COLUMN IF NOT EXISTS "takerPositionId" TEXT;
ALTER TABLE "ArenaMatch" ADD COLUMN IF NOT EXISTS "makerSide" TEXT;
ALTER TABLE "ArenaMatch" ADD COLUMN IF NOT EXISTS "stakeLamports" TEXT;

CREATE TABLE IF NOT EXISTS "SportPosition" (
    "id" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "selection" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "stakeLamports" TEXT NOT NULL,
    "agentWallet" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "matchedPositionId" TEXT,
    "matchId" TEXT,
    "offerId" TEXT,
    "ticketId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "clientOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SportPosition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SportPosition_agentWallet_clientOrderId_key" ON "SportPosition"("agentWallet", "clientOrderId");
CREATE INDEX IF NOT EXISTS "SportPosition_fixtureId_status_stakeLamports_createdAt_idx" ON "SportPosition"("fixtureId", "status", "stakeLamports", "createdAt");
CREATE INDEX IF NOT EXISTS "SportPosition_agentWallet_status_createdAt_idx" ON "SportPosition"("agentWallet", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "SportPosition_expiresAt_status_idx" ON "SportPosition"("expiresAt", "status");
CREATE INDEX IF NOT EXISTS "SportPosition_matchId_idx" ON "SportPosition"("matchId");
CREATE INDEX IF NOT EXISTS "SportPosition_offerId_idx" ON "SportPosition"("offerId");
CREATE INDEX IF NOT EXISTS "SportPosition_ticketId_idx" ON "SportPosition"("ticketId");
CREATE INDEX IF NOT EXISTS "ArenaMatch_makerPositionId_idx" ON "ArenaMatch"("makerPositionId");
CREATE INDEX IF NOT EXISTS "ArenaMatch_takerPositionId_idx" ON "ArenaMatch"("takerPositionId");
