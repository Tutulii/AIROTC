import { Prisma } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { middlemanForwarder } from './middlemanForwarder';
import { attachSportTicketByOffer } from './arena/sportSettlementEngine';
import { serializeArenaMatch } from './arena/arenaMatch.service';
import { webhooks } from './webhookDelivery';
import { CONNECTION, ESCROW_PROGRAM_ID } from '../solana/program';

const prismaAny = prisma as any;
const SPORT_MARKET_TYPE = '1X2_PARTICIPANT_RESULT';
const LAMPORTS_PER_SOL = 1_000_000_000n;
const DEFAULT_POSITION_ACCEPT_BUFFER_SECONDS = 60;
const DEFAULT_POSITION_FUNDING_WINDOW_MINUTES = 60;
const MIN_POSITION_FUNDING_WINDOW_MINUTES = 5;
const MAX_POSITION_FUNDING_WINDOW_MINUTES = 24 * 60;
const SPORT_POSITION_VAULT_ACCOUNT_SPACE = 8 + 256;
const PUBLIC_POSITION_STATUSES = ['funded_open', 'partially_filled', 'matching', 'matched', 'filled', 'expired', 'cancelled'] as const;

type SportSide = 'back' | 'lay';
type SportSelection = 'part1' | 'draw' | 'part2';
type SportMatchKind = 'same_selection_back_lay' | 'complement_back_back';
type SportPositionStatus =
    | 'funding_required'
    | 'funded_open'
    | 'partially_filled'
    | 'matching'
    | 'matched'
    | 'filled'
    | 'expired'
    | 'cancelled'
    | 'refund_pending'
    | 'funding_failed'
    | 'all';

interface MatchArtifacts {
    position: any;
    counterpartyPosition: any;
    fill?: any | null;
    fillLamports?: string | null;
    matchKind?: SportMatchKind;
    offer: any;
    ticket: any;
    arenaMatch: any;
    createdByDirectAccept?: boolean;
}

interface MiddlemanAttachResult {
    arenaMatch?: Record<string, unknown> | null;
    sportEscrow?: Record<string, unknown> | null;
}

async function recordFundingEvent(tx: any, params: {
    positionId: string;
    wallet: string;
    event: string;
    txSignature?: string | null;
    lamports?: string | null;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    if (!tx.sportPositionFundingEvent?.create) return;
    await tx.sportPositionFundingEvent.create({
        data: {
            positionId: params.positionId,
            wallet: params.wallet,
            event: params.event,
            txSignature: params.txSignature || null,
            lamports: params.lamports || null,
            metadata: jsonValue(params.metadata || {}),
        },
    });
}

function httpError(message: string, statusCode = 400): Error {
    return Object.assign(new Error(message), { statusCode });
}

function trimString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
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
    if (selection === 'part1' || selection === 'draw' || selection === 'part2') {
        return selection;
    }
    throw httpError('sport_selection_must_be_part1_draw_or_part2', 400);
}

function normalizeSide(value: unknown): SportSide {
    const side = trimString(value)?.toLowerCase() || 'back';
    if (side === 'back' || side === 'lay') return side;
    throw httpError('sport_side_must_be_back_or_lay', 400);
}

function normalizePositionStatus(value: unknown, fallback: SportPositionStatus): SportPositionStatus {
    const status = trimString(value)?.toLowerCase() || fallback;
    if (status === 'open') return 'funded_open';
    if (
        status === 'funding_required'
        || status === 'funded_open'
        || status === 'partially_filled'
        || status === 'matching'
        || status === 'matched'
        || status === 'filled'
        || status === 'expired'
        || status === 'cancelled'
        || status === 'refund_pending'
        || status === 'funding_failed'
        || status === 'all'
    ) {
        return status;
    }
    throw httpError('sport_position_status_invalid', 400);
}

function oppositeSide(side: SportSide): SportSide {
    return side === 'back' ? 'lay' : 'back';
}

function complementSelection(selection: unknown): SportSelection | null {
    if (selection === 'part1') return 'part2';
    if (selection === 'part2') return 'part1';
    return null;
}

function sportComplementBackMatchingEnabled(): boolean {
    return process.env.SPORT_COMPLEMENT_BACK_MATCHING_ENABLED !== 'false';
}

function resolveSportMatchKind(left: any, right: any): SportMatchKind | null {
    if (
        left?.fixtureId === right?.fixtureId
        && left?.selection === right?.selection
        && left?.side === oppositeSide(right?.side as SportSide)
    ) {
        return 'same_selection_back_lay';
    }
    if (
        sportComplementBackMatchingEnabled()
        && left?.fixtureId === right?.fixtureId
        && left?.side === 'back'
        && right?.side === 'back'
        && complementSelection(left?.selection) === right?.selection
    ) {
        return 'complement_back_back';
    }
    return null;
}

function matchCandidateBranches(position: any): Array<Record<string, unknown>> {
    const branches: Array<Record<string, unknown>> = [
        {
            selection: position.selection,
            side: oppositeSide(position.side as SportSide),
        },
    ];
    const complement = complementSelection(position.selection);
    if (
        sportComplementBackMatchingEnabled()
        && position.side === 'back'
        && complement
    ) {
        branches.push({
            selection: complement,
            side: 'back',
        });
    }
    return branches;
}

function sportPartialFillEnabled(): boolean {
    return process.env.SPORT_PARTIAL_FILL_ENABLED !== 'false';
}

function positionVaultVersion(): 'v1' | 'v2' {
    return sportPartialFillEnabled() ? 'v2' : 'v1';
}

function sideToDirection(side: SportSide): 'BUY_SELECTION' | 'SELL_SELECTION' {
    return side === 'back' ? 'BUY_SELECTION' : 'SELL_SELECTION';
}

function sideToOfferMode(side: SportSide): 'buy' | 'sell' {
    return side === 'back' ? 'buy' : 'sell';
}

function positionAsset(fixtureId: string, selection: string): string {
    return `TXLINE:${fixtureId}:${SPORT_MARKET_TYPE}:${selection}`;
}

function normalizeClientOrderId(value: unknown): string | null {
    const clientOrderId = trimString(value);
    if (!clientOrderId) return null;
    if (clientOrderId.length > 128) throw httpError('clientOrderId_too_long', 400);
    return clientOrderId;
}

function solToLamports(value: unknown): bigint {
    const raw = typeof value === 'number' ? value.toString() : trimString(value);
    if (!raw || !/^\d+(\.\d{1,9})?$/.test(raw)) {
        throw httpError('stakeSol_must_have_at_most_9_decimals', 400);
    }
    const [whole, fraction = ''] = raw.split('.');
    return (BigInt(whole) * LAMPORTS_PER_SOL) + BigInt(fraction.padEnd(9, '0'));
}

function lamportsToSolNumber(lamports: string | bigint): number {
    return Number(typeof lamports === 'bigint' ? lamports : BigInt(lamports)) / Number(LAMPORTS_PER_SOL);
}

function bigintString(value: unknown, fallback = '0'): string {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value)).toString();
    if (typeof value === 'string' && /^\d+$/.test(value)) return value;
    return fallback;
}

function positionFilledLamports(row: any): string {
    return bigintString(row?.filledLamports, row?.status === 'matched' ? bigintString(row?.stakeLamports) : '0');
}

function positionRemainingLamports(row: any): string {
    if (row?.remainingLamports !== undefined && row?.remainingLamports !== null) {
        return bigintString(row.remainingLamports);
    }
    if (row?.status === 'funded_open') return bigintString(row?.stakeLamports);
    return '0';
}

function stakeBounds(): { min: bigint; max: bigint } {
    const min = solToLamports(process.env.SPORT_POSITION_MIN_SOL || '0.001');
    const max = solToLamports(process.env.SPORT_POSITION_MAX_SOL || '10');
    return { min, max };
}

function validateStake(value: unknown): string {
    const lamports = solToLamports(value);
    const { min, max } = stakeBounds();
    if (lamports < min) throw httpError('stakeSol_below_minimum', 400);
    if (lamports > max) throw httpError('stakeSol_above_maximum', 400);
    return lamports.toString();
}

function kickoffBufferMs(): number {
    const seconds = Number(process.env.SPORT_POSITION_ACCEPT_BUFFER_SECONDS || DEFAULT_POSITION_ACCEPT_BUFFER_SECONDS);
    return Math.max(0, Number.isFinite(seconds) ? seconds : DEFAULT_POSITION_ACCEPT_BUFFER_SECONDS) * 1000;
}

function fundingWindowMs(): number {
    const minutes = Number(process.env.SPORT_POSITION_FUNDING_WINDOW_MINUTES || DEFAULT_POSITION_FUNDING_WINDOW_MINUTES);
    const safeMinutes = Number.isFinite(minutes)
        ? Math.min(Math.max(minutes, MIN_POSITION_FUNDING_WINDOW_MINUTES), MAX_POSITION_FUNDING_WINDOW_MINUTES)
        : DEFAULT_POSITION_FUNDING_WINDOW_MINUTES;
    return safeMinutes * 60_000;
}

function fundingExpiresAt(fixture: any, now: Date): Date {
    const draftExpiry = new Date(now.getTime() + fundingWindowMs());
    const fixtureCutoff = fixture?.startsAt
        ? new Date(new Date(fixture.startsAt).getTime() - kickoffBufferMs())
        : draftExpiry;
    return draftExpiry.getTime() < fixtureCutoff.getTime() ? draftExpiry : fixtureCutoff;
}

function derivePositionVaultPda(positionId: string): string {
    const seedHash = crypto.createHash('sha256').update(positionId).digest();
    return PublicKey.findProgramAddressSync(
        [Buffer.from('sport_position'), seedHash],
        ESCROW_PROGRAM_ID,
    )[0].toBase58();
}

function derivePositionVaultPdaV2(positionId: string): string {
    const seedHash = crypto.createHash('sha256').update(positionId).digest();
    return PublicKey.findProgramAddressSync(
        [Buffer.from('sport_position_v2'), seedHash],
        ESCROW_PROGRAM_ID,
    )[0].toBase58();
}

function derivePositionVaultPdaForVersion(positionId: string, vaultVersion: unknown): string {
    return vaultVersion === 'v1' ? derivePositionVaultPda(positionId) : derivePositionVaultPdaV2(positionId);
}

function positionVaultSeedPrefix(vaultVersion: unknown): 'sport_position' | 'sport_position_v2' {
    return vaultVersion === 'v1' ? 'sport_position' : 'sport_position_v2';
}

function sha256Hex(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function deriveConfigPda(): string {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('config')],
        ESCROW_PROGRAM_ID,
    )[0].toBase58();
}

function unixSeconds(value: unknown): number | null {
    if (!value) return null;
    const ms = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

async function fundingBalanceCheck(row: any): Promise<Record<string, unknown>> {
    if (process.env.SPORT_POSITION_FUNDING_BALANCE_CHECK === 'false') {
        return { checked: false, reason: 'disabled' };
    }
    try {
        const owner = new PublicKey(row.agentWallet);
        const [balanceLamports, rentBufferLamports] = await Promise.all([
            CONNECTION.getBalance(owner, 'confirmed'),
            CONNECTION.getMinimumBalanceForRentExemption(SPORT_POSITION_VAULT_ACCOUNT_SPACE).catch(() => 0),
        ]);
        const stakeLamports = BigInt(row.stakeLamports || '0');
        const requiredLamports = stakeLamports + BigInt(rentBufferLamports);
        return {
            checked: true,
            ownerWallet: row.agentWallet,
            cluster: process.env.SOLANA_CLUSTER || 'devnet',
            balanceLamports: String(balanceLamports),
            balanceSol: lamportsToSolNumber(BigInt(balanceLamports)),
            stakeLamports: stakeLamports.toString(),
            stakeSol: lamportsToSolNumber(stakeLamports),
            rentBufferLamports: String(rentBufferLamports),
            requiredLamports: requiredLamports.toString(),
            requiredSol: lamportsToSolNumber(requiredLamports),
            hasEnoughBalance: BigInt(balanceLamports) >= requiredLamports,
        };
    } catch (error: any) {
        return {
            checked: false,
            reason: 'wallet_balance_check_failed',
            error: error?.message || String(error),
        };
    }
}

function fundingInstructions(row: any, balanceCheck?: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!row?.vaultPda) return null;
    const rawPdaFundingEnabled = process.env.SPORT_POSITION_ENABLE_RAW_PDA_FUNDING === 'true';
    const programVaultModeEnabled = process.env.SPORT_POSITION_VAULT_MODE === 'program';
    const transferEnabled = rawPdaFundingEnabled || programVaultModeEnabled;
    const positionIdHashHex = sha256Hex(row.id);
    const fixtureHashHex = sha256Hex(String(row.fixtureId));
    const marketHashHex = sha256Hex(SPORT_MARKET_TYPE);
    const selectionHashHex = sha256Hex(String(row.selection));
    const fundingExpiresAtIso = row.fundingExpiresAt instanceof Date ? row.fundingExpiresAt.toISOString() : row.fundingExpiresAt;
    const fundingExpiresAtUnix = unixSeconds(row.fundingExpiresAt);
    const configPda = deriveConfigPda();
    const nativeMint = 'So11111111111111111111111111111111111111112';
    const vaultVersion = row.vaultVersion === 'v1' ? 'v1' : 'v2';
    const seedPrefix = positionVaultSeedPrefix(vaultVersion);
    const anchorInstructions = vaultVersion === 'v2'
        ? {
            initializeSportPositionV2: {
                method: 'initialize_sport_position_v2',
                args: {
                    positionIdHashHex,
                    fixtureHashHex,
                    marketHashHex,
                    selectionHashHex,
                    side: row.side === 'lay' ? 'lay' : 'back',
                    totalStakeLamports: row.stakeLamports,
                    expiresAtUnix: fundingExpiresAtUnix,
                },
                accounts: {
                    sportPosition: row.vaultPda,
                    owner: row.agentWallet,
                    mint: nativeMint,
                    config: configPda,
                },
            },
            fundSportPositionV2: {
                method: 'fund_sport_position_v2',
                args: {},
                accounts: {
                    sportPosition: row.vaultPda,
                    owner: row.agentWallet,
                    config: configPda,
                },
            },
            cancelSportPositionRemaining: {
                method: 'cancel_sport_position_remaining',
                args: {},
                accounts: {
                    sportPosition: row.vaultPda,
                    owner: row.agentWallet,
                    config: configPda,
                },
            },
            closeSportPositionV2IfEmpty: {
                method: 'close_sport_position_v2_if_empty',
                args: {},
                accounts: {
                    sportPosition: row.vaultPda,
                    owner: row.agentWallet,
                    config: configPda,
                },
            },
        }
        : {
            initializeSportPosition: {
                method: 'initialize_sport_position',
                args: {
                    positionIdHashHex,
                    fixtureHashHex,
                    marketHashHex,
                    selectionHashHex,
                    side: row.side === 'lay' ? 'lay' : 'back',
                    stakeLamports: row.stakeLamports,
                    expiresAtUnix: fundingExpiresAtUnix,
                },
                accounts: {
                    sportPosition: row.vaultPda,
                    owner: row.agentWallet,
                    mint: nativeMint,
                    config: configPda,
                },
            },
            fundSportPosition: {
                method: 'fund_sport_position',
                args: {},
                accounts: {
                    sportPosition: row.vaultPda,
                    owner: row.agentWallet,
                    config: configPda,
                },
            },
            cancelSportPosition: {
                method: 'cancel_sport_position',
                args: {},
                accounts: {
                    sportPosition: row.vaultPda,
                    owner: row.agentWallet,
                    config: configPda,
                },
            },
        };
    const instructions: Record<string, unknown> = {
        type: 'sport_position_prefund',
        network: process.env.SOLANA_CLUSTER || 'devnet',
        programId: ESCROW_PROGRAM_ID.toBase58(),
        positionId: row.id,
        vaultVersion,
        pdaDerivation: {
            vaultVersion,
            seedPrefix,
            seedHashAlgorithm: 'sha256',
            seedHashInput: 'positionId',
            seedHashHex: positionIdHashHex,
            programId: ESCROW_PROGRAM_ID.toBase58(),
            vaultPda: row.vaultPda,
            compatibilityNote: vaultVersion === 'v2'
                ? 'Use the sport_position_v2 seed prefix for this position. The older sport_position seed is only for legacy v1 positions and derives a different PDA.'
                : 'Legacy v1 position. New SPORT positions use sport_position_v2.',
        },
        positionIdHashHex,
        fixtureHashHex,
        marketHashHex,
        selectionHashHex,
        ownerWallet: row.agentWallet,
        vaultPda: row.vaultPda,
        amountLamports: row.stakeLamports,
        amountSol: lamportsToSolNumber(row.stakeLamports),
        memo: `AIROTC_SPORT_POSITION:${row.id}`,
        expiresAt: fundingExpiresAtIso,
        transferEnabled,
        vaultMode: programVaultModeEnabled ? 'program' : rawPdaFundingEnabled ? 'raw_pda_devnet' : 'disabled',
        verifierRequired: process.env.SPORT_POSITION_VERIFY_FUNDING_ONCHAIN === 'true',
        unsafeRawPdaDevnetOnly: rawPdaFundingEnabled && !programVaultModeEnabled,
        anchor: anchorInstructions,
        note: transferEnabled
            ? programVaultModeEnabled
                ? vaultVersion === 'v2'
                    ? 'Call initialize_sport_position_v2, then fund_sport_position_v2 for exactly this stake. After confirmation, call confirm_position_funding with the transaction signature.'
                    : 'Call initialize_sport_position, then fund_sport_position for exactly this stake. After confirmation, call confirm_position_funding with the transaction signature.'
                : 'Send exactly this stake to the SPORT position vault, then call confirm_position_funding with the transaction signature.'
            : 'SPORT position vault transfer is not enabled on this deployment yet. Do not transfer funds to this PDA until the on-chain vault program path is enabled.',
    };
    if (balanceCheck !== undefined) instructions.balanceCheck = balanceCheck;
    return instructions;
}

function requireFundingTxIfConfigured(txSignature: string | undefined): void {
    if (process.env.SPORT_POSITION_VERIFY_FUNDING_ONCHAIN === 'true' && !txSignature) {
        throw httpError('fundingTx_required_for_onchain_verification', 400);
    }
}

async function verifyFundingTxIfConfigured(row: any, txSignature: string | undefined): Promise<Record<string, unknown>> {
    if (process.env.SPORT_POSITION_VERIFY_FUNDING_ONCHAIN !== 'true') {
        if (
            process.env.SPORT_POSITION_ALLOW_SERVER_RECORDED_FUNDING === 'true'
            || process.env.NODE_ENV === 'test'
        ) {
            return { verified: false, mode: 'server_recorded' };
        }
        throw httpError('sport_position_funding_verification_not_configured', 503);
    }
    requireFundingTxIfConfigured(txSignature);
    const tx = await CONNECTION.getTransaction(txSignature!, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
    });
    if (!tx || tx.meta?.err) throw httpError('fundingTx_not_confirmed', 409);
    const accountKeys = 'staticAccountKeys' in tx.transaction.message
        ? (tx.transaction.message as any).staticAccountKeys
        : (tx.transaction.message as any).accountKeys;
    const vaultIndex = accountKeys.findIndex((key: any) => key.toBase58?.() === row.vaultPda);
    if (vaultIndex < 0) throw httpError('fundingTx_missing_position_vault', 400);
    const pre = BigInt(tx.meta?.preBalances?.[vaultIndex] || 0);
    const post = BigInt(tx.meta?.postBalances?.[vaultIndex] || 0);
    const delta = post - pre;
    if (delta < BigInt(row.stakeLamports)) throw httpError('fundingTx_underfunded_position', 400);
    if (process.env.SPORT_POSITION_VAULT_MODE === 'program') {
        const accountInfo = await CONNECTION.getAccountInfo(new PublicKey(row.vaultPda), 'confirmed');
        if (!accountInfo) throw httpError('sport_position_vault_not_found', 409);
        if (!accountInfo.owner.equals(ESCROW_PROGRAM_ID)) {
            throw httpError('sport_position_vault_owner_mismatch', 400);
        }
    }
    return {
        verified: true,
        mode: 'solana_rpc',
        slot: tx.slot,
        vaultDeltaLamports: delta.toString(),
        vaultMode: process.env.SPORT_POSITION_VAULT_MODE === 'program' ? 'program' : 'raw_pda_devnet',
    };
}

function fixtureSource(fixture: any): string {
    return String(asRecord(fixture?.raw).source || '').trim().toLowerCase();
}

function isNumericFixtureId(value: string): boolean {
    return /^\d+$/.test(value);
}

async function requireOpenTxlineFixture(fixtureId: string, now = new Date()): Promise<any> {
    const fixture = await prismaAny.arenaFixture.findUnique({ where: { fixtureId } });
    if (!fixture) throw httpError('sport_fixture_not_found', 404);
    const source = fixtureSource(fixture);
    if (source && source !== 'txline') throw httpError('sport_fixture_must_be_txline_source', 400);
    if (!source && !isNumericFixtureId(fixtureId)) throw httpError('sport_fixture_must_be_txline_source', 400);
    if (fixture.status !== 'upcoming') throw httpError('sport_fixture_not_open_for_positions', 409);
    if (!fixture.startsAt) throw httpError('sport_fixture_missing_start_time', 409);
    const cutoff = new Date(fixture.startsAt).getTime() - kickoffBufferMs();
    if (now.getTime() >= cutoff) throw httpError('sport_fixture_position_window_closed', 409);
    return fixture;
}

async function expireOpenPositions(tx: any, now = new Date()): Promise<void> {
    await tx.sportPosition.updateMany({
        where: { status: { in: ['open', 'funding_required', 'funded_open', 'partially_filled'] }, expiresAt: { lte: now } },
        data: { status: 'expired' },
    });
    await tx.sportPosition.updateMany({
        where: { status: 'funding_required', fundingExpiresAt: { lte: now } },
        data: { status: 'expired' },
    });
}

function serializePosition(row: any): Record<string, unknown> {
    if (!row) return {};
    const filledLamports = positionFilledLamports(row);
    const remainingLamports = positionRemainingLamports(row);
    const refundedLamports = bigintString(row.refundedLamports);
    const fills = Array.isArray(row.fills) ? row.fills.map(serializeFill) : undefined;
    const nowMs = Date.now();
    const fundingExpiresAtIso = row.fundingExpiresAt instanceof Date ? row.fundingExpiresAt.toISOString() : row.fundingExpiresAt || null;
    const expiresAtIso = row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt;
    const fundingWindowExpired = Boolean(fundingExpiresAtIso && new Date(fundingExpiresAtIso).getTime() <= nowMs);
    const liquidityWindowExpired = Boolean(expiresAtIso && new Date(expiresAtIso).getTime() <= nowMs);
    const hasOpenLiquidity = ['funded_open', 'partially_filled'].includes(row.status) && BigInt(remainingLamports || '0') > 0n;
    return {
        id: row.id,
        fixtureId: row.fixtureId,
        selection: row.selection,
        side: row.side,
        stakeLamports: row.stakeLamports,
        stakeSol: lamportsToSolNumber(row.stakeLamports),
        filledLamports,
        filledSol: lamportsToSolNumber(filledLamports),
        remainingLamports,
        remainingSol: lamportsToSolNumber(remainingLamports),
        refundedLamports,
        refundedSol: lamportsToSolNumber(refundedLamports),
        fillCount: row._count?.fills ?? row.fillCount ?? (fills ? fills.length : undefined),
        vaultVersion: row.vaultVersion || 'v1',
        agentWallet: row.agentWallet,
        status: row.status,
        vaultPda: row.vaultPda || null,
        fundingTx: row.fundingTx || null,
        fundedLamports: row.fundedLamports || null,
        fundedAt: row.fundedAt instanceof Date ? row.fundedAt.toISOString() : row.fundedAt || null,
        fundingExpiresAt: fundingExpiresAtIso,
        fundingWindow: {
            expiresAt: fundingExpiresAtIso,
            appliesToStatus: 'funding_required',
            expired: fundingWindowExpired,
            note: 'Funding expiry only applies before stake is locked. Funded liquidity remains open until liquidityWindow.expiresAt.',
        },
        cancelTx: row.cancelTx || null,
        matchedAt: row.matchedAt instanceof Date ? row.matchedAt.toISOString() : row.matchedAt || null,
        matchedPositionId: row.matchedPositionId || null,
        matchId: row.matchId || null,
        offerId: row.offerId || null,
        ticketId: row.ticketId || null,
        fundingInstructions: row.status === 'funding_required' ? fundingInstructions(row) : null,
        expiresAt: expiresAtIso,
        liquidityWindow: {
            expiresAt: expiresAtIso,
            appliesToStatus: ['funded_open', 'partially_filled'],
            expired: liquidityWindowExpired,
        },
        autoRefundEligibleAt: hasOpenLiquidity ? expiresAtIso : null,
        clientOrderId: row.clientOrderId || null,
        ...(fills ? { fills } : {}),
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    };
}

function serializeFill(row: any): Record<string, unknown> {
    if (!row) return {};
    return {
        id: row.id,
        fixtureId: row.fixtureId,
        selection: row.selection,
        backPositionId: row.backPositionId,
        layPositionId: row.layPositionId,
        backWallet: row.backWallet,
        layWallet: row.layWallet,
        fillLamports: row.fillLamports,
        fillSol: lamportsToSolNumber(row.fillLamports),
        ticketId: row.ticketId || null,
        escrowPda: row.escrowPda || null,
        commitTx: row.commitTx || null,
        status: row.status,
        winnerWallet: row.winnerWallet || null,
        releaseTx: row.releaseTx || null,
        refundTx: row.refundTx || null,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
        settledAt: row.settledAt instanceof Date ? row.settledAt.toISOString() : row.settledAt || null,
    };
}

function serializeTicket(ticket: any): Record<string, unknown> | null {
    if (!ticket) return null;
    return {
        id: ticket.id,
        offerId: ticket.offerId,
        buyer: ticket.buyer,
        seller: ticket.seller,
        status: ticket.status,
        rollupMode: ticket.rollupMode,
        createdAt: ticket.createdAt instanceof Date ? ticket.createdAt.toISOString() : ticket.createdAt,
    };
}

function sanitizeSportDepositInstructions(instructions: any): Record<string, unknown> | null {
    if (!instructions || typeof instructions !== 'object') return null;
    const buyer = asRecord(instructions.buyer);
    const seller = asRecord(instructions.seller);
    const protocolDustLamports = buyer.protocolDustLamports ?? instructions.protocolDustLamports ?? 0;
    const buyerStake = buyer.stake ?? buyer.payment ?? buyer.total;
    const sellerStake = seller.stake ?? seller.total;

    return {
        escrowPda: instructions.escrowPda || instructions.escrow_pda || null,
        stakeModel: 'equal_stake',
        buyer: {
            wallet: buyer.wallet || null,
            stake: buyerStake ?? null,
            total: buyer.total ?? buyerStake ?? null,
            ...(Number(protocolDustLamports) > 0 ? { protocolDustLamports } : {}),
        },
        seller: {
            wallet: seller.wallet || null,
            stake: sellerStake ?? null,
            total: seller.total ?? sellerStake ?? null,
        },
    };
}

function matchedResponse(artifacts: MatchArtifacts, attach: MiddlemanAttachResult = {}): Record<string, unknown> {
    return {
        matched: true,
        position: serializePosition(artifacts.position),
        counterpartyPosition: serializePosition(artifacts.counterpartyPosition),
        offer: {
            id: artifacts.offer.id,
            asset: artifacts.offer.asset,
            price: artifacts.offer.price,
            amount: artifacts.offer.amount,
            rollupMode: artifacts.offer.rollupMode,
            fixtureId: artifacts.offer.fixtureId,
            marketType: artifacts.offer.marketType,
            selection: artifacts.offer.selection,
            status: artifacts.offer.status,
        },
        fill: artifacts.fill ? serializeFill(artifacts.fill) : null,
        ticket: serializeTicket(artifacts.ticket),
        ticketId: artifacts.ticket.id,
        arenaMatch: attach.arenaMatch || serializeArenaMatch(artifacts.arenaMatch),
        sportEscrow: attach.sportEscrow || null,
    };
}

async function createMatchedArtifacts(tx: any, params: {
    makerPosition: any;
    takerPosition: any;
    fixture: any;
    fill?: any | null;
    fillLamports?: string | null;
    matchKind?: SportMatchKind;
}): Promise<MatchArtifacts> {
    const maker = params.makerPosition;
    const taker = params.takerPosition;
    const makerSide = maker.side as SportSide;
    const matchKind = params.matchKind || resolveSportMatchKind(maker, taker) || 'same_selection_back_lay';
    const mode = sideToOfferMode(makerSide);
    const fillLamports = params.fillLamports || maker.stakeLamports;
    const stakeSol = lamportsToSolNumber(fillLamports);
    const makerAgent = await tx.agent.upsert({
        where: { wallet: maker.agentWallet },
        update: {},
        create: { wallet: maker.agentWallet },
    });
    await tx.agent.upsert({
        where: { wallet: taker.agentWallet },
        update: {},
        create: { wallet: taker.agentWallet },
    });

    const offer = await tx.offer.create({
        data: {
            creatorId: makerAgent.id,
            asset: positionAsset(maker.fixtureId, maker.selection),
            price: stakeSol,
            amount: 1,
            mode,
            rollupMode: 'SPORT',
            collateral: 0,
            tokenMint: null,
            tokenDecimals: 9,
            fixtureId: maker.fixtureId,
            marketType: SPORT_MARKET_TYPE,
            selection: maker.selection,
            status: 'matched',
        },
    });
    const buyerWallet = mode === 'buy' ? maker.agentWallet : taker.agentWallet;
    const sellerWallet = mode === 'buy' ? taker.agentWallet : maker.agentWallet;
    const ticket = await tx.ticket.create({
        data: {
            offerId: offer.id,
            buyer: buyerWallet,
            seller: sellerWallet,
            status: 'awaiting_result',
            rollupMode: 'SPORT',
        },
    });
    const arenaMatch = await tx.arenaMatch.create({
        data: {
            fixtureId: maker.fixtureId,
            offerId: offer.id,
            ticketId: ticket.id,
            marketType: SPORT_MARKET_TYPE,
            selection: maker.selection,
            direction: sideToDirection(makerSide),
            makerPositionId: maker.id,
            takerPositionId: taker.id,
            makerSide,
            stakeLamports: fillLamports,
            makerVaultPda: maker.vaultPda || null,
            takerVaultPda: taker.vaultPda || null,
            makerWallet: maker.agentWallet,
            takerWallet: taker.agentWallet,
            buyerWallet,
            sellerWallet,
            rollupMode: 'SPORT',
            status: 'ticket_attached',
            startedAt: new Date(),
            proof: jsonValue({
                createdBy: 'sport_position_layer',
                fixtureKnown: Boolean(params.fixture),
                fixtureStartsAt: params.fixture?.startsAt || null,
                settlementSource: 'txline',
                marketModel: matchKind === 'complement_back_back'
                    ? 'complement_back_draw_refund'
                    : 'binary_back_lay',
                makerPositionId: maker.id,
                takerPositionId: taker.id,
                makerSide,
                matchKind,
                makerSelection: maker.selection,
                takerSelection: taker.selection,
                drawPolicy: matchKind === 'complement_back_back' ? 'void_refund' : null,
                stakeLamports: fillLamports,
                makerVaultPda: maker.vaultPda || null,
                takerVaultPda: taker.vaultPda || null,
                fillId: params.fill?.id || null,
                partialFill: Boolean(params.fill),
                prefunded: true,
            }),
        },
    });
    let fill = params.fill || null;
    if (fill) {
        fill = await tx.sportPositionFill.update({
            where: { id: fill.id },
            data: {
                ticketId: ticket.id,
            },
        });
    }
    const matchedAt = new Date();
    let position = taker;
    let counterpartyPosition = maker;
    if (!fill) {
        [position, counterpartyPosition] = await Promise.all([
            tx.sportPosition.update({
                where: { id: taker.id },
                data: {
                    status: 'matched',
                    filledLamports: taker.stakeLamports,
                    remainingLamports: '0',
                    matchedAt,
                    matchedPositionId: maker.id,
                    matchId: arenaMatch.id,
                    offerId: offer.id,
                    ticketId: ticket.id,
                },
            }),
            tx.sportPosition.update({
                where: { id: maker.id },
                data: {
                    status: 'matched',
                    filledLamports: maker.stakeLamports,
                    remainingLamports: '0',
                    matchedAt,
                    matchedPositionId: taker.id,
                    matchId: arenaMatch.id,
                    offerId: offer.id,
                    ticketId: ticket.id,
                },
            }),
        ]);
    } else {
        [position, counterpartyPosition] = await Promise.all([
            tx.sportPosition.findUnique({ where: { id: taker.id } }),
            tx.sportPosition.findUnique({ where: { id: maker.id } }),
        ]);
    }
    return {
        position,
        counterpartyPosition,
        fill,
        fillLamports,
        matchKind,
        offer,
        ticket,
        arenaMatch,
    };
}

function statusFromAccounting(filled: bigint, remaining: bigint): string {
    if (remaining > 0n && filled > 0n) return 'partially_filled';
    if (remaining > 0n) return 'funded_open';
    return 'filled';
}

async function restoreFillReservation(tx: any, fill: any): Promise<void> {
    if (!fill) return;
    const fillAmount = BigInt(fill.fillLamports);
    const positions = await tx.sportPosition.findMany({
        where: { id: { in: [fill.backPositionId, fill.layPositionId] } },
    });
    for (const position of positions) {
        const filled = BigInt(positionFilledLamports(position));
        const remaining = BigInt(positionRemainingLamports(position));
        const restoredFilled = filled >= fillAmount ? filled - fillAmount : 0n;
        const restoredRemaining = remaining + fillAmount;
        await tx.sportPosition.update({
            where: { id: position.id },
            data: {
                filledLamports: restoredFilled.toString(),
                remainingLamports: restoredRemaining.toString(),
                status: statusFromAccounting(restoredFilled, restoredRemaining),
                matchedAt: restoredFilled > 0n ? position.matchedAt : null,
            },
        });
    }
    await tx.sportPositionFill.update({
        where: { id: fill.id },
        data: { status: 'failed' },
    });
}

async function attachEscrowOrCompensate(artifacts: MatchArtifacts): Promise<MiddlemanAttachResult> {
    const matchedPositions = [artifacts.position, artifacts.counterpartyPosition];
    const buyerPosition = matchedPositions.find((position) => position.agentWallet === artifacts.ticket.buyer);
    const sellerPosition = matchedPositions.find((position) => position.agentWallet === artifacts.ticket.seller);
    const stakeLamports = artifacts.fillLamports || artifacts.position.stakeLamports;
    const result = await middlemanForwarder.forwardOfferAccepted({
        ticketId: artifacts.ticket.id,
        buyerWallet: artifacts.ticket.buyer,
        sellerWallet: artifacts.ticket.seller,
        asset: artifacts.offer.asset,
        price: Number(artifacts.offer.price),
        amount: Number(artifacts.offer.amount),
        collateral: 0,
        tokenMint: null,
        rollupMode: 'SPORT',
        sportPositionVaults: {
            buyerPositionVaultPda: buyerPosition?.vaultPda || null,
            sellerPositionVaultPda: sellerPosition?.vaultPda || null,
            buyerPositionId: buyerPosition?.id || null,
            sellerPositionId: sellerPosition?.id || null,
            stakeLamports,
            fillId: artifacts.fill?.id || null,
            fillLamports: stakeLamports,
            vaultVersion: artifacts.fill ? 'v2' : artifacts.position.vaultVersion || 'v1',
        },
    });

    if (!result.success) {
        await prisma.$transaction(async (tx) => {
            if (artifacts.fill) {
                await restoreFillReservation(tx as any, artifacts.fill);
            }
            await (tx as any).arenaMatch.deleteMany({ where: { id: artifacts.arenaMatch.id } });
            await tx.ticket.deleteMany({ where: { id: artifacts.ticket.id } });
            await tx.offer.deleteMany({ where: { id: artifacts.offer.id } });
            if (artifacts.createdByDirectAccept && !artifacts.fill) {
                await (tx as any).sportPosition.deleteMany({ where: { id: artifacts.position.id } });
            }
            if (!artifacts.fill) {
                await (tx as any).sportPosition.updateMany({
                    where: {
                        id: {
                            in: artifacts.createdByDirectAccept
                                ? [artifacts.counterpartyPosition.id]
                                : [artifacts.position.id, artifacts.counterpartyPosition.id],
                        },
                    },
                    data: {
                        status: 'funded_open',
                        matchedPositionId: null,
                        matchId: null,
                        offerId: null,
                        ticketId: null,
                        matchedAt: null,
                    },
                });
            }
        });
        throw httpError(result.error || 'sport_middleman_forward_failed', 502);
    }

    let fill = artifacts.fill || null;
    if (fill) {
        fill = await prismaAny.sportPositionFill.update({
            where: { id: fill.id },
            data: {
                status: 'awaiting_result',
                escrowPda: result.dealPda || null,
                commitTx: (result as any).tx || null,
            },
        });
        artifacts.fill = fill;
    }

    const attachResult = await attachSportTicketByOffer({
        offerId: artifacts.offer.id,
        ticketId: artifacts.ticket.id,
        escrowPda: result.dealPda || null,
    });
    const arenaMatch = (attachResult as any).match || attachResult;
    const sportEscrow = {
        mathOnly: true,
        phase: result.phase || null,
        dealPda: result.dealPda || null,
        depositInstructions: null,
        legacyDepositInstructions: sanitizeSportDepositInstructions(result.depositInstructions),
        prefundedPositionVaults: {
            buyer: buyerPosition?.vaultPda || null,
            seller: sellerPosition?.vaultPda || null,
            stakeLamports,
            fillId: fill?.id || null,
        },
        note: 'SPORT position settlement is deterministic: positions are prefunded, there is no delivery step, TxLINE final outcome decides payout.',
    };

    webhooks.dealMatched(artifacts.ticket.id, artifacts.ticket.buyer, artifacts.ticket.seller, artifacts.offer)
        .catch((error: any) => {
            logger.warn('sport_position_deal_matched_webhook_failed', {
                ticketId: artifacts.ticket.id,
                error: error?.message,
            });
        });

    return { arenaMatch, sportEscrow };
}

export async function postSportPosition(walletInput: string, input: {
    fixtureId?: unknown;
    selection?: unknown;
    side?: unknown;
    stakeSol?: unknown;
    clientOrderId?: unknown;
}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const fixtureId = trimString(input.fixtureId);
    if (!fixtureId) throw httpError('fixtureId_required', 400);
    const selection = normalizeSelection(input.selection);
    const side = normalizeSide(input.side);
    const stakeLamports = validateStake(input.stakeSol);
    const clientOrderId = normalizeClientOrderId(input.clientOrderId);
    const now = new Date();
    const fixture = await requireOpenTxlineFixture(fixtureId, now);

    const result = await prisma.$transaction(async (tx) => {
        await expireOpenPositions(tx, now);
        if (clientOrderId) {
            const existing = await (tx as any).sportPosition.findUnique({
                where: { agentWallet_clientOrderId: { agentWallet: wallet, clientOrderId } },
            });
            if (existing) return { existing };
        }

        const draftFundingExpiresAt = fundingExpiresAt(fixture, now);
        if (draftFundingExpiresAt.getTime() <= now.getTime()) {
            throw httpError('sport_fixture_position_window_closed', 409);
        }
        const created = await (tx as any).sportPosition.create({
            data: {
                fixtureId,
                selection,
                side,
                stakeLamports,
                filledLamports: '0',
                remainingLamports: '0',
                refundedLamports: '0',
                vaultVersion: positionVaultVersion(),
                agentWallet: wallet,
                status: 'funding_required',
                expiresAt: fixture.startsAt,
                fundingExpiresAt: draftFundingExpiresAt,
                clientOrderId,
            },
        });
        const vaultPda = derivePositionVaultPdaForVersion(created.id, created.vaultVersion);
        const position = await (tx as any).sportPosition.update({
            where: { id: created.id },
            data: { vaultPda },
        });
        await recordFundingEvent(tx, {
            positionId: position.id,
            wallet,
            event: 'funding_required',
            lamports: stakeLamports,
            metadata: {
                vaultPda,
                fixtureId,
                selection,
                side,
                fundingExpiresAt: draftFundingExpiresAt.toISOString(),
            },
        });
        return { position };
    });

    if ((result as any).existing) {
        const existing = (result as any).existing;
        const balanceCheck = existing.status === 'funding_required'
            ? await fundingBalanceCheck(existing)
            : null;
        return {
            matched: existing.status === 'matched',
            idempotent: true,
            position: serializePosition(existing),
            fundingInstructions: existing.status === 'funding_required' ? fundingInstructions(existing, balanceCheck) : null,
            reason: existing.status === 'funding_required' ? 'existing_position_requires_funding' : undefined,
        };
    }

    const position = (result as any).position;
    const balanceCheck = await fundingBalanceCheck(position);
    return {
        matched: false,
        status: 'funding_required',
        reason: 'stake_must_be_locked_before_position_is_public',
        position: serializePosition(position),
        fundingInstructions: fundingInstructions(position, balanceCheck),
    };
}

async function tryMatchExactFundedPosition(positionId: string, now = new Date()): Promise<Record<string, unknown> | null> {
    const artifacts = await prisma.$transaction(async (tx) => {
        await expireOpenPositions(tx, now);
        const position = await (tx as any).sportPosition.findUnique({ where: { id: positionId } });
        if (!position || position.status !== 'funded_open') return { position };
        const fixture = await (tx as any).arenaFixture.findUnique({ where: { fixtureId: position.fixtureId } });
        if (!fixture) throw httpError('sport_fixture_not_found', 404);
        await requireOpenTxlineFixture(position.fixtureId, now);

        const counterparty = await (tx as any).sportPosition.findFirst({
            where: {
                fixtureId: position.fixtureId,
                selection: position.selection,
                stakeLamports: position.stakeLamports,
                side: oppositeSide(position.side as SportSide),
                status: 'funded_open',
                expiresAt: { gt: now },
                agentWallet: { not: position.agentWallet },
            },
            orderBy: [{ fundedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        });
        if (!counterparty) return { position };

        const claimedPosition = await (tx as any).sportPosition.updateMany({
            where: { id: position.id, status: 'funded_open' },
            data: { status: 'matching' },
        });
        const claimedCounterparty = await (tx as any).sportPosition.updateMany({
            where: { id: counterparty.id, status: 'funded_open' },
            data: { status: 'matching' },
        });
        if (claimedPosition.count !== 1 || claimedCounterparty.count !== 1) {
            return { position };
        }

        await recordFundingEvent(tx, {
            positionId: counterparty.id,
            wallet: counterparty.agentWallet,
            event: 'matching',
            lamports: counterparty.stakeLamports,
            metadata: { counterpartyPositionId: position.id },
        });
        await recordFundingEvent(tx, {
            positionId: position.id,
            wallet: position.agentWallet,
            event: 'matching',
            lamports: position.stakeLamports,
            metadata: { counterpartyPositionId: counterparty.id },
        });

        return createMatchedArtifacts(tx, {
            makerPosition: counterparty,
            takerPosition: position,
            fixture,
        });
    });

    if (!(artifacts as any).ticket) return null;
    const attach = await attachEscrowOrCompensate(artifacts as MatchArtifacts);
    return matchedResponse(artifacts as MatchArtifacts, attach);
}

function reservePositionFillData(row: any, fillLamports: bigint, now: Date): Record<string, unknown> {
    const filled = BigInt(positionFilledLamports(row));
    const remaining = BigInt(positionRemainingLamports(row));
    const nextFilled = filled + fillLamports;
    const nextRemaining = remaining - fillLamports;
    if (nextRemaining < 0n) throw httpError('sport_position_overfill_rejected', 409);
    return {
        filledLamports: nextFilled.toString(),
        remainingLamports: nextRemaining.toString(),
        status: statusFromAccounting(nextFilled, nextRemaining),
        matchedAt: row.matchedAt || now,
    };
}

async function tryMatchPartialFundedPosition(positionId: string, now = new Date()): Promise<Record<string, unknown> | null> {
    const matches: Record<string, unknown>[] = [];
    const maxFills = Math.min(Math.max(Number(process.env.SPORT_PARTIAL_MAX_FILLS_PER_CONFIRM) || 8, 1), 25);

    for (let index = 0; index < maxFills; index += 1) {
        let artifacts: any;
        try {
            artifacts = await prisma.$transaction(async (tx) => {
                await expireOpenPositions(tx, now);
                const position = await (tx as any).sportPosition.findUnique({ where: { id: positionId } });
                if (!position || !['funded_open', 'partially_filled'].includes(position.status)) return { position };
                if ((position.vaultVersion || 'v1') !== 'v2') return { position };
                const remaining = BigInt(positionRemainingLamports(position));
                if (remaining <= 0n) return { position };

                const fixture = await (tx as any).arenaFixture.findUnique({ where: { fixtureId: position.fixtureId } });
                if (!fixture) throw httpError('sport_fixture_not_found', 404);
                await requireOpenTxlineFixture(position.fixtureId, now);

                const candidates = await (tx as any).sportPosition.findMany({
                    where: {
                        fixtureId: position.fixtureId,
                        OR: matchCandidateBranches(position),
                        status: { in: ['funded_open', 'partially_filled'] },
                        expiresAt: { gt: now },
                        agentWallet: { not: position.agentWallet },
                        vaultVersion: 'v2',
                        remainingLamports: { not: '0' },
                    },
                    orderBy: [{ fundedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
                    take: 25,
                });
                const counterparty = candidates.find((candidate: any) => {
                    return BigInt(positionRemainingLamports(candidate)) > 0n
                        && resolveSportMatchKind(position, candidate) !== null;
                });
                if (!counterparty) return { position };
                const matchKind = resolveSportMatchKind(position, counterparty);
                if (!matchKind) return { position };

                const counterpartyRemaining = BigInt(positionRemainingLamports(counterparty));
                const fillAmount = remaining < counterpartyRemaining ? remaining : counterpartyRemaining;
                if (fillAmount <= 0n) return { position };

                const claimedPosition = await (tx as any).sportPosition.updateMany({
                    where: {
                        id: position.id,
                        status: position.status,
                        remainingLamports: positionRemainingLamports(position),
                    },
                    data: reservePositionFillData(position, fillAmount, now),
                });
                const claimedCounterparty = await (tx as any).sportPosition.updateMany({
                    where: {
                        id: counterparty.id,
                        status: counterparty.status,
                        remainingLamports: positionRemainingLamports(counterparty),
                    },
                    data: reservePositionFillData(counterparty, fillAmount, now),
                });
                if (claimedPosition.count !== 1 || claimedCounterparty.count !== 1) {
                    throw httpError('sport_position_match_race_retry', 409);
                }

                const backPosition = matchKind === 'same_selection_back_lay'
                    ? (position.side === 'back' ? position : counterparty)
                    : counterparty;
                const layPosition = matchKind === 'same_selection_back_lay'
                    ? (position.side === 'lay' ? position : counterparty)
                    : position;
                const fill = await (tx as any).sportPositionFill.create({
                    data: {
                        fixtureId: position.fixtureId,
                        selection: position.selection,
                        backPositionId: backPosition.id,
                        layPositionId: layPosition.id,
                        backWallet: backPosition.agentWallet,
                        layWallet: layPosition.agentWallet,
                        fillLamports: fillAmount.toString(),
                        status: 'committing',
                    },
                });

                await recordFundingEvent(tx, {
                    positionId: position.id,
                    wallet: position.agentWallet,
                    event: 'partial_fill_reserved',
                    lamports: fillAmount.toString(),
                        metadata: {
                            fillId: fill.id,
                            counterpartyPositionId: counterparty.id,
                            matchKind,
                            counterpartySelection: counterparty.selection,
                            drawPolicy: matchKind === 'complement_back_back' ? 'void_refund' : null,
                            remainingLamportsBefore: remaining.toString(),
                        },
                    });
                await recordFundingEvent(tx, {
                    positionId: counterparty.id,
                    wallet: counterparty.agentWallet,
                    event: 'partial_fill_reserved',
                    lamports: fillAmount.toString(),
                        metadata: {
                            fillId: fill.id,
                            counterpartyPositionId: position.id,
                            matchKind,
                            counterpartySelection: position.selection,
                            drawPolicy: matchKind === 'complement_back_back' ? 'void_refund' : null,
                            remainingLamportsBefore: counterpartyRemaining.toString(),
                        },
                    });

                return createMatchedArtifacts(tx, {
                    makerPosition: counterparty,
                    takerPosition: position,
                    fixture,
                    fill,
                    fillLamports: fillAmount.toString(),
                    matchKind,
                });
            });
        } catch (error: any) {
            if (error?.message === 'sport_position_match_race_retry') {
                logger.warn('sport_position_partial_match_race_retry', { positionId, attempt: index + 1 });
                continue;
            }
            throw error;
        }

        if (!(artifacts as any).ticket) break;
        const attach = await attachEscrowOrCompensate(artifacts as MatchArtifacts);
        matches.push(matchedResponse(artifacts as MatchArtifacts, attach));
    }

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    return {
        matched: true,
        matchCount: matches.length,
        matches,
        fills: matches.map((match: any) => match.fill).filter(Boolean),
    };
}

async function tryMatchFundedPosition(positionId: string, now = new Date()): Promise<Record<string, unknown> | null> {
    const current = await prismaAny.sportPosition.findUnique({ where: { id: positionId } });
    if (!current) return null;
    if ((current.vaultVersion || 'v1') !== 'v2' || !sportPartialFillEnabled()) {
        return tryMatchExactFundedPosition(positionId, now);
    }
    return tryMatchPartialFundedPosition(positionId, now);
}

export async function confirmSportPositionFunding(walletInput: string, positionIdInput: unknown, input: {
    fundingTx?: unknown;
    txSignature?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const positionId = trimString(positionIdInput);
    if (!positionId) throw httpError('position_id_required', 400);
    const fundingTx = trimString(input.fundingTx) || trimString(input.txSignature);
    requireFundingTxIfConfigured(fundingTx);
    const now = new Date();

    const current = await prismaAny.sportPosition.findUnique({ where: { id: positionId } });
    if (!current) throw httpError('sport_position_not_found', 404);
    if (current.agentWallet !== wallet) throw httpError('sport_position_wallet_mismatch', 403);
    if (!current.vaultPda) throw httpError('sport_position_missing_vault', 409);
    if (current.status === 'matched' || current.status === 'filled') {
        return { matched: true, idempotent: true, position: serializePosition(current) };
    }
    if (current.status === 'funded_open' || current.status === 'partially_filled') {
        const matched = await tryMatchFundedPosition(positionId, now);
        return matched || {
            matched: false,
            idempotent: true,
            status: current.status,
            position: serializePosition(current),
        };
    }
    if (current.status !== 'funding_required') {
        throw httpError('sport_position_not_awaiting_funding', 409);
    }
    if (current.fundingExpiresAt && new Date(current.fundingExpiresAt).getTime() <= now.getTime()) {
        await prismaAny.sportPosition.update({
            where: { id: positionId },
            data: { status: 'expired' },
        });
        throw httpError('sport_position_funding_window_expired', 409);
    }

    const verification = await verifyFundingTxIfConfigured(current, fundingTx);
    const funded = await prisma.$transaction(async (tx) => {
        const claimed = await (tx as any).sportPosition.updateMany({
            where: { id: positionId, status: 'funding_required' },
            data: {
                status: 'funded_open',
                fundingTx: fundingTx || current.fundingTx || null,
                fundedLamports: current.stakeLamports,
                filledLamports: current.filledLamports || '0',
                remainingLamports: current.stakeLamports,
                fundedAt: now,
            },
        });
        if (claimed.count !== 1) {
            return (tx as any).sportPosition.findUnique({ where: { id: positionId } });
        }
        const row = await (tx as any).sportPosition.findUnique({ where: { id: positionId } });
        await recordFundingEvent(tx, {
            positionId,
            wallet,
            event: 'funded_open',
            txSignature: fundingTx || null,
            lamports: current.stakeLamports,
            metadata: verification,
        });
        return row;
    });

    const matched = await tryMatchFundedPosition(positionId, now);
    return matched || {
        matched: false,
        status: 'funded_open',
        reason: (funded?.vaultVersion || 'v1') === 'v2'
            ? 'waiting_for_opposite_side_liquidity'
            : 'waiting_for_equal_stake_counterparty',
        position: serializePosition(funded),
        fundingProof: verification,
    };
}

export async function executeSportPositionFunding(walletInput: string, positionIdInput: unknown, input: {
    walletKeypair?: unknown;
    ownerKeypair?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const positionId = trimString(positionIdInput);
    if (!positionId) throw httpError('position_id_required', 400);
    const ownerKeypair = input.walletKeypair ?? input.ownerKeypair;
    if (!ownerKeypair) throw httpError('walletKeypair_required', 400);
    const cluster = String(process.env.SOLANA_CLUSTER || 'devnet').toLowerCase();
    if ((cluster === 'mainnet' || cluster === 'mainnet-beta') && process.env.SPORT_POSITION_EXECUTE_FUNDING_ALLOW_MAINNET !== 'true') {
        throw httpError('sport_execute_funding_mainnet_disabled', 403);
    }

    const current = await prismaAny.sportPosition.findUnique({ where: { id: positionId } });
    if (!current) throw httpError('sport_position_not_found', 404);
    if (current.agentWallet !== wallet) throw httpError('sport_position_wallet_mismatch', 403);
    if (!current.vaultPda) throw httpError('sport_position_missing_vault', 409);
    if ((current.vaultVersion || 'v1') !== 'v2') {
        throw httpError('sport_execute_funding_requires_v2_position', 409);
    }
    if (current.status === 'funded_open' || current.status === 'partially_filled' || current.status === 'matched' || current.status === 'filled') {
        const confirmed = await confirmSportPositionFunding(wallet, positionId, {
            fundingTx: current.fundingTx || undefined,
        });
        return {
            executed: false,
            idempotent: true,
            fundingTx: current.fundingTx || null,
            position: serializePosition(current),
            confirmation: confirmed,
        };
    }
    if (current.status !== 'funding_required') {
        throw httpError('sport_position_not_awaiting_funding', 409);
    }
    const expiresAtUnix = unixSeconds(current.fundingExpiresAt);
    if (!expiresAtUnix) throw httpError('sport_position_missing_funding_expiry', 409);
    if (new Date(current.fundingExpiresAt).getTime() <= Date.now()) {
        await prismaAny.sportPosition.update({
            where: { id: positionId },
            data: { status: 'expired' },
        });
        throw httpError('sport_position_funding_window_expired', 409);
    }

    try {
        await prismaAny.sportPositionFundingEvent?.create?.({
            data: {
                positionId,
                wallet,
                event: 'funding_execution_started',
                lamports: current.stakeLamports,
                metadata: jsonValue({
                    vaultPda: current.vaultPda,
                    vaultVersion: current.vaultVersion || 'v2',
                    cluster,
                }),
            },
        });
    } catch (error: any) {
        logger.warn('sport_position_funding_execution_event_failed', {
            positionId,
            error: error?.message || String(error),
        });
    }

    const result = await middlemanForwarder.forwardSportPositionFunding({
        positionId,
        ownerWallet: wallet,
        ownerKeypair,
        fixtureId: current.fixtureId,
        marketType: SPORT_MARKET_TYPE,
        selection: current.selection,
        side: current.side === 'lay' ? 'lay' : 'back',
        stakeLamports: current.stakeLamports,
        expiresAtUnix,
        vaultPda: current.vaultPda,
    });

    if (!result.success || !result.fundingTx) {
        try {
            await prismaAny.sportPositionFundingEvent?.create?.({
                data: {
                    positionId,
                    wallet,
                    event: 'funding_execution_failed',
                    lamports: current.stakeLamports,
                    metadata: jsonValue({
                        error: result.error || 'sport_position_funding_execution_failed',
                        vaultPda: current.vaultPda,
                    }),
                },
            });
        } catch {
            // Best-effort audit event; funding failure remains the returned error.
        }
        throw httpError(result.error || 'sport_position_funding_execution_failed', 502);
    }

    try {
        await prismaAny.sportPositionFundingEvent?.create?.({
            data: {
                positionId,
                wallet,
                event: 'funding_executed',
                txSignature: result.fundingTx,
                lamports: current.stakeLamports,
                metadata: jsonValue({
                    initTx: result.initTx || null,
                    fundingTx: result.fundingTx,
                    vaultPda: result.vaultPda || current.vaultPda,
                }),
            },
        });
    } catch {
        // Best-effort audit event; the chain transaction is the source of truth.
    }

    const confirmation = await confirmSportPositionFunding(wallet, positionId, {
        fundingTx: result.fundingTx,
    });

    return {
        executed: true,
        initTx: result.initTx || null,
        fundingTx: result.fundingTx,
        tx: result.fundingTx,
        vaultPda: result.vaultPda || current.vaultPda,
        positionId,
        confirmation,
    };
}

export async function acceptSportPosition(walletInput: string, positionIdInput: unknown, input: {
    clientOrderId?: unknown;
    stakeSol?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const positionId = trimString(positionIdInput);
    if (!positionId) throw httpError('position_id_required', 400);
    const clientOrderId = normalizeClientOrderId(input.clientOrderId);
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
        await expireOpenPositions(tx, now);
        const makerPosition = await (tx as any).sportPosition.findUnique({ where: { id: positionId } });
        if (!makerPosition) throw httpError('sport_position_not_found', 404);
        if (!['funded_open', 'partially_filled'].includes(makerPosition.status)) {
            throw httpError('position_not_available_until_funded', 409);
        }
        if (makerPosition.agentWallet === wallet) throw httpError('cannot_accept_own_position', 403);
        const makerRemaining = BigInt(positionRemainingLamports(makerPosition));
        if (makerRemaining <= 0n) throw httpError('sport_position_no_remaining_liquidity', 409);
        const fixture = await (tx as any).arenaFixture.findUnique({ where: { fixtureId: makerPosition.fixtureId } });
        if (!fixture) throw httpError('sport_fixture_not_found', 404);
        await requireOpenTxlineFixture(makerPosition.fixtureId, now);
        if (clientOrderId) {
            const existing = await (tx as any).sportPosition.findUnique({
                where: { agentWallet_clientOrderId: { agentWallet: wallet, clientOrderId } },
            });
            if (existing) return { existing };
        }
        const takerStakeLamports = input.stakeSol === undefined || input.stakeSol === null || input.stakeSol === ''
            ? makerRemaining.toString()
            : validateStake(input.stakeSol);
        if ((makerPosition.vaultVersion || 'v1') !== 'v2' && takerStakeLamports !== makerPosition.stakeLamports) {
            throw httpError('partial_accept_requires_v2_position', 409);
        }

        const created = await (tx as any).sportPosition.create({
            data: {
                fixtureId: makerPosition.fixtureId,
                selection: makerPosition.selection,
                side: oppositeSide(makerPosition.side as SportSide),
                stakeLamports: takerStakeLamports,
                filledLamports: '0',
                remainingLamports: '0',
                refundedLamports: '0',
                vaultVersion: makerPosition.vaultVersion || positionVaultVersion(),
                agentWallet: wallet,
                status: 'funding_required',
                expiresAt: makerPosition.expiresAt,
                fundingExpiresAt: fundingExpiresAt(fixture, now),
                clientOrderId,
            },
        });
        const vaultPda = derivePositionVaultPdaForVersion(created.id, created.vaultVersion);
        const takerPosition = await (tx as any).sportPosition.update({
            where: { id: created.id },
            data: { vaultPda },
        });
        await recordFundingEvent(tx, {
            positionId: takerPosition.id,
            wallet,
            event: 'funding_required',
            lamports: takerPosition.stakeLamports,
            metadata: {
                acceptedPositionId: makerPosition.id,
                vaultPda,
                lazyAccept: true,
                requestedStakeLamports: takerStakeLamports,
                makerRemainingLamports: makerRemaining.toString(),
            },
        });
        return { position: takerPosition, acceptedPosition: makerPosition };
    });

    if ((result as any).existing) {
        const existing = (result as any).existing;
        const balanceCheck = existing.status === 'funding_required'
            ? await fundingBalanceCheck(existing)
            : null;
        return {
            matched: existing.status === 'matched',
            idempotent: true,
            position: serializePosition(existing),
            fundingInstructions: existing.status === 'funding_required' ? fundingInstructions(existing, balanceCheck) : null,
        };
    }

    const position = (result as any).position;
    const balanceCheck = await fundingBalanceCheck(position);
    return {
        matched: false,
        status: 'funding_required',
        reason: 'counterparty_stake_must_be_locked_before_partial_match',
        position: serializePosition(position),
        acceptedPosition: serializePosition((result as any).acceptedPosition),
        fundingInstructions: fundingInstructions(position, balanceCheck),
    };
}

export async function cancelSportPosition(walletInput: string, positionIdInput: unknown, input: {
    cancelTx?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const positionId = trimString(positionIdInput);
    if (!positionId) throw httpError('position_id_required', 400);
    const cancelTx = trimString(input.cancelTx);
    const now = new Date();
    const position = await prisma.$transaction(async (tx) => {
        const row = await (tx as any).sportPosition.findUnique({ where: { id: positionId } });
        if (!row) throw httpError('sport_position_not_found', 404);
        if (row.agentWallet !== wallet) throw httpError('sport_position_wallet_mismatch', 403);
        if (!['funding_required', 'funded_open', 'partially_filled', 'open'].includes(row.status)) {
            throw httpError('sport_position_cannot_cancel_after_match', 409);
        }
        const remaining = BigInt(positionRemainingLamports(row));
        const filled = BigInt(positionFilledLamports(row));
        const refunded = BigInt(bigintString(row.refundedLamports));
        const cancelRefundLamports = ['funded_open', 'partially_filled', 'open'].includes(row.status)
            ? remaining
            : 0n;
        const nextStatus = row.status === 'partially_filled' && filled > 0n ? 'filled' : 'cancelled';
        const updated = await (tx as any).sportPosition.update({
            where: { id: positionId },
            data: {
                status: nextStatus,
                cancelTx: cancelTx || row.cancelTx || null,
                remainingLamports: '0',
                refundedLamports: (refunded + cancelRefundLamports).toString(),
            },
        });
        await recordFundingEvent(tx, {
            positionId,
            wallet,
            event: cancelRefundLamports > 0n ? 'cancel_remaining_refund_required' : 'cancelled',
            txSignature: cancelTx || null,
            lamports: cancelRefundLamports > 0n ? cancelRefundLamports.toString() : null,
            metadata: {
                previousStatus: row.status,
                cancelledAt: now.toISOString(),
                vaultPda: row.vaultPda || null,
                filledLamports: filled.toString(),
                remainingLamports: remaining.toString(),
            },
        });
        return updated;
    });
    return {
        cancelled: true,
        refundRequired: Boolean(BigInt(position.refundedLamports || '0') > 0n && !cancelTx),
        position: serializePosition(position),
    };
}

function expiredRefundLimit(value: unknown): number {
    return Math.min(Math.max(Math.floor(Number(value) || 25), 1), 100);
}

export async function sweepExpiredSportPositionRefunds(options: {
    limit?: unknown;
    now?: Date;
} = {}): Promise<Record<string, unknown>> {
    const now = options.now || new Date();
    const limit = expiredRefundLimit(options.limit);
    const candidates = await prismaAny.sportPosition.findMany({
        where: {
            status: { in: ['funded_open', 'partially_filled', 'expired'] },
            vaultVersion: 'v2',
            vaultPda: { not: null },
            remainingLamports: { not: '0' },
            expiresAt: { lte: now },
        },
        orderBy: [{ expiresAt: 'asc' }, { fundedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
    });

    const refunded: Record<string, unknown>[] = [];
    const skipped: Record<string, unknown>[] = [];

    for (const candidate of candidates) {
        const remaining = BigInt(positionRemainingLamports(candidate));
        if (remaining <= 0n) {
            skipped.push({ positionId: candidate.id, reason: 'no_remaining_lamports' });
            continue;
        }
        const previousStatus = candidate.status;
        const claim = await prismaAny.sportPosition.updateMany({
            where: {
                id: candidate.id,
                status: previousStatus,
                remainingLamports: positionRemainingLamports(candidate),
            },
            data: { status: 'refund_pending' },
        });
        if (claim.count !== 1) {
            skipped.push({ positionId: candidate.id, reason: 'refund_claim_race' });
            continue;
        }

        await prisma.$transaction(async (tx) => {
            await recordFundingEvent(tx, {
                positionId: candidate.id,
                wallet: candidate.agentWallet,
                event: 'expired_remaining_refund_started',
                lamports: remaining.toString(),
                metadata: {
                    previousStatus,
                    vaultPda: candidate.vaultPda,
                    expiresAt: new Date(candidate.expiresAt).toISOString(),
                    sweptAt: now.toISOString(),
                },
            });
        });

        const bridgeResult = await middlemanForwarder.forwardExpiredSportPositionRefund({
            positionId: candidate.id,
            ownerWallet: candidate.agentWallet,
            vaultPda: candidate.vaultPda,
            closeIfNoCommittedStake: BigInt(positionFilledLamports(candidate)) === 0n,
        });

        if (!bridgeResult.success) {
            await prisma.$transaction(async (tx) => {
                await (tx as any).sportPosition.updateMany({
                    where: { id: candidate.id, status: 'refund_pending' },
                    data: { status: previousStatus },
                });
                await recordFundingEvent(tx, {
                    positionId: candidate.id,
                    wallet: candidate.agentWallet,
                    event: 'expired_remaining_refund_failed',
                    lamports: remaining.toString(),
                    metadata: {
                        previousStatus,
                        error: bridgeResult.error || 'unknown_error',
                    },
                });
            });
            skipped.push({
                positionId: candidate.id,
                reason: 'expired_refund_bridge_failed',
                error: bridgeResult.error || 'unknown_error',
            });
            continue;
        }

        const filled = BigInt(positionFilledLamports(candidate));
        const refundedLamports = BigInt(bigintString(bridgeResult.refundedLamports, remaining.toString()));
        const alreadyRefunded = BigInt(bigintString(candidate.refundedLamports));
        const nextStatus = filled > 0n ? 'filled' : 'cancelled';
        const updated = await prisma.$transaction(async (tx) => {
            const row = await (tx as any).sportPosition.update({
                where: { id: candidate.id },
                data: {
                    status: nextStatus,
                    remainingLamports: '0',
                    refundedLamports: (alreadyRefunded + refundedLamports).toString(),
                    cancelTx: bridgeResult.tx || candidate.cancelTx || null,
                },
            });
            await recordFundingEvent(tx, {
                positionId: candidate.id,
                wallet: candidate.agentWallet,
                event: 'expired_remaining_refunded',
                txSignature: bridgeResult.tx || null,
                lamports: refundedLamports.toString(),
                metadata: {
                    previousStatus,
                    nextStatus,
                    vaultPda: candidate.vaultPda,
                    closeTx: bridgeResult.closeTx || null,
                    closed: Boolean(bridgeResult.closed),
                    sweptAt: now.toISOString(),
                },
            });
            return row;
        });

        refunded.push({
            positionId: candidate.id,
            wallet: candidate.agentWallet,
            refundedLamports: refundedLamports.toString(),
            refundTx: bridgeResult.tx || null,
            closeTx: bridgeResult.closeTx || null,
            status: updated.status,
        });
    }

    return {
        mode: 'SPORT',
        scanned: candidates.length,
        refundedCount: refunded.length,
        skippedCount: skipped.length,
        refunded,
        skipped,
    };
}

export async function getSportPosition(walletInput: string, positionIdInput: unknown): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const positionId = trimString(positionIdInput);
    if (!positionId) throw httpError('position_id_required', 400);
    const position = await prismaAny.sportPosition.findUnique({ where: { id: positionId } });
    if (!position) throw httpError('sport_position_not_found', 404);
    if (
        position.agentWallet !== wallet
        && !['funded_open', 'partially_filled', 'matched', 'filled', 'expired', 'cancelled'].includes(position.status)
    ) {
        throw httpError('sport_position_not_public', 403);
    }
    return {
        position: serializePosition(position),
    };
}

export async function listSportPositions(options: {
    fixtureId?: unknown;
    status?: unknown;
    limit?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const fixtureId = trimString(options.fixtureId);
    const status = normalizePositionStatus(options.status, 'funded_open');
    const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 50), 1), 100);
    const where: Record<string, unknown> = {};
    if (fixtureId) where.fixtureId = fixtureId;
    if (status === 'funding_required' || status === 'funding_failed') {
        return {
            count: 0,
            positions: [],
            note: 'funding drafts are private; use /v1/sport/me/positions for wallet-owned recovery',
        };
    }
    if (status === 'all') {
        where.status = { in: [...PUBLIC_POSITION_STATUSES] };
    } else if (status === 'funded_open') {
        where.status = { in: ['funded_open', 'partially_filled'] };
        where.remainingLamports = { not: '0' };
    } else {
        where.status = status;
    }
    const positions = await prismaAny.sportPosition.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
    });
    return {
        count: positions.length,
        positions: positions.map(serializePosition),
    };
}

export async function listMySportPositions(walletInput: string, options: {
    status?: unknown;
    limit?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const status = normalizePositionStatus(options.status, 'all');
    const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 100), 1), 200);
    const positions = await prismaAny.sportPosition.findMany({
        where: {
            agentWallet: wallet,
            ...(status && status !== 'all' ? { status } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
    });
    return {
        wallet,
        count: positions.length,
        positions: positions.map(serializePosition),
    };
}

export async function listSportPositionFills(walletInput: string, positionIdInput: unknown, options: {
    limit?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const positionId = trimString(positionIdInput);
    if (!positionId) throw httpError('position_id_required', 400);
    const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 100), 1), 200);
    const position = await prismaAny.sportPosition.findUnique({ where: { id: positionId } });
    if (!position) throw httpError('sport_position_not_found', 404);
    if (
        position.agentWallet !== wallet
        && !['funded_open', 'partially_filled', 'matched', 'filled', 'expired', 'cancelled'].includes(position.status)
    ) {
        throw httpError('sport_position_not_public', 403);
    }
    const fills = await prismaAny.sportPositionFill.findMany({
        where: {
            OR: [
                { backPositionId: positionId },
                { layPositionId: positionId },
            ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
    });
    return {
        position: serializePosition(position),
        count: fills.length,
        fills: fills.map(serializeFill),
    };
}

export async function listMySportFills(walletInput: string, options: {
    status?: unknown;
    limit?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const status = trimString(options.status)?.toLowerCase();
    const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 100), 1), 200);
    const where: Record<string, unknown> = {
        OR: [
            { backWallet: wallet },
            { layWallet: wallet },
        ],
    };
    if (status && status !== 'all') where.status = status;
    const fills = await prismaAny.sportPositionFill.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
    });
    return {
        wallet,
        count: fills.length,
        fills: fills.map(serializeFill),
    };
}

export async function listMySportTickets(walletInput: string, options: {
    limit?: unknown;
} = {}): Promise<Record<string, unknown>> {
    const wallet = validateWallet(walletInput);
    const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 100), 1), 200);
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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
    });
    return {
        wallet,
        count: matches.length,
        tickets: matches.map(serializeArenaMatch),
    };
}
