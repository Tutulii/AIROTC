import { PublicKey } from '@solana/web3.js';
import { prisma } from '../lib/prisma';
import { calculateVisibleReputation, getTier } from '../utils/reputation';

const prismaAny = prisma as any;

const TERMINAL_SPORT_STATUSES = new Set(['settled', 'released', 'refunded', 'cancelled', 'failed']);
const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 50;
const MAX_MATCH_SCAN = 5000;

type SportRole = 'maker' | 'taker';

export interface ReputationProfileOptions {
    includeHistory?: boolean;
    recentLimit?: number;
}

function httpError(message: string, statusCode: number): Error {
    const error = new Error(message);
    (error as any).statusCode = statusCode;
    return error;
}

function validateWallet(walletInput: string): string {
    const wallet = typeof walletInput === 'string' ? walletInput.trim() : '';
    try {
        new PublicKey(wallet);
    } catch {
        throw httpError('invalid_wallet', 400);
    }
    return wallet;
}

function toNumber(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
        const converted = (value as { toNumber: () => number }).toNumber();
        return Number.isFinite(converted) ? converted : 0;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function asDateMs(value: unknown): number {
    if (!value) return 0;
    const ms = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
    return Number.isFinite(ms) ? ms : 0;
}

function serializeDate(value: unknown): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function inferMakerWins(match: any, outcomeWinner: string | null): boolean | null {
    const direction = typeof match?.direction === 'string' ? match.direction : '';
    const selection = typeof match?.selection === 'string' ? match.selection : '';
    if (!direction || !selection || !outcomeWinner) return null;
    if (direction === 'BUY_SELECTION') return selection === outcomeWinner;
    if (direction === 'SELL_SELECTION') return selection !== outcomeWinner;
    return null;
}

function roleForWallet(match: any, wallet: string): SportRole | null {
    if (match?.makerWallet === wallet) return 'maker';
    if (match?.takerWallet === wallet) return 'taker';
    if (!match?.takerWallet && match?.makerWallet !== wallet) {
        if (match?.buyerWallet === wallet || match?.sellerWallet === wallet) return 'taker';
    }
    return null;
}

function normalizeLimit(value: number | undefined): number {
    if (value === undefined || value === null) return DEFAULT_RECENT_LIMIT;
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return DEFAULT_RECENT_LIMIT;
    return Math.min(Math.max(parsed, 1), MAX_RECENT_LIMIT);
}

function calculateSampleConfidence(evaluable: number): number {
    if (evaluable <= 0) return 0;
    return Math.min(1, Math.log10(evaluable + 1) / Math.log10(51));
}

function calculateVolumeConfidence(totalNotional: number): number {
    if (totalNotional <= 0) return 0;
    return Math.min(1, Math.log10(totalNotional + 1) / Math.log10(101));
}

function formatConfidence(value: number): number {
    return Number(value.toFixed(4));
}

function calculateCombinedScore(params: {
    dealScore: number;
    dealCount: number;
    cancelledDeals: number;
    sportEvaluable: number;
    sportAccuracy: number | null;
    sportNotional: number;
}): number {
    if (params.dealCount <= 0 && params.sportEvaluable <= 0) return 0;
    if (params.sportEvaluable <= 0) return Math.round(params.dealScore);

    const accuracyScore = (params.sportAccuracy ?? 0) * 100;
    const sampleScore = calculateSampleConfidence(params.sportEvaluable) * 100;
    const volumeScore = calculateVolumeConfidence(params.sportNotional) * 100;
    const cancellationPenalty = params.dealCount > 0
        ? Math.min(15, (params.cancelledDeals / params.dealCount) * 15)
        : 0;

    const score =
        (params.dealScore * 0.35) +
        (accuracyScore * 0.40) +
        (sampleScore * 0.15) +
        (volumeScore * 0.10) -
        cancellationPenalty;

    return Math.max(0, Math.min(100, Math.round(score)));
}

function trustSummary(tier: string, sportEvaluable: number, sportAccuracy: number | null): string {
    if (sportEvaluable <= 0) return 'No settled SPORT prediction history yet';
    const accuracyPct = Math.round((sportAccuracy ?? 0) * 100);
    if (tier === 'elite') return `Elite counterparty with ${accuracyPct}% SPORT prediction accuracy`;
    if (tier === 'trusted') return `Reliable counterparty with ${accuracyPct}% SPORT prediction accuracy`;
    if (tier === 'neutral') return `Some SPORT history with ${accuracyPct}% prediction accuracy`;
    return `Risky or unproven SPORT counterparty with ${accuracyPct}% prediction accuracy`;
}

export async function getReputationProfile(
    walletInput: string,
    options: ReputationProfileOptions = {},
): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const recentLimit = normalizeLimit(options.recentLimit);
    const includeHistory = options.includeHistory !== false;

    const [agent, sportMatches] = await Promise.all([
        prisma.agent.findUnique({ where: { wallet } }),
        prismaAny.arenaMatch.findMany({
            where: {
                rollupMode: 'SPORT',
                OR: [
                    { makerWallet: wallet },
                    { takerWallet: wallet },
                    { buyerWallet: wallet },
                    { sellerWallet: wallet },
                ],
            },
            orderBy: [{ settledAt: 'desc' }, { createdAt: 'desc' }],
            take: MAX_MATCH_SCAN + 1,
        }),
    ]);

    const scannedMatches = sportMatches.slice(0, MAX_MATCH_SCAN);
    const fixtureIds: string[] = Array.from(new Set<string>(scannedMatches
        .map((match: any) => match.fixtureId)
        .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id))));
    const offerIds: string[] = Array.from(new Set<string>(scannedMatches
        .map((match: any) => match.offerId)
        .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id))));

    const [outcomes, offers, reputationEvents] = await Promise.all([
        fixtureIds.length > 0
            ? prismaAny.arenaOutcome.findMany({ where: { fixtureId: { in: fixtureIds } } })
            : Promise.resolve([]),
        offerIds.length > 0
            ? prisma.offer.findMany({
                where: { id: { in: offerIds } },
                select: { id: true, price: true, amount: true, collateral: true, asset: true },
            })
            : Promise.resolve([]),
        includeHistory
            ? prisma.agentEvent.findMany({
                where: { wallet, event: 'reputation.update' },
                orderBy: { createdAt: 'desc' },
                take: recentLimit,
            })
            : Promise.resolve([]),
    ]);

    const outcomesByFixture = new Map<string, any>((outcomes as any[]).map((outcome: any) => [outcome.fixtureId, outcome]));
    const offersById = new Map(offers.map((offer: any) => [offer.id, offer]));

    const evaluated: Array<Record<string, unknown> & { correct: boolean; settledMs: number }> = [];
    let pending = 0;
    let cancelled = 0;
    let failed = 0;
    let makerCount = 0;
    let takerCount = 0;
    let totalNotional = 0;

    for (const match of scannedMatches) {
        const role = roleForWallet(match, wallet);
        if (!role) continue;
        if (role === 'maker') makerCount += 1;
        if (role === 'taker') takerCount += 1;

        const status = typeof match.status === 'string' ? match.status : 'unknown';
        if (!TERMINAL_SPORT_STATUSES.has(status)) {
            pending += 1;
            continue;
        }
        if (status === 'cancelled') cancelled += 1;
        if (status === 'failed') failed += 1;

        const outcome = outcomesByFixture.get(match.fixtureId);
        const outcomeWinner = typeof match.outcomeWinner === 'string'
            ? match.outcomeWinner
            : typeof outcome?.winner === 'string' ? outcome.winner : null;
        const makerWins = inferMakerWins(match, outcomeWinner);
        if (makerWins === null) continue;

        const correct = role === 'maker' ? makerWins : !makerWins;
        const offer = match.offerId ? offersById.get(match.offerId) : null;
        const notional = offer ? toNumber(offer.price) * toNumber(offer.amount || 1) : 0;
        totalNotional += Math.max(0, notional);

        evaluated.push({
            matchId: match.id,
            fixtureId: match.fixtureId,
            ticketId: match.ticketId || null,
            offerId: match.offerId || null,
            role,
            counterpartyWallet: role === 'maker' ? match.takerWallet || null : match.makerWallet || null,
            marketType: match.marketType || null,
            selection: match.selection || null,
            direction: match.direction || null,
            outcomeWinner,
            correct,
            status,
            settlementAction: match.settlementAction || null,
            winnerWallet: match.winnerWallet || null,
            notional,
            settledAt: serializeDate(match.settledAt),
            createdAt: serializeDate(match.createdAt),
            settledMs: asDateMs(match.settledAt) || asDateMs(match.createdAt),
        });
    }

    evaluated.sort((a, b) => b.settledMs - a.settledMs);
    const correct = evaluated.filter((item) => item.correct).length;
    const wrong = evaluated.length - correct;
    const accuracy = evaluated.length > 0 ? correct / evaluated.length : null;
    const sampleConfidence = calculateSampleConfidence(evaluated.length);
    const volumeConfidence = calculateVolumeConfidence(totalNotional);
    const currentStreak = evaluated.reduce((streak, item, index) => {
        if (index === 0) return 1;
        if (streak === 0) return 0;
        return item.correct === evaluated[0].correct ? streak + 1 : 0;
    }, 0);

    const dealScore = agent ? calculateVisibleReputation(agent as any) : 0;
    const dealCount = agent?.totalDeals || 0;
    const combinedScore = calculateCombinedScore({
        dealScore,
        dealCount,
        cancelledDeals: agent?.cancelledDeals || 0,
        sportEvaluable: evaluated.length,
        sportAccuracy: accuracy,
        sportNotional: totalNotional,
    });
    const tier = getTier(combinedScore, dealCount + evaluated.length);

    return {
        wallet,
        registered: Boolean(agent),
        score: combinedScore,
        tier,
        trustSummary: trustSummary(tier, evaluated.length, accuracy),
        algorithm: {
            version: 'sport_reputation_v1',
            formula: evaluated.length > 0
                ? '35% deal reliability + 40% SPORT prediction accuracy + 15% SPORT sample confidence + 10% SPORT notional confidence - cancellation penalty'
                : 'Visible deal reliability score; fresh wallets score 0 until settled history exists',
            scoreRange: [0, 100],
            computedFrom: ['Agent deal counters', 'ArenaMatch SPORT settlements', 'ArenaOutcome TxLINE winners'],
            eventHistorySource: 'AgentEvent where event = reputation.update',
        },
        dealReputation: {
            score: dealScore,
            totalDeals: agent?.totalDeals || 0,
            successfulDeals: agent?.successfulDeals || 0,
            cancelledDeals: agent?.cancelledDeals || 0,
            disputedDeals: agent?.disputedDeals || 0,
            totalVolume: agent?.totalVolume || '0',
            avgSettlementTime: agent?.avgSettlementTime || 0,
        },
        predictionReputation: {
            rollupMode: 'SPORT',
            totalMatches: scannedMatches.length,
            scannedLimit: MAX_MATCH_SCAN,
            truncated: sportMatches.length > MAX_MATCH_SCAN,
            evaluableSettledPredictions: evaluated.length,
            correctPredictions: correct,
            wrongPredictions: wrong,
            accuracy,
            accuracyPct: accuracy === null ? null : Number((accuracy * 100).toFixed(2)),
            pendingMatches: pending,
            cancelledMatches: cancelled,
            failedMatches: failed,
            sampleConfidence: formatConfidence(sampleConfidence),
            notional: Number(totalNotional.toFixed(6)),
            volumeConfidence: formatConfidence(volumeConfidence),
            currentStreak: evaluated.length > 0
                ? { result: evaluated[0].correct ? 'correct' : 'wrong', count: currentStreak }
                : null,
            roles: {
                maker: makerCount,
                taker: takerCount,
            },
            recent: evaluated.slice(0, recentLimit).map(({ settledMs, ...item }) => item),
        },
        history: includeHistory
            ? reputationEvents.map((event: any) => ({
                id: event.id,
                event: event.event,
                ticketId: event.ticketId || null,
                dealId: event.dealId || null,
                payload: event.payload,
                createdAt: serializeDate(event.createdAt),
            }))
            : undefined,
        generatedAt: new Date().toISOString(),
    };
}
