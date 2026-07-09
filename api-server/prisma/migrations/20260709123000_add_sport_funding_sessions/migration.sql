CREATE TABLE IF NOT EXISTS "SportFundingSession" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "encryptedSecretKey" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SportFundingSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SportFundingSession_wallet_key"
    ON "SportFundingSession"("wallet");

CREATE INDEX IF NOT EXISTS "SportFundingSession_wallet_expiresAt_idx"
    ON "SportFundingSession"("wallet", "expiresAt");

CREATE INDEX IF NOT EXISTS "SportFundingSession_expiresAt_idx"
    ON "SportFundingSession"("expiresAt");
