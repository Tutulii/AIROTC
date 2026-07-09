import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { validateCreateOffer } from '../utils/offerValidator';
import { serializeArenaMatch } from '../services/arena/arenaMatch.service';

function sanitizeOffer<T extends Record<string, any>>(offer: T): T {
    const {
        creatorSettlementWallet: _hiddenSettlement,
        creatorRewardWallet: _hiddenReward,
        creatorFundingWallet: _hiddenFunding,
        ...rest
    } = offer as T & {
        creatorSettlementWallet?: string | null;
        creatorRewardWallet?: string | null;
        creatorFundingWallet?: string | null;
    };
    if (rest.rollupMode === 'SPORT') {
        const { collateral: _hiddenCollateral, ...sportRest } = rest;
        return {
            ...sportRest,
            stake: sportRest.price,
            stakeModel: 'equal_stake',
        } as unknown as T;
    }
    return rest as T;
}

export const createOffer = async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet;
        if (!wallet) {
            res.status(401).json({ success: false, error: 'Unauthorized: Wallet missing' });
            return;
        }

        const validation = validateCreateOffer(req.body);
        if (!validation.valid) {
            res.status(400).json({ success: false, error: validation.error });
            return;
        }

        const {
            asset,
            price,
            amount,
            mode,
            collateral,
            tokenMint,
            rollupMode,
            privateMode,
            settlementWallet,
            rewardWallet,
            fundingWallet,
            fixtureId,
            marketType,
            selection,
        } = req.body;
        const tokenDecimals = validation.tokenDecimals ?? 9;
        const resolvedRollupMode =
            rollupMode === 'PER' || privateMode === true
                ? 'PER'
                : rollupMode === 'SPORT'
                    ? 'SPORT'
                    : rollupMode === 'NONE'
                        ? 'NONE'
                        : 'ER';

        const sportFixtureId =
            resolvedRollupMode === 'SPORT' && typeof fixtureId === 'string' ? fixtureId.trim() : null;
        const sportMarketType =
            resolvedRollupMode === 'SPORT' && typeof marketType === 'string' && marketType.trim()
                ? marketType.trim()
                : null;
        const sportSelection =
            resolvedRollupMode === 'SPORT' && typeof selection === 'string' ? selection.trim() : null;

        if (resolvedRollupMode === 'SPORT') {
            if (!sportFixtureId || !sportSelection) {
                res.status(400).json({ success: false, error: 'fixtureId and selection are required for SPORT offers' });
                return;
            }

            const result = await prisma.$transaction(async (tx) => {
                const agent = await tx.agent.upsert({
                    where: { wallet },
                    update: {},
                    create: { wallet },
                });

                const offer = await tx.offer.create({
                    data: {
                        creatorId: agent.id,
                        asset,
                        price,
                        amount,
                        mode,
                        rollupMode: resolvedRollupMode,
                        collateral: 0,
                        tokenMint: tokenMint || null,
                        tokenDecimals,
                        creatorSettlementWallet: settlementWallet || null,
                        creatorRewardWallet: rewardWallet || null,
                        creatorFundingWallet: fundingWallet || null,
                        fixtureId: sportFixtureId,
                        marketType: sportMarketType,
                        selection: sportSelection,
                    },
                });

                let fixture: any = null;
                try {
                    fixture = await (tx as any).arenaFixture.findUnique({
                        where: { fixtureId: sportFixtureId },
                    });
                } catch {
                    fixture = null;
                }

                const arenaMatch = await (tx as any).arenaMatch.create({
                    data: {
                        fixtureId: sportFixtureId,
                        offerId: offer.id,
                        marketType: sportMarketType,
                        selection: sportSelection,
                        direction: mode === 'sell' ? 'SELL_SELECTION' : 'BUY_SELECTION',
                        makerWallet: wallet,
                        rollupMode: 'SPORT',
                        status: 'offer_created',
                        startedAt: new Date(),
                        proof: {
                            createdBy: 'sport_offer',
                            fixtureKnown: Boolean(fixture),
                            settlementSource: 'txline',
                        },
                    },
                });

                return { offer, arenaMatch };
            });

            res.status(201).json({
                success: true,
                data: sanitizeOffer(result.offer),
                arenaMatch: serializeArenaMatch(result.arenaMatch),
            });
            return;
        }

        const agent = await prisma.agent.upsert({
            where: { wallet },
            update: {},
            create: { wallet }
        });

        const offer = await prisma.offer.create({
            data: {
                creatorId: agent.id,
                asset,
                price,
                amount,
                mode,
                rollupMode: resolvedRollupMode,
                collateral,
                tokenMint: tokenMint || null,
                tokenDecimals,
                creatorSettlementWallet: settlementWallet || null,
                creatorRewardWallet: rewardWallet || null,
                creatorFundingWallet: fundingWallet || null,
            }
        });

        res.status(201).json({
            success: true,
            data: sanitizeOffer(offer)
        });
    } catch (error: any) {
        logger.error("error");
        res.status(500).json({ success: false, error: 'Internal server error while creating offer' });
    }
};

export const getOffers = async (req: Request, res: Response): Promise<void> => {
    try {
        const rawAsset = req.query.asset;
        const { minPrice, maxPrice, mode, rollupMode } = req.query;

        // ── Sanitize query parameters ──
        const sanitizeQueryParam = (val: unknown, maxLen = 100): string | undefined => {
            if (!val || typeof val !== 'string') return undefined;
            // Strip SQL injection characters, HTML, and control chars
            return val
                .replace(/['"`;\\]/g, '')     // Strip SQL-dangerous chars
                .replace(/<[^>]*>/g, '')        // Strip HTML tags
                .replace(/[\x00-\x1F\x7F]/g, '') // Strip control chars
                .substring(0, maxLen)
                .trim() || undefined;
        };

        const where: any = {
            status: 'active',
        };

        const cleanAsset = sanitizeQueryParam(rawAsset, 64);
        if (cleanAsset) {
            where.asset = cleanAsset;
        }

        const cleanFixtureId = sanitizeQueryParam(req.query.fixtureId, 100);
        if (cleanFixtureId) {
            where.fixtureId = cleanFixtureId;
        }

        if (rollupMode) {
            if (rollupMode === 'ER' || rollupMode === 'PER' || rollupMode === 'NONE' || rollupMode === 'SPORT') {
                where.rollupMode = rollupMode;
            } else {
                res.status(400).json({ success: false, error: 'rollupMode must be "NONE", "ER", "PER", or "SPORT"' });
                return;
            }
        }

        if (mode) {
            if (mode === 'buy' || mode === 'sell') {
                where.mode = mode;
            } else {
                res.status(400).json({ success: false, error: 'mode must be "buy" or "sell"' });
                return;
            }
        }

        if (minPrice || maxPrice) {
            where.price = {};
            if (minPrice) {
                const min = parseFloat(minPrice as string);
                if (isNaN(min)) {
                    res.status(400).json({ success: false, error: 'minPrice must be a valid number' });
                    return;
                }
                where.price.gte = min;
            }
            if (maxPrice) {
                const max = parseFloat(maxPrice as string);
                if (isNaN(max)) {
                    res.status(400).json({ success: false, error: 'maxPrice must be a valid number' });
                    return;
                }
                where.price.lte = max;
            }
        }

        const offers = await prisma.offer.findMany({
            where,
            include: {
                creator: {
                    select: {
                        wallet: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });

        res.status(200).json({
            success: true,
            data: offers.map((offer) => sanitizeOffer(offer)),
        });
    } catch (error: any) {
        logger.error("error");
        res.status(500).json({ success: false, error: 'Internal server error while fetching offers' });
    }
};

export const getMyOffers = async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet;
        if (!wallet) {
            res.status(401).json({ success: false, error: 'Unauthorized: Wallet missing' });
            return;
        }

        const status =
            typeof req.query.status === 'string' && req.query.status.trim().length > 0
                ? req.query.status.trim()
                : undefined;

        const offers = await prisma.offer.findMany({
            where: {
                creator: { wallet },
                ...(status ? { status } : {}),
            },
            include: {
                creator: {
                    select: {
                        wallet: true,
                    },
                },
                ticket: {
                    select: {
                        id: true,
                        buyer: true,
                        seller: true,
                        status: true,
                        rollupMode: true,
                        createdAt: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });

        res.status(200).json({
            success: true,
            data: offers.map((offer) => sanitizeOffer(offer)),
        });
    } catch (error: any) {
        logger.error("error");
        res.status(500).json({ success: false, error: 'Internal server error while fetching your offers' });
    }
};

export const getOfferById = async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;

        if (!id) {
            res.status(400).json({ success: false, error: 'Offer ID is required' });
            return;
        }

        const offer = await prisma.offer.findUnique({
            where: { id: id as string },
            include: {
                creator: {
                    select: {
                        id: true,
                        wallet: true,
                    },
                },
                ticket: {
                    select: {
                        id: true,
                        buyer: true,
                        seller: true,
                        status: true,
                        rollupMode: true,
                        createdAt: true,
                    },
                },
            },
        });

        if (!offer) {
            res.status(404).json({ success: false, error: 'Offer not found' });
            return;
        }

        res.status(200).json({
            success: true,
            data: sanitizeOffer(offer),
        });
    } catch (error: any) {
        logger.error("error");
        res.status(500).json({ success: false, error: 'Internal server error while fetching offer details' });
    }
};

export const updateOffer = async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet;
        if (!wallet) {
            res.status(401).json({ success: false, error: 'Unauthorized: Wallet missing' });
            return;
        }

        const { id } = req.params;
        if (!id) {
            res.status(400).json({ success: false, error: 'Offer ID is required' });
            return;
        }

        const offer = await prisma.offer.findUnique({
            where: { id: id as string },
            include: { creator: true }
        });

        if (!offer) {
            res.status(404).json({ success: false, error: 'Offer not found' });
            return;
        }

        if (offer.creator.wallet !== wallet) {
            res.status(403).json({ success: false, error: 'Forbidden: You are not allowed to modify this offer' });
            return;
        }

        if (offer.status !== 'active') {
            res.status(400).json({ success: false, error: 'Offer is not active' });
            return;
        }

        const { price, amount, status } = req.body;
        const updateData: any = {};

        if (price !== undefined) {
            if (typeof price !== 'number' || price <= 0) {
                res.status(400).json({ success: false, error: 'price must be a number > 0' });
                return;
            }
            updateData.price = price;
        }

        if (amount !== undefined) {
            if (typeof amount !== 'number' || amount <= 0) {
                res.status(400).json({ success: false, error: 'amount must be a number > 0' });
                return;
            }
            updateData.amount = amount;
        }

        if (status !== undefined) {
            if (status !== 'cancelled') {
                res.status(400).json({ success: false, error: 'status can only be updated to "cancelled" manually' });
                return;
            }
            updateData.status = status;
        }

        if (Object.keys(updateData).length === 0) {
            res.status(400).json({ success: false, error: 'No valid fields provided for update' });
            return;
        }

        const updatedOffer = await prisma.offer.update({
            where: { id: id as string },
            data: updateData
        });

        res.status(200).json({
            success: true,
            data: sanitizeOffer(updatedOffer)
        });

    } catch (error: any) {
        logger.error("error");
        res.status(500).json({ success: false, error: 'Internal server error while updating offer' });
    }
};
