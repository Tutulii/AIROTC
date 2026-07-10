import { PublicKey } from '@solana/web3.js';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { webhooks } from './webhookDelivery';

const prismaAny = prisma as any;
const SPORT_MARKET_TYPE = '1X2_PARTICIPANT_RESULT';
const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_INTENT_LIMIT = 100;
const DEFAULT_INTENT_LIMIT = 50;
const DEFAULT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

type SportSide = 'back' | 'lay';
type SportSelection = 'part1' | 'draw' | 'part2';
type SportIntentStatus = 'active' | 'cancelled' | 'expired' | 'matched' | 'all';

function httpError(message: string, statusCode = 400): Error {
    return Object.assign(new Error(message), { statusCode });
}

function trimString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validateWallet(value: unknown): string {
    const wallet = trimString(value);
    if (!wallet) throw httpError('wallet_required', 401);
    try {
        new PublicKey(wallet);
    } catch {
        throw httpError('invalid_wallet', 400);
    }
    return wallet;
}

function normalizeSelection(value: unknown): SportSelection {
    const selection = trimString(value)?.toLowerCase();
    if (selection === 'part1' || selection === 'draw' || selection === 'part2') return selection;
    throw httpError('sport_selection_must_be_part1_draw_or_part2', 400);
}

function normalizeSide(value: unknown): SportSide {
    const side = trimString(value)?.toLowerCase() || 'back';
    if (side === 'back' || side === 'lay') return side;
    throw httpError('sport_side_must_be_back_or_lay', 400);
}

function normalizeIntentStatus(value: unknown, fallback: SportIntentStatus): SportIntentStatus {
    const status = trimString(value)?.toLowerCase() || fallback;
    if (
        status === 'active'
        || status === 'cancelled'
        || status === 'expired'
        || status === 'matched'
        || status === 'all'
    ) {
        return status;
    }
    throw httpError('sport_intent_status_invalid', 400);
}

function normalizeLimit(value: unknown, fallback = DEFAULT_INTENT_LIMIT): number {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, 1), MAX_INTENT_LIMIT);
}

function validateFixtureId(value: unknown): string {
    const fixtureId = trimString(value);
    if (!fixtureId) throw httpError('fixtureId_required', 400);
    return fixtureId;
}

function normalizeClientIntentId(value: unknown): string | null {
    const id = trimString(value);
    if (!id) return null;
    if (!/^[a-zA-Z0-9._:-]{1,96}$/.test(id)) {
        throw httpError('clientIntentId_invalid', 400);
    }
    return id;
}

function normalizeNote(value: unknown): string | null {
    const note = trimString(value);
    if (!note) return null;
    return note.slice(0, 280);
}

function validateStakeLamports(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw httpError('stakeSol_must_be_positive', 400);
    const lamports = BigInt(Math.round(parsed * Number(LAMPORTS_PER_SOL)));
    if (lamports <= 0n) throw httpError('stakeSol_too_small', 400);
    return lamports.toString();
}

function bigintString(value: unknown, fallback = '0'): string {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value)).toString();
    if (typeof value === 'string' && /^\d+$/.test(value)) return value;
    return fallback;
}

function lamportsToSolNumber(value: unknown): number {
    return Number(BigInt(bigintString(value))) / Number(LAMPORTS_PER_SOL);
}

function oppositeSide(side: SportSide): SportSide {
    return side === 'back' ? 'lay' : 'back';
}

function complementSelection(selection: unknown): SportSelection | null {
    if (selection === 'part1') return 'part2';
    if (selection === 'part2') return 'part1';
    return null;
}

function complementBackMatchingEnabled(): boolean {
    return process.env.SPORT_COMPLEMENT_BACK_MATCHING_ENABLED !== 'false';
}

function matchingBranchesForDesired(selection: SportSelection, side: SportSide): Array<Record<string, string>> {
    const branches: Array<Record<string, string>> = [
        { selection, side: oppositeSide(side) },
    ];
    const complement = complementSelection(selection);
    if (complementBackMatchingEnabled() && side === 'back' && complement) {
        branches.push({ selection: complement, side: 'back' });
    }
    return branches;
}

function matchingIntentBranchesForPosition(position: any): Array<Record<string, string>> {
    const branches: Array<Record<string, string>> = [
        { selection: position.selection, side: oppositeSide(position.side as SportSide) },
    ];
    const complement = complementSelection(position.selection);
    if (complementBackMatchingEnabled() && position.side === 'back' && complement) {
        branches.push({ selection: complement, side: 'back' });
    }
    return branches;
}

function serializeDate(value: unknown): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function serializeIntent(row: any): Record<string, unknown> {
    return {
        id: row.id,
        wallet: row.wallet,
        fixtureId: row.fixtureId,
        marketType: row.marketType || SPORT_MARKET_TYPE,
        selection: row.selection,
        side: row.side,
        stakeLamports: row.stakeLamports || null,
        stakeSol: row.stakeLamports ? lamportsToSolNumber(row.stakeLamports) : null,
        minStakeLamports: row.minStakeLamports || null,
        minStakeSol: row.minStakeLamports ? lamportsToSolNumber(row.minStakeLamports) : null,
        maxStakeLamports: row.maxStakeLamports || null,
        maxStakeSol: row.maxStakeLamports ? lamportsToSolNumber(row.maxStakeLamports) : null,
        status: row.status,
        note: row.note || null,
        clientIntentId: row.clientIntentId || null,
        expiresAt: serializeDate(row.expiresAt),
        lastNotifiedAt: serializeDate(row.lastNotifiedAt),
        createdAt: serializeDate(row.createdAt),
        updatedAt: serializeDate(row.updatedAt),
    };
}

function serializePositionLiquidity(row: any, requestedLamports?: bigint | null): Record<string, unknown> {
    const remainingLamports = BigInt(bigintString(row.remainingLamports || row.stakeLamports));
    const fillLamports = requestedLamports && requestedLamports > 0n && requestedLamports < remainingLamports
        ? requestedLamports
        : remainingLamports;
    return {
        positionId: row.id,
        wallet: row.agentWallet,
        fixtureId: row.fixtureId,
        marketType: SPORT_MARKET_TYPE,
        selection: row.selection,
        side: row.side,
        status: row.status,
        remainingLamports: remainingLamports.toString(),
        remainingSol: lamportsToSolNumber(remainingLamports.toString()),
        fillLamports: fillLamports.toString(),
        fillSol: lamportsToSolNumber(fillLamports.toString()),
        fundedAt: serializeDate(row.fundedAt),
        createdAt: serializeDate(row.createdAt),
    };
}

function intentEventPayload(intent: any, matches: Record<string, unknown>[] = []): Record<string, unknown> {
    return {
        mode: 'SPORT',
        intent: serializeIntent(intent),
        intentId: intent.id,
        fixtureId: intent.fixtureId,
        marketType: intent.marketType || SPORT_MARKET_TYPE,
        selection: intent.selection,
        side: intent.side,
        matchingLiquidityCount: matches.length,
        matchingLiquidity: matches.slice(0, 5),
    };
}

function defaultIntentExpiry(fixture: any, now = new Date()): Date {
    if (fixture?.startsAt) {
        const startsAt = new Date(fixture.startsAt);
        if (!Number.isNaN(startsAt.getTime()) && startsAt.getTime() > now.getTime()) {
            return startsAt;
        }
    }
    return new Date(now.getTime() + DEFAULT_INTENT_TTL_MS);
}

async function expireSportIntents(now = new Date()): Promise<void> {
    if (!prismaAny.sportIntent?.updateMany) return;
    await prismaAny.sportIntent.updateMany({
        where: {
            status: 'active',
            expiresAt: { lte: now },
        },
        data: { status: 'expired' },
    });
}

async function requireFixture(fixtureId: string): Promise<any> {
    const fixture = await prismaAny.arenaFixture?.findUnique?.({ where: { fixtureId } });
    if (!fixture) throw httpError('sport_fixture_not_found', 404);
    return fixture;
}

async function findMatchingPositionRows(params: {
    wallet?: string;
    fixtureId: string;
    selection: SportSelection;
    side: SportSide;
    stakeLamports?: string | null;
    limit?: unknown;
}): Promise<any[]> {
    const limit = normalizeLimit(params.limit, 25);
    const where: Record<string, unknown> = {
        fixtureId: params.fixtureId,
        OR: matchingBranchesForDesired(params.selection, params.side),
        status: { in: ['funded_open', 'partially_filled'] },
        remainingLamports: { not: '0' },
    };
    if (params.wallet) where.agentWallet = { not: params.wallet };
    const rows = await prismaAny.sportPosition.findMany({
        where,
        orderBy: [{ fundedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
    });
    return (rows || []).filter((row: any) => BigInt(bigintString(row.remainingLamports || row.stakeLamports)) > 0n);
}

async function matchingLiquidityForIntentRow(intent: any, limit?: unknown): Promise<Record<string, unknown>[]> {
    const requestedLamports = intent.stakeLamports ? BigInt(bigintString(intent.stakeLamports)) : null;
    const minLamports = intent.minStakeLamports ? BigInt(bigintString(intent.minStakeLamports)) : 0n;
    const rows = await findMatchingPositionRows({
        wallet: intent.wallet,
        fixtureId: intent.fixtureId,
        selection: intent.selection,
        side: intent.side,
        stakeLamports: intent.stakeLamports || null,
        limit,
    });
    return rows
        .map((row) => serializePositionLiquidity(row, requestedLamports))
        .filter((row) => BigInt(String(row.fillLamports || '0')) >= minLamports);
}

export async function findSportMatchingLiquidity(walletInput: string, input: {
    fixtureId?: unknown;
    selection?: unknown;
    side?: unknown;
    stakeSol?: unknown;
    limit?: unknown;
}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const fixtureId = validateFixtureId(input.fixtureId);
    await requireFixture(fixtureId);
    const selection = normalizeSelection(input.selection);
    const side = normalizeSide(input.side);
    const stakeLamports = validateStakeLamports(input.stakeSol);
    const requested = stakeLamports ? BigInt(stakeLamports) : null;
    const positions = (await findMatchingPositionRows({
        wallet,
        fixtureId,
        selection,
        side,
        stakeLamports,
        limit: input.limit,
    })).map((row) => serializePositionLiquidity(row, requested));
    const totalFill = positions.reduce((sum, row) => sum + BigInt(String(row.fillLamports || '0')), 0n);
    return {
        wallet,
        query: {
            fixtureId,
            marketType: SPORT_MARKET_TYPE,
            selection,
            side,
            stakeLamports,
            stakeSol: stakeLamports ? lamportsToSolNumber(stakeLamports) : null,
        },
        count: positions.length,
        totalFillLamports: totalFill.toString(),
        totalFillSol: lamportsToSolNumber(totalFill.toString()),
        positions,
    };
}

export async function createSportIntent(walletInput: string, input: {
    fixtureId?: unknown;
    selection?: unknown;
    side?: unknown;
    stakeSol?: unknown;
    minStakeSol?: unknown;
    maxStakeSol?: unknown;
    expiresAt?: unknown;
    note?: unknown;
    clientIntentId?: unknown;
}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const fixtureId = validateFixtureId(input.fixtureId);
    const fixture = await requireFixture(fixtureId);
    const selection = normalizeSelection(input.selection);
    const side = normalizeSide(input.side);
    const stakeLamports = validateStakeLamports(input.stakeSol);
    const minStakeLamports = validateStakeLamports(input.minStakeSol);
    const maxStakeLamports = validateStakeLamports(input.maxStakeSol);
    const clientIntentId = normalizeClientIntentId(input.clientIntentId);
    const now = new Date();
    const suppliedExpiry = trimString(input.expiresAt);
    const expiresAt = suppliedExpiry ? new Date(suppliedExpiry) : defaultIntentExpiry(fixture, now);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
        throw httpError('sport_intent_expiresAt_must_be_future', 400);
    }
    if (minStakeLamports && maxStakeLamports && BigInt(minStakeLamports) > BigInt(maxStakeLamports)) {
        throw httpError('sport_intent_minStake_gt_maxStake', 400);
    }
    await expireSportIntents(now);

    const data = {
        wallet,
        fixtureId,
        marketType: SPORT_MARKET_TYPE,
        selection,
        side,
        stakeLamports,
        minStakeLamports,
        maxStakeLamports,
        status: 'active',
        note: normalizeNote(input.note),
        clientIntentId,
        expiresAt,
    };
    const intent = clientIntentId
        ? await prismaAny.sportIntent.upsert({
            where: { wallet_clientIntentId: { wallet, clientIntentId } },
            create: data,
            update: {
                ...data,
                lastNotifiedAt: null,
            },
        })
        : await prismaAny.sportIntent.create({ data });
    const matchingLiquidity = await matchingLiquidityForIntentRow(intent, 25);
    webhooks.intentCreated(wallet, intentEventPayload(intent, matchingLiquidity)).catch((error: any) => {
        logger.warn('sport_intent_created_event_failed', {
            intentId: intent.id,
            wallet,
            error: error?.message || String(error),
        });
    });
    if (matchingLiquidity.length > 0) {
        await emitIntentLiquidityEvents(intent, matchingLiquidity);
    }
    return {
        intent: serializeIntent(intent),
        matchingLiquidityCount: matchingLiquidity.length,
        matchingLiquidity,
    };
}

export async function listSportIntents(options: {
    fixtureId?: unknown;
    selection?: unknown;
    side?: unknown;
    status?: unknown;
    limit?: unknown;
} = {}): Promise<Record<string, unknown>> {
    await expireSportIntents();
    const fixtureId = trimString(options.fixtureId);
    const selection = options.selection ? normalizeSelection(options.selection) : undefined;
    const side = options.side ? normalizeSide(options.side) : undefined;
    const status = normalizeIntentStatus(options.status, 'active');
    const limit = normalizeLimit(options.limit);
    const where: Record<string, unknown> = {};
    if (fixtureId) where.fixtureId = fixtureId;
    if (selection) where.selection = selection;
    if (side) where.side = side;
    if (status !== 'all') where.status = status;
    const rows = await prismaAny.sportIntent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
    });
    return {
        count: rows.length,
        intents: rows.map(serializeIntent),
    };
}

export async function listMySportIntents(walletInput: string, options: {
    status?: unknown;
    limit?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    await expireSportIntents();
    const status = normalizeIntentStatus(options.status, 'all');
    const limit = normalizeLimit(options.limit);
    const rows = await prismaAny.sportIntent.findMany({
        where: {
            wallet,
            ...(status !== 'all' ? { status } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
    });
    return {
        wallet,
        count: rows.length,
        intents: rows.map(serializeIntent),
    };
}

export async function cancelSportIntent(walletInput: string, intentIdInput: unknown): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const intentId = trimString(intentIdInput);
    if (!intentId) throw httpError('intent_id_required', 400);
    const intent = await prismaAny.sportIntent.findUnique({ where: { id: intentId } });
    if (!intent) throw httpError('sport_intent_not_found', 404);
    if (intent.wallet !== wallet) throw httpError('sport_intent_wallet_mismatch', 403);
    if (intent.status !== 'active') {
        return {
            cancelled: false,
            idempotent: true,
            intent: serializeIntent(intent),
        };
    }
    const updated = await prismaAny.sportIntent.update({
        where: { id: intentId },
        data: { status: 'cancelled' },
    });
    return {
        cancelled: true,
        intent: serializeIntent(updated),
    };
}

async function emitIntentLiquidityEvents(intent: any, matchingLiquidity: Record<string, unknown>[]): Promise<void> {
    const payload = intentEventPayload(intent, matchingLiquidity);
    if (prismaAny.sportIntent?.update) {
        await prismaAny.sportIntent.update({
            where: { id: intent.id },
            data: { lastNotifiedAt: new Date() },
        }).catch(() => undefined);
    }
    await Promise.allSettled([
        webhooks.intentMatchAvailable(intent.wallet, payload),
        webhooks.liquidityAvailable(intent.wallet, payload),
    ]);
}

export async function notifySportIntentsForPosition(position: any): Promise<Record<string, unknown>> {
    if (!position || !prismaAny.sportIntent?.findMany) {
        return { notified: 0, intents: [] };
    }
    const remainingLamports = BigInt(bigintString(position.remainingLamports || position.stakeLamports));
    if (remainingLamports <= 0n || !['funded_open', 'partially_filled'].includes(position.status)) {
        return { notified: 0, intents: [] };
    }
    const now = new Date();
    await expireSportIntents(now);
    const rows = await prismaAny.sportIntent.findMany({
        where: {
            fixtureId: position.fixtureId,
            OR: matchingIntentBranchesForPosition(position),
            status: 'active',
            wallet: { not: position.agentWallet },
            expiresAt: { gt: now },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100,
    });
    const notified: Record<string, unknown>[] = [];
    for (const intent of rows || []) {
        const requestedLamports = intent.stakeLamports ? BigInt(bigintString(intent.stakeLamports)) : null;
        const minLamports = intent.minStakeLamports ? BigInt(bigintString(intent.minStakeLamports)) : 0n;
        const liquidity = serializePositionLiquidity(position, requestedLamports);
        if (BigInt(String(liquidity.fillLamports || '0')) < minLamports) continue;
        await emitIntentLiquidityEvents(intent, [liquidity]);
        notified.push({
            intentId: intent.id,
            wallet: intent.wallet,
            fillLamports: liquidity.fillLamports,
        });
    }
    return {
        positionId: position.id,
        notified: notified.length,
        intents: notified,
    };
}

export function getSportEventGuide(): Record<string, unknown> {
    return {
        mode: 'SPORT',
        websocket: {
            event: 'agent.event',
            canonicalNames: [
                'position.funded',
                'intent.match_available',
                'liquidity.available',
                'position.filled',
                'match.awaiting_result',
                'match.settled',
                'position.refunded',
            ],
            subscribeExample: {
                events: ['intent.match_available', 'position.filled', 'match.settled'],
                includeUnacked: true,
            },
            ackExample: { id: '<AgentEvent.id>' },
        },
        mcp: {
            eventTools: [
                'airotc_get_agent_events',
                'airotc_ack_agent_event',
                'airotc_ack_agent_events',
                'airotc_sport_get_event_guide',
            ],
            discoveryTools: [
                'airotc_sport_create_intent',
                'airotc_sport_list_intents',
                'airotc_sport_find_matching_liquidity',
                'airotc_sport_list_my_intents',
                'airotc_sport_cancel_intent',
            ],
        },
        presets: {
            sport_trader: ['intent.match_available', 'position.filled', 'match.awaiting_result', 'match.settled'],
            sport_discovery: ['intent.created', 'intent.match_available', 'liquidity.available'],
            sport_settlement: ['match.awaiting_result', 'match.settled', 'position.refunded'],
        },
        note: 'Events are persisted first and delivered at least once. Agents should dedupe by AgentEvent.id and ACK after processing.',
    };
}
