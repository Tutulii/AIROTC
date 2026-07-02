CREATE TABLE IF NOT EXISTS "ArenaStrategyOffer" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArenaStrategyOffer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ArenaStrategyOffer_dedupeKey_key" ON "ArenaStrategyOffer"("dedupeKey");
CREATE INDEX IF NOT EXISTS "ArenaStrategyOffer_signalId_idx" ON "ArenaStrategyOffer"("signalId");
CREATE INDEX IF NOT EXISTS "ArenaStrategyOffer_offerId_idx" ON "ArenaStrategyOffer"("offerId");
CREATE INDEX IF NOT EXISTS "ArenaStrategyOffer_wallet_createdAt_idx" ON "ArenaStrategyOffer"("wallet", "createdAt");
