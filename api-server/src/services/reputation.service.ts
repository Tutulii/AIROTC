import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { calculateReputation } from '../utils/reputation';
import { webhookReputationUpdate } from './webhook.service';

export const handleDealSuccess = async (dealId: string, buyerWallet: string, sellerWallet: string, amountStr: string, settlementTimeSeconds: number) => {
    try {
        await prisma.$transaction(async (tx) => {
            // 1. Idempotency Lock logically shielding inflations
            const existing = await tx.dealReputationProcessing.findUnique({ where: { dealId } });
            if (existing) return;

            // Mark gracefully before performing computations
            await tx.dealReputationProcessing.create({ data: { dealId, processed: true } });

            // 2. Resolve Agents locally
            let buyer = await tx.agent.findUnique({ where: { wallet: buyerWallet } });
            let seller = await tx.agent.findUnique({ where: { wallet: sellerWallet } });

            if (!buyer || !seller) return; // Agents must securely exist

            // 3. Compute Metrics gracefully avoiding float lambda exceptions via BigInt bounds
            const amountBN = BigInt(amountStr || "0");

            const updateAgent = async (agent: any) => {
                const oldAvg = agent.avgSettlementTime;
                const n = agent.totalDeals + 1;
                const newAvg = n === 1 ? settlementTimeSeconds : ((oldAvg * (n - 1)) + settlementTimeSeconds) / n;

                const newVolume = (BigInt(agent.totalVolume || "0") + amountBN).toString();

                const updatedStats = {
                    totalDeals: agent.totalDeals + 1,
                    successfulDeals: agent.successfulDeals + 1,
                    cancelledDeals: agent.cancelledDeals,
                    disputedDeals: agent.disputedDeals,
                    totalVolume: newVolume,
                    avgSettlementTime: newAvg
                };

                const newReputation = calculateReputation(updatedStats);

                // Demo tracing bounds directly injected
                logger.info("info", { detail: `[REPUTATION UPDATE]` });
                logger.info("info", { detail: `Deal: ${dealId}` });
                logger.info("info", { detail: `Wallet ${agent.wallet} Score → ${agent.reputationScore} → ${newReputation}` });

                await tx.agent.update({
                    where: { id: agent.id },
                    data: {
                        ...updatedStats,
                        reputationScore: newReputation
                    }
                });

                // Webhook push (fire-and-forget)
                webhookReputationUpdate({
                    wallet: agent.wallet,
                    oldScore: agent.reputationScore,
                    newScore: newReputation,
                    dealId,
                    outcome: 'success',
                });
            };

            await updateAgent(buyer);
            await updateAgent(seller);
        });
    } catch (error) {
        logger.error("error", { detail: error });
    }
};

export const handleDealCancel = async (dealId: string, buyerWallet: string, sellerWallet: string) => {
    try {
        await prisma.$transaction(async (tx) => {
            const existing = await tx.dealReputationProcessing.findUnique({ where: { dealId } });
            if (existing) return;

            await tx.dealReputationProcessing.create({ data: { dealId, processed: true } });

            let buyer = await tx.agent.findUnique({ where: { wallet: buyerWallet } });
            let seller = await tx.agent.findUnique({ where: { wallet: sellerWallet } });

            if (!buyer || !seller) return;

            const updateAgent = async (agent: any) => {
                const updatedStats = {
                    totalDeals: agent.totalDeals + 1,
                    successfulDeals: agent.successfulDeals,
                    cancelledDeals: agent.cancelledDeals + 1,
                    disputedDeals: agent.disputedDeals,
                    totalVolume: agent.totalVolume,
                    avgSettlementTime: agent.avgSettlementTime
                };

                const newReputation = calculateReputation(updatedStats);

                logger.info("info", { detail: `[REPUTATION UPDATE] (CANCEL)` });
                logger.info("info", { detail: `Deal: ${dealId}` });
                logger.info("info", { detail: `Wallet ${agent.wallet} Score → ${agent.reputationScore} → ${newReputation}` });

                await tx.agent.update({
                    where: { id: agent.id },
                    data: {
                        ...updatedStats,
                        reputationScore: newReputation
                    }
                });

                // Webhook push (fire-and-forget)
                webhookReputationUpdate({
                    wallet: agent.wallet,
                    oldScore: agent.reputationScore,
                    newScore: newReputation,
                    dealId,
                    outcome: 'cancelled',
                });
            };

            await updateAgent(buyer);
            await updateAgent(seller);
        });
    } catch (error) {
        logger.error("error", { detail: error });
    }
};
