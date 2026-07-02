CREATE TABLE IF NOT EXISTS "ArenaMatch" (
    "id" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "signalId" TEXT,
    "strategy" TEXT,
    "marketType" TEXT,
    "selection" TEXT,
    "direction" TEXT,
    "signalConfidence" DOUBLE PRECISION,
    "makerWallet" TEXT NOT NULL,
    "takerWallet" TEXT,
    "buyerWallet" TEXT,
    "sellerWallet" TEXT,
    "offerId" TEXT,
    "ticketId" TEXT,
    "escrowPda" TEXT,
    "rollupMode" TEXT NOT NULL DEFAULT 'NONE',
    "status" TEXT NOT NULL DEFAULT 'created',
    "buyerDepositLamports" TEXT,
    "sellerDepositLamports" TEXT,
    "buyerDepositTx" TEXT,
    "sellerDepositTx" TEXT,
    "buyerDepositedAt" TIMESTAMP(3),
    "sellerDepositedAt" TIMESTAMP(3),
    "outcomeId" TEXT,
    "outcomeWinner" TEXT,
    "winnerWallet" TEXT,
    "settlementAction" TEXT,
    "settlementStatus" TEXT,
    "releaseTx" TEXT,
    "refundTx" TEXT,
    "settledAt" TIMESTAMP(3),
    "proof" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArenaMatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ArenaMatch_fixtureId_status_idx" ON "ArenaMatch"("fixtureId", "status");
CREATE INDEX IF NOT EXISTS "ArenaMatch_signalId_idx" ON "ArenaMatch"("signalId");
CREATE INDEX IF NOT EXISTS "ArenaMatch_offerId_idx" ON "ArenaMatch"("offerId");
CREATE INDEX IF NOT EXISTS "ArenaMatch_ticketId_idx" ON "ArenaMatch"("ticketId");
CREATE INDEX IF NOT EXISTS "ArenaMatch_makerWallet_createdAt_idx" ON "ArenaMatch"("makerWallet", "createdAt");
CREATE INDEX IF NOT EXISTS "ArenaMatch_takerWallet_createdAt_idx" ON "ArenaMatch"("takerWallet", "createdAt");
CREATE INDEX IF NOT EXISTS "ArenaMatch_escrowPda_idx" ON "ArenaMatch"("escrowPda");
