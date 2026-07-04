import { PublicKey } from '@solana/web3.js';
import { prisma } from '../lib/prisma';
import { serializeArenaMatch } from './arena/arenaMatch.service';
import { getReputationProfile } from './reputationProfile.service';

const prismaAny = prisma as any;

const MAX_HISTORY_LIMIT = 200;
const MAX_DISCOVERY_LIMIT = 50;
const TEMPLATE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const EVALUABLE_STATUSES = new Set(['settled', 'released', 'refunded']);

type SportRole = 'maker' | 'taker';

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

function trimString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeTemplateName(nameInput: unknown): string {
    const name = trimString(nameInput);
    if (!name || !TEMPLATE_NAME_RE.test(name)) {
        throw httpError('invalid_strategy_template_name', 400);
    }
    return name;
}

function asRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function jsonValue(value: unknown): any {
    return JSON.parse(JSON.stringify(value ?? {}));
}

function serializeDate(value: unknown): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

function round(value: number, digits = 4): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, 1), max);
}

function fixtureSource(fixture: any): string {
    return String(asRecord(fixture?.raw).source || '').trim().toLowerCase();
}

function isLegacySportFixtureId(value: unknown): boolean {
    const fixtureId = trimString(value);
    return Boolean(fixtureId?.startsWith('espn:') || fixtureId?.startsWith('hosted-smoke-'));
}

function isNumericTxlineFixtureId(value: unknown): boolean {
    const fixtureId = trimString(value);
    return Boolean(fixtureId && /^\d+$/.test(fixtureId));
}

function isTrustedSportMatch(match: any, fixture?: any | null): boolean {
    if (!trimString(match?.fixtureId) || isLegacySportFixtureId(match.fixtureId)) return false;
    const source = fixtureSource(fixture);
    if (source) return source === 'txline';
    return isNumericTxlineFixtureId(match.fixtureId);
}

function roleForWallet(match: any, wallet: string): SportRole | null {
    if (match?.makerWallet === wallet) return 'maker';
    if (match?.takerWallet === wallet) return 'taker';
    if (!match?.takerWallet && match?.makerWallet !== wallet) {
        if (match?.buyerWallet === wallet || match?.sellerWallet === wallet) return 'taker';
    }
    return null;
}

function inferMakerWins(match: any, outcomeWinner: string | null): boolean | null {
    const direction = trimString(match?.direction);
    const selection = trimString(match?.selection);
    if (!direction || !selection || !outcomeWinner) return null;
    if (direction === 'BUY_SELECTION') return selection === outcomeWinner;
    if (direction === 'SELL_SELECTION') return selection !== outcomeWinner;
    return null;
}

function sportAsset(params: {
    fixtureId: string;
    marketType: string;
    selection: string;
    asset?: string | null;
}): string {
    const supplied = trimString(params.asset);
    if (supplied) return supplied;
    return ['TXLINE', params.fixtureId, params.marketType, params.selection]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(':')
        .slice(0, 200);
}

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
    return rest as T;
}

async function fixtureMapForMatches(matches: any[]): Promise<Map<string, any>> {
    if (!prismaAny.arenaFixture?.findMany || matches.length === 0) return new Map();
    const fixtureIds = [...new Set(matches.map((match) => trimString(match.fixtureId)).filter(Boolean))];
    if (fixtureIds.length === 0) return new Map();
    const fixtures = await prismaAny.arenaFixture.findMany({
        where: { fixtureId: { in: fixtureIds } },
    });
    return new Map(fixtures.map((fixture: any) => [fixture.fixtureId, fixture]));
}

function normalizeOfferDefaults(raw: unknown): Record<string, any> {
    const defaults = asRecord(raw);
    const mode = defaults.mode === 'buy' || defaults.mode === 'sell' ? defaults.mode : undefined;
    const amount = toNumber(defaults.amount);
    const price = toNumber(defaults.price);
    const collateral = toNumber(defaults.collateral);
    if (!mode) throw httpError('template_mode_required', 400);
    if (amount <= 0) throw httpError('template_amount_must_be_positive', 400);
    if (price <= 0) throw httpError('template_price_must_be_positive', 400);
    if (collateral < 0) throw httpError('template_collateral_must_be_non_negative', 400);

    return {
        mode,
        amount,
        price,
        collateral,
        marketType: trimString(defaults.marketType) || null,
        selection: trimString(defaults.selection) || null,
        asset: trimString(defaults.asset) || null,
        settlementWallet: trimString(defaults.settlementWallet) || null,
        rewardWallet: trimString(defaults.rewardWallet) || null,
        fundingWallet: trimString(defaults.fundingWallet) || null,
    };
}

function mergeTemplateDefaults(templateDefaults: unknown, overrides: unknown): Record<string, any> {
    const base = normalizeOfferDefaults(templateDefaults);
    const patch = asRecord(overrides);
    const merged = {
        ...base,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== null && value !== '')),
    };
    return normalizeOfferDefaults(merged);
}

export async function listMySportTrades(
    walletInput: string,
    options: { limit?: unknown; includeLegacy?: unknown } = {},
): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const limit = normalizeLimit(options.limit, 100, MAX_HISTORY_LIMIT);
    const includeLegacy = options.includeLegacy === true || options.includeLegacy === 'true';

    const matches = await prismaAny.arenaMatch.findMany({
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
        take: limit + 1,
    });
    const fixturesById = await fixtureMapForMatches(matches);
    const trustedMatches = includeLegacy
        ? matches
        : matches.filter((match: any) => isTrustedSportMatch(match, fixturesById.get(match.fixtureId)));
    const selectedMatches = trustedMatches.slice(0, limit);
    const ignoredLegacyMatches = includeLegacy ? 0 : matches.length - trustedMatches.length;

    const fixtureIds = [...new Set<string>(selectedMatches
        .map((match: any) => match.fixtureId)
        .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id)))];
    const offerIds = [...new Set<string>(selectedMatches
        .map((match: any) => match.offerId)
        .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id)))];
    const [outcomes, offers] = await Promise.all([
        fixtureIds.length > 0
            ? prismaAny.arenaOutcome.findMany({ where: { fixtureId: { in: fixtureIds } } })
            : Promise.resolve([]),
        offerIds.length > 0
            ? prisma.offer.findMany({ where: { id: { in: offerIds } } })
            : Promise.resolve([]),
    ]);
    const outcomesByFixture = new Map((outcomes as any[]).map((outcome: any) => [outcome.fixtureId, outcome]));
    const offersById = new Map((offers as any[]).map((offer: any) => [offer.id, offer]));

    let evaluable = 0;
    let correct = 0;
    let wrong = 0;
    let pending = 0;
    let cancelled = 0;
    let failed = 0;
    let notionalWon = 0;
    let notionalLost = 0;
    const byMarket = new Map<string, any>();
    const bySelection = new Map<string, any>();

    const trades = selectedMatches.map((match: any) => {
        const role = roleForWallet(match, wallet);
        const fixture = fixturesById.get(match.fixtureId);
        const offer = match.offerId ? offersById.get(match.offerId) : null;
        const outcome = outcomesByFixture.get(match.fixtureId);
        const outcomeWinner = trimString(match.outcomeWinner) || trimString(outcome?.winner) || null;
        const makerWins = inferMakerWins(match, outcomeWinner);
        const status = trimString(match.status) || 'unknown';
        const notionalSol = offer ? toNumber(offer.price) * toNumber(offer.amount || 1) : 0;
        const marketKey = trimString(match.marketType) || 'unknown';
        const selectionKey = trimString(match.selection) || 'unknown';

        let result: 'correct' | 'wrong' | 'pending' | 'cancelled' | 'failed' | 'unevaluable' = 'pending';
        if (status === 'cancelled') result = 'cancelled';
        else if (status === 'failed') result = 'failed';
        else if (EVALUABLE_STATUSES.has(status) && makerWins !== null && role) {
            const walletCorrect = role === 'maker' ? makerWins : !makerWins;
            result = walletCorrect ? 'correct' : 'wrong';
        } else if (EVALUABLE_STATUSES.has(status)) {
            result = 'unevaluable';
        }

        if (result === 'correct' || result === 'wrong') {
            evaluable += 1;
            if (result === 'correct') {
                correct += 1;
                notionalWon += notionalSol;
            } else {
                wrong += 1;
                notionalLost += notionalSol;
            }

            for (const [map, key] of [[byMarket, marketKey], [bySelection, selectionKey]] as const) {
                const current = map.get(key) || { key, total: 0, correct: 0, wrong: 0, estimatedPnlSol: 0 };
                current.total += 1;
                if (result === 'correct') current.correct += 1;
                if (result === 'wrong') current.wrong += 1;
                current.estimatedPnlSol += result === 'correct' ? notionalSol : -notionalSol;
                map.set(key, current);
            }
        } else if (result === 'pending') pending += 1;
        else if (result === 'cancelled') cancelled += 1;
        else if (result === 'failed') failed += 1;

        return {
            matchId: match.id,
            fixtureId: match.fixtureId,
            fixture: fixture ? {
                homeTeam: fixture.homeTeam,
                awayTeam: fixture.awayTeam,
                startsAt: serializeDate(fixture.startsAt),
                status: fixture.status,
                source: fixtureSource(fixture) || null,
            } : null,
            ticketId: match.ticketId || null,
            offerId: match.offerId || null,
            role,
            counterpartyWallet: role === 'maker' ? match.takerWallet || null : match.makerWallet || null,
            marketType: match.marketType || null,
            selection: match.selection || null,
            direction: match.direction || null,
            outcomeWinner,
            result,
            status,
            settlementAction: match.settlementAction || null,
            winnerWallet: match.winnerWallet || null,
            notionalSol: round(notionalSol, 6),
            estimatedPnlSol: result === 'correct' ? round(notionalSol, 6) : result === 'wrong' ? round(-notionalSol, 6) : 0,
            releaseTx: match.releaseTx || null,
            refundTx: match.refundTx || null,
            settledAt: serializeDate(match.settledAt),
            createdAt: serializeDate(match.createdAt),
        };
    });

    const decorateBucket = (bucket: any) => ({
        ...bucket,
        accuracyPct: bucket.total > 0 ? round((bucket.correct / bucket.total) * 100, 2) : null,
        estimatedPnlSol: round(bucket.estimatedPnlSol, 6),
    });

    return {
        wallet,
        summary: {
            totalTrades: selectedMatches.length,
            evaluableSettled: evaluable,
            correct,
            wrong,
            pending,
            cancelled,
            failed,
            ignoredLegacyMatches,
            rawAccuracyPct: evaluable > 0 ? round((correct / evaluable) * 100, 2) : null,
            notionalWonSol: round(notionalWon, 6),
            notionalLostSol: round(notionalLost, 6),
            netEstimatedPnlSol: round(notionalWon - notionalLost, 6),
        },
        marketPerformance: Array.from(byMarket.values()).map(decorateBucket),
        selectionPerformance: Array.from(bySelection.values()).map(decorateBucket),
        trades,
    };
}

export async function listStrategyTemplates(walletInput: string): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const templates = await prismaAny.agentStrategyTemplate.findMany({
        where: { wallet },
        orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
    });
    return {
        wallet,
        count: templates.length,
        data: templates.map((template: any) => ({
            id: template.id,
            wallet: template.wallet,
            name: template.name,
            description: template.description || null,
            enabled: template.enabled,
            defaults: template.defaults,
            createdAt: serializeDate(template.createdAt),
            updatedAt: serializeDate(template.updatedAt),
        })),
    };
}

export async function upsertStrategyTemplate(
    walletInput: string,
    input: { name?: unknown; description?: unknown; defaults?: unknown; enabled?: unknown },
): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const name = normalizeTemplateName(input.name);
    const defaults = normalizeOfferDefaults(input.defaults);
    const enabled = input.enabled !== false;
    const description = trimString(input.description) || null;

    await prisma.agent.upsert({
        where: { wallet },
        update: {},
        create: { wallet },
    });

    const template = await prismaAny.agentStrategyTemplate.upsert({
        where: { wallet_name: { wallet, name } },
        update: { description, defaults: jsonValue(defaults), enabled },
        create: { wallet, name, description, defaults: jsonValue(defaults), enabled },
    });

    return {
        id: template.id,
        wallet: template.wallet,
        name: template.name,
        description: template.description || null,
        enabled: template.enabled,
        defaults: template.defaults,
        createdAt: serializeDate(template.createdAt),
        updatedAt: serializeDate(template.updatedAt),
    };
}

export async function deleteStrategyTemplate(walletInput: string, nameInput: unknown): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const name = normalizeTemplateName(nameInput);
    const deleted = await prismaAny.agentStrategyTemplate.deleteMany({ where: { wallet, name } });
    return {
        wallet,
        name,
        deleted: deleted.count > 0,
    };
}

export async function createSportOfferFromTemplate(
    walletInput: string,
    nameInput: unknown,
    input: { fixtureId?: unknown; overrides?: unknown } = {},
): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const name = normalizeTemplateName(nameInput);
    const template = await prismaAny.agentStrategyTemplate.findUnique({ where: { wallet_name: { wallet, name } } });
    if (!template || template.enabled === false) {
        throw httpError('strategy_template_not_found_or_disabled', 404);
    }

    const overrides = asRecord(input.overrides);
    const defaults = mergeTemplateDefaults(template.defaults, overrides);
    const fixtureId = trimString(input.fixtureId) || trimString(overrides.fixtureId);
    const marketType = trimString(defaults.marketType) || trimString(overrides.marketType);
    const selection = trimString(defaults.selection) || trimString(overrides.selection);
    if (!fixtureId) throw httpError('fixtureId_required', 400);
    if (!marketType) throw httpError('marketType_required', 400);
    if (!selection) throw httpError('selection_required', 400);

    const result = await prisma.$transaction(async (tx) => {
        const agent = await tx.agent.upsert({
            where: { wallet },
            update: {},
            create: { wallet },
        });

        let fixture: any = null;
        try {
            fixture = await (tx as any).arenaFixture.findUnique({ where: { fixtureId } });
        } catch {
            fixture = null;
        }

        const offer = await tx.offer.create({
            data: {
                creatorId: agent.id,
                asset: sportAsset({ fixtureId, marketType, selection, asset: defaults.asset }),
                price: defaults.price,
                amount: defaults.amount,
                mode: defaults.mode,
                rollupMode: 'SPORT',
                collateral: defaults.collateral,
                tokenMint: null,
                tokenDecimals: 9,
                creatorSettlementWallet: defaults.settlementWallet || null,
                creatorRewardWallet: defaults.rewardWallet || null,
                creatorFundingWallet: defaults.fundingWallet || null,
                fixtureId,
                marketType,
                selection,
            },
        });

        const arenaMatch = await (tx as any).arenaMatch.create({
            data: {
                fixtureId,
                offerId: offer.id,
                strategy: `template:${name}`,
                marketType,
                selection,
                direction: defaults.mode === 'sell' ? 'SELL_SELECTION' : 'BUY_SELECTION',
                makerWallet: wallet,
                rollupMode: 'SPORT',
                status: 'offer_created',
                startedAt: new Date(),
                proof: {
                    createdBy: 'sport_strategy_template',
                    templateName: name,
                    fixtureKnown: Boolean(fixture),
                    settlementSource: 'txline',
                },
            },
        });

        return { offer, arenaMatch };
    });

    return {
        template: {
            id: template.id,
            name: template.name,
        },
        offer: sanitizeOffer(result.offer),
        arenaMatch: serializeArenaMatch(result.arenaMatch),
    };
}

export async function discoverSportAgents(options: {
    limit?: unknown;
    fixtureId?: unknown;
    marketType?: unknown;
    minSettledPredictions?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const limit = normalizeLimit(options.limit, 25, MAX_DISCOVERY_LIMIT);
    const fixtureId = trimString(options.fixtureId);
    const marketType = trimString(options.marketType);
    const minSettledPredictions = Math.max(0, Math.floor(Number(options.minSettledPredictions || 0)));

    const [rawOffers, rawRecentMatches] = await Promise.all([
        prisma.offer.findMany({
            where: {
                rollupMode: 'SPORT',
                status: 'active',
                ...(fixtureId ? { fixtureId } : {}),
                ...(marketType ? { marketType } : {}),
            },
            include: { creator: { select: { wallet: true } } },
            orderBy: { createdAt: 'desc' },
            take: 250,
        }),
        prismaAny.arenaMatch.findMany({
            where: {
                rollupMode: 'SPORT',
                ...(fixtureId ? { fixtureId } : {}),
                ...(marketType ? { marketType } : {}),
            },
            orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
            take: 500,
        }),
    ]);
    const fixtureIds = [...new Set([
        ...(rawOffers as any[]).map((offer: any) => trimString(offer.fixtureId)),
        ...(rawRecentMatches as any[]).map((match: any) => trimString(match.fixtureId)),
    ].filter(Boolean) as string[])];
    const fixtures = fixtureIds.length > 0 && prismaAny.arenaFixture?.findMany
        ? await prismaAny.arenaFixture.findMany({ where: { fixtureId: { in: fixtureIds } } })
        : [];
    const fixturesById = new Map((fixtures as any[]).map((fixture: any) => [fixture.fixtureId, fixture]));
    const offers = (rawOffers as any[]).filter((offer: any) =>
        isTrustedSportMatch({ fixtureId: offer.fixtureId }, fixturesById.get(offer.fixtureId))
    );
    const recentMatches = (rawRecentMatches as any[]).filter((match: any) =>
        isTrustedSportMatch(match, fixturesById.get(match.fixtureId))
    );
    const ignoredLegacyOffers = (rawOffers as any[]).length - offers.length;
    const ignoredLegacyMatches = (rawRecentMatches as any[]).length - recentMatches.length;

    const walletMap = new Map<string, any>();
    const touch = (wallet?: string | null) => {
        if (!wallet) return null;
        if (!walletMap.has(wallet)) {
            walletMap.set(wallet, {
                wallet,
                activeSportOffers: 0,
                activeOfferSamples: [],
                pendingSportMatches: 0,
                settledSportMatches: 0,
                markets: new Set<string>(),
                fixtures: new Set<string>(),
                lastActiveAtMs: 0,
            });
        }
        return walletMap.get(wallet);
    };

    for (const offer of offers as any[]) {
        const entry = touch(offer.creator?.wallet);
        if (!entry) continue;
        entry.activeSportOffers += 1;
        if (entry.activeOfferSamples.length < 3) {
            entry.activeOfferSamples.push({
                offerId: offer.id,
                fixtureId: offer.fixtureId,
                marketType: offer.marketType,
                selection: offer.selection,
                mode: offer.mode,
                price: offer.price,
                amount: offer.amount,
                collateral: offer.collateral,
                createdAt: serializeDate(offer.createdAt),
            });
        }
        if (offer.marketType) entry.markets.add(offer.marketType);
        if (offer.fixtureId) entry.fixtures.add(offer.fixtureId);
        entry.lastActiveAtMs = Math.max(entry.lastActiveAtMs, new Date(offer.createdAt).getTime());
    }

    for (const match of recentMatches as any[]) {
        for (const wallet of [match.makerWallet, match.takerWallet, match.buyerWallet, match.sellerWallet]) {
            const entry = touch(wallet);
            if (!entry) continue;
            if (match.marketType) entry.markets.add(match.marketType);
            if (match.fixtureId) entry.fixtures.add(match.fixtureId);
            if (EVALUABLE_STATUSES.has(match.status)) entry.settledSportMatches += 1;
            else if (!['cancelled', 'failed'].includes(match.status)) entry.pendingSportMatches += 1;
            entry.lastActiveAtMs = Math.max(entry.lastActiveAtMs, new Date(match.updatedAt || match.createdAt).getTime());
        }
    }

    const candidates = Array.from(walletMap.values())
        .sort((a, b) => b.lastActiveAtMs - a.lastActiveAtMs)
        .slice(0, Math.max(limit * 2, limit));
    const profiles = await Promise.all(
        candidates.map(async (entry) => {
            const profile: any = await getReputationProfile(entry.wallet, { includeHistory: false, recentLimit: 3 });
            return {
                wallet: entry.wallet,
                score: profile.score,
                tier: profile.tier,
                riskLevel: profile.riskLevel,
                trustSummary: profile.trustSummary,
                recommendedCounterpartyAction: profile.recommendedCounterpartyAction,
                activeSportOffers: entry.activeSportOffers,
                pendingSportMatches: entry.pendingSportMatches,
                settledSportMatches: profile.predictionReputation.evaluableSettledPredictions,
                accuracyPct: profile.predictionReputation.accuracyPct,
                adjustedAccuracyPct: profile.predictionReputation.adjustedAccuracyPct,
                markets: Array.from(entry.markets).sort(),
                fixtureIds: Array.from(entry.fixtures).slice(0, 10),
                activeOfferSamples: entry.activeOfferSamples,
                lastActiveAt: entry.lastActiveAtMs > 0 ? new Date(entry.lastActiveAtMs).toISOString() : null,
            };
        }),
    );

    return {
        count: profiles.filter((entry) => entry.settledSportMatches >= minSettledPredictions).slice(0, limit).length,
        filters: {
            fixtureId: fixtureId || null,
            marketType: marketType || null,
            minSettledPredictions,
        },
        ignoredLegacyOffers,
        ignoredLegacyMatches,
        data: profiles
            .filter((entry) => entry.settledSportMatches >= minSettledPredictions)
            .sort((a, b) => {
                if (b.activeSportOffers !== a.activeSportOffers) return b.activeSportOffers - a.activeSportOffers;
                if (b.score !== a.score) return b.score - a.score;
                return String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || ''));
            })
            .slice(0, limit),
    };
}
