CREATE TABLE IF NOT EXISTS "AgentEvent" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "ticketId" TEXT,
    "dealId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AgentEvent_wallet_ackedAt_createdAt_idx" ON "AgentEvent"("wallet", "ackedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentEvent_wallet_event_createdAt_idx" ON "AgentEvent"("wallet", "event", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentEvent_expiresAt_idx" ON "AgentEvent"("expiresAt");
