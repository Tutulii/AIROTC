ALTER TABLE "PrivateSettlement"
  ADD COLUMN IF NOT EXISTS "lifecycleMode" TEXT NOT NULL DEFAULT 'RECEIVER_WALLET_ONLY',
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "PrivateSettlementParticipant" (
  "id" TEXT NOT NULL,
  "settlementId" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "mint" TEXT NOT NULL,
  "sourceWallet" TEXT NOT NULL,
  "receiverWallet" TEXT NOT NULL,
  "finalWallet" TEXT,
  "phase" TEXT NOT NULL DEFAULT 'PENDING',
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "shieldAmountLamports" TEXT,
  "shieldTx" TEXT,
  "settlementAmountLamports" TEXT,
  "utxoTx" TEXT,
  "claimTx" TEXT,
  "unshieldAmountLamports" TEXT,
  "unshieldTx" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PrivateSettlementParticipant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PrivateSettlementParticipant_settlementId_role_key"
  ON "PrivateSettlementParticipant"("settlementId", "role");

CREATE INDEX IF NOT EXISTS "PrivateSettlementParticipant_dealId_idx"
  ON "PrivateSettlementParticipant"("dealId");

CREATE INDEX IF NOT EXISTS "PrivateSettlementParticipant_sourceWallet_idx"
  ON "PrivateSettlementParticipant"("sourceWallet");

CREATE INDEX IF NOT EXISTS "PrivateSettlementParticipant_receiverWallet_idx"
  ON "PrivateSettlementParticipant"("receiverWallet");

ALTER TABLE "PrivateSettlementParticipant"
  ADD CONSTRAINT "PrivateSettlementParticipant_settlementId_fkey"
  FOREIGN KEY ("settlementId") REFERENCES "PrivateSettlement"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
