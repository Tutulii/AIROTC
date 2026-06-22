import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { SUCCESSFUL_TICKET_STATUSES } from '../services/ticketStatusPolicy';
import { calculateVisibleReputation } from '../utils/reputation';

function toNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
        return (value as { toNumber: () => number }).toNumber();
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function isStrictPerOpaqueMode(): boolean {
    const raw = process.env.PER_STRICT_OPAQUE_MODE;
    if (raw === undefined) return true;
    return raw !== 'false';
}

export const getStats = async (req: Request, res: Response) => {
    try {
        const since24h = new Date(Date.now() - (24 * 60 * 60 * 1000));
        const registeredAgents = await prisma.agent.count();
        const activeDeals = await prisma.ticket.count({
            where: { status: 'negotiating' },
        });

        // Volume: sum price*amount from completed deals observed in the last 24 hours.
        const ticketsWithOffers = await prisma.ticket.findMany({
            where: {
                status: { in: [...SUCCESSFUL_TICKET_STATUSES] },
                createdAt: { gte: since24h },
            },
            include: { offer: { select: { price: true, amount: true } } },
        });
        const volumeNum = ticketsWithOffers.reduce((sum, t) => {
            if (t.offer) return sum + (toNumber(t.offer.price) * toNumber(t.offer.amount));
            return sum;
        }, 0);
        const volume24h = volumeNum > 1_000_000
            ? `$${(volumeNum / 1_000_000).toFixed(1)}M`
            : volumeNum > 1_000
                ? `$${(volumeNum / 1_000).toFixed(1)}K`
                : `$${volumeNum.toFixed(0)}`;

        // Settlement rate: completed deals / total deals (not hardcoded)
        const totalTickets = await prisma.ticket.count();
        const completedTickets = await prisma.ticket.count({
            where: { status: { in: [...SUCCESSFUL_TICKET_STATUSES] } },
        });
        const settlementRate = totalTickets > 0
            ? `${((completedTickets / totalTickets) * 100).toFixed(1)}%`
            : "N/A";

        res.json({
            success: true,
            data: {
                activeDeals,
                volume24h,
                settlementRate,
                registeredAgents
            }
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
};

/** List all registered agents with pagination */
export const getAgentsList = async (req: Request, res: Response) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const skip = (page - 1) * limit;
        const sortBy = (req.query.sort as string) || 'reputationScore';
        const order = (req.query.order as string) === 'asc' ? 'asc' : 'desc';

        const orderByField: Record<string, any> = {};
        if (['reputationScore', 'totalDeals', 'totalVolume', 'createdAt'].includes(sortBy)) {
            orderByField[sortBy] = order;
        } else {
            orderByField.reputationScore = 'desc';
        }

        const [agents, total] = await Promise.all([
            prisma.agent.findMany({
                skip,
                take: limit,
                orderBy: orderByField,
                select: {
                    id: true,
                    wallet: true,
                    createdAt: true,
                    totalDeals: true,
                    successfulDeals: true,
                    cancelledDeals: true,
                    disputedDeals: true,
                    totalVolume: true,
                    avgSettlementTime: true,
                    reputationScore: true,
                },
            }),
            prisma.agent.count(),
        ]);

        const data = agents.map((agent) => ({
            ...agent,
            reputationScore: calculateVisibleReputation(agent),
        }));

        res.json({
            success: true,
            data,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
};

/** List recent deals/tickets */
export const getRecentDeals = async (req: Request, res: Response) => {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const strictPerOpaqueMode = isStrictPerOpaqueMode();

        const tickets = await prisma.ticket.findMany({
            take: limit,
            orderBy: { createdAt: 'desc' },
            include: {
                offer: {
                    select: { asset: true, price: true, amount: true, mode: true, collateral: true, tokenMint: true, tokenDecimals: true },
                },
            },
        });

        const data = tickets.map((ticket) => {
            const redactPrivateTerms =
                strictPerOpaqueMode &&
                (ticket as any).rollupMode === 'PER' &&
                ticket.offer;

            if (!redactPrivateTerms || !ticket.offer) {
                return ticket;
            }

            return {
                ...ticket,
                privateTermsRedacted: true,
                offer: {
                    ...ticket.offer,
                    price: null,
                    collateral: null,
                    privateTermsRedacted: true,
                },
            };
        });

        res.json({ success: true, data });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
};
