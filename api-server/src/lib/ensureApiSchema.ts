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
            tables: ['Offer', 'Ticket', 'Agent'],
            columns: [
                'Offer.creatorSettlementWallet',
                'Offer.creatorRewardWallet',
                'Offer.creatorFundingWallet',
                'Offer.rollupMode',
                'Ticket.rollupMode',
                'Agent.webhookEvents',
            ],
            mode: 'startup_self_heal',
        });
    } catch (error) {
        logger.error('api_schema_bootstrap_failed', {}, error);
        throw error;
    }
}
