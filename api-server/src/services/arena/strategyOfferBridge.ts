import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { validateCreateOffer } from '../../utils/offerValidator';
import { serializeStrategySignal } from './strategyEngine';

const prismaAny = prisma as any;
const DEFAULT_SIGNAL_OFFER_PRICE_SOL = 0.01;
const DEFAULT_SIGNAL_OFFER_AMOUNT = 1;

export interface StrategyOfferOptions {
    asset?: string;
    price?: number;
    amount?: number;
    collateral?: number;
    mode?: 'buy' | 'sell';
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function positiveNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function signalTradeIntent(signal: any): Record<string, any> {
    return signal?.tradeIntent && typeof signal.tradeIntent === 'object' && !Array.isArray(signal.tradeIntent)
        ? signal.tradeIntent
        : {};
}

function defaultMode(signal: any): 'buy' | 'sell' {
    const intent = signalTradeIntent(signal);
    return intent.action === 'quote_sell' ? 'sell' : 'buy';
}

function defaultPrice(signal: any): number {
    const intent = signalTradeIntent(signal);
    const maxStake = positiveNumber(intent.maxStakeSol, DEFAULT_SIGNAL_OFFER_PRICE_SOL);
    return Math.min(maxStake, DEFAULT_SIGNAL_OFFER_PRICE_SOL);
}

function buildSignalAsset(signal: any): string {
    const parts = [
        'TXLINE',
        signal.fixtureId,
        signal.marketType || 'market',
        signal.selection || 'selection',
    ].filter(Boolean);
    return parts.join(':').slice(0, 200);
}

function offerDedupeKey(signalId: string, wallet: string, input: Record<string, unknown>): string {
    return crypto
        .createHash('sha256')
        .update(stableJson({
            signalId,
            wallet,
            asset: input.asset,
            price: input.price,
            amount: input.amount,
            collateral: input.collateral,
            mode: input.mode,
        }))
        .digest('hex');
}

function sanitizeOffer(offer: any): Record<string, unknown> {
    if (!offer || typeof offer !== 'object') return {};
    const {
        creatorSettlementWallet: _hiddenSettlement,
        creatorRewardWallet: _hiddenReward,
        creatorFundingWallet: _hiddenFunding,
        ...rest
    } = offer;
    return rest;
}

export async function createOfferFromStrategySignal(
    signalId: string,
    wallet: string,
    options: StrategyOfferOptions = {}
): Promise<Record<string, unknown>> {
    if (!signalId || typeof signalId !== 'string') {
        const error = new Error('strategy_signal_id_required');
        (error as any).statusCode = 400;
        throw error;
    }
    if (!wallet || typeof wallet !== 'string') {
        const error = new Error('wallet_required');
        (error as any).statusCode = 401;
        throw error;
    }

    const signal = await prismaAny.arenaStrategySignal.findUnique({
        where: { id: signalId },
    });
    if (!signal) {
        const error = new Error('strategy_signal_not_found');
        (error as any).statusCode = 404;
        throw error;
    }

    const price = positiveNumber(options.price, defaultPrice(signal));
    const amount = positiveNumber(options.amount, DEFAULT_SIGNAL_OFFER_AMOUNT);
    const collateral = nonNegativeNumber(options.collateral, price);
    const offerInput = {
        asset: (options.asset || buildSignalAsset(signal)).slice(0, 200),
        price,
        amount,
        collateral,
        mode: options.mode || defaultMode(signal),
        rollupMode: 'NONE' as const,
    };

    const validation = validateCreateOffer(offerInput);
    if (!validation.valid) {
        const error = new Error(validation.error || 'invalid_strategy_offer');
        (error as any).statusCode = 400;
        throw error;
    }

    const dedupeKey = offerDedupeKey(signalId, wallet, offerInput);
    return prismaAny.$transaction(async (tx: any) => {
        const existing = await tx.arenaStrategyOffer.findUnique({
            where: { dedupeKey },
        });
        if (existing) {
            const offer = await tx.offer.findUnique({
                where: { id: existing.offerId },
                include: {
                    creator: {
                        select: { wallet: true },
                    },
                },
            });
            return {
                created: false,
                signal: serializeStrategySignal(signal),
                offer: sanitizeOffer(offer),
                bridge: existing,
            };
        }

        const agent = await tx.agent.upsert({
            where: { wallet },
            update: {},
            create: { wallet },
        });
        const offer = await tx.offer.create({
            data: {
                creatorId: agent.id,
                asset: offerInput.asset,
                price: offerInput.price,
                amount: offerInput.amount,
                mode: offerInput.mode,
                rollupMode: offerInput.rollupMode,
                collateral: offerInput.collateral,
                tokenMint: null,
                tokenDecimals: validation.tokenDecimals ?? 9,
                creatorSettlementWallet: null,
                creatorRewardWallet: null,
                creatorFundingWallet: null,
            },
            include: {
                creator: {
                    select: { wallet: true },
                },
            },
        });
        const bridge = await tx.arenaStrategyOffer.create({
            data: {
                signalId,
                offerId: offer.id,
                wallet,
                fixtureId: signal.fixtureId,
                params: jsonValue(offerInput),
                dedupeKey,
            },
        });

        return {
            created: true,
            signal: serializeStrategySignal(signal),
            offer: sanitizeOffer(offer),
            bridge,
        };
    });
}
