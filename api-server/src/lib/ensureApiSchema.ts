import type { PrismaClient } from '@prisma/client';
import { logger as defaultLogger } from './logger';

type LoggerLike = Pick<typeof defaultLogger, 'info' | 'error'>;

const DDL_STATEMENTS = [
    `ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "creatorSettlementWallet" TEXT;`,
    `ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "creatorRewardWallet" TEXT;`,
    `ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "creatorFundingWallet" TEXT;`,
    `ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "rollupMode" TEXT;`,
    `UPDATE "Offer" SET "rollupMode" = 'ER' WHERE "rollupMode" IS NULL;`,
    `ALTER TABLE "Offer" ALTER COLUMN "rollupMode" SET DEFAULT 'ER';`,
    `ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "rollupMode" TEXT;`,
    `UPDATE "Ticket" SET "rollupMode" = 'ER' WHERE "rollupMode" IS NULL;`,
    `ALTER TABLE "Ticket" ALTER COLUMN "rollupMode" SET DEFAULT 'ER';`,
    `ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "webhookEvents" TEXT;`,
    `CREATE TABLE IF NOT EXISTS "AgentEvent" (
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
    );`,
    `CREATE INDEX IF NOT EXISTS "AgentEvent_wallet_ackedAt_createdAt_idx" ON "AgentEvent"("wallet", "ackedAt", "createdAt");`,
    `CREATE INDEX IF NOT EXISTS "AgentEvent_wallet_event_createdAt_idx" ON "AgentEvent"("wallet", "event", "createdAt");`,
    `CREATE INDEX IF NOT EXISTS "AgentEvent_expiresAt_idx" ON "AgentEvent"("expiresAt");`,
    `CREATE TABLE IF NOT EXISTS "AgentNotificationChannel" (
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
    );`,
    `CREATE INDEX IF NOT EXISTS "AgentNotificationChannel_wallet_enabled_idx" ON "AgentNotificationChannel"("wallet", "enabled");`,
    `CREATE INDEX IF NOT EXISTS "AgentNotificationChannel_wallet_type_idx" ON "AgentNotificationChannel"("wallet", "type");`,
];

export async function ensureApiSchema(
    prisma: PrismaClient,
    logger: LoggerLike = defaultLogger
): Promise<void> {
    try {
        for (const statement of DDL_STATEMENTS) {
            await prisma.$executeRawUnsafe(statement);
        }

        logger.info('api_schema_ready', {
            tables: ['Offer', 'Ticket', 'Agent', 'AgentEvent', 'AgentNotificationChannel'],
            columns: [
                'Offer.creatorSettlementWallet',
                'Offer.creatorRewardWallet',
                'Offer.creatorFundingWallet',
                'Offer.rollupMode',
                'Ticket.rollupMode',
                'Agent.webhookEvents',
                'AgentEvent.wallet',
                'AgentEvent.event',
                'AgentEvent.payload',
                'AgentEvent.ackedAt',
                'AgentNotificationChannel.wallet',
                'AgentNotificationChannel.type',
                'AgentNotificationChannel.config',
            ],
            mode: 'startup_self_heal',
        });
    } catch (error) {
        logger.error('api_schema_bootstrap_failed', {}, error);
        throw error;
    }
}
