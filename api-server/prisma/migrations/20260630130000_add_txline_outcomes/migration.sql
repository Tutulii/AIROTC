CREATE TABLE IF NOT EXISTS "ArenaOutcome" (
    "id" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "homeScore" INTEGER NOT NULL,
    "awayScore" INTEGER NOT NULL,
    "winner" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceUpdateId" TEXT,
    "sourceTimestamp" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArenaOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ArenaOutcome_fixtureId_key" ON "ArenaOutcome"("fixtureId");
CREATE INDEX IF NOT EXISTS "ArenaOutcome_winner_idx" ON "ArenaOutcome"("winner");
CREATE INDEX IF NOT EXISTS "ArenaOutcome_sourceTimestamp_idx" ON "ArenaOutcome"("sourceTimestamp");
