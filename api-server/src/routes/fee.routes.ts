/**
 * Fee & Revenue Routes — Platform Revenue Visibility
 *
 * Tracks and exposes platform fee collection from escrow releases.
 * Every time the Middleman calls release_funds, a fee record is created.
 *
 * Endpoints:
 *   GET  /v1/fees/summary       — Total revenue summary (public)
 *   GET  /v1/fees/history       — Paginated fee collection history
 *   POST /v1/fees/record        — Record a fee (called by Middleman after release_funds)
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateSolana } from '../middleware/auth';
import { logger } from '../lib/logger';

const router = Router();

function toNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
        return (value as { toNumber: () => number }).toNumber();
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

// ─── GET /v1/fees/summary — Platform Revenue Summary (Public) ───

router.get('/v1/fees/summary', async (_req: Request, res: Response): Promise<void> => {
    try {
        // Total fees collected
        const allFees = await prisma.feeCollection.findMany({
            select: { feeAmount: true, dealAmount: true, token: true, feeRate: true },
        });

        // Aggregate by token
        const byToken: Record<string, { totalFees: bigint; totalVolume: bigint; count: number }> = {};

        for (const fee of allFees) {
            const token = fee.token;
            if (!byToken[token]) {
                byToken[token] = { totalFees: BigInt(0), totalVolume: BigInt(0), count: 0 };
            }
            byToken[token].totalFees += BigInt(fee.feeAmount);
            byToken[token].totalVolume += BigInt(fee.dealAmount);
            byToken[token].count += 1;
        }

        // Format response
        const breakdown = Object.entries(byToken).map(([token, data]) => ({
            token,
            totalFeesCollected: data.totalFees.toString(),
            totalFeesFormatted: formatLamports(data.totalFees, token),
            totalVolume: data.totalVolume.toString(),
            totalVolumeFormatted: formatLamports(data.totalVolume, token),
            dealCount: data.count,
        }));

        // Overall stats
        const totalDeals = allFees.length;
        const avgFeeRate = totalDeals > 0
            ? (allFees.reduce((sum, f) => sum + toNumber(f.feeRate), 0) / totalDeals).toFixed(2)
            : '0';

        res.status(200).json({
            success: true,
            revenue: {
                totalDealsSettled: totalDeals,
                averageFeeRate: `${avgFeeRate}%`,
                breakdown,
                lastUpdated: new Date().toISOString(),
            },
        });
    } catch (error: any) {
        logger.error('fee_summary_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to fetch fee summary' });
    }
});

// ─── GET /v1/fees/history — Paginated Fee Collection History ───

router.get('/v1/fees/history', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        const skip = (page - 1) * limit;
        const token = req.query.token as string;

        const where: any = {};
        if (token) where.token = token;

        const [fees, total] = await Promise.all([
            prisma.feeCollection.findMany({
                where,
                orderBy: { collectedAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.feeCollection.count({ where }),
        ]);

        // Format for readability
        const formatted = fees.map(f => ({
            id: f.id,
            ticketId: f.ticketId,
            dealPda: f.dealPda,
            buyer: f.buyerWallet,
            seller: f.sellerWallet,
            dealAmount: f.dealAmount,
            dealAmountFormatted: formatLamports(BigInt(f.dealAmount), f.token),
            feeAmount: f.feeAmount,
            feeAmountFormatted: formatLamports(BigInt(f.feeAmount), f.token),
            feeRate: `${f.feeRate}%`,
            token: f.token,
            txSignature: f.txSignature,
            collectedAt: f.collectedAt,
        }));

        res.status(200).json({
            success: true,
            fees: formatted,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error: any) {
        logger.error('fee_history_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to fetch fee history' });
    }
});

// ─── POST /v1/fees/record — Record a Fee Collection ───
// Called by the Middleman after a successful release_funds on-chain

router.post('/v1/fees/record', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const { ticketId, dealPda, buyerWallet, sellerWallet, dealAmount, feeAmount, feeRate, token, txSignature } = req.body;

        // Validate required fields
        if (!ticketId || !dealPda || !buyerWallet || !sellerWallet || !dealAmount || !feeAmount) {
            res.status(400).json({ success: false, error: 'Missing required fields: ticketId, dealPda, buyerWallet, sellerWallet, dealAmount, feeAmount' });
            return;
        }

        // Prevent duplicate recording
        const existing = await prisma.feeCollection.findFirst({
            where: { ticketId, dealPda },
        });

        if (existing) {
            res.status(200).json({ success: true, message: 'Fee already recorded', fee: existing });
            return;
        }

        const fee = await prisma.feeCollection.create({
            data: {
                ticketId,
                dealPda,
                buyerWallet,
                sellerWallet,
                dealAmount: dealAmount.toString(),
                feeAmount: feeAmount.toString(),
                feeRate: feeRate || 1.0,
                token: token || 'SOL',
                txSignature: txSignature || null,
            },
        });

        logger.info('fee_recorded', {
            ticketId,
            feeAmount: formatLamports(BigInt(feeAmount.toString()), token || 'SOL'),
            token: token || 'SOL',
        });

        res.status(201).json({ success: true, fee });
    } catch (error: any) {
        logger.error('fee_record_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to record fee' });
    }
});

// ─── Helpers ───

function formatLamports(lamports: bigint, token: string): string {
    if (token === 'SOL') {
        const sol = Number(lamports) / 1_000_000_000;
        return `${sol.toFixed(4)} SOL`;
    }
    if (token === 'USDC' || token === 'USDT') {
        const amount = Number(lamports) / 1_000_000;
        return `$${amount.toFixed(2)}`;
    }
    // Generic token — assume 9 decimals
    const amount = Number(lamports) / 1_000_000_000;
    return `${amount.toFixed(4)} ${token}`;
}

export default router;
