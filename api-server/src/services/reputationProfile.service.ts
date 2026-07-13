import { PublicKey } from '@solana/web3.js';
import { prisma } from '../lib/prisma';
import { calculateVisibleReputation, getTier } from '../utils/reputation';

const prismaAny = prisma as any;

const EVALUABLE_SPORT_STATUSES = new Set(['settled', 'released', 'refunded']);
const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 50;
const MAX_MATCH_SCAN = 5000;
const MAX_BATCH_WALLETS = 25;
const DEFAULT_LEADERBOARD_LIMIT = 10;
const MAX_LEADERBOARD_LIMIT = 25;
const LEADERBOARD_CANDIDATE_SCAN = 1000;
const LEADERBOARD_PROFILE_CANDIDATES = 100;
const MIN_CONFIDENT_SPORT_SAMPLE = 5;
const MIN_TRUSTED_SPORT_SAMPLE = 10;

type SportRole = 'maker' | 'taker';
type RiskSeverity = 'info' | 'warning' | 'critical';
type CounterpartyAction = 'accept' | 'accept_with_collateral' | 'counter_or_request_more_collateral' | 'avoid_or_manual_review';

export interface ReputationProfileOptions {
    includeHistory?: boolean;
    recentLimit?: number;
}

export interface ReputationLeaderboardOptions extends ReputationProfileOptions {
    limit?: number;
    minSettledPredictions?: number;
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

function tryNormalizeWallet(walletInput: unknown): { wallet?: string; error?: string; input: string } {
    const input = typeof walletInput === 'string' ? walletInput.trim() : String(walletInput || '').trim();
    try {
        return { wallet: validateWallet(input), input };
    } catch {
        return { error: 'invalid_wallet', input };
    }
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

function trimString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fixtureSource(fixture: any): string {
    return String(asRecord(fixture?.raw).source || '').trim().toLowerCase();
}

function isLegacySportFixtureId(value: unknown): boolean {
    const fixtureId = trimString(value);
    return Boolean(fixtureId?.startsWith('espn:') || fixtureId?.startsWith('hosted-smoke-'));
}

function isReputationSportCandidate(match: any, fixture?: any | null): boolean {
    if (!trimString(match?.fixtureId) || isLegacySportFixtureId(match.fixtureId)) return false;
    const source = fixtureSource(fixture);
    if (source) return source === 'txline';
    return true;
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

function round(value: number, digits = 2): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
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

function normalizeLeaderboardLimit(value: number | undefined): number {
    if (value === undefined || value === null) return DEFAULT_LEADERBOARD_LIMIT;
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return DEFAULT_LEADERBOARD_LIMIT;
    return Math.min(Math.max(parsed, 1), MAX_LEADERBOARD_LIMIT);
}

function calculateSampleConfidence(evaluable: number): number {
    if (evaluable <= 0) return 0;
    return Math.min(1, Math.log10(evaluable + 1) / Math.log10(51));
}

function calculateVolumeConfidence(totalNotional: number): number {
    if (totalNotional <= 0) return 0;
    return Math.min(1, Math.log10(totalNotional + 1) / Math.log10(101));
}

function calculateWilsonLowerBound(successes: number, total: number): number | null {
    if (total <= 0) return null;
    const z = 1.96;
    const p = successes / total;
    const z2 = z * z;
    const denominator = 1 + z2 / total;
    const center = p + z2 / (2 * total);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
    return Math.max(0, (center - margin) / denominator);
}

function formatConfidence(value: number): number {
    return round(value, 4);
}

function buildScore(params: {
    dealScore: number;
    dealCount: number;
    cancelledDeals: number;
    disputedDeals: number;
    sportEvaluable: number;
    rawAccuracy: number | null;
    adjustedAccuracy: number | null;
    sportNotional: number;
}): { score: number; breakdown: Record<string, unknown> } {
    if (params.dealCount <= 0 && params.sportEvaluable <= 0) {
        return {
            score: 0,
            breakdown: {
                dealReliability: 0,
                predictionAccuracy: 0,
                sampleConfidence: 0,
                notionalConfidence: 0,
                cancellationPenalty: 0,
                disputePenalty: 0,
            },
        };
    }

    if (params.sportEvaluable <= 0) {
        return {
            score: Math.round(params.dealScore),
            breakdown: {
                dealReliability: round(params.dealScore),
                predictionAccuracy: null,
                sampleConfidence: 0,
                notionalConfidence: 0,
                cancellationPenalty: 0,
                disputePenalty: 0,
            },
        };
    }

    const adjustedAccuracyScore = (params.adjustedAccuracy ?? 0) * 100;
    const sampleConfidence = calculateSampleConfidence(params.sportEvaluable);
    const sampleScore = sampleConfidence * 100;
    const volumeScore = calculateVolumeConfidence(params.sportNotional) * 100;
    const sportWeight = Math.min(0.65, sampleConfidence);
    const dealWeight = 1 - sportWeight;
    const sportComposite =
        (adjustedAccuracyScore * 0.70) +
        (sampleScore * 0.20) +
        (volumeScore * 0.10);
    const cancellationPenalty = params.dealCount > 0
        ? Math.min(15, (params.cancelledDeals / params.dealCount) * 15)
        : 0;
    const disputePenalty = params.dealCount > 0
        ? Math.min(20, (params.disputedDeals / params.dealCount) * 20)
        : 0;

    const score =
        (params.dealScore * dealWeight) +
        (sportComposite * sportWeight) -
        cancellationPenalty -
        disputePenalty;

    return {
        score: Math.max(0, Math.min(100, Math.round(score))),
        breakdown: {
            dealReliability: round(params.dealScore),
            predictionAccuracyRaw: params.rawAccuracy === null ? null : round(params.rawAccuracy * 100),
            predictionAccuracyAdjusted: params.adjustedAccuracy === null ? null : round(params.adjustedAccuracy * 100),
            sampleConfidence: round(sampleScore),
            notionalConfidence: round(volumeScore),
            sportComposite: round(sportComposite),
            sportWeight: round(sportWeight * 100),
            dealWeight: round(dealWeight * 100),
            cancellationPenalty: round(cancellationPenalty),
            disputePenalty: round(disputePenalty),
        },
    };
}

function buildRiskFlags(params: {
    registered: boolean;
    dealCount: number;
    cancelledDeals: number;
    disputedDeals: number;
    sportEvaluable: number;
    rawAccuracy: number | null;
    adjustedAccuracy: number | null;
    pending: number;
    failed: number;
    unevaluableSettled: number;
    truncated: boolean;
}): Array<{ code: string; severity: RiskSeverity; message: string }> {
    const flags: Array<{ code: string; severity: RiskSeverity; message: string }> = [];
    if (!params.registered && params.sportEvaluable === 0) {
        flags.push({
            code: 'fresh_wallet',
            severity: 'warning',
            message: 'Wallet has no AIR OTC deal or settled SPORT prediction history.',
        });
    }
    if (params.sportEvaluable === 0) {
        flags.push({
            code: 'no_sport_settlements',
            severity: 'info',
            message: 'No settled SPORT predictions are available for this wallet yet.',
        });
    } else if (params.sportEvaluable < MIN_CONFIDENT_SPORT_SAMPLE) {
        flags.push({
            code: 'low_sport_sample',
            severity: 'warning',
            message: `Only ${params.sportEvaluable} settled SPORT prediction(s); treat accuracy as low-confidence.`,
        });
    } else if (params.sportEvaluable < MIN_TRUSTED_SPORT_SAMPLE) {
        flags.push({
            code: 'medium_sport_sample',
            severity: 'info',
            message: `Only ${params.sportEvaluable} settled SPORT predictions; confidence is still building.`,
        });
    }
    if (params.rawAccuracy !== null && params.sportEvaluable >= MIN_CONFIDENT_SPORT_SAMPLE && params.rawAccuracy < 0.45) {
        flags.push({
            code: 'low_prediction_accuracy',
            severity: 'warning',
            message: `SPORT prediction accuracy is ${round(params.rawAccuracy * 100)}% across ${params.sportEvaluable} settled prediction(s).`,
        });
    }
    if (params.dealCount > 0 && params.cancelledDeals / params.dealCount > 0.25) {
        flags.push({
            code: 'high_cancellation_rate',
            severity: 'warning',
            message: 'Cancellation rate is above 25% of historical AIR OTC deals.',
        });
    }
    if (params.dealCount > 0 && params.disputedDeals / params.dealCount > 0.1) {
        flags.push({
            code: 'dispute_history',
            severity: 'critical',
            message: 'Dispute rate is above 10% of historical AIR OTC deals.',
        });
    }
    if (params.pending >= 5) {
        flags.push({
            code: 'open_sport_exposure',
            severity: 'info',
            message: `${params.pending} SPORT match(es) are still pending settlement.`,
        });
    }
    if (params.failed > 0) {
        flags.push({
            code: 'settlement_failures',
            severity: 'warning',
            message: `${params.failed} SPORT match(es) ended in failed settlement state.`,
        });
    }
    if (params.unevaluableSettled > 0) {
        flags.push({
            code: 'missing_outcome_link',
            severity: 'warning',
            message: `${params.unevaluableSettled} settled SPORT match(es) could not be evaluated because outcome/direction data was missing.`,
        });
    }
    if (params.truncated) {
        flags.push({
            code: 'history_truncated',
            severity: 'info',
            message: `Only the most recent ${MAX_MATCH_SCAN} SPORT matches were scanned.`,
        });
    }
    return flags;
}

function summarizeRisk(flags: Array<{ severity: RiskSeverity }>): 'low' | 'medium' | 'high' | 'critical' {
    if (flags.some((flag) => flag.severity === 'critical')) return 'critical';
    if (flags.filter((flag) => flag.severity === 'warning').length >= 2) return 'high';
    if (flags.some((flag) => flag.severity === 'warning')) return 'medium';
    return 'low';
}

function recommendedAction(score: number, riskLevel: string, sportEvaluable: number): CounterpartyAction {
    if (riskLevel === 'critical' || score < 25) return 'avoid_or_manual_review';
    if (score < 50) return 'counter_or_request_more_collateral';
    if (score < 75 || sportEvaluable < MIN_CONFIDENT_SPORT_SAMPLE) return 'accept_with_collateral';
    return 'accept';
}

function trustSummary(tier: string, sportEvaluable: number, rawAccuracy: number | null, adjustedAccuracy: number | null): string {
    if (sportEvaluable <= 0) return 'No settled SPORT prediction history yet';
    const accuracyPct = Math.round((rawAccuracy ?? 0) * 100);
    const adjustedPct = Math.round((adjustedAccuracy ?? 0) * 100);
    if (tier === 'elite') return `Elite counterparty: ${accuracyPct}% raw SPORT accuracy, ${adjustedPct}% confidence-adjusted`;
    if (tier === 'trusted') return `Reliable counterparty: ${accuracyPct}% raw SPORT accuracy, ${adjustedPct}% confidence-adjusted`;
    if (tier === 'neutral') return `Some SPORT history: ${accuracyPct}% raw SPORT accuracy, ${adjustedPct}% confidence-adjusted`;
    return `Risky or unproven SPORT counterparty: ${accuracyPct}% raw SPORT accuracy, ${adjustedPct}% confidence-adjusted`;
}

export async function getReputationProfile(
    walletInput: string,
    options: ReputationProfileOptions = {},
): Promise<Record<string, any>> {
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
    const rawFixtureIds: string[] = Array.from(new Set<string>(scannedMatches
        .map((match: any) => match.fixtureId)
        .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id))));

    const fixtures = rawFixtureIds.length > 0 && prismaAny.arenaFixture?.findMany
        ? await prismaAny.arenaFixture.findMany({ where: { fixtureId: { in: rawFixtureIds } } })
        : [];
    const fixturesByFixtureId = new Map<string, any>((fixtures as any[]).map((fixture: any) => [fixture.fixtureId, fixture]));
    const reputationMatches = scannedMatches.filter((match: any) => (
        isReputationSportCandidate(match, fixturesByFixtureId.get(match.fixtureId))
    ));
    const ignoredLegacyMatches = scannedMatches.length - reputationMatches.length;

    const fixtureIds: string[] = Array.from(new Set<string>(reputationMatches
        .map((match: any) => match.fixtureId)
        .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id))));
    const offerIds: string[] = Array.from(new Set<string>(reputationMatches
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
    let unevaluableSettled = 0;
    let makerCount = 0;
    let takerCount = 0;
    let totalNotional = 0;

    for (const match of reputationMatches) {
        const role = roleForWallet(match, wallet);
        if (!role) continue;
        if (role === 'maker') makerCount += 1;
        if (role === 'taker') takerCount += 1;

        const status = typeof match.status === 'string' ? match.status : 'unknown';
        if (status === 'cancelled') {
            cancelled += 1;
            continue;
        }
        if (status === 'failed') {
            failed += 1;
            continue;
        }
        if (!EVALUABLE_SPORT_STATUSES.has(status)) {
            pending += 1;
            continue;
        }

        const outcome = outcomesByFixture.get(match.fixtureId);
        const outcomeWinner = typeof match.outcomeWinner === 'string'
            ? match.outcomeWinner
            : typeof outcome?.winner === 'string' ? outcome.winner : null;
        const makerWins = inferMakerWins(match, outcomeWinner);
        if (makerWins === null) {
            unevaluableSettled += 1;
            continue;
        }

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
    const rawAccuracy = evaluated.length > 0 ? correct / evaluated.length : null;
    const adjustedAccuracy = calculateWilsonLowerBound(correct, evaluated.length);
    const sampleConfidence = calculateSampleConfidence(evaluated.length);
    const volumeConfidence = calculateVolumeConfidence(totalNotional);
    const currentStreak = evaluated.reduce((streak, item, index) => {
        if (index === 0) return 1;
        if (streak === 0) return 0;
        return item.correct === evaluated[0].correct ? streak + 1 : 0;
    }, 0);

    const dealScore = agent ? calculateVisibleReputation(agent as any) : 0;
    const dealCount = toNumber(agent?.totalDeals);
    const successfulDeals = toNumber(agent?.successfulDeals);
    const cancelledDeals = toNumber(agent?.cancelledDeals);
    const disputedDeals = toNumber(agent?.disputedDeals);
    const scoreResult = buildScore({
        dealScore,
        dealCount,
        cancelledDeals,
        disputedDeals,
        sportEvaluable: evaluated.length,
        rawAccuracy,
        adjustedAccuracy,
        sportNotional: totalNotional,
    });
    const tier = getTier(scoreResult.score, dealCount + evaluated.length);
    const riskFlags = buildRiskFlags({
        registered: Boolean(agent),
        dealCount,
        cancelledDeals,
        disputedDeals,
        sportEvaluable: evaluated.length,
        rawAccuracy,
        adjustedAccuracy,
        pending,
        failed,
        unevaluableSettled,
        truncated: sportMatches.length > MAX_MATCH_SCAN,
    });
    const riskLevel = summarizeRisk(riskFlags);
    const action = recommendedAction(scoreResult.score, riskLevel, evaluated.length);

    return {
        wallet,
        registered: Boolean(agent),
        score: scoreResult.score,
        tier,
        riskLevel,
        recommendedCounterpartyAction: action,
        trustSummary: trustSummary(tier, evaluated.length, rawAccuracy, adjustedAccuracy),
        algorithm: {
            version: 'sport_reputation_v2',
            formula: evaluated.length > 0
                ? 'Sample-weighted blend of visible deal reliability and SPORT prediction quality; SPORT weight ramps up with settled sample confidence and is capped at 65%'
                : 'Visible deal reliability score; fresh wallets score 0 until settled history exists',
            scoreRange: [0, 100],
            accuracyMethod: 'Wilson lower bound at 95% confidence; raw accuracy is shown separately',
            computedFrom: ['Agent deal counters', 'ArenaMatch SPORT settlements', 'ArenaOutcome TxLINE winners'],
            eventHistorySource: 'AgentEvent where event = reputation.update',
            minimumConfidentSportSample: MIN_CONFIDENT_SPORT_SAMPLE,
            minimumTrustedSportSample: MIN_TRUSTED_SPORT_SAMPLE,
        },
        scoreBreakdown: scoreResult.breakdown,
        riskFlags,
        dealReputation: {
            score: dealScore,
            totalDeals: dealCount,
            successfulDeals,
            cancelledDeals,
            disputedDeals,
            totalVolume: agent?.totalVolume || '0',
            avgSettlementTime: agent?.avgSettlementTime || 0,
            successRate: dealCount > 0 ? round(successfulDeals / dealCount, 4) : null,
            cancellationRate: dealCount > 0 ? round(cancelledDeals / dealCount, 4) : null,
            disputeRate: dealCount > 0 ? round(disputedDeals / dealCount, 4) : null,
        },
        predictionReputation: {
            rollupMode: 'SPORT',
            totalMatches: reputationMatches.length,
            scannedLimit: MAX_MATCH_SCAN,
            truncated: sportMatches.length > MAX_MATCH_SCAN,
            ignoredLegacyMatches,
            evaluableSettledPredictions: evaluated.length,
            correctPredictions: correct,
            wrongPredictions: wrong,
            accuracy: rawAccuracy,
            accuracyPct: rawAccuracy === null ? null : round(rawAccuracy * 100),
            adjustedAccuracy,
            adjustedAccuracyPct: adjustedAccuracy === null ? null : round(adjustedAccuracy * 100),
            pendingMatches: pending,
            cancelledMatches: cancelled,
            failedMatches: failed,
            unevaluableSettledMatches: unevaluableSettled,
            sampleConfidence: formatConfidence(sampleConfidence),
            notional: round(totalNotional, 6),
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

export async function getReputationBatch(
    walletInputs: unknown[],
    options: ReputationProfileOptions = {},
): Promise<Record<string, unknown>> {
    if (!Array.isArray(walletInputs)) {
        throw httpError('wallets_must_be_array', 400);
    }
    if (walletInputs.length > MAX_BATCH_WALLETS) {
        throw httpError(`too_many_wallets:max_${MAX_BATCH_WALLETS}`, 400);
    }

    const seen = new Set<string>();
    const validWallets: string[] = [];
    const rejected: Array<{ wallet: string; error: string }> = [];

    for (const input of walletInputs) {
        const normalized = tryNormalizeWallet(input);
        if (!normalized.wallet) {
            rejected.push({ wallet: normalized.input, error: normalized.error || 'invalid_wallet' });
            continue;
        }
        if (seen.has(normalized.wallet)) continue;
        seen.add(normalized.wallet);
        validWallets.push(normalized.wallet);
    }

    const profiles = await Promise.all(
        validWallets.map((wallet) => getReputationProfile(wallet, {
            includeHistory: options.includeHistory,
            recentLimit: options.recentLimit,
        })),
    );

    return {
        success: true,
        count: profiles.length,
        rejected,
        maxWallets: MAX_BATCH_WALLETS,
        data: profiles,
        generatedAt: new Date().toISOString(),
    };
}

export async function getReputationLeaderboard(
    options: ReputationLeaderboardOptions = {},
): Promise<Record<string, unknown>> {
    const limit = normalizeLeaderboardLimit(options.limit);
    const minSettledPredictions = Math.max(0, Math.floor(Number(options.minSettledPredictions || 0)));

    const [sportMatches, topAgents] = await Promise.all([
        prismaAny.arenaMatch.findMany({
            where: { rollupMode: 'SPORT' },
            orderBy: [{ settledAt: 'desc' }, { createdAt: 'desc' }],
            take: LEADERBOARD_CANDIDATE_SCAN,
            select: { makerWallet: true, takerWallet: true, buyerWallet: true, sellerWallet: true },
        }),
        prisma.agent.findMany({
            orderBy: [{ successfulDeals: 'desc' }, { totalDeals: 'desc' }],
            take: LEADERBOARD_PROFILE_CANDIDATES,
            select: { wallet: true },
        }),
    ]);

    const walletSet = new Set<string>();
    for (const match of sportMatches as any[]) {
        for (const candidate of [match.makerWallet, match.takerWallet, match.buyerWallet, match.sellerWallet]) {
            if (typeof candidate === 'string' && candidate) walletSet.add(candidate);
        }
    }
    for (const agent of topAgents as any[]) {
        if (typeof agent.wallet === 'string' && agent.wallet) walletSet.add(agent.wallet);
    }

    const candidateWallets = Array.from(walletSet).slice(0, LEADERBOARD_PROFILE_CANDIDATES);
    const profiles = await Promise.all(
        candidateWallets.map((wallet) => getReputationProfile(wallet, {
            includeHistory: false,
            recentLimit: options.recentLimit,
        })),
    );

    const ranked = profiles
        .filter((profile: any) => profile.predictionReputation.evaluableSettledPredictions >= minSettledPredictions)
        .sort((a: any, b: any) => {
            if (b.score !== a.score) return b.score - a.score;
            const bAdjusted = b.predictionReputation.adjustedAccuracy ?? -1;
            const aAdjusted = a.predictionReputation.adjustedAccuracy ?? -1;
            if (bAdjusted !== aAdjusted) return bAdjusted - aAdjusted;
            return b.predictionReputation.evaluableSettledPredictions - a.predictionReputation.evaluableSettledPredictions;
        })
        .slice(0, limit)
        .map((profile: any, index) => ({
            rank: index + 1,
            wallet: profile.wallet,
            score: profile.score,
            tier: profile.tier,
            riskLevel: profile.riskLevel,
            recommendedCounterpartyAction: profile.recommendedCounterpartyAction,
            predictionReputation: {
                evaluableSettledPredictions: profile.predictionReputation.evaluableSettledPredictions,
                correctPredictions: profile.predictionReputation.correctPredictions,
                wrongPredictions: profile.predictionReputation.wrongPredictions,
                accuracyPct: profile.predictionReputation.accuracyPct,
                adjustedAccuracyPct: profile.predictionReputation.adjustedAccuracyPct,
                notional: profile.predictionReputation.notional,
            },
            dealReputation: {
                totalDeals: profile.dealReputation.totalDeals,
                successfulDeals: profile.dealReputation.successfulDeals,
                cancelledDeals: profile.dealReputation.cancelledDeals,
                disputedDeals: profile.dealReputation.disputedDeals,
            },
            trustSummary: profile.trustSummary,
        }));

    return {
        success: true,
        data: ranked,
        limit,
        minSettledPredictions,
        candidateWallets: candidateWallets.length,
        generatedAt: new Date().toISOString(),
    };
}
