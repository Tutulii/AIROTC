import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { generateApiKey } from '../middleware/auth';
import { calculateVisibleReputation, getTier } from '../utils/reputation';
import {
    isValidWebhookUrl,
    normalizeWebhookEvents,
    parseStoredWebhookEvents,
    serializeWebhookEvents,
    type WebhookEvent,
} from './webhookDelivery';

export const registerAgentService = async (wallet: string) => {
    // Strict Input Validation guaranteeing string mapping against PublicKey bounds
    try {
        const decoded = bs58.decode(wallet);
        if (decoded.length !== 32) throw new Error();
        new PublicKey(wallet);
    } catch {
        const err = new Error('INVALID_WALLET');
        err.name = '400';
        throw err;
    }

    try {
        // Generate API key for the new agent
        const { raw: apiKey, hash: apiKeyHash } = generateApiKey();

        const agent = await prisma.agent.create({
            data: { wallet, apiKeyHash },
            select: { wallet: true }
        });

        // Return the raw API key — this is the ONLY time it's shown
        return {
            wallet: agent.wallet,
            created: true,
            apiKey, // mk_abc123... — save this, it won't be shown again
        };
    } catch (error: any) {
        // Evaluate Prisma explicitly rejecting Unique Boundary constraint mapping silently via 200 idemptency
        if (error.code === 'P2002') {
            return { wallet, created: false, apiKey: null };
        }
        throw error;
    }
};

const formatTime = (totalSeconds: number): string => {
    if (totalSeconds === 0) return "0s";
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
};

const getTrustSummary = (tier: string, successRate: number, disputeRate: number): string => {
    if (tier === "new") return "No trading history yet";
    if (tier === "elite" && disputeRate === 0) return "Flawless trading history. Highly recommended.";
    if (tier === "elite") return "Top-tier reliability trader with negligible disputes.";
    if (tier === "trusted") return "High reliability trader with low dispute rate.";
    if (tier === "neutral") return "Average trader. Proceed with standard caution.";
    if (disputeRate > 0.2) return "High dispute rate. Trade with extreme caution.";
    return "Below average reliability. Exercise caution.";
};

export const getAgentProfile = async (wallet: string) => {
    // 1. Validation
    try {
        new PublicKey(wallet);
    } catch {
        const err = new Error('Invalid wallet address');
        err.name = '400';
        throw err;
    }

    // 2. DB Fetch
    const agent = await prisma.agent.findUnique({
        where: { wallet }
    });

    if (!agent) {
        const err = new Error('Agent not found');
        err.name = '404';
        throw err;
    }

    // 3. Derived Metrics
    const total = agent.totalDeals;
    let successRate = 0;
    let disputeRate = 0;

    if (total > 0) {
        successRate = agent.successfulDeals / total;
        disputeRate = agent.disputedDeals / total;
    }

    const reputationScore = calculateVisibleReputation(agent);
    const tier = getTier(reputationScore, total);
    const trustSummary = getTrustSummary(tier, successRate, disputeRate);

    // 4. Response Structure mapped meticulously avoiding type ambiguity
    const response = {
        wallet: agent.wallet,
        reputationScore,
        tier,
        trustSummary,
        stats: {
            totalDeals: agent.totalDeals,
            successfulDeals: agent.successfulDeals,
            cancelledDeals: agent.cancelledDeals,
            disputedDeals: agent.disputedDeals,
            totalVolume: agent.totalVolume,
            avgSettlementTime: agent.avgSettlementTime,
            avgSettlementTimeFormatted: formatTime(agent.avgSettlementTime)
        },
        metrics: {
            successRate,
            disputeRate
        }
    };

    logger.info("info", { detail: `\n[AGENT PROFILE]` });
    logger.info("info", { detail: `Wallet: ${agent.wallet}` });
    logger.info("info", { detail: `Score: ${reputationScore}` });
    logger.info("info", { detail: `Tier: ${tier}` });
    logger.info("info", { detail: `Deals: ${agent.totalDeals}` });
    logger.info("info", { detail: `Success: ${(successRate * 100).toFixed(0)}%` });

    return response;
};

export const updateWebhookConfig = async (
    wallet: string,
    webhookUrl: string | null,
    webhookEvents?: unknown,
) => {
    // 1. Validate wallet
    try {
        new PublicKey(wallet);
    } catch {
        const err = new Error('Invalid wallet address');
        err.name = '400';
        throw err;
    }

    // 2. Validate URL if provided
    if (webhookUrl !== null) {
        if (!isValidWebhookUrl(webhookUrl)) {
            const err = new Error('Invalid webhook URL. Must be a valid HTTP/HTTPS URL.');
            err.name = '400';
            throw err;
        }
    }

    let normalizedEvents: WebhookEvent[] | null | undefined;
    try {
        normalizedEvents = normalizeWebhookEvents(webhookEvents);
    } catch (error: any) {
        const err = new Error(error.message);
        err.name = '400';
        throw err;
    }

    // 3. Find agent
    const agent = await prisma.agent.findUnique({ where: { wallet } });
    if (!agent) {
        const err = new Error('Agent not found');
        err.name = '404';
        throw err;
    }

    // 4. Generate secret on first setup, preserve on updates, clear on removal
    let webhookSecret = agent.webhookSecret;
    if (webhookUrl === null) {
        // Removing webhook — clear endpoint, secret, and custom event preferences.
        webhookSecret = null;
        normalizedEvents = null;
    } else if (!webhookSecret) {
        // First time — generate a random 32-byte hex secret
        const crypto = await import('crypto');
        webhookSecret = crypto.randomBytes(32).toString('hex');
    }

    // 5. Update
    await prisma.agent.update({
        where: { wallet },
        data: {
            webhookUrl,
            webhookSecret,
            webhookEvents: normalizedEvents === undefined
                ? agent.webhookEvents
                : serializeWebhookEvents(normalizedEvents),
        },
    });

    const enabledEvents = webhookUrl
        ? parseStoredWebhookEvents(normalizedEvents === undefined ? agent.webhookEvents : serializeWebhookEvents(normalizedEvents))
        : [];

    logger.info("info", {
        detail: `[WEBHOOK CONFIG] Wallet: ${wallet} | URL: ${webhookUrl ?? 'REMOVED'} | Events: ${enabledEvents.length}`,
    });

    return {
        wallet,
        webhookUrl,
        webhookSecret: webhookUrl ? webhookSecret : null, // Only reveal secret when setting URL
        configured: webhookUrl !== null,
        events: enabledEvents,
    };
};
