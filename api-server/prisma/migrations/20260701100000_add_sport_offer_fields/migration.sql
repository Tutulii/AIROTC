ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "fixtureId" TEXT;
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "marketType" TEXT;
ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "selection" TEXT;

CREATE INDEX IF NOT EXISTS "Offer_fixtureId_rollupMode_idx" ON "Offer"("fixtureId", "rollupMode");
