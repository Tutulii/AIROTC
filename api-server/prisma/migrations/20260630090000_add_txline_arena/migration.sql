CREATE TABLE IF NOT EXISTS "ArenaFixture" (
    "id" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "sport" TEXT NOT NULL DEFAULT 'football',
    "homeTeam" TEXT,
    "awayTeam" TEXT,
    "startsAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "raw" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArenaFixture_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ArenaFixture_fixtureId_key" ON "ArenaFixture"("fixtureId");
CREATE INDEX IF NOT EXISTS "ArenaFixture_status_startsAt_idx" ON "ArenaFixture"("status", "startsAt");

CREATE TABLE IF NOT EXISTS "ArenaOddsUpdate" (
    "id" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "selection" TEXT NOT NULL,
    "odds" DOUBLE PRECISION NOT NULL,
    "impliedProbability" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "sourceUpdateId" TEXT,
    "sourceTimestamp" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArenaOddsUpdate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ArenaOddsUpdate_fixtureId_market_selection_sourceTimestamp_idx" ON "ArenaOddsUpdate"("fixtureId", "market", "selection", "sourceTimestamp");
CREATE INDEX IF NOT EXISTS "ArenaOddsUpdate_sourceUpdateId_idx" ON "ArenaOddsUpdate"("sourceUpdateId");

CREATE TABLE IF NOT EXISTS "ArenaScoreUpdate" (
    "id" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "source" TEXT NOT NULL,
    "sourceUpdateId" TEXT,
    "sourceTimestamp" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArenaScoreUpdate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ArenaScoreUpdate_fixtureId_sourceTimestamp_idx" ON "ArenaScoreUpdate"("fixtureId", "sourceTimestamp");
CREATE INDEX IF NOT EXISTS "ArenaScoreUpdate_sourceUpdateId_idx" ON "ArenaScoreUpdate"("sourceUpdateId");

CREATE TABLE IF NOT EXISTS "ArenaTimelineEvent" (
    "id" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "homeTeam" TEXT,
    "awayTeam" TEXT,
    "marketType" TEXT,
    "selection" TEXT,
    "oddsValue" DOUBLE PRECISION,
    "scoreState" JSONB,
    "txlineTimestamp" TIMESTAMP(3) NOT NULL,
    "sourceEndpoint" TEXT NOT NULL,
    "sourceUpdateId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArenaTimelineEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ArenaTimelineEvent_dedupeKey_key" ON "ArenaTimelineEvent"("dedupeKey");
CREATE INDEX IF NOT EXISTS "ArenaTimelineEvent_fixtureId_txlineTimestamp_eventType_idx" ON "ArenaTimelineEvent"("fixtureId", "txlineTimestamp", "eventType");
CREATE INDEX IF NOT EXISTS "ArenaTimelineEvent_sourceEndpoint_txlineTimestamp_idx" ON "ArenaTimelineEvent"("sourceEndpoint", "txlineTimestamp");
