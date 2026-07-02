CREATE TABLE IF NOT EXISTS "ArenaStrategySignal" (
    "id" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "marketType" TEXT,
    "selection" TEXT,
    "direction" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "oddsBefore" DOUBLE PRECISION,
    "oddsAfter" DOUBLE PRECISION,
    "oddsChangePct" DOUBLE PRECISION,
    "impliedBefore" DOUBLE PRECISION,
    "impliedAfter" DOUBLE PRECISION,
    "impliedDelta" DOUBLE PRECISION,
    "scoreContext" JSONB,
    "tradeIntent" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "reason" TEXT NOT NULL,
    "sourceEventIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "signalTimestamp" TIMESTAMP(3) NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArenaStrategySignal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ArenaStrategySignal_dedupeKey_key" ON "ArenaStrategySignal"("dedupeKey");
CREATE INDEX IF NOT EXISTS "ArenaStrategySignal_fixtureId_strategy_signalTimestamp_idx" ON "ArenaStrategySignal"("fixtureId", "strategy", "signalTimestamp");
CREATE INDEX IF NOT EXISTS "ArenaStrategySignal_strategy_confidence_idx" ON "ArenaStrategySignal"("strategy", "confidence");
