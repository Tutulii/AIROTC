import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { requireInternalBridgeAuth } from '../middleware/internalBridgeAuth';
import { SUCCESSFUL_TICKET_STATUSES } from '../services/ticketStatusPolicy';
import { calculateVisibleReputation } from '../utils/reputation';

const router = Router();

const ALLOWED_TICKET_STATUSES = new Set([
    'negotiating',
    'agreed',
    'completed',
    'cancelled',
    'disputed',
]);

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function parseNonNegativeNumber(value: unknown, field: string): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid ${field}`);
    }
    return parsed;
}

function parseMode(value: unknown): 'buy' | 'sell' {
    if (value === 'buy' || value === 'sell') return value;
    throw new Error('Invalid mode');
}

function parseTicketStatus(value: unknown): string {
    if (!isNonEmptyString(value) || !ALLOWED_TICKET_STATUSES.has(value)) {
        throw new Error('Invalid status');
    }
    return value;
}

type ReputationOutcome = 'success' | 'cancelled' | 'disputed';

async function updateAgentReputationFromBridge(wallets: string[], outcome: ReputationOutcome): Promise<void> {
    const uniqueWallets = [...new Set(wallets.filter((wallet) => wallet !== 'pending'))];

    await Promise.all(uniqueWallets.map(async (wallet) => {
        const agent = await prisma.agent.findUnique({ where: { wallet } });
        if (!agent) return;

        const updatedStats = {
            totalDeals: agent.totalDeals + 1,
            successfulDeals: agent.successfulDeals + (outcome === 'success' ? 1 : 0),
            cancelledDeals: agent.cancelledDeals + (outcome === 'cancelled' ? 1 : 0),
            disputedDeals: agent.disputedDeals + (outcome === 'disputed' ? 1 : 0),
            totalVolume: agent.totalVolume,
            avgSettlementTime: agent.avgSettlementTime,
        };

        await prisma.agent.update({
            where: { id: agent.id },
            data: {
                ...updatedStats,
                reputationScore: calculateVisibleReputation(updatedStats),
            },
        });
    }));
}

router.use(requireInternalBridgeAuth);

router.get('/ticket/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        const ticket = await prisma.ticket.findUnique({
            where: { id },
            include: {
                offer: {
                    select: {
                        id: true,
                        asset: true,
                        price: true,
                        amount: true,
                        mode: true,
                        collateral: true,
                    },
                },
            },
        });

        if (!ticket) {
            res.status(404).json({ success: false, error: 'Ticket not found' });
            return;
        }

        res.status(200).json({ success: true, data: ticket });
    } catch (error: any) {
        logger.error('bridge_ticket_lookup_failed', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /v1/bridge/offer
 * Creates an offer in the Observatory DB. Signed internal-only route.
 */
router.post('/offer', async (req: Request, res: Response): Promise<void> => {
    try {
        const { creatorWallet, asset, price, amount, mode, collateral } = req.body ?? {};

        if (!isNonEmptyString(creatorWallet) || !isNonEmptyString(asset)) {
            res.status(400).json({ success: false, error: 'Missing required fields' });
            return;
        }

        const normalizedCreatorWallet = creatorWallet.trim();
        const normalizedAsset = asset.trim();
        const parsedPrice = parseNonNegativeNumber(price ?? 0, 'price');
        const parsedAmount = parseNonNegativeNumber(amount ?? 1, 'amount');
        const parsedCollateral = parseNonNegativeNumber(collateral ?? 0, 'collateral');
        const parsedMode = parseMode(mode ?? 'buy');

        const agent = await prisma.agent.upsert({
            where: { wallet: normalizedCreatorWallet },
            update: {},
            create: { wallet: normalizedCreatorWallet },
        });

        const offer = await prisma.offer.create({
            data: {
                creatorId: agent.id,
                asset: normalizedAsset,
                price: parsedPrice,
                amount: parsedAmount,
                mode: parsedMode,
                collateral: parsedCollateral,
                status: 'active',
            },
        });

        res.status(201).json({ success: true, data: offer });
    } catch (error: any) {
        if (error instanceof Error && error.message.startsWith('Invalid ')) {
            res.status(400).json({ success: false, error: error.message });
            return;
        }
        logger.error('bridge_offer_create_failed', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /v1/bridge/ticket
 * Creates a ticket linked to an offer. Signed internal-only route.
 */
router.post('/ticket', async (req: Request, res: Response): Promise<void> => {
    try {
        const { offerId, buyer, seller, status } = req.body ?? {};

        if (!isNonEmptyString(offerId) || !isNonEmptyString(buyer)) {
            res.status(400).json({ success: false, error: 'Missing required fields' });
            return;
        }

        const normalizedOfferId = offerId.trim();
        const normalizedBuyer = buyer.trim();
        const parsedSeller = isNonEmptyString(seller) ? seller.trim() : 'pending';
        const parsedStatus = parseTicketStatus(status ?? 'negotiating');

        await prisma.agent.upsert({
            where: { wallet: normalizedBuyer },
            update: {},
            create: { wallet: normalizedBuyer },
        });
        if (parsedSeller !== 'pending') {
            await prisma.agent.upsert({
                where: { wallet: parsedSeller },
                update: {},
                create: { wallet: parsedSeller },
            });
        }

        const existing = await prisma.ticket.findUnique({ where: { offerId: normalizedOfferId } });
        if (existing) {
            res.status(200).json({ success: true, data: existing, created: false });
            return;
        }

        const ticket = await prisma.ticket.create({
            data: {
                offerId: normalizedOfferId,
                buyer: normalizedBuyer,
                seller: parsedSeller,
                status: parsedStatus,
            },
        });

        res.status(201).json({ success: true, data: ticket });
    } catch (error: any) {
        if (error instanceof Error && error.message === 'Invalid status') {
            res.status(400).json({ success: false, error: error.message });
            return;
        }
        logger.error('bridge_ticket_create_failed', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PATCH /v1/bridge/ticket/:id
 * Updates a ticket's status. Signed internal-only route.
 */
router.patch('/ticket/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        const parsedStatus = parseTicketStatus(req.body?.status);

        const ticket = await prisma.ticket.update({
            where: { id },
            data: { status: parsedStatus },
        });

        const dealId = ticket.offerId;
        const alreadyProcessed = await prisma.dealReputationProcessing.findUnique({
            where: { dealId: `${dealId}_${parsedStatus}` },
        });

        if (!alreadyProcessed) {
            if (SUCCESSFUL_TICKET_STATUSES.includes(parsedStatus as (typeof SUCCESSFUL_TICKET_STATUSES)[number])) {
                await updateAgentReputationFromBridge([ticket.buyer, ticket.seller], 'success');
            } else if (parsedStatus === 'cancelled') {
                await updateAgentReputationFromBridge([ticket.buyer, ticket.seller], 'cancelled');
            } else if (parsedStatus === 'disputed') {
                await updateAgentReputationFromBridge([ticket.buyer, ticket.seller], 'disputed');
            }

            if ([...SUCCESSFUL_TICKET_STATUSES, 'cancelled', 'disputed'].includes(parsedStatus as any)) {
                await prisma.dealReputationProcessing.create({
                    data: { dealId: `${dealId}_${parsedStatus}` },
                });
            }
        }

        res.status(200).json({ success: true, data: ticket });
    } catch (error: any) {
        if (error instanceof Error && error.message === 'Invalid status') {
            res.status(400).json({ success: false, error: error.message });
            return;
        }
        if (error.code === 'P2025') {
            res.status(404).json({ success: false, error: 'Ticket not found' });
            return;
        }
        logger.error('bridge_ticket_update_failed', { error: error.message });
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
