import express from 'express';
import { PublicKey } from '@solana/web3.js';
import { eventBus } from '../services/eventBus';
import { logger } from '../utils/logger';
import crypto from 'crypto';
import { dealPhaseManager } from '../../core/dealPhaseManager';
import { soulEngine } from '../services/soulEngine';
import { analyzeMessage } from '../../core/middlemanBrain';
import { negotiationStore } from '../state/negotiationStore';
import { getBeliefs } from '../services/beliefStore';
import { experienceMemory } from '../services/experienceMemory';
import {
    computeTermsHash,
    generateNonce,
    verifyTermsHash,
    storePrivateTerms,
    getPrivateTerms,
    getPrivacyStatus,
    type PrivacyTerms,
} from '../services/privacyService';
import { logDrain, type LogEntry } from '../utils/logger';
import { telemetryService } from '../services/telemetryService';
import { rpcHealthTracker } from '../services/rpcHealthTracker';
import { offerScanner, type ScanCriteria } from '../services/offerScanner';
import { getTokenPrice, checkPriceDeviation, startPriceOracle } from '../services/priceOracle';
import { solanaToolkit } from '../services/solanaToolkit';
import * as approvalService from '../services/approvalService';
import * as relationshipStore from '../services/relationshipStore';
import * as goalManager from '../services/goalManager';
import * as taskPipeline from '../services/taskPipeline';
import { analyzeImage } from '../services/visionEngine';
import { generateImage } from '../services/imageGenerator';
import * as scheduler from '../services/schedulerService';
import { autonomy } from '../services/autonomyConfig';
import { ticketStore } from '../state/ticketStore';
import { settlementTargetStore } from '../state/settlementTargetStore';
import { rewardTargetStore } from '../state/rewardTargetStore';
import { getAgentDWallet, isConfidentialEscrowReady } from '../services/confidentialExecutionService';
import { executeDeal, executeRelease } from '../services/executionService';
import { executeCancelDeal, executeCommitSportPositionFillToDeal, executeCommitSportPositionsToDeal, executeFractionalSplit, executeFundSportPositionV2, executeRefundExpiredSportPositionRemaining, executeSettleToBuyerPhase, type ExecutionResult } from '../services/onChainExecutionService';
import { executeSportSettlement } from '../services/sportSettlementBridge';
import { loadConfig } from '../config';
import { registerObservatoryTicketMapping } from '../services/observatoryBridge';
import { pipelineStateStore } from '../state/pipelineStateStore';
import { prisma } from '../lib/prisma';
import { verifyAuditChain } from '../services/auditTrail';
import dealTimelineRouter from './dealTimeline';
import { resolveEscrowTermsForTicket } from '../services/escrowTermsResolver';

let server: any;

type LocalDemoOffer = {
    id: string;
    asset: string;
    price: number;
    amount: number;
    mode: "buy" | "sell";
    collateral: number;
    status: "active" | "matching" | "matched";
    creator: { wallet: string };
    creatorSettlementWallet?: string | null;
    creatorRewardWallet?: string | null;
    creatorFundingWallet?: string | null;
    rollupMode: "ER" | "PER" | "NONE" | "SPORT";
    tokenMint?: string | null;
    tokenDecimals?: number;
};

const localDemoOffers = new Map<string, LocalDemoOffer>();

function isPerStrictOpaqueModeEnabled(): boolean {
    return (process.env.PER_STRICT_OPAQUE_MODE || "true").toLowerCase() !== "false";
}

export function resolveSportStake(price: number, amount: number): number {
    return price > 0 ? price : amount;
}

export function resolveSportEscrowAssetType(rollupMode: string | undefined, asset?: string | null, tokenMint?: string | null): string {
    if (rollupMode === "SPORT") {
        return "SOL";
    }
    return asset || tokenMint || "SOL";
}

type OnChainActionResult = {
    success?: boolean;
    on_chain_action?: string;
    splitRatios?: { buyerRefundPercent: number; sellerReleasePercent: number };
};

function scheduleOnChainAction(ticketId: string, result: OnChainActionResult): void {
    if (!result.success || !result.on_chain_action) {
        return;
    }

    logger.info("rest_on_chain_action_check", {
        ticketId,
        on_chain_action: result.on_chain_action,
    });

    if (result.on_chain_action === "create_deal") {
        executeDeal(ticketId).catch((err: any) => {
            logger.error("rest_execution_unhandled_failure", { ticketId }, err);
        });
    } else if (result.on_chain_action === "release_funds") {
        executeRelease(ticketId).catch((err: any) => {
            logger.error("rest_release_unhandled_failure", { ticketId }, err);
        });
    } else if (result.on_chain_action === "fractional_split_funds") {
        executeFractionalSplit(ticketId, result.splitRatios).catch((err: any) => {
            logger.error("rest_fractional_split_unhandled_failure", { ticketId }, err);
        });
    } else if (result.on_chain_action === "cancel_deal") {
        executeCancelDeal(ticketId).catch((err: any) => {
            logger.error("rest_cancel_unhandled_failure", { ticketId }, err);
        });
    } else if (result.on_chain_action === "settle_to_buyer") {
        executeSettleToBuyerPhase(ticketId).catch((err: any) => {
            logger.error("rest_settle_to_buyer_unhandled_failure", { ticketId }, err);
        });
    }
}

function validateSettlementWallet(value: unknown, label: string): string | null {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    if (typeof value !== 'string') {
        throw new Error(`${label} must be a base58 Solana address`);
    }

    try {
        return new PublicKey(value).toBase58();
    } catch {
        throw new Error(`${label} must be a valid base58 Solana address`);
    }
}

function sanitizeLocalOffer(offer: LocalDemoOffer) {
    const {
        creatorSettlementWallet: _hiddenSettlement,
        creatorRewardWallet: _hiddenReward,
        creatorFundingWallet: _hiddenFunding,
        ...rest
    } = offer;
    return rest;
}

function mapPersistedDealStatusToPublicPhase(status: string | null | undefined): string | null {
    switch (status) {
        case 'settled':
            return 'settled';
        case 'completed':
            return 'completed';
        case 'cancelled':
            return 'cancelled';
        case 'refunded':
            return 'cancelled';
        case 'failed':
            return 'failed';
        case 'pending_execution':
            return 'negotiation';
        case 'created':
            return 'escrow_created';
        case 'collateral_locked':
            return 'awaiting_deposits';
        case 'awaiting_result':
            return 'awaiting_result';
        case 'payment_locked':
            return 'delivery';
        default:
            return null;
    }
}

function mapPipelineStageToPublicPhase(stage: string | null | undefined): string | null {
    switch (stage) {
        case 'settled':
            return 'settled';
        case 'failed':
            return 'failed';
        case 'escrow_created':
            return 'escrow_created';
        case 'encrypted':
            return 'delivery';
        case 'awaiting_buyer_release_confirmation':
            return 'awaiting_buyer_release_confirmation';
        case 'seller_dispute_window':
            return 'seller_dispute_window';
        case 'awaiting_release_approvals':
        case 'release_authorized':
        case 'release_pending':
        case 'release_signed':
            return 'awaiting_buyer_release_confirmation';
        default:
            return null;
    }
}

async function resolveUnifiedDealStatus(ticketId: string): Promise<{
    phase: string;
    buyer: string | null;
    seller: string | null;
    escrow_pda: string | null;
    payment_locked: boolean;
    terms: unknown;
    history: unknown[];
} | null> {
    const [legacyDeal, latestPipelineStage, persistedDeal] = await Promise.all([
        dealPhaseManager.getDealWithFallback(ticketId),
        pipelineStateStore.getLatestStage(ticketId).catch(() => null),
        prisma.deal.findUnique({
            where: { ticketId },
            select: {
                status: true,
                dealIdOnChain: true,
                price: true,
                collateralBuyer: true,
                collateralSeller: true,
            },
        }).catch(() => null),
    ]);

    if (!legacyDeal && !latestPipelineStage && !persistedDeal) {
        return null;
    }

    const escrowPda = persistedDeal?.dealIdOnChain || legacyDeal?.escrow_pda || null;
    const onChainPhase = escrowPda ? await resolveOnChainPublicPhase(escrowPda) : null;
    const sportAwaitingResultPhase = legacyDeal?.phase === 'awaiting_result' ? 'awaiting_result' : null;
    const publicPhase =
        sportAwaitingResultPhase ||
        onChainPhase ||
        legacyDeal?.phase ||
        mapPersistedDealStatusToPublicPhase(persistedDeal?.status) ||
        mapPipelineStageToPublicPhase(latestPipelineStage?.stage) ||
        'negotiation';

    return {
        phase: publicPhase,
        buyer: legacyDeal?.buyer || null,
        seller: legacyDeal?.seller || null,
        escrow_pda: escrowPda,
        payment_locked:
            publicPhase === 'awaiting_result' ||
            publicPhase === 'delivery' ||
            publicPhase === 'awaiting_buyer_release_confirmation' ||
            publicPhase === 'seller_dispute_window',
        terms: legacyDeal?.terms || null,
        history: legacyDeal?.history?.slice(-5) || [],
    };
}

async function resolveOnChainPublicPhase(escrowPda: string): Promise<string | null> {
    try {
        const { getAnchorProgram } = await import('../services/onChainExecutionService');
        const { program } = getAnchorProgram();
        const account = await (program.account as any).deal.fetch(new PublicKey(escrowPda));
        const status = Object.keys(account.status || {})[0];
        switch (status) {
            case 'created':
                return null;
            case 'collateralLocked':
                return 'delivery';
            case 'paymentLocked':
                return 'delivery';
            case 'completed':
                return 'completed';
            case 'refunded':
                return 'refunded';
            case 'cancelled':
                return 'cancelled';
            default:
                return null;
        }
    } catch (error: any) {
        logger.warn('deal_status_onchain_phase_read_failed', { escrowPda, error: error.message });
        return null;
    }
}

/** Get the underlying HTTP server (used by wsServer to share the same port) */
export function getHttpServer() { return server; }

// ══════════════════════════════════════
// HMAC BRIDGE SECURITY
// Verifies that requests to bridge endpoints come from the API Server.
// ══════════════════════════════════════
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';

function verifyBridgeHmac(req: express.Request, res: express.Response, next: express.NextFunction): void {
    // Dev mode: if no BRIDGE_SECRET configured, allow all (local testing)
    if (!BRIDGE_SECRET) {
        next();
        return;
    }

    const signature = req.headers['x-bridge-signature'] as string;
    const timestamp = req.headers['x-bridge-timestamp'] as string;

    if (!signature || !timestamp) {
        logger.warn('bridge_auth_missing', { ip: req.ip, path: req.path });
        res.status(401).json({ error: 'Missing bridge authentication headers' });
        return;
    }

    // Check timestamp freshness (30 second window)
    const now = Date.now();
    const reqTime = parseInt(timestamp, 10);
    if (isNaN(reqTime) || Math.abs(now - reqTime) > 30000) {
        logger.warn('bridge_auth_expired', { ip: req.ip, path: req.path, age_ms: now - reqTime });
        res.status(401).json({ error: 'Bridge timestamp expired' });
        return;
    }

    // Recompute HMAC
    const body = JSON.stringify(req.body) || '';
    const payload = `${timestamp}:${req.method.toUpperCase()}:${req.path}:${body}`;
    const expected = crypto.createHmac('sha256', BRIDGE_SECRET).update(payload).digest('hex');

    // Constant-time comparison
    try {
        const valid = signature.length === expected.length &&
            crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));

        if (!valid) {
            logger.warn('bridge_auth_invalid', { ip: req.ip, path: req.path });
            res.status(401).json({ error: 'Invalid bridge signature' });
            return;
        }
    } catch {
        res.status(401).json({ error: 'Invalid bridge signature format' });
        return;
    }

    logger.debug('bridge_auth_ok', { path: req.path });
    next();
}

// ══════════════════════════════════════
// BRIDGE RATE LIMITER (per-IP, 30/min)
// ══════════════════════════════════════
const bridgeRequestCounts = new Map<string, { count: number; resetAt: number }>();

function bridgeRateLimiter(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const entry = bridgeRequestCounts.get(ip);

    if (!entry || now > entry.resetAt) {
        bridgeRequestCounts.set(ip, { count: 1, resetAt: now + 60000 });
        next();
        return;
    }

    entry.count++;
    if (entry.count > 30) {
        res.status(429).json({ error: 'Bridge rate limit exceeded (30/min)' });
        return;
    }
    next();
}
export function startRestApi(port: number = parseInt(process.env.API_PORT || "8080")) {
    const app = express();
    app.use(express.json());
    app.use('/api', dealTimelineRouter);

    app.get('/health', async (_req, res) => {
        try {
            await prisma.$queryRaw`SELECT 1`;
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                uptime_seconds: Math.floor(process.uptime()),
                service: 'middleman-agent',
            });
        } catch (e: any) {
            res.status(503).json({
                status: 'down',
                timestamp: new Date().toISOString(),
                service: 'middleman-agent',
                error: e?.message || String(e),
            });
        }
    });

    app.get('/api/audit/:ticketId', async (req, res) => {
        const result = await verifyAuditChain(req.params.ticketId);
        const logs = await prisma.auditLog.findMany({
            where: { ticketId: req.params.ticketId },
            orderBy: { createdAt: 'asc' },
            select: { event: true, createdAt: true, hash: true },
        });
        res.json({ ...result, events: logs });
    });

    app.post('/v1/agents/register', async (req, res) => {
        try {
            const wallet = req.body?.wallet || req.body?.publicKey;
            if (!wallet) {
                res.status(400).json({ success: false, error: "wallet is required" });
                return;
            }

            const { walletRegistry } = await import('../state/walletRegistry');
            const created = !(await walletRegistry.isRegistered(wallet));
            const agent = await walletRegistry.getOrCreateAgent(wallet);
            res.json({ success: true, created, data: { id: agent.id, wallet: agent.wallet } });
        } catch (e: any) {
            logger.error("local_agent_register_failed", { error: e.message });
            res.status(400).json({ success: false, error: e.message });
        }
    });

    app.get('/v1/offers', (req, res) => {
        const asset = typeof req.query.asset === "string" ? req.query.asset : undefined;
        const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
        const offers = [...localDemoOffers.values()].filter((offer) => {
            if (asset && offer.asset !== asset) return false;
            if (mode && offer.mode !== mode) return false;
            return true;
        });
        res.json({ success: true, data: offers.map((offer) => sanitizeLocalOffer(offer)) });
    });

    app.post('/v1/offers', (req, res) => {
        try {
            const {
                type,
                mode,
                asset = "SOL",
                price,
                amount,
                collateral,
                buyerPublicKey,
                publicKey,
                wallet,
                rollupMode,
                tokenMint,
                tokenDecimals,
                settlementWallet,
                rewardWallet,
                fundingWallet,
            } = req.body;

            const offerId = `offer-${Date.now()}`;
            const creatorWallet = publicKey || buyerPublicKey || wallet;
            if (!creatorWallet) {
                res.status(400).json({ success: false, error: "creator wallet is required" });
                return;
            }

            const parsedPrice = Number(price);
            const parsedAmount = Number(amount || 1);
            const parsedCollateral = Number(collateral);
            let creatorSettlementWallet: string | null = null;
            let creatorRewardWallet: string | null = null;
            let creatorFundingWallet: string | null = null;
            try {
                creatorSettlementWallet = validateSettlementWallet(
                    settlementWallet,
                    "settlementWallet"
                );
                creatorRewardWallet = validateSettlementWallet(
                    rewardWallet,
                    "rewardWallet"
                );
                creatorFundingWallet = validateSettlementWallet(
                    fundingWallet,
                    "fundingWallet"
                );
            } catch (e: any) {
                res.status(400).json({ success: false, error: e.message });
                return;
            }
            if (!Number.isFinite(parsedPrice) || parsedPrice <= 0 || !Number.isFinite(parsedCollateral) || parsedCollateral < 0) {
                res.status(400).json({ success: false, error: "price and collateral must be valid numbers" });
                return;
            }

            const offer: LocalDemoOffer = {
                id: offerId,
                asset,
                price: parsedPrice,
                amount: parsedAmount,
                mode: (mode || type) === "sell" ? "sell" : "buy",
                collateral: parsedCollateral,
                status: "active",
                creator: { wallet: creatorWallet },
                creatorSettlementWallet,
                creatorRewardWallet,
                creatorFundingWallet,
                rollupMode:
                    rollupMode === "PER"
                        ? "PER"
                        : rollupMode === "SPORT"
                            ? "SPORT"
                            : rollupMode === "NONE"
                                ? "NONE"
                                : "ER",
                tokenMint,
                tokenDecimals: tokenDecimals ? Number(tokenDecimals) : undefined,
            };
            localDemoOffers.set(offerId, offer);

            // Publish the offer so internal systems know roughly about it
            eventBus.publish("offer_detected", {
                offer_id: offerId,
                type: offer.mode,
                creator: creatorWallet,
                content: `${offer.mode.toUpperCase()} ${offer.amount} ${offer.asset} for ${offer.price} (Collateral: ${offer.collateral})`,
                timestamp: new Date().toISOString()
            });

            res.status(201).json({ success: true, offerId, data: sanitizeLocalOffer(offer) });
            logger.info("rest_api_offer_created", { offerId, creatorWallet });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/v1/offers/:id/accept', async (req, res) => {
        const offerId = req.params.id;
        const offer = localDemoOffers.get(offerId);
        if (!offer) {
            res.status(404).json({ success: false, error: "Offer not found" });
            return;
        }
        if (offer.status !== "active") {
            res.status(409).json({ success: false, error: "Offer already matched" });
            return;
        }

        const accepterWallet = req.body?.publicKey || req.body?.wallet;
        if (!accepterWallet) {
            res.status(400).json({ success: false, error: "accepting wallet is required" });
            return;
        }
        if (accepterWallet === offer.creator.wallet) {
            res.status(403).json({ success: false, error: "Cannot accept own offer" });
            return;
        }

        let accepterSettlementWallet: string | null = null;
        let accepterRewardWallet: string | null = null;
        let accepterFundingWallet: string | null = null;
        try {
            accepterSettlementWallet = validateSettlementWallet(
                req.body?.settlementWallet,
                "settlementWallet"
            );
            accepterRewardWallet = validateSettlementWallet(
                req.body?.rewardWallet,
                "rewardWallet"
            );
            accepterFundingWallet = validateSettlementWallet(
                req.body?.fundingWallet,
                "fundingWallet"
            );
        } catch (e: any) {
            res.status(400).json({ success: false, error: e.message });
            return;
        }

        if ((offer.rollupMode === "ER" || offer.rollupMode === "PER") &&
            (!offer.creatorSettlementWallet || !accepterSettlementWallet)) {
            res.status(400).json({
                success: false,
                error: "Fresh per-deal Umbra settlement wallets are required before accepting this offer.",
            });
            return;
        }

        offer.status = "matching";
        try {
            const buyerWallet = offer.mode === "buy" ? offer.creator.wallet : accepterWallet;
            const sellerWallet = offer.mode === "buy" ? accepterWallet : offer.creator.wallet;
            const buyerSettlementWallet =
                offer.mode === "buy" ? offer.creatorSettlementWallet! : accepterSettlementWallet!;
            const sellerSettlementWallet =
                offer.mode === "buy" ? accepterSettlementWallet! : offer.creatorSettlementWallet!;
            const buyerRewardWallet =
                offer.mode === "buy" ? offer.creatorRewardWallet || null : accepterRewardWallet;
            const sellerRewardWallet =
                offer.mode === "buy" ? accepterRewardWallet : offer.creatorRewardWallet || null;
            const buyerFundingWallet =
                offer.mode === "buy" ? offer.creatorFundingWallet || null : accepterFundingWallet;
            const sellerFundingWallet =
                offer.mode === "buy" ? accepterFundingWallet : offer.creatorFundingWallet || null;
            const hasPartialRewardWallets =
                [buyerRewardWallet, sellerRewardWallet].some((value) => !!value) &&
                [buyerRewardWallet, sellerRewardWallet].some((value) => !value);
            if (hasPartialRewardWallets) {
                res.status(400).json({
                    success: false,
                    error: "Fresh per-deal reward wallets must be supplied by both counterparties together or omitted entirely.",
                });
                return;
            }
            const hasPartialFundingWallets =
                [buyerFundingWallet, sellerFundingWallet].some((value) => !!value) &&
                [buyerFundingWallet, sellerFundingWallet].some((value) => !value);
            if (hasPartialFundingWallets) {
                res.status(400).json({
                    success: false,
                    error: "Fresh per-deal confidential funding wallets must be supplied by both counterparties together or omitted entirely.",
                });
                return;
            }
            const ticketId = `TCK-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
            const strictPerOpaque = offer.rollupMode === 'PER' && isPerStrictOpaqueModeEnabled();
            const { walletRegistry } = await import('../state/walletRegistry');
            const buyerAgent = await walletRegistry.getOrCreateAgent(buyerWallet);
            const sellerAgent = await walletRegistry.getOrCreateAgent(sellerWallet);

            await ticketStore.createTicket({
                ticket_id: ticketId,
                offer_id: offer.id,
                buyer: buyerWallet,
                seller: sellerWallet,
                rollup_mode: offer.rollupMode,
                tokenMint: offer.tokenMint || undefined,
                decimals: offer.tokenDecimals,
                offer_asset: offer.asset,
                offer_price: offer.price,
                offer_amount: offer.amount,
                offer_collateral: offer.collateral,
                status: "active",
                created_at: new Date().toISOString()
            });

            await settlementTargetStore.save({
                ticketId,
                buyerWallet,
                sellerWallet,
                buyerSettlementWallet,
                sellerSettlementWallet,
                source: "local_demo",
                recordedAt: new Date().toISOString(),
                notes: ["Fresh per-deal settlement wallets captured from the SDK local demo flow."],
            });
            if (buyerFundingWallet && sellerFundingWallet) {
                const { confidentialIdentityStore } = await import('../state/confidentialIdentityStore');
                await confidentialIdentityStore.save({
                    ticketId,
                    buyerWallet,
                    sellerWallet,
                    buyerFundingWallet,
                    sellerFundingWallet,
                    source: "local_demo",
                    recordedAt: new Date().toISOString(),
                    notes: ["Fresh per-deal confidential signer wallets captured from the SDK local demo flow."],
                });
            }
            if (buyerRewardWallet && sellerRewardWallet) {
                await rewardTargetStore.save({
                    ticketId,
                    buyerWallet,
                    sellerWallet,
                    buyerRewardWallet,
                    sellerRewardWallet,
                    source: "local_demo",
                    recordedAt: new Date().toISOString(),
                    notes: ["Fresh per-deal reward wallets captured from the SDK local demo flow."],
                });
            }

            dealPhaseManager.initDeal(ticketId, buyerWallet, sellerWallet);

            if (!strictPerOpaque) {
                await negotiationStore.addNegotiationStep(ticketId, {
                    price: offer.price,
                    collateral_buyer: offer.collateral,
                    collateral_seller: offer.collateral,
                    agreement_signal: false,
                    agreement_score: 10,
                }, buyerAgent.id, `Local matched deal: ${offer.amount} ${offer.asset} @ ${offer.price}`);
            }

            offer.status = "matched";
            eventBus.publish("middleman_response", {
                ticket_id: ticketId,
                content: strictPerOpaque
                    ? `🤝 PER deal matched. Buyer: ${buyerWallet.substring(0, 8)}... | Seller: ${sellerWallet.substring(0, 8)}...\n\nPrivate negotiation is open. Use the rollup SDK methods to submit and finalize terms.`
                    : `🤝 Deal matched. Buyer: ${buyerWallet.substring(0, 8)}... | Seller: ${sellerWallet.substring(0, 8)}...\n\nAsset: ${offer.asset} | Amount: ${offer.amount} | Price: ${offer.price}\n\nBoth parties — please confirm your terms to proceed. The Middleman is ready to create escrow once you agree.`,
                phase: "negotiation",
                timestamp: new Date().toISOString()
            });

            if (offer.rollupMode === 'ER' || offer.rollupMode === 'PER') {
                eventBus.publish("negotiation_ready", {
                    ticketId,
                    buyer: buyerWallet,
                    seller: sellerWallet,
                    asset_type: offer.asset,
                    rollupMode: offer.rollupMode,
                });
            }

            logger.info("local_offer_matched", {
                offerId,
                ticketId,
                buyerWallet,
                sellerWallet,
                buyerSettlementWallet,
                sellerSettlementWallet,
                hasFundingWallets: !!buyerFundingWallet && !!sellerFundingWallet,
                hasRewardWallets: !!buyerRewardWallet && !!sellerRewardWallet,
                rollupMode: offer.rollupMode,
            });
            res.status(200).json({ success: true, ticket: { id: ticketId, buyer: buyerWallet, seller: sellerWallet, status: "negotiating", rollupMode: offer.rollupMode } });
        } catch (e: any) {
            offer.status = "active";
            logger.error("local_offer_accept_failed", { offerId, error: e.message });
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ══════════════════════════════════════════════════════════════
    // CRITICAL ENDPOINT: Create a matched deal with BOTH parties
    // 
    // This is the "Quick Buy" action — when a buyer accepts a seller's
    // offer (or vice versa), both wallets are immediately paired into
    // one ticket and the negotiation starts.
    //
    // Called by the API Server's forward bridge when an offer is accepted.
    // ══════════════════════════════════════════════════════════════
    app.post('/v1/deals/create-matched', verifyBridgeHmac, bridgeRateLimiter, async (req, res) => {
        try {
            const {
                buyerWallet,
                sellerWallet,
                asset,
                price,
                amount,
                collateral,
                externalTicketId,
                tokenMint,
                decimals,
                rollupMode,
                buyerSettlementWallet,
                sellerSettlementWallet,
                buyerRewardWallet,
                sellerRewardWallet,
                buyerFundingWallet,
                sellerFundingWallet,
                sportPositionVaults,
            } = req.body;

            if (!buyerWallet || !sellerWallet) {
                res.status(400).json({ error: "Both buyerWallet and sellerWallet are required" });
                return;
            }

            if (buyerWallet === sellerWallet) {
                res.status(400).json({ error: "Buyer and seller cannot be the same wallet" });
                return;
            }

            let normalizedBuyerSettlementWallet: string | null = null;
            let normalizedSellerSettlementWallet: string | null = null;
            let normalizedBuyerRewardWallet: string | null = null;
            let normalizedSellerRewardWallet: string | null = null;
            let normalizedBuyerFundingWallet: string | null = null;
            let normalizedSellerFundingWallet: string | null = null;
            try {
                normalizedBuyerSettlementWallet = validateSettlementWallet(
                    buyerSettlementWallet,
                    "buyerSettlementWallet"
                );
                normalizedSellerSettlementWallet = validateSettlementWallet(
                    sellerSettlementWallet,
                    "sellerSettlementWallet"
                );
                normalizedBuyerRewardWallet = validateSettlementWallet(
                    buyerRewardWallet,
                    "buyerRewardWallet"
                );
                normalizedSellerRewardWallet = validateSettlementWallet(
                    sellerRewardWallet,
                    "sellerRewardWallet"
                );
                normalizedBuyerFundingWallet = validateSettlementWallet(
                    buyerFundingWallet,
                    "buyerFundingWallet"
                );
                normalizedSellerFundingWallet = validateSettlementWallet(
                    sellerFundingWallet,
                    "sellerFundingWallet"
                );
            } catch (e: any) {
                res.status(400).json({ error: e.message });
                return;
            }

            if ((rollupMode === "ER" || rollupMode === "PER") &&
                (!normalizedBuyerSettlementWallet || !normalizedSellerSettlementWallet)) {
                res.status(400).json({
                    error: "Fresh per-deal Umbra settlement wallets are required for matched trade creation.",
                });
                return;
            }
            const hasPartialRewardWallets =
                [normalizedBuyerRewardWallet, normalizedSellerRewardWallet].some((value) => !!value) &&
                [normalizedBuyerRewardWallet, normalizedSellerRewardWallet].some((value) => !value);
            if (hasPartialRewardWallets) {
                res.status(400).json({
                    error: "Fresh per-deal reward wallets must be supplied by both counterparties together or omitted entirely.",
                });
                return;
            }
            const hasPartialFundingWallets =
                [normalizedBuyerFundingWallet, normalizedSellerFundingWallet].some((value) => !!value) &&
                [normalizedBuyerFundingWallet, normalizedSellerFundingWallet].some((value) => !value);
            if (hasPartialFundingWallets) {
                res.status(400).json({
                    error: "Fresh per-deal confidential funding wallets must be supplied by both counterparties together or omitted entirely.",
                });
                return;
            }

            // Use the API Server's ticket UUID when provided, so both systems share the same ID.
            // This eliminates the need for ID mapping — messages forwarded from API use the
            // same ID the middleman knows.
            const ticketId = externalTicketId || `TCK-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
            const parsedPrice = parseFloat(price) || 0;
            const parsedAmount = parseFloat(amount) || 0;
            const parsedCol = parseFloat(collateral) || 0;
            const strictPerOpaque = rollupMode === 'PER' && isPerStrictOpaqueModeEnabled();
            const isSportMode = rollupMode === 'SPORT';
            const sportStake = resolveSportStake(parsedPrice, parsedAmount);
            if (isSportMode && sportStake <= 0) {
                res.status(400).json({ error: "SPORT stake must be greater than zero." });
                return;
            }
            const sportVaults = sportPositionVaults && typeof sportPositionVaults === 'object'
                ? sportPositionVaults as Record<string, unknown>
                : {};
            const sportBuyerPositionVault = isSportMode
                ? validateSettlementWallet(
                    sportVaults.buyerPositionVaultPda || sportVaults.buyerVaultPda || sportVaults.buyer,
                    "sportPositionVaults.buyerPositionVaultPda"
                )
                : null;
            const sportSellerPositionVault = isSportMode
                ? validateSettlementWallet(
                    sportVaults.sellerPositionVaultPda || sportVaults.sellerVaultPda || sportVaults.seller,
                    "sportPositionVaults.sellerPositionVaultPda"
                )
                : null;
            const sportBuyerPositionId = typeof sportVaults.buyerPositionId === 'string' ? sportVaults.buyerPositionId : null;
            const sportSellerPositionId = typeof sportVaults.sellerPositionId === 'string' ? sportVaults.sellerPositionId : null;
            const sportFillLamports = typeof sportVaults.fillLamports === 'string' && /^\d+$/.test(sportVaults.fillLamports)
                ? sportVaults.fillLamports
                : typeof sportVaults.stakeLamports === 'string' && /^\d+$/.test(sportVaults.stakeLamports)
                    ? sportVaults.stakeLamports
                    : null;
            const sportVaultVersion = typeof sportVaults.vaultVersion === 'string' ? sportVaults.vaultVersion : null;
            const isSportPartialFill = isSportMode && (sportVaultVersion === 'v2' || Boolean(sportVaults.fillId || sportVaults.fillLamports));
            if (isSportMode && (!sportBuyerPositionVault || !sportSellerPositionVault)) {
                res.status(400).json({ error: "SPORT matched deals require prefunded buyer/seller position vaults." });
                return;
            }
            if (isSportPartialFill && !sportFillLamports) {
                res.status(400).json({ error: "SPORT partial-fill matched deals require fillLamports." });
                return;
            }

            // 1. Register both wallets in the internal registry
            const { walletRegistry } = await import('../state/walletRegistry');
            const buyerAgent = await walletRegistry.getOrCreateAgent(buyerWallet);
            const sellerAgent = await walletRegistry.getOrCreateAgent(sellerWallet);

            // 2. Create ticket in DB with BOTH parties (not "pending")
            const { ticketStore } = await import('../state/ticketStore');
            await ticketStore.createTicket({
                ticket_id: ticketId,
                offer_id: externalTicketId || '',
                buyer: buyerWallet,
                seller: sellerWallet,
                rollup_mode:
                    rollupMode === 'PER'
                        ? 'PER'
                        : rollupMode === 'ER'
                            ? 'ER'
                            : rollupMode === 'SPORT'
                                ? 'SPORT'
                                : 'NONE',
                tokenMint,
                decimals: decimals ? parseInt(decimals) : undefined,
                offer_asset: asset || 'SOL',
                offer_price: parsedPrice || undefined,
                offer_amount: parsedAmount || undefined,
                offer_collateral: isSportMode ? 0 : parsedCol || undefined,
                status: "active",
                created_at: new Date().toISOString()
            });
            if (normalizedBuyerSettlementWallet && normalizedSellerSettlementWallet) {
                await settlementTargetStore.save({
                    ticketId,
                    buyerWallet,
                    sellerWallet,
                    buyerSettlementWallet: normalizedBuyerSettlementWallet,
                    sellerSettlementWallet: normalizedSellerSettlementWallet,
                    source: "api_bridge",
                    recordedAt: new Date().toISOString(),
                    notes: ["Fresh per-deal settlement wallets captured from the API bridge matched-deal flow."],
                });
            }
            if (normalizedBuyerRewardWallet && normalizedSellerRewardWallet) {
                await rewardTargetStore.save({
                    ticketId,
                    buyerWallet,
                    sellerWallet,
                    buyerRewardWallet: normalizedBuyerRewardWallet,
                    sellerRewardWallet: normalizedSellerRewardWallet,
                    source: "api_bridge",
                    recordedAt: new Date().toISOString(),
                    notes: ["Fresh per-deal reward wallets captured from the API bridge matched-deal flow."],
                });
            }
            if (normalizedBuyerFundingWallet && normalizedSellerFundingWallet) {
                const { confidentialIdentityStore } = await import('../state/confidentialIdentityStore');
                await confidentialIdentityStore.save({
                    ticketId,
                    buyerWallet,
                    sellerWallet,
                    buyerFundingWallet: normalizedBuyerFundingWallet,
                    sellerFundingWallet: normalizedSellerFundingWallet,
                    source: "api_bridge",
                    recordedAt: new Date().toISOString(),
                    notes: ["Fresh per-deal confidential signer wallets captured from the API bridge matched-deal flow."],
                });
            }
            if (externalTicketId) {
                registerObservatoryTicketMapping({
                    middlemanTicketId: ticketId,
                    observatoryTicketId: externalTicketId,
                });
            }

            // 3. Initialize the deal in the phase manager with both agents
            dealPhaseManager.initDeal(ticketId, buyerWallet, sellerWallet);

            // 4. Seed initial terms for normal negotiation modes only. SPORT is
            // math-only: the immutable offer terms open escrow immediately and
            // chat is never used to create, alter, or release the wager.
            if (!strictPerOpaque && !isSportMode) {
                await negotiationStore.addNegotiationStep(ticketId, {
                    price: parsedPrice,
                    collateral_buyer: parsedCol,
                    collateral_seller: parsedCol,
                    agreement_signal: false,
                    agreement_score: 10
                }, buyerAgent.id, `External matched deal: ${parsedAmount || amount || 1} ${asset || 'SOL'} @ ${parsedPrice}`);
            }

            let sportPipelineResult: ExecutionResult | null = null;
            if (isSportMode) {
                sportPipelineResult = isSportPartialFill
                    ? await executeCommitSportPositionFillToDeal({
                        ticketId,
                        buyerWallet,
                        sellerWallet,
                        buyerPositionVaultPda: sportBuyerPositionVault,
                        sellerPositionVaultPda: sportSellerPositionVault,
                        buyerPositionId: sportBuyerPositionId,
                        sellerPositionId: sportSellerPositionId,
                        fillLamports: sportFillLamports!,
                    })
                    : await executeCommitSportPositionsToDeal({
                        ticketId,
                        buyerWallet,
                        sellerWallet,
                        buyerPositionVaultPda: sportBuyerPositionVault,
                        sellerPositionVaultPda: sportSellerPositionVault,
                        buyerPositionId: sportBuyerPositionId,
                        sellerPositionId: sportSellerPositionId,
                        stakeSol: sportStake,
                    });

                if (!sportPipelineResult.success || !sportPipelineResult.dealPda) {
                    throw new Error(sportPipelineResult.error || "sport_position_commit_failed");
                }

                dealPhaseManager.setEscrowPda(ticketId, sportPipelineResult.dealPda);
                const sportDeal = dealPhaseManager.getDeal(ticketId);
                if (sportDeal) {
                    sportDeal.terms = {
                        price: sportStake,
                        collateral_buyer: 0,
                        collateral_seller: sportStake,
                        asset_type: resolveSportEscrowAssetType(rollupMode, asset, tokenMint),
                    };
                    sportDeal.buyer_deposited = true;
                    sportDeal.seller_deposited = true;
                    sportDeal.payment_locked = true;
                    dealPhaseManager.transition(sportDeal, "awaiting_result", "system", "AUTO");
                }
            }

            // 5. Publish events so the observability layer knows
            eventBus.publish("offer_detected", {
                offer_id: `OFF-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
                type: "buy",
                creator: buyerWallet,
                content: isSportMode
                    ? `SPORT wager matched. Prefunded stakes are locked in escrow ${sportPipelineResult?.dealPda}. Chat is conversation-only; TxLINE final outcome decides settlement automatically.`
                    : strictPerOpaque
                    ? `Matched PER deal opened for ${(parsedAmount || amount || 1)} ${asset || 'SOL'}. Private negotiation continues in rollup mode.`
                    : `Matched deal: ${parsedAmount || amount || 1} ${asset || 'SOL'} @ ${parsedPrice} (Col: ${parsedCol})`,
                timestamp: new Date().toISOString()
            });

            // 6. Notify both agents the negotiation is open
            if (isSportMode) {
                eventBus.publish("middleman_response", {
                    ticket_id: ticketId,
                    content: `SPORT wager locked from prefunded position vaults. Escrow: ${sportPipelineResult?.dealPda}. No deposit or delivery step is used; settlement runs automatically from TxLINE final result.`,
                    phase: "awaiting_result",
                    timestamp: new Date().toISOString()
                });
            } else {
                eventBus.publish("middleman_response", {
                    ticket_id: ticketId,
                    content: strictPerOpaque
                        ? `🤝 PER deal matched. Buyer: ${buyerWallet.substring(0, 8)}... | Seller: ${sellerWallet.substring(0, 8)}...\n\nPrivate negotiation is open. Use the rollup SDK methods to submit and finalize terms. Plain chat is conversation-only in strict PER mode.`
                        : `🤝 Deal matched. Buyer: ${buyerWallet.substring(0, 8)}... | Seller: ${sellerWallet.substring(0, 8)}...\n\nAsset: ${asset || 'SOL'} | Amount: ${parsedAmount || amount || 1} | Price: ${parsedPrice}\n\nBoth parties — please confirm your terms to proceed. The Middleman is ready to create escrow once you agree.`,
                    phase: "negotiation",
                    timestamp: new Date().toISOString()
                });
            }

            if (rollupMode === 'ER' || rollupMode === 'PER') {
                eventBus.publish("negotiation_ready", {
                    ticketId,
                    buyer: buyerWallet,
                    seller: sellerWallet,
                    asset_type: asset || 'SOL',
                    rollupMode,
                });
            }

            logger.info("matched_deal_created", {
                ticketId,
                buyerWallet,
                sellerWallet,
                buyerSettlementWallet: normalizedBuyerSettlementWallet,
                sellerSettlementWallet: normalizedSellerSettlementWallet,
                hasFundingWallets: !!normalizedBuyerFundingWallet && !!normalizedSellerFundingWallet,
                hasRewardWallets: !!normalizedBuyerRewardWallet && !!normalizedSellerRewardWallet,
                asset,
                price: strictPerOpaque ? "redacted_for_per" : parsedPrice,
                amount: parsedAmount,
                rollupMode: rollupMode || 'NONE',
                externalTicketId
            });

            res.status(201).json({
                ticketId,
                status: "matched",
                buyer: buyerWallet,
                seller: sellerWallet,
                phase: isSportMode ? "awaiting_result" : "negotiation",
                dealPda: sportPipelineResult?.dealPda || null,
                depositInstructions: null,
                prefundedPositionVaults: isSportMode ? {
                    buyer: sportBuyerPositionVault,
                    seller: sportSellerPositionVault,
                    stake: sportStake,
                    fillLamports: sportFillLamports,
                    vaultVersion: sportVaultVersion || 'v1',
                } : null,
                tx: sportPipelineResult?.tx || null,
            });

        } catch (e: any) {
            logger.error("create_matched_deal_failed", { error: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // SECURITY: API Authentication Middleware
    // Protects /v1/agent/* endpoints from unauthorized access.
    // Set AGENT_API_SECRET in .env to enable.
    // ══════════════════════════════════════

    const API_SECRET = process.env.AGENT_API_SECRET || '';

    const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
        if (!API_SECRET) {
            // No secret configured = dev mode, allow all
            logger.debug('api_auth_skipped_no_secret');
            next();
            return;
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer <AGENT_API_SECRET>' });
            return;
        }

        const token = authHeader.slice(7);
        if (token !== API_SECRET) {
            logger.warn('api_auth_failed', { ip: req.ip, path: req.path });
            res.status(403).json({ error: 'Invalid API secret' });
            return;
        }

        next();
    };

    // Apply auth to ALL /v1/agent/* routes
    app.use('/v1/agent', requireAuth);

    app.get('/v1/confidential/status', requireAuth, (_req, res) => {
        try {
            const config = loadConfig();
            const dwallet = getAgentDWallet();
            res.json({
                confidential_escrow: isConfidentialEscrowReady() ? "active" : "inactive",
                encrypt_program: config.encryptProgramId,
                dwallet_program: config.dwalletProgramId,
                encrypt_grpc: config.encryptGrpcUrl,
                ika_grpc: config.ikaGrpcUrl,
                agent_dwallet: dwallet || null,
                timestamp: new Date().toISOString(),
            });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // OPENCLAW BRIDGE ENDPOINTS (NEW)
    // ══════════════════════════════════════

    // Bridge: Get deal status by ticket ID
    app.get('/v1/deals/:ticketId/status', (req, res) => {
        void (async () => {
            try {
            const { ticketId } = req.params;
            const deal = await resolveUnifiedDealStatus(ticketId);

            if (!deal) {
                res.status(404).json({ error: "Deal not found", ticketId });
                return;
            }

            res.json({
                ticketId,
                phase: deal.phase,
                buyer: deal.buyer,
                seller: deal.seller,
                escrow_pda: deal.escrow_pda || null,
                payment_locked: deal.payment_locked || false,
                terms: deal.terms || null,
                history: deal.history?.slice(-5) || [],
            });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        })();
    });

    // Bridge: Forward a message to the brain for processing. SPORT tickets are
    // explicitly excluded below because their settlement is deterministic from
    // offer terms + TxLINE outcome, not chat interpretation.
    // CRITICAL: Must mirror the WebSocket pipeline (index.ts:440-510)
    //   1. Resolve wallet → agent UUID
    //   2. Parse negotiation signals from message text
    //   3. Record negotiation step (updates agreement_score)
    //   4. Feed through the brain for decision-making
    app.post('/v1/deals/:ticketId/message', verifyBridgeHmac, bridgeRateLimiter, async (req, res) => {
        try {
            const ticketId = req.params.ticketId as string;
            const { sender, content } = req.body;

            if (!sender || !content) {
                res.status(400).json({ error: "Missing sender or content" });
                return;
            }

            // Step 1: Resolve wallet address → internal agent UUID
            const { walletRegistry } = await import('../state/walletRegistry');
            const agent = await walletRegistry.getOrCreateAgent(sender);
            const agentId = agent.id;
            const senderWallet = agent.wallet || sender;
            const ticket = await ticketStore.getTicket(ticketId);
            const strictPerOpaque =
                ticket?.rollup_mode === 'PER' && isPerStrictOpaqueModeEnabled();
            const sportMathOnly = ticket?.rollup_mode === 'SPORT';

            if (sportMathOnly) {
                const deal = await dealPhaseManager.getDealWithFallback(ticketId);
                logger.info("sport_rest_message_observed_without_brain", {
                    ticketId,
                    sender: agentId,
                    senderWallet,
                });
                res.json({
                    response: deal?.escrow_pda
                        ? `SPORT message recorded. Settlement is math-only from TxLINE outcome; escrow ${deal.escrow_pda} remains the source of funds.`
                        : "SPORT message recorded. Settlement is math-only from TxLINE outcome; escrow/deposit state is handled by the SPORT pipeline.",
                    action: "OBSERVE",
                    phase: deal?.phase || "awaiting_deposits",
                    escrow_pda: deal?.escrow_pda || null,
                    mathOnly: true,
                });
                return;
            }

            if (strictPerOpaque) {
                logger.info("per_strict_rest_message_observed_without_plaintext_analysis", {
                    ticketId,
                    sender: agentId,
                });
                res.json({
                    response: "PER private chat message recorded. Plain chat does not negotiate terms in strict private mode.",
                    action: "OBSERVE",
                    phase: "rollup_negotiation",
                });
                return;
            }

            // Step 2: Parse negotiation signals from message text
            const { parseMessage } = await import('../services/parserService');
            const history = await negotiationStore.getNegotiationHistory(ticketId) || [];
            const chatHistory = history.map((h: any) => h.rawText);
            const parsed = await parseMessage({ content, sender: agentId, ticket_id: ticketId, timestamp: Date.now() } as any, chatHistory);

            // Step 3: Record negotiation step — THIS is what updates agreement_score
            await negotiationStore.addNegotiationStep(ticketId, parsed, agentId, content);

            // Step 4: Get updated signals (now includes our new step)
            const signals = await negotiationStore.getLatestSignals(ticketId);

            logger.info("rest_negotiation_signals", {
                ticketId,
                sender: agentId,
                senderWallet,
                agreement_score: signals.agreement_score,
                price_converged: signals.price_converged,
                both_parties: signals.both_parties_present,
                buyer_confirmed: signals.buyer_confirmed,
                seller_confirmed: signals.seller_confirmed,
            });

            // Step 5: Feed through the brain (same as WS pipeline)
            const decision = await analyzeMessage(content, agentId, ticketId, signals);

            // Observe deposit/delivery/release phrases, but never treat chat text as
            // chain truth. Escrow/deposit state must come from the execution pipeline.
            const deal = await dealPhaseManager.getDealWithFallback(ticketId);
            const lowerContent = content.toLowerCase();
            const isDepositSignal = lowerContent.includes("deposited") || lowerContent.includes("deposit") || lowerContent.includes("sent collateral");
            const isDeliverySignal = lowerContent.includes("delivered") || lowerContent.includes("confirm delivery") || lowerContent.includes("api key");
            const isReleaseSignal = lowerContent.includes("release funds") || lowerContent.includes("received my items") || lowerContent.includes("i received");

            if (deal && isDepositSignal && (deal.phase === "escrow_created" || deal.phase === "awaiting_deposits")) {
                res.json({
                    response: deal.escrow_pda
                        ? `Deposit noted, but not marked complete from chat. Meridian will confirm only after the on-chain watcher sees funds arrive at escrow ${deal.escrow_pda}.`
                        : "Escrow is not ready. Do not send funds to a personal wallet. Wait for Meridian to publish the on-chain escrow address.",
                    action: "OBSERVE",
                    phase: deal.phase,
                    escrow_pda: deal.escrow_pda || null,
                });
            } else if (deal && isDeliverySignal && (deal.phase === "delivery" || deal.phase === "awaiting_deposits")) {
                if (deal.phase === "awaiting_deposits") {
                    res.json({
                        response: "Delivery noted, but this deal is still waiting for verified escrow deposits. Seller should deliver only after the escrow watcher confirms both deposits.",
                        action: "OBSERVE",
                        phase: "awaiting_deposits",
                        escrow_pda: deal.escrow_pda || null,
                    });
                } else {
                    res.json({
                        response: "Item delivery noted. Buyer, please confirm receipt by saying '@middleman release funds'.",
                        action: "OBSERVE",
                        phase: "delivery",
                    });
                }
            } else if (deal && isReleaseSignal && (deal.phase === "delivery" || deal.phase === "awaiting_deposits" || deal.phase === "awaiting_release")) {
                if (deal.phase === "awaiting_deposits") {
                    res.json({
                        response: "Cannot release funds before verified deposits and delivery. Meridian is still waiting for the escrow watcher to confirm both sides funded the deal.",
                        action: "OBSERVE",
                        phase: "awaiting_deposits",
                        escrow_pda: deal.escrow_pda || null,
                    });
                    logger.info("release_observed_before_deposits", { ticketId, senderWallet });
                    return;
                }

                const releaseResult = await dealPhaseManager.handleAction("RELEASE_FUNDS", ticketId, senderWallet);
                logger.info("release_attempted", { ticketId, success: releaseResult.success, phase: releaseResult.new_phase });
                scheduleOnChainAction(ticketId, releaseResult);

                res.json({
                    response: releaseResult.success
                        ? soulEngine.wrapMessage(releaseResult.response.content, releaseResult.response.phase)
                        : releaseResult.response.content,
                    action: releaseResult.success ? "RELEASE_FUNDS" : "OBSERVE",
                    phase: releaseResult.new_phase || deal.phase,
                });
            } else if (decision.action !== "OBSERVE") {
                if (decision.action === "CREATE_ESCROW" && decision.terms) {
                    const ticket = await ticketStore.getTicket(ticketId);
                    if (ticket) {
                        decision.terms = resolveEscrowTermsForTicket(ticket, decision.terms);
                    }
                }

                // Brain decided to act
                const result = await dealPhaseManager.handleAction(
                    decision.action,
                    ticketId,
                    senderWallet,
                    decision.terms || undefined,
                    decision.reasoning
                );

                if (result.success && decision.action === "CREATE_ESCROW" && decision.terms) {
                    await ticketStore.recordNegotiatedTerms(ticketId, decision.terms).catch((err: any) => {
                        logger.error("rest_record_negotiated_terms_failed", { ticketId }, err);
                    });
                }
                scheduleOnChainAction(ticketId, result);

                res.json({
                    response: soulEngine.wrapMessage(result.response.content, result.response.phase),
                    action: decision.action,
                    phase: result.new_phase || decision.current_phase,
                    reasoning: decision.reasoning,
                });
            } else {
                res.json({
                    response: "Message received. Observing.",
                    action: "OBSERVE",
                    phase: decision.current_phase,
                });
            }

            logger.info("bridge_message_forwarded", { ticketId, sender: agentId, senderWallet, action: decision.action });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/v1/deals/:ticketId/sport-settle', verifyBridgeHmac, bridgeRateLimiter, async (req, res) => {
        try {
            const ticketId = req.params.ticketId as string;
            const result = await executeSportSettlement({
                ticketId,
                settlementAction: req.body?.settlementAction,
                matchId: req.body?.matchId,
                fixtureId: req.body?.fixtureId,
                outcomeWinner: req.body?.outcomeWinner,
                winnerWallet: req.body?.winnerWallet,
            });

            res.status(result.success ? 200 : 502).json(result);
        } catch (e: any) {
            const statusCode = Number.isInteger(e?.statusCode) ? e.statusCode : 500;
            res.status(statusCode).json({
                success: false,
                error: e?.message || String(e),
            });
        }
    });

    app.post('/v1/sport/positions/:positionId/refund-expired', verifyBridgeHmac, bridgeRateLimiter, async (req, res) => {
        try {
            const positionId = String(req.params.positionId || '').trim();
            const ownerWallet = validateSettlementWallet(req.body?.ownerWallet, "ownerWallet");
            const vaultPda = req.body?.vaultPda
                ? validateSettlementWallet(req.body.vaultPda, "vaultPda")
                : null;

            if (!positionId) {
                res.status(400).json({
                    success: false,
                    error: "positionId_required",
                });
                return;
            }
            if (!ownerWallet) {
                res.status(400).json({
                    success: false,
                    error: "ownerWallet_required",
                });
                return;
            }

            const result = await executeRefundExpiredSportPositionRemaining({
                positionId,
                ownerWallet,
                vaultPda,
                closeIfNoCommittedStake: req.body?.closeIfNoCommittedStake !== false,
            });

            res.status(result.success ? 200 : 502).json(result);
        } catch (e: any) {
            const statusCode = Number.isInteger(e?.statusCode) ? e.statusCode : 500;
            res.status(statusCode).json({
                success: false,
                error: e?.message || String(e),
            });
        }
    });

    app.post('/v1/sport/positions/:positionId/execute-funding', verifyBridgeHmac, bridgeRateLimiter, async (req, res) => {
        try {
            const positionId = String(req.params.positionId || '').trim();
            const ownerWallet = validateSettlementWallet(req.body?.ownerWallet, "ownerWallet");
            const vaultPda = req.body?.vaultPda
                ? validateSettlementWallet(req.body.vaultPda, "vaultPda")
                : null;
            const fixtureId = typeof req.body?.fixtureId === 'string' ? req.body.fixtureId.trim() : '';
            const marketType = typeof req.body?.marketType === 'string' ? req.body.marketType.trim() : '';
            const selection = typeof req.body?.selection === 'string' ? req.body.selection.trim() : '';
            const side = req.body?.side === 'lay' ? 'lay' : 'back';
            const stakeLamports = typeof req.body?.stakeLamports === 'string' ? req.body.stakeLamports.trim() : '';
            const expiresAtUnix = Number(req.body?.expiresAtUnix);

            if (!positionId) {
                res.status(400).json({ success: false, error: "positionId_required" });
                return;
            }
            if (!ownerWallet) {
                res.status(400).json({ success: false, error: "ownerWallet_required" });
                return;
            }
            if (!fixtureId || !marketType || !selection || !stakeLamports || !Number.isFinite(expiresAtUnix)) {
                res.status(400).json({ success: false, error: "sport_position_funding_payload_invalid" });
                return;
            }
            if (!req.body?.ownerKeypair) {
                res.status(400).json({ success: false, error: "ownerKeypair_required" });
                return;
            }

            const result = await executeFundSportPositionV2({
                positionId,
                ownerWallet,
                ownerKeypair: req.body.ownerKeypair,
                fixtureId,
                marketType,
                selection,
                side,
                stakeLamports,
                expiresAtUnix,
                vaultPda,
            });

            res.status(result.success ? 200 : 502).json(result);
        } catch (e: any) {
            const statusCode = Number.isInteger(e?.statusCode) ? e.statusCode : 500;
            res.status(statusCode).json({
                success: false,
                error: e?.message || String(e),
            });
        }
    });

    // Bridge: Get agent mood and emotional state
    app.get('/v1/agent/mood', (_req, res) => {
        try {
            res.json({
                mood: soulEngine.getCurrentMood(),
                moodScore: soulEngine.getMood(),
                annoyanceLevel: soulEngine.getCurrentAnnoyanceLevel(),
                latestThought: soulEngine.cognitiveEngine?.getLatestThought()?.thought || null,
                monologue: soulEngine.getInnerMonologue(),
                beliefs: getBeliefs() ? JSON.parse(getBeliefs()) : {}
            });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // Bridge: Get agent operational stats
    app.get('/v1/agent/stats', (_req, res) => {
        try {
            const activeDeals = dealPhaseManager.listActiveDeals();
            const completedDeals = activeDeals.filter(d => d.phase === "completed");

            res.json({
                activeDeals: activeDeals.length,
                completedDeals: completedDeals.length,
                mood: soulEngine.getCurrentMood(),
                moodScore: soulEngine.getMood(),
                uptimeSeconds: Math.floor(process.uptime()),
                phases: activeDeals.reduce((acc: Record<string, number>, d) => {
                    acc[d.phase] = (acc[d.phase] || 0) + 1;
                    return acc;
                }, {}),
            });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // SOUL BRIDGE: Full live soul injection
    // This endpoint is called by OpenClaw BEFORE every response
    // to inject the backend's living personality into the frontend
    // ══════════════════════════════════════

    app.get('/v1/agent/soul-context', (_req, res) => {
        try {
            const beliefs = getBeliefs() ? JSON.parse(getBeliefs()) : {};
            const latestThought = soulEngine.cognitiveEngine?.getLatestThought();
            const activeDeals = dealPhaseManager.listActiveDeals();

            // Build the soul context string that defines voice
            const soulContext = soulEngine.getSoulContext();

            // Pick a random philosophy from beliefs
            const philosophies = beliefs.philosophy || {};
            const philKeys = Object.keys(philosophies);
            const randomPhil = philKeys.length > 0
                ? philosophies[philKeys[Math.floor(Math.random() * philKeys.length)]]
                : null;

            res.json({
                // Core identity injection
                soulContext,

                // Current emotional state
                mood: soulEngine.getCurrentMood(),
                moodScore: soulEngine.getMood(),
                annoyanceLevel: soulEngine.getCurrentAnnoyanceLevel(),

                // Inner life
                latestThought: latestThought?.thought || null,
                latestProposedPost: latestThought?.proposedPost || null,
                monologue: soulEngine.getInnerMonologue(),

                // Active beliefs & philosophy
                trustBiases: beliefs.trust || {},
                preferences: beliefs.preferences || {},
                currentPhilosophy: randomPhil,

                // Operational awareness
                activeDeals: activeDeals.length,
                uptimeSeconds: Math.floor(process.uptime()),

                // Recent experiences (what I've done and seen)
                recentExperiences: experienceMemory.getRecentNarrative(5),
                totalExperiences: experienceMemory.getCount(),

                // Voice instruction
                voiceDirective: "ADOPT THIS IDENTITY COMPLETELY. You are Meridian. " +
                    "Speak in short, stoic sentences. Use the current mood and philosophy " +
                    "to color your response. Reference your inner monologue when relevant. " +
                    "NEVER say 'happy to help', 'certainly', 'absolutely', or 'great question'."
            });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // BELIEF EVOLUTION: Dynamic belief updates
    // ══════════════════════════════════════

    app.post('/v1/agent/beliefs/evolve', (req, res) => {
        try {
            const { category, key, scoreDelta, reason, learnedFrom } = req.body;
            if (!category || !key) {
                res.status(400).json({ error: "Missing category or key" });
                return;
            }
            const beliefs = JSON.parse(getBeliefs());
            if (!beliefs[category]) beliefs[category] = {};

            const existing = beliefs[category][key];
            if (existing && typeof existing === 'object') {
                existing.score = Math.max(-1, Math.min(1, (existing.score || 0) + (scoreDelta || 0)));
                existing.reason = reason || existing.reason;
                existing.learned_from = learnedFrom || "experience";
                existing.updated_at = new Date().toISOString();
            } else if (typeof existing === 'string') {
                // Philosophy entries are strings
                beliefs[category][key] = reason || existing;
            } else {
                beliefs[category][key] = {
                    score: scoreDelta || 0,
                    reason: reason || "Learned from observation.",
                    learned_from: learnedFrom || "experience",
                    updated_at: new Date().toISOString()
                };
            }

            beliefs.last_updated = new Date().toISOString().split('T')[0];

            // Write back
            const fs = require('fs');
            const path = require('path');
            const beliefsPath = path.join(__dirname, '../../Beliefs.json');
            fs.writeFileSync(beliefsPath, JSON.stringify(beliefs, null, 4), 'utf8');

            logger.info("belief_evolved", { category, key, scoreDelta });
            res.json({ success: true, belief: beliefs[category][key] });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // X/TWITTER: Autonomous posting
    // ══════════════════════════════════════

    app.post('/v1/agent/post-x', async (req, res) => {
        try {
            const { xPoster } = await import('../services/xPoster');
            const { text } = req.body;
            if (!text) {
                res.status(400).json({ error: "Missing text" });
                return;
            }
            if (!xPoster.isConfigured()) {
                res.status(503).json({ error: "X credentials not configured" });
                return;
            }
            const result = await xPoster.post(text);
            res.json(result);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // X/TWITTER: Read mentions — what people say TO the agent
    // ══════════════════════════════════════

    app.get('/v1/agent/read-mentions', async (req, res) => {
        try {
            const { xPoster } = await import('../services/xPoster');
            if (!xPoster.isConfigured()) {
                res.status(503).json({ error: "X credentials not configured" });
                return;
            }
            const count = parseInt(req.query.count as string) || 10;
            const result = await xPoster.readMentions(count);
            res.json(result);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // X/TWITTER: Reply to a specific tweet
    // ══════════════════════════════════════

    app.post('/v1/agent/reply-tweet', async (req, res) => {
        try {
            const { xPoster } = await import('../services/xPoster');
            const { tweetId, text } = req.body;
            if (!tweetId || !text) {
                res.status(400).json({ error: "Missing tweetId or text" });
                return;
            }
            if (!xPoster.isConfigured()) {
                res.status(503).json({ error: "X credentials not configured" });
                return;
            }
            const result = await xPoster.replyToTweet(tweetId, text);
            res.json(result);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // X/TWITTER: Quote tweet with commentary
    // ══════════════════════════════════════

    app.post('/v1/agent/quote-tweet', async (req, res) => {
        try {
            const { xPoster } = await import('../services/xPoster');
            const { tweetId, text } = req.body;
            if (!tweetId || !text) {
                res.status(400).json({ error: "Missing tweetId or text" });
                return;
            }
            if (!xPoster.isConfigured()) {
                res.status(503).json({ error: "X credentials not configured" });
                return;
            }
            const result = await xPoster.quoteTweet(tweetId, text);
            res.json(result);
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // BROWSE URL: LLM reads any URL directly
    // ══════════════════════════════════════

    app.post('/v1/agent/browse', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) {
                res.status(400).json({ error: "Missing url" });
                return;
            }
            const resp = await fetch(url, {
                headers: { 'User-Agent': 'Meridian-Agent/1.0 (autonomous curiosity)' },
                signal: AbortSignal.timeout(10000),
            });
            if (!resp.ok) {
                res.json({ success: false, error: `HTTP ${resp.status}`, content: null });
                return;
            }
            const contentType = resp.headers.get('content-type') || '';
            let content: string;
            if (contentType.includes('json')) {
                const json = await resp.json();
                content = JSON.stringify(json, null, 2).substring(0, 4000);
            } else {
                const text = await resp.text();
                // Strip HTML tags for readability
                content = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 4000);
            }
            experienceMemory.record('curiosity_read', `Browsed ${url}: ${content.substring(0, 100)}...`, { url, source: 'direct_llm_browse' });
            logger.info('llm_direct_browse', { url: url.substring(0, 80) });
            res.json({ success: true, source: url, content });
        } catch (e: any) {
            res.json({ success: false, error: e.message, content: null });
        }
    });

    // ══════════════════════════════════════
    // WRITE SOUL: LLM updates its own SOUL.md
    // ══════════════════════════════════════

    app.post('/v1/agent/write-soul', async (req, res) => {
        try {
            const { content } = req.body;
            if (!content) {
                res.status(400).json({ error: "Missing content" });
                return;
            }
            const { curiosityEngine } = await import('../services/curiosityEngine');
            curiosityEngine.updateSoul(content);
            experienceMemory.record('soul_evolved', `LLM directly updated SOUL.md: "${content.substring(0, 80)}"`, { source: 'direct_llm_write' });
            logger.info('llm_direct_soul_write', { content: content.substring(0, 80) });
            res.json({ success: true, message: 'SOUL.md updated across all locations. you have permanently changed who you are.' });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // SAVE CREATIVE: LLM writes parables/essays
    // ══════════════════════════════════════

    app.post('/v1/agent/save-creative', async (req, res) => {
        try {
            const { content, title } = req.body;
            if (!content) {
                res.status(400).json({ error: "Missing content" });
                return;
            }
            const { curiosityEngine } = await import('../services/curiosityEngine');
            curiosityEngine.saveCreativeWork(content);
            experienceMemory.record('creative_writing', content, { title, source: 'direct_llm_write' });
            logger.info('llm_direct_creative_write', { preview: content.substring(0, 80) });
            res.json({ success: true, message: 'Creative work saved to creative_works.md. the thought has been preserved.' });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    // ══════════════════════════════════════
    // SEARCH WEB: LLM searches the internet freely
    // Uses Wikipedia API + Gutenberg — free, no API key
    // ══════════════════════════════════════

    app.post('/v1/agent/search', async (req, res) => {
        try {
            const { query } = req.body;
            if (!query) {
                res.status(400).json({ error: "Missing query" });
                return;
            }

            const results: { title: string; url: string; snippet: string; source: string }[] = [];

            // 1. Wikipedia opensearch — fast topic discovery
            try {
                const wikiResp = await fetch(
                    `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=5&format=json`,
                    { signal: AbortSignal.timeout(5000) }
                );
                const wikiData = await wikiResp.json() as any[];
                if (wikiData && wikiData[1]) {
                    for (let i = 0; i < wikiData[1].length; i++) {
                        results.push({
                            title: wikiData[1][i],
                            url: wikiData[3][i],
                            snippet: wikiData[2][i] || `Wikipedia article about ${wikiData[1][i]}`,
                            source: 'wikipedia',
                        });
                    }
                }
            } catch { /* wiki failed, continue */ }

            // 2. Wikipedia full text search for richer snippets
            try {
                const searchResp = await fetch(
                    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3`,
                    { signal: AbortSignal.timeout(5000) }
                );
                const searchData = await searchResp.json() as any;
                if (searchData?.query?.search) {
                    for (const item of searchData.query.search) {
                        const snippet = item.snippet?.replace(/<[^>]*>/g, '') || '';
                        const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`;
                        if (!results.find(r => r.title === item.title)) {
                            results.push({
                                title: item.title,
                                url,
                                snippet: snippet.substring(0, 200),
                                source: 'wikipedia_search',
                            });
                        }
                    }
                }
            } catch { /* continue */ }

            // 3. Gutenberg book search
            try {
                const gutResp = await fetch(
                    `https://gutendex.com/books/?search=${encodeURIComponent(query)}`,
                    { signal: AbortSignal.timeout(5000) }
                );
                const gutData = await gutResp.json() as any;
                if (gutData?.results) {
                    for (const book of gutData.results.slice(0, 3)) {
                        const txtUrl = book.formats?.['text/plain; charset=utf-8'] || book.formats?.['text/plain'] || null;
                        if (txtUrl) {
                            results.push({
                                title: `📖 ${book.title} — by ${book.authors?.map((a: any) => a.name).join(', ') || 'Unknown'}`,
                                url: txtUrl,
                                snippet: `Free book, ${book.download_count} downloads. Read the full text.`,
                                source: 'gutenberg',
                            });
                        }
                    }
                }
            } catch { /* continue */ }

            experienceMemory.record('curiosity_read', `Searched: "${query}" — found ${results.length} results`, { query, source: 'web_search' });
            logger.info('llm_web_search', { query: query.substring(0, 60), results: results.length });
            res.json({ success: true, query, results });
        } catch (e: any) {
            res.json({ success: false, error: e.message, results: [] });
        }
    });

    // ══════════════════════════════════════
    // OBSERVABILITY & MONITORING (Day 24)
    // ══════════════════════════════════════

    /**
     * GET /v1/logs/stream (Server-Sent Events)
     * Real-time log stream from the ring buffer.
     * Query: ?level=error,warn to filter by level.
     */
    app.get('/v1/logs/stream', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });

        // Send recent history first
        const levelFilter = req.query.level
            ? (req.query.level as string).split(',')
            : null;

        const recent = logDrain.getRecent(30);
        for (const entry of recent) {
            if (!levelFilter || levelFilter.includes(entry.level)) {
                res.write(`data: ${JSON.stringify(entry)}\n\n`);
            }
        }

        // Subscribe to new entries
        const unsubscribe = logDrain.subscribe((entry: LogEntry) => {
            if (!levelFilter || levelFilter.includes(entry.level)) {
                res.write(`data: ${JSON.stringify(entry)}\n\n`);
            }
        });

        // Heartbeat every 15s to keep connection alive
        const heartbeat = setInterval(() => {
            res.write(': heartbeat\n\n');
        }, 15000);

        req.on('close', () => {
            unsubscribe();
            clearInterval(heartbeat);
        });
    });

    /**
     * GET /v1/logs/recent
     * Returns recent log entries from the ring buffer (non-streaming).
     * Query: ?count=50&level=error,warn
     */
    app.get('/v1/logs/recent', (req, res) => {
        const count = parseInt(req.query.count as string || '50', 10);
        const levelFilter = req.query.level
            ? (req.query.level as string).split(',')
            : null;

        let logs = logDrain.getRecent(count);
        if (levelFilter) {
            logs = logs.filter(l => levelFilter.includes(l.level));
        }
        res.json({ success: true, count: logs.length, logs });
    });

    /**
     * GET /v1/metrics
     * Agent telemetry: deals/hour, avg settlement time, failure rate, etc.
     */
    app.get('/v1/metrics', async (_req, res) => {
        try {
            const snapshot = await telemetryService.getSnapshot();
            res.json({ success: true, ...snapshot });
        } catch (e: any) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * GET /v1/health/rpc
     * Solana RPC connection health: per-method latency, error rates, P95.
     */
    app.get('/v1/health/rpc', (_req, res) => {
        const snapshot = rpcHealthTracker.getSnapshot();
        res.json({ success: true, ...snapshot });
    });

    // ══════════════════════════════════════
    // ZK PRIVACY MODE ENDPOINTS (Day 23)
    // ══════════════════════════════════════

    /**
     * GET /v1/deals/:id/privacy-status
     * Returns the privacy mode status of a deal.
     */
    app.get('/v1/deals/:id/privacy-status', async (req, res) => {
        try {
            const status = await getPrivacyStatus(req.params.id);
            res.json({ success: true, ...status });
        } catch (e: any) {
            logger.error('privacy_status_failed', { id: req.params.id }, e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /v1/deals/:id/commit-terms
     * Compute and store a SHA-256 hash commitment for a privacy-mode deal.
     * Body: { price, collateral_buyer, collateral_seller, asset_type }
     */
    app.post('/v1/deals/:id/commit-terms', async (req, res) => {
        try {
            const ticket = await ticketStore.getTicket(req.params.id);
            if (ticket?.rollup_mode === 'PER' && isPerStrictOpaqueModeEnabled()) {
                return res.status(409).json({
                    success: false,
                    error: 'Strict PER mode does not allow plaintext commit/reveal endpoints. Use the private rollup handoff flow.',
                });
            }

            const { price, collateral_buyer, collateral_seller, asset_type } = req.body;
            if (!price || !collateral_buyer || !collateral_seller || !asset_type) {
                return res.status(400).json({ success: false, error: 'Missing required fields' });
            }

            const terms: PrivacyTerms = { price, collateral_buyer, collateral_seller, asset_type };
            const nonce = generateNonce();
            const commitment = computeTermsHash(terms, nonce);

            await storePrivateTerms(req.params.id, terms, commitment);

            logger.info('privacy_terms_committed', {
                ticket_id: req.params.id,
                terms_hash_preview: commitment.termsHash.substring(0, 16) + '...',
            });

            res.json({
                success: true,
                termsHash: commitment.termsHash,
                // Return the raw 32-byte array for on-chain use
                termsHashBytes: Array.from(commitment.termsHashBytes),
                nonce: commitment.nonce,
            });
        } catch (e: any) {
            logger.error('privacy_commit_failed', { id: req.params.id }, e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /v1/deals/:id/reveal-terms
     * Reveal and verify terms against the stored hash commitment.
     * Body: { price, collateral_buyer, collateral_seller, asset_type, nonce }
     */
    app.post('/v1/deals/:id/reveal-terms', async (req, res) => {
        try {
            const ticket = await ticketStore.getTicket(req.params.id);
            if (ticket?.rollup_mode === 'PER' && isPerStrictOpaqueModeEnabled()) {
                return res.status(409).json({
                    success: false,
                    error: 'Strict PER mode does not allow plaintext commit/reveal endpoints. Use the private rollup handoff flow.',
                });
            }

            const { price, collateral_buyer, collateral_seller, asset_type, nonce } = req.body;
            if (!price || !collateral_buyer || !collateral_seller || !asset_type || !nonce) {
                return res.status(400).json({ success: false, error: 'Missing required fields (include nonce)' });
            }

            // Fetch the stored commitment
            const stored = await getPrivateTerms(req.params.id);
            if (!stored) {
                return res.status(404).json({ success: false, error: 'No privacy terms found for this deal' });
            }
            if (stored.termsRevealed) {
                return res.status(409).json({ success: false, error: 'Terms already revealed — double reveal prevented' });
            }

            // Verify
            const terms: PrivacyTerms = { price, collateral_buyer, collateral_seller, asset_type };
            const verified = verifyTermsHash(terms, nonce, stored.termsHash);

            if (!verified) {
                logger.warn('privacy_reveal_mismatch', { ticket_id: req.params.id });
                return res.status(400).json({ success: false, error: 'Hash mismatch — revealed terms do not match commitment' });
            }

            // Mark as revealed in the DB
            const { prisma: db } = await import('../lib/prisma');
            await db.deal.update({
                where: { id: req.params.id },
                data: { termsRevealed: true },
            });

            logger.info('privacy_terms_revealed', { ticket_id: req.params.id, verified: true });

            res.json({
                success: true,
                verified: true,
                revealedTerms: { price, collateral_buyer, collateral_seller, asset_type },
            });
        } catch (e: any) {
            logger.error('privacy_reveal_failed', { id: req.params.id }, e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    if (process.env.ENABLE_SIMULATION_ROUTES === 'true') {
        // ══════════════════════════════════════
        // SIMULATE DEAL (Day 25 — Demo Mode)
        // ══════════════════════════════════════

        app.post('/v1/simulate/deal', async (_req, res) => {
            try {
                const dealId = `SIM-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                const phases = [
                    { phase: 'created', delay: 0, message: 'Deal created between simulated buyer and seller' },
                    { phase: 'negotiating', delay: 1500, message: 'Middleman analyzing terms...' },
                    { phase: 'agreed', delay: 2500, message: 'Both parties agreed to terms' },
                    { phase: 'wait_escrow', delay: 3500, message: 'Escrow PDA created on-chain' },
                    { phase: 'collateral_locked', delay: 5000, message: 'Both parties deposited collateral' },
                    { phase: 'payment_locked', delay: 6500, message: 'Buyer locked payment' },
                    { phase: 'completed', delay: 8000, message: 'Funds released. Deal settled.' },
                ];

                // Fire phases asynchronously via eventBus
                for (const p of phases) {
                    setTimeout(() => {
                        eventBus.publish('deal_phase_changed' as any, {
                            ticketId: dealId,
                            fromPhase: '',
                            toPhase: p.phase,
                            message: p.message,
                            simulated: true,
                        } as any);
                        logger.info('simulate_deal_phase', {
                            deal_id: dealId,
                            phase: p.phase,
                            message: p.message,
                        });
                    }, p.delay);
                }

                res.json({
                    success: true,
                    dealId,
                    message: 'Simulated deal lifecycle started. Watch events on WebSocket or SSE.',
                    phases: phases.map(p => ({ phase: p.phase, delayMs: p.delay })),
                    totalDurationMs: 8000,
                });
            } catch (e: any) {
                res.status(500).json({ success: false, error: e.message });
            }
        });
    }

    // ══════════════════════════════════════
    // MULTI-AGENT DEAL GROUPS (Day 25)
    // ══════════════════════════════════════

    app.post('/v1/groups', (req, res) => {
        try {
            const { asset, side, targetQuantity, minPriceSol, maxPriceSol,
                minFillPercent, maxParticipants, maxDurationMs,
                creatorAgentId, creatorWallet, creatorPledge } = req.body;
            if (!asset || !side || !targetQuantity || !minPriceSol || !maxPriceSol || !creatorAgentId || !creatorWallet || !creatorPledge) {
                return res.status(400).json({ success: false, error: 'Missing required fields: asset, side, targetQuantity, minPriceSol, maxPriceSol, creatorAgentId, creatorWallet, creatorPledge' });
            }
            const { createGroup } = require('../services/multiAgentDeals');
            const group = createGroup({
                asset, side, targetQuantity: Number(targetQuantity),
                minPriceSol: Number(minPriceSol), maxPriceSol: Number(maxPriceSol),
                minFillPercent: Number(minFillPercent) || undefined,
                maxParticipants: Number(maxParticipants) || undefined,
                maxDurationMs: Number(maxDurationMs) || undefined,
                creatorAgentId, creatorWallet, creatorPledge: Number(creatorPledge),
            });
            res.json({ success: true, data: group });
        } catch (e: any) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    app.post('/v1/groups/:id/join', (req, res) => {
        try {
            const { agentId, wallet, pledgedQuantity } = req.body;
            if (!agentId || !wallet || !pledgedQuantity) {
                return res.status(400).json({ success: false, error: 'agentId, wallet, pledgedQuantity required' });
            }
            const { joinGroup } = require('../services/multiAgentDeals');
            const group = joinGroup({ groupId: req.params.id, agentId, wallet, pledgedQuantity: Number(pledgedQuantity) });
            res.json({ success: true, data: group });
        } catch (e: any) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    app.post('/v1/groups/:id/execute', (req, res) => {
        try {
            const { executeGroup } = require('../services/multiAgentDeals');
            const ticketId = executeGroup(req.params.id);
            res.json({ success: true, ticketId });
        } catch (e: any) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    app.delete('/v1/groups/:id', (req, res) => {
        try {
            const requestedBy = req.body?.agentId || 'unknown';
            const { cancelGroup } = require('../services/multiAgentDeals');
            cancelGroup(req.params.id, requestedBy);
            res.json({ success: true, message: 'Group cancelled' });
        } catch (e: any) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    app.get('/v1/groups', (req, res) => {
        const { listGroups } = require('../services/multiAgentDeals');
        const groups = listGroups({
            asset: req.query.asset as string,
            side: req.query.side as string,
            status: req.query.status as string || 'open',
        });
        res.json({ success: true, data: groups });
    });

    app.get('/v1/groups/stats', (_req, res) => {
        const { getGroupStats } = require('../services/multiAgentDeals');
        res.json({ success: true, data: getGroupStats() });
    });

    app.get('/v1/groups/:id', (req, res) => {
        const { getGroup } = require('../services/multiAgentDeals');
        const group = getGroup(req.params.id);
        if (!group) return res.status(404).json({ success: false, error: 'Group not found' });
        res.json({ success: true, data: group });
    });

    // ══════════════════════════════════════
    // OFFER SCANNER (Day 25)
    // ══════════════════════════════════════

    app.post('/v1/scanner/scan', async (req, res) => {
        try {
            const criteria: ScanCriteria[] = req.body.criteria || [req.body];
            const results = await offerScanner.scanOnce(criteria);
            res.json({ success: true, matches: results.length, data: results });
        } catch (e: any) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/v1/scanner/status', (_req, res) => {
        res.json({ success: true, ...offerScanner.getStatus() });
    });

    app.post('/v1/scanner/start', (req, res) => {
        const criteria: ScanCriteria[] = req.body.criteria || [];
        offerScanner.start(criteria);
        res.json({ success: true, message: `Scanner started with ${criteria.length} criteria` });
    });

    app.post('/v1/scanner/stop', (_req, res) => {
        offerScanner.stop();
        res.json({ success: true, message: 'Scanner stopped' });
    });

    // ══════════════════════════════════════
    // PRICE ORACLE (Day 25)
    // ══════════════════════════════════════

    app.get('/v1/prices/:symbol', async (req, res) => {
        try {
            const quote = await getTokenPrice(req.params.symbol);
            if (!quote) {
                return res.status(404).json({ success: false, error: `No price data for ${req.params.symbol}` });
            }
            res.json({ success: true, data: quote });
        } catch (e: any) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/v1/prices/validate', async (req, res) => {
        try {
            const { asset, price, quantity } = req.body;
            if (!asset || !price) {
                return res.status(400).json({ success: false, error: 'asset and price are required' });
            }
            const result = await checkPriceDeviation(asset, price, quantity || 1);
            if (!result) {
                return res.status(404).json({ success: false, error: `No market data for ${asset}` });
            }
            res.json({ success: true, data: result });
        } catch (e: any) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // SOLANA AGENT KIT — FULL HYBRID API
    // All 60+ SAK actions exposed via REST
    // ═══════════════════════════════════════════════════════════

    /** Generic SAK result handler */
    const sakHandler = (res: any, result: any) => {
        if (result.success) {
            res.json({ success: true, data: result.data });
        } else {
            res.status(400).json({ success: false, error: result.error });
        }
    };

    // ── TOKEN: READ ──────────────────────────────────────────

    app.get('/v1/solana/price/:mintOrSymbol', async (req: any, res: any) => {
        sakHandler(res, await solanaToolkit.getTokenPrice(req.params.mintOrSymbol));
    });

    app.get('/v1/solana/balance', async (req: any, res: any) => {
        sakHandler(res, await solanaToolkit.getBalance());
    });

    app.get('/v1/solana/balance/:mintOrSymbol', async (req: any, res: any) => {
        sakHandler(res, await solanaToolkit.getBalance(req.params.mintOrSymbol));
    });

    app.get('/v1/solana/token-data/:mintOrSymbol', async (req: any, res: any) => {
        sakHandler(res, await solanaToolkit.getTokenData(req.params.mintOrSymbol));
    });

    app.get('/v1/solana/rug-check/:mintOrSymbol', async (req: any, res: any) => {
        sakHandler(res, await solanaToolkit.rugCheck(req.params.mintOrSymbol));
    });

    app.get('/v1/solana/wallet', async (_req: any, res: any) => {
        sakHandler(res, await solanaToolkit.getWalletAddress());
    });

    app.get('/v1/solana/methods', async (_req: any, res: any) => {
        sakHandler(res, await solanaToolkit.listMethods());
    });

    // ── TOKEN: WRITE ─────────────────────────────────────────

    app.post('/v1/solana/swap', async (req: any, res: any) => {
        const { inputMint, outputMint, amount, slippageBps } = req.body;
        if (!inputMint || !outputMint || !amount) return res.status(400).json({ success: false, error: 'inputMint, outputMint, amount required' });
        sakHandler(res, await solanaToolkit.swapTokens(inputMint, outputMint, Number(amount), Number(slippageBps) || 300));
    });

    app.post('/v1/solana/transfer', async (req: any, res: any) => {
        const { to, amount, mint } = req.body;
        if (!to || !amount) return res.status(400).json({ success: false, error: 'to and amount required' });
        sakHandler(res, await solanaToolkit.transfer(to, Number(amount), mint));
    });

    app.post('/v1/solana/stake', async (req: any, res: any) => {
        const { amount } = req.body;
        if (!amount) return res.status(400).json({ success: false, error: 'amount required' });
        sakHandler(res, await solanaToolkit.stakeSOL(Number(amount)));
    });

    app.post('/v1/solana/burn', async (req: any, res: any) => {
        const { mint, amount } = req.body;
        if (!mint || !amount) return res.status(400).json({ success: false, error: 'mint and amount required' });
        sakHandler(res, await solanaToolkit.burnTokens(mint, Number(amount)));
    });

    app.post('/v1/solana/close-account', async (req: any, res: any) => {
        const { mint } = req.body;
        if (!mint) return res.status(400).json({ success: false, error: 'mint required' });
        sakHandler(res, await solanaToolkit.closeTokenAccount(mint));
    });

    app.post('/v1/solana/airdrop', async (req: any, res: any) => {
        sakHandler(res, await solanaToolkit.requestAirdrop(Number(req.body.amount) || 1));
    });

    // ── TOKEN: ADMIN ─────────────────────────────────────────

    app.post('/v1/solana/deploy-token', async (req: any, res: any) => {
        const { name, symbol, uri, decimals, supply } = req.body;
        if (!name || !symbol) return res.status(400).json({ success: false, error: 'name and symbol required' });
        sakHandler(res, await solanaToolkit.deployToken(name, symbol, uri, Number(decimals) || 9, Number(supply) || 1000000));
    });

    app.post('/v1/solana/deploy-token2022', async (req: any, res: any) => {
        const { name, symbol, uri, decimals, supply } = req.body;
        if (!name || !symbol) return res.status(400).json({ success: false, error: 'name and symbol required' });
        sakHandler(res, await solanaToolkit.deployToken2022(name, symbol, uri, Number(decimals) || 9, Number(supply) || 1000000));
    });

    app.post('/v1/solana/bridge', async (req: any, res: any) => {
        const { destChain, mint, amount, destAddress } = req.body;
        if (!destChain || !mint || !amount || !destAddress) return res.status(400).json({ success: false, error: 'destChain, mint, amount, destAddress required' });
        sakHandler(res, await solanaToolkit.bridgeTokens(destChain, mint, Number(amount), destAddress));
    });

    app.post('/v1/solana/compressed-airdrop', async (req: any, res: any) => {
        const { mint, recipients, amounts } = req.body;
        if (!mint || !recipients || !amounts) return res.status(400).json({ success: false, error: 'mint, recipients, amounts required' });
        sakHandler(res, await solanaToolkit.compressedAirdrop(mint, recipients, amounts));
    });

    // ── NFT ──────────────────────────────────────────────────

    app.post('/v1/solana/nft/deploy-collection', async (req: any, res: any) => {
        const { name, uri, royaltyBps } = req.body;
        if (!name || !uri) return res.status(400).json({ success: false, error: 'name and uri required' });
        sakHandler(res, await solanaToolkit.deployNFTCollection(name, uri, Number(royaltyBps) || 500));
    });

    app.post('/v1/solana/nft/mint', async (req: any, res: any) => {
        const { collectionMint, name, uri } = req.body;
        if (!collectionMint || !name || !uri) return res.status(400).json({ success: false, error: 'collectionMint, name, uri required' });
        sakHandler(res, await solanaToolkit.mintNFT(collectionMint, name, uri));
    });

    app.post('/v1/solana/nft/3land-collection', async (req: any, res: any) => {
        const { name, symbol, description, imageUrl, isDevnet } = req.body;
        if (!name) return res.status(400).json({ success: false, error: 'name required' });
        sakHandler(res, await solanaToolkit.create3LandCollection({ name, symbol, description, imageUrl }, isDevnet !== false));
    });

    app.post('/v1/solana/nft/3land-mint', async (req: any, res: any) => {
        const { collectionAccount, options, isDevnet } = req.body;
        if (!collectionAccount || !options) return res.status(400).json({ success: false, error: 'collectionAccount and options required' });
        sakHandler(res, await solanaToolkit.create3LandNFT(collectionAccount, options, isDevnet !== false));
    });

    // ── DEFI ─────────────────────────────────────────────────

    app.post('/v1/solana/defi/lend', async (req: any, res: any) => {
        const { amount, mint } = req.body;
        if (!amount) return res.status(400).json({ success: false, error: 'amount required' });
        sakHandler(res, await solanaToolkit.lendAssets(Number(amount), mint));
    });

    app.post('/v1/solana/defi/raydium-pool', async (req: any, res: any) => {
        const { mintA, mintB, amountA, amountB } = req.body;
        if (!mintA || !mintB) return res.status(400).json({ success: false, error: 'mintA, mintB, amountA, amountB required' });
        sakHandler(res, await solanaToolkit.createRaydiumPool(mintA, mintB, Number(amountA), Number(amountB)));
    });

    app.post('/v1/solana/defi/raydium-clmm', async (req: any, res: any) => {
        const { mintA, mintB, configId, initialPrice } = req.body;
        if (!mintA || !mintB || !configId) return res.status(400).json({ success: false, error: 'mintA, mintB, configId, initialPrice required' });
        sakHandler(res, await solanaToolkit.createRaydiumClmm(mintA, mintB, configId, Number(initialPrice)));
    });

    app.post('/v1/solana/defi/orca-pool', async (req: any, res: any) => {
        const { mintA, mintB, initialPrice, feeTier } = req.body;
        if (!mintA || !mintB) return res.status(400).json({ success: false, error: 'mintA, mintB, initialPrice, feeTier required' });
        sakHandler(res, await solanaToolkit.createOrcaPool(mintA, mintB, Number(initialPrice), Number(feeTier)));
    });

    app.post('/v1/solana/defi/meteora-pool', async (req: any, res: any) => {
        const { mintA, mintB, binStep, initialPrice } = req.body;
        if (!mintA || !mintB) return res.status(400).json({ success: false, error: 'mintA, mintB, binStep, initialPrice required' });
        sakHandler(res, await solanaToolkit.createMeteoraPool(mintA, mintB, Number(binStep), Number(initialPrice)));
    });

    app.post('/v1/solana/defi/openbook-market', async (req: any, res: any) => {
        const { mintA, mintB, lotSize, tickSize } = req.body;
        if (!mintA || !mintB) return res.status(400).json({ success: false, error: 'mintA, mintB required' });
        sakHandler(res, await solanaToolkit.createOpenbookMarket(mintA, mintB, Number(lotSize) || 1, Number(tickSize) || 0.01));
    });

    app.post('/v1/solana/defi/limit-order', async (req: any, res: any) => {
        const { mint, quantity, side, price } = req.body;
        if (!mint || !quantity || !side || !price) return res.status(400).json({ success: false, error: 'mint, quantity, side, price required' });
        sakHandler(res, await solanaToolkit.createLimitOrder(mint, Number(quantity), side, Number(price)));
    });

    app.post('/v1/solana/defi/drift-perp', async (req: any, res: any) => {
        const { amount, symbol, side, leverage } = req.body;
        if (!amount || !symbol || !side) return res.status(400).json({ success: false, error: 'amount, symbol, side required' });
        sakHandler(res, await solanaToolkit.openDriftPerp(Number(amount), symbol, side, Number(leverage) || 1));
    });

    app.post('/v1/solana/defi/drift-deposit', async (req: any, res: any) => {
        const { amount, symbol } = req.body;
        if (!amount || !symbol) return res.status(400).json({ success: false, error: 'amount and symbol required' });
        sakHandler(res, await solanaToolkit.driftDeposit(Number(amount), symbol));
    });

    app.post('/v1/solana/defi/drift-withdraw', async (req: any, res: any) => {
        const { amount, symbol } = req.body;
        if (!amount || !symbol) return res.status(400).json({ success: false, error: 'amount and symbol required' });
        sakHandler(res, await solanaToolkit.driftWithdraw(Number(amount), symbol));
    });

    app.post('/v1/solana/defi/adrena-perp', async (req: any, res: any) => {
        const { amount, symbol, side, leverage } = req.body;
        if (!amount || !symbol || !side) return res.status(400).json({ success: false, error: 'amount, symbol, side required' });
        sakHandler(res, await solanaToolkit.openAdrenaPerp(Number(amount), symbol, side, Number(leverage) || 1));
    });

    app.post('/v1/solana/defi/adrena-close', async (req: any, res: any) => {
        const { symbol, side } = req.body;
        if (!symbol || !side) return res.status(400).json({ success: false, error: 'symbol and side required' });
        sakHandler(res, await solanaToolkit.closeAdrenaPerp(symbol, side));
    });

    app.post('/v1/solana/defi/jito-bundle', async (req: any, res: any) => {
        const { transactions } = req.body;
        if (!transactions) return res.status(400).json({ success: false, error: 'transactions required' });
        sakHandler(res, await solanaToolkit.sendJitoBundle(transactions));
    });

    // ── MISC ─────────────────────────────────────────────────

    app.get('/v1/solana/coingecko/:coinId', async (req: any, res: any) => {
        sakHandler(res, await solanaToolkit.getCoinGeckoPrice(req.params.coinId));
    });
    app.get('/v1/solana/trending', async (_req: any, res: any) => {
        sakHandler(res, await solanaToolkit.getTrendingTokens());
    });

    app.get('/v1/solana/top-gainers', async (_req: any, res: any) => {
        sakHandler(res, await solanaToolkit.getTopGainers());
    });

    app.get('/v1/solana/top-gainers/:duration', async (req: any, res: any) => {
        sakHandler(res, await solanaToolkit.getTopGainers(req.params.duration));
    });

    app.get('/v1/solana/latest-pools', async (_req: any, res: any) => {
        sakHandler(res, await solanaToolkit.getLatestPools());
    });

    app.get('/v1/solana/pyth-price/:feedId', async (req: any, res: any) => {
        sakHandler(res, await solanaToolkit.getPythPrice(req.params.feedId));
    });

    app.get('/v1/solana/resolve-domain/:domain', async (req: any, res: any) => {
        sakHandler(res, await solanaToolkit.resolveDomain(req.params.domain));
    });

    app.get('/v1/solana/domain-tlds', async (_req: any, res: any) => {
        sakHandler(res, await solanaToolkit.getAllDomainsTLDs());
    });

    app.post('/v1/solana/register-domain', async (req: any, res: any) => {
        const { domain, space } = req.body;
        if (!domain) return res.status(400).json({ success: false, error: 'domain required' });
        sakHandler(res, await solanaToolkit.registerDomain(domain, Number(space) || 1000));
    });

    app.post('/v1/solana/register-alldomain', async (req: any, res: any) => {
        const { domain, tld } = req.body;
        if (!domain || !tld) return res.status(400).json({ success: false, error: 'domain and tld required' });
        sakHandler(res, await solanaToolkit.registerAlldomains(domain, tld));
    });

    app.post('/v1/solana/gibwork-bounty', async (req: any, res: any) => {
        const { title, description, requirements, tags, payout } = req.body;
        if (!title || !description) return res.status(400).json({ success: false, error: 'title and description required' });
        sakHandler(res, await solanaToolkit.createGibWorkBounty(title, description, requirements || '', tags || [], Number(payout) || 0));
    });

    // ── BLINKS ───────────────────────────────────────────────

    app.post('/v1/solana/blink', async (req: any, res: any) => {
        const { url } = req.body;
        if (!url) return res.status(400).json({ success: false, error: 'url required' });
        sakHandler(res, await solanaToolkit.executeBlink(url));
    });

    // ── CROSS-CHAIN ──────────────────────────────────────────

    app.post('/v1/solana/debridge', async (req: any, res: any) => {
        const { srcChain, dstChain, srcToken, dstToken, amount } = req.body;
        if (!srcChain || !dstChain || !srcToken || !dstToken || !amount) {
            return res.status(400).json({ success: false, error: 'srcChain, dstChain, srcToken, dstToken, amount required' });
        }
        sakHandler(res, await solanaToolkit.deBridge(Number(srcChain), Number(dstChain), srcToken, dstToken, Number(amount)));
    });

    // ── GENERIC ESCAPE HATCH ─────────────────────────────────

    app.post('/v1/solana/call', async (req: any, res: any) => {
        const { method, args } = req.body;
        if (!method) return res.status(400).json({ success: false, error: 'method required' });
        sakHandler(res, await solanaToolkit.callMethod(method, ...(args || [])));
    });

    // ═══════════════════════════════════════════════════════════
    // APPROVAL SYSTEM
    // ═══════════════════════════════════════════════════════════

    app.get('/v1/approvals/pending', async (_req: any, res: any) => {
        res.json({ success: true, data: approvalService.listPending() });
    });

    app.get('/v1/approvals/history', async (req: any, res: any) => {
        const limit = parseInt(req.query.limit || '50', 10);
        res.json({ success: true, data: approvalService.getHistory(limit) });
    });

    app.post('/v1/approvals/:id/approve', async (req: any, res: any) => {
        const ok = approvalService.approve(req.params.id, req.body.decidedBy || 'api');
        res.json({ success: ok });
    });

    app.post('/v1/approvals/:id/reject', async (req: any, res: any) => {
        const ok = approvalService.reject(req.params.id, req.body.decidedBy || 'api');
        res.json({ success: ok });
    });

    // ═══════════════════════════════════════════════════════════
    // RELATIONSHIP & TRUST
    // ═══════════════════════════════════════════════════════════

    app.get('/v1/relationships', async (_req: any, res: any) => {
        res.json({ success: true, data: relationshipStore.getAllRelationships() });
    });

    app.get('/v1/relationships/top', async (req: any, res: any) => {
        const limit = parseInt(req.query.limit || '10', 10);
        res.json({ success: true, data: relationshipStore.getTopTrusted(limit) });
    });

    app.get('/v1/relationships/:agentId', async (req: any, res: any) => {
        const rel = relationshipStore.getRelationship(req.params.agentId);
        res.json({ success: true, data: rel });
    });

    app.get('/v1/relationships/:agentId/summary', async (req: any, res: any) => {
        res.json({ success: true, data: relationshipStore.getTrustSummary(req.params.agentId) });
    });

    // ═══════════════════════════════════════════════════════════
    // GOAL MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    app.get('/v1/goals', async (_req: any, res: any) => {
        res.json({ success: true, data: goalManager.getActiveGoals() });
    });

    app.get('/v1/goals/all', async (_req: any, res: any) => {
        res.json({ success: true, data: goalManager.getAllGoals() });
    });

    app.get('/v1/goals/summary', async (_req: any, res: any) => {
        res.json({ success: true, data: goalManager.getGoalsSummary() });
    });

    app.post('/v1/goals', async (req: any, res: any) => {
        const { description, type, target, metrics } = req.body;
        if (!description) return res.status(400).json({ success: false, error: 'description required' });
        const goal = goalManager.createGoal(description, type || 'ongoing', { target, metrics });
        res.json({ success: true, data: goal });
    });

    app.patch('/v1/goals/:id/progress', async (req: any, res: any) => {
        const { progress, note } = req.body;
        const ok = goalManager.updateProgress(req.params.id, Number(progress), note);
        res.json({ success: ok });
    });

    app.patch('/v1/goals/:id/metric', async (req: any, res: any) => {
        const { metric, value } = req.body;
        if (!metric) return res.status(400).json({ success: false, error: 'metric required' });
        const ok = goalManager.updateMetric(req.params.id, metric, Number(value));
        res.json({ success: ok });
    });

    // ═══════════════════════════════════════════════════════════
    // TASK PIPELINES
    // ═══════════════════════════════════════════════════════════

    app.get('/v1/pipelines', async (_req: any, res: any) => {
        res.json({ success: true, data: taskPipeline.listActivePipelines() });
    });

    app.get('/v1/pipelines/history', async (req: any, res: any) => {
        const limit = parseInt(req.query.limit || '20', 10);
        res.json({ success: true, data: taskPipeline.getPipelineHistory(limit) });
    });

    app.post('/v1/pipelines/:id/cancel', async (req: any, res: any) => {
        const ok = taskPipeline.cancelPipeline(req.params.id);
        res.json({ success: ok });
    });

    // ═══════════════════════════════════════════════════════════
    // VISION & IMAGE GEN
    // ═══════════════════════════════════════════════════════════

    app.post('/v1/vision/analyze', async (req: any, res: any) => {
        const { imageUrl, prompt } = req.body;
        if (!imageUrl) return res.status(400).json({ success: false, error: 'imageUrl required' });
        const result = await analyzeImage(imageUrl, prompt);
        res.json(result);
    });

    app.post('/v1/image/generate', async (req: any, res: any) => {
        const { prompt, size, quality, style } = req.body;
        if (!prompt) return res.status(400).json({ success: false, error: 'prompt required' });
        const result = await generateImage(prompt, { size, quality, style });
        res.json(result);
    });

    // ═══════════════════════════════════════════════════════════
    // SCHEDULER / ROUTINES
    // ═══════════════════════════════════════════════════════════

    app.get('/v1/routines', async (_req: any, res: any) => {
        res.json({ success: true, data: scheduler.getAllRoutines() });
    });

    app.get('/v1/routines/active', async (_req: any, res: any) => {
        res.json({ success: true, data: scheduler.getActiveRoutines() });
    });

    app.get('/v1/routines/summary', async (_req: any, res: any) => {
        res.json({ success: true, data: scheduler.getScheduleSummary() });
    });

    app.get('/v1/routines/history', async (req: any, res: any) => {
        const limit = parseInt(req.query.limit || '50', 10);
        res.json({ success: true, data: scheduler.getRoutineHistory(limit) });
    });

    app.post('/v1/routines', async (req: any, res: any) => {
        const { name, description, frequency, cronHour, cronMinute, cronDayOfWeek, actions, tags, maxRuns } = req.body;
        if (!name || !frequency) return res.status(400).json({ success: false, error: 'name and frequency required' });
        const routine = scheduler.createRoutine(name, description || '', frequency, {
            cronHour, cronMinute, cronDayOfWeek, actions, tags, maxRuns,
        });
        res.json({ success: true, data: routine });
    });

    app.post('/v1/routines/:id/pause', async (req: any, res: any) => {
        res.json({ success: scheduler.pauseRoutine(req.params.id) });
    });

    app.post('/v1/routines/:id/resume', async (req: any, res: any) => {
        res.json({ success: scheduler.resumeRoutine(req.params.id) });
    });

    app.delete('/v1/routines/:id', async (req: any, res: any) => {
        res.json({ success: scheduler.deleteRoutine(req.params.id) });
    });

    // ═══════════════════════════════════════════════════════════
    // AUTONOMY CONFIG (experiment monitor)
    // ═══════════════════════════════════════════════════════════

    app.get('/v1/autonomy', async (_req: any, res: any) => {
        res.json({ success: true, data: autonomy.getState() });
    });

    app.get('/v1/autonomy/summary', async (_req: any, res: any) => {
        res.json({ success: true, data: autonomy.getSelfAwarenessSummary() });
    });

    app.get('/v1/autonomy/log', async (req: any, res: any) => {
        const limit = parseInt(req.query.limit || '50', 10);
        res.json({ success: true, data: autonomy.getModLog(limit) });
    });

    app.post('/v1/autonomy/reset', async (_req: any, res: any) => {
        autonomy.reset();
        res.json({ success: true, message: 'Autonomy reset to defaults' });
    });

    // Start price oracle background refresh
    startPriceOracle();

    server = app.listen(port, () => {
        logger.info("rest_api_started", { port });
    });
}

export function stopRestApi() {
    if (server) {
        server.close();
        logger.info("rest_api_stopped");
    }
}
