CREATE TABLE IF NOT EXISTS "AgentNotificationChannel" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "events" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "lastSentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentNotificationChannel_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AgentNotificationChannel_wallet_enabled_idx"
    ON "AgentNotificationChannel"("wallet", "enabled");

CREATE INDEX IF NOT EXISTS "AgentNotificationChannel_wallet_type_idx"
    ON "AgentNotificationChannel"("wallet", "type");
