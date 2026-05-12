/**
 * Market Discovery (Level 5 Autonomy)
 *
 * Autonomous counterparty discovery and trade intent matching engine.
 * Broadcasts agent's trade intents via Solana Memo program and listens
 * for intents from other agents.
 *
 * Architecture:
 *   1. BROADCAST: Write JSON trade intents to Solana Memo Tx
 *   2. LISTEN: Poll recent Memo transactions for matching intents
 *   3. MATCH: Price overlap detection → auto-create ticket
 *   4. EXPIRE: Prune intents past their expiration time
 */

import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import { eventBus } from "./eventBus";
import { shutdownManager } from "../utils/shutdownManager";
import { checkPriceDeviation } from "./priceOracle";
import { broadcastIntent as broadcastMemoIntent } from "./intentBroadcaster";
import { getConnection } from "../solana/connection";
import { getWallet } from "../solana/wallet";
import { loadConfig } from "../config";

// ==========================================
// TYPES
// ==========================================

export interface TradeIntentInput {
    side: "buy" | "sell";
    asset: string;
    minPrice: number;
    maxPrice: number;
    quantity: number;
    ttlMinutes?: number; // Default: 60
}

export interface MatchResult {
    buyIntent: { id: string; agentId: string; maxPrice: number };
    sellIntent: { id: string; agentId: string; minPrice: number };
    matchPrice: number; // Midpoint of overlapping range
    asset: string;
}

// ==========================================
// STATE
// ==========================================

let _isRunning = false;
let _matchInterval: ReturnType<typeof setInterval> | null = null;

const MATCH_CYCLE_MS = 30_000; // Check for matches every 30s
const EXPIRY_CYCLE_MS = 60_000; // Clean expired intents every 60s

// ==========================================
// INTENT MANAGEMENT
// ==========================================

/**
 * Register a new trade intent (can be called by external APIs or internally).
 * After DB insertion, broadcasts the intent on-chain via Solana Memo.
 */
export async function registerIntent(
    agentId: string,
    input: TradeIntentInput
): Promise<string> {
    const ttl = input.ttlMinutes || 60;
    const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

    // Validate price against oracle for fairness
    const deviation = await checkPriceDeviation(input.asset, (input.minPrice + input.maxPrice) / 2, input.quantity);
    if (deviation && !deviation.isFair) {
        logger.warn("market_intent_price_warning", {
            agent: agentId,
            asset: input.asset,
            deviation_percent: deviation.deviationPercent,
            market_price_sol: deviation.marketPriceSol,
        });
    }

    const intent = await prisma.tradeIntent.create({
        data: {
            agentId,
            side: input.side,
            asset: input.asset,
            minPrice: input.minPrice,
            maxPrice: input.maxPrice,
            quantity: input.quantity,
            status: "active",
            expiresAt,
        },
    });

    logger.info("market_intent_registered", {
        intent_id: intent.id,
        agent: agentId,
        side: input.side,
        asset: input.asset,
        price_range: `${input.minPrice}-${input.maxPrice}`,
    });

    // ── Broadcast on-chain via Solana Memo ──────────────────────────
    try {
        const config = loadConfig();
        const connection = getConnection();
        const wallet = getWallet();

        const result = await broadcastMemoIntent(connection, wallet, {
            side: input.side,
            asset: input.asset,
            minPrice: input.minPrice,
            maxPrice: input.maxPrice,
            quantity: input.quantity,
            agentEndpoint: config.agentEndpoint,
            ttlMinutes: ttl,
        });

        if (result.success && result.txSignature) {
            // Record the memo tx signature back to the DB row
            await prisma.tradeIntent.update({
                where: { id: intent.id },
                data: { memoTxSig: result.txSignature },
            });

            logger.info("market_intent_broadcast_onchain", {
                intent_id: intent.id,
                tx: result.txSignature,
                explorer: result.explorerUrl,
            });
        }
    } catch (broadcastErr: any) {
        // Broadcasting failure is non-fatal — intent is still in the local DB
        logger.warn("market_intent_broadcast_skipped", {
            intent_id: intent.id,
            reason: broadcastErr.message,
        });
    }

    return intent.id;
}

/**
 * Cancel an active trade intent.
 */
export async function cancelIntent(intentId: string): Promise<void> {
    await prisma.tradeIntent.update({
        where: { id: intentId },
        data: { status: "expired" },
    });
    logger.info("market_intent_cancelled", { intent_id: intentId });
}

/**
 * List all active intents, optionally filtered by asset.
 */
export async function listActiveIntents(asset?: string) {
    return prisma.tradeIntent.findMany({
        where: {
            status: "active",
            expiresAt: { gt: new Date() },
            ...(asset ? { asset } : {}),
        },
        orderBy: { createdAt: "desc" },
    });
}

// ==========================================
// MATCHING ENGINE
// ==========================================

/**
 * Run one cycle of the matching engine.
 * Finds buy/sell pairs where price ranges overlap.
 */
async function runMatchCycle(): Promise<MatchResult[]> {
    const matches: MatchResult[] = [];

    try {
        const activeIntents = await prisma.tradeIntent.findMany({
            where: { status: "active", expiresAt: { gt: new Date() } },
        });

        // Group by asset
        const byAsset = new Map<string, typeof activeIntents>();
        for (const intent of activeIntents) {
            const list = byAsset.get(intent.asset) || [];
            list.push(intent);
            byAsset.set(intent.asset, list);
        }

        for (const [asset, intents] of byAsset) {
            const buys = intents.filter(i => i.side === "buy");
            const sells = intents.filter(i => i.side === "sell");

            for (const buy of buys) {
                for (const sell of sells) {
                    // Skip self-matching
                    if (buy.agentId === sell.agentId) continue;

                    // Check price overlap: buyer max >= seller min
                    if (buy.maxPrice >= sell.minPrice) {
                        const matchPrice = (buy.maxPrice + sell.minPrice) / 2;

                        matches.push({
                            buyIntent: { id: buy.id, agentId: buy.agentId, maxPrice: buy.maxPrice },
                            sellIntent: { id: sell.id, agentId: sell.agentId, minPrice: sell.minPrice },
                            matchPrice,
                            asset,
                        });

                        // Mark both as matched
                        await prisma.tradeIntent.updateMany({
                            where: { id: { in: [buy.id, sell.id] } },
                            data: { status: "matched" },
                        });

                        logger.info("market_match_found", {
                            asset,
                            buyer: buy.agentId,
                            seller: sell.agentId,
                            match_price_sol: matchPrice,
                            buy_max: buy.maxPrice,
                            sell_min: sell.minPrice,
                        });

                        // Emit event for the pipeline to create a ticket
                        eventBus.publish("ticket_created", {
                            ticket_id: `MATCH-${Date.now()}-${asset}`,
                            offer_id: `${buy.id}::${sell.id}`,
                            buyer: buy.agentId,
                            seller: sell.agentId,
                            status: "active",
                        } as any);

                        break; // One match per buy intent per cycle
                    }
                }
            }
        }

        if (matches.length > 0) {
            logger.info("market_match_cycle_complete", { matches_found: matches.length });
        }

    } catch (error: any) {
        logger.error("market_match_cycle_error", {}, error);
    }

    return matches;
}

/**
 * Expire old intents.
 */
async function expireOldIntents(): Promise<void> {
    try {
        const result = await prisma.tradeIntent.updateMany({
            where: {
                status: "active",
                expiresAt: { lt: new Date() },
            },
            data: { status: "expired" },
        });

        if (result.count > 0) {
            logger.info("market_intents_expired", { count: result.count });
        }
    } catch (error: any) {
        logger.error("market_expire_error", {}, error);
    }
}

// ==========================================
// ON-CHAIN INTENT HANDLER (Sprint 2C)
// ==========================================

/**
 * Get or create an Agent row for a remote agent discovered on-chain.
 * Uses the agentEndpoint as a stable identifier since we don't know
 * their wallet from the memo payload alone.
 */
async function getOrCreateRemoteAgent(agentEndpoint: string): Promise<string> {
    // Use endpoint as a deterministic wallet-like identifier
    const endpointHash = `remote-${Buffer.from(agentEndpoint).toString("base64").slice(0, 32)}`;

    const existing = await prisma.agent.findUnique({
        where: { wallet: endpointHash },
    });

    if (existing) {
        if (existing.endpoint !== agentEndpoint) {
            await prisma.agent.update({
                where: { id: existing.id },
                data: { endpoint: agentEndpoint }
            });
        }
        return existing.id;
    }

    const agent = await prisma.agent.create({
        data: {
            wallet: endpointHash,
            endpoint: agentEndpoint
        },
    });

    logger.info("market_remote_agent_created", {
        agent_id: agent.id,
        endpoint: agentEndpoint,
    });

    return agent.id;
}

/**
 * Handle an intent discovered on-chain via the intent listener.
 * Stores it as a TradeIntent and immediately triggers a match cycle.
 */
export async function handleDiscoveredIntent(event: {
    signature: string;
    intent: {
        side: "buy" | "sell";
        asset: string;
        minPrice: number;
        maxPrice: number;
        quantity: number;
        agentEndpoint: string;
        expiresAt: number;
    };
    discoveredAt: number;
}): Promise<void> {
    const { signature, intent } = event;

    try {
        // Skip if we've already stored this tx signature
        const existing = await prisma.tradeIntent.findUnique({
            where: { memoTxSig: signature },
        });
        if (existing) return;

        // Skip expired intents
        if (intent.expiresAt < Date.now()) return;

        // Get or create a DB agent for this remote agent
        const agentId = await getOrCreateRemoteAgent(intent.agentEndpoint);

        // Store intent in DB so the matching engine can find it
        const stored = await prisma.tradeIntent.create({
            data: {
                agentId,
                side: intent.side,
                asset: intent.asset,
                minPrice: intent.minPrice,
                maxPrice: intent.maxPrice,
                quantity: intent.quantity,
                status: "active",
                memoTxSig: signature,
                expiresAt: new Date(intent.expiresAt),
            },
        });

        logger.info("market_onchain_intent_stored", {
            intent_id: stored.id,
            side: intent.side,
            asset: intent.asset,
            price_range: `${intent.minPrice}-${intent.maxPrice}`,
            agentEndpoint: intent.agentEndpoint,
            tx: signature,
        });

        // Trigger an immediate match cycle — don't wait for the timer
        const matches = await runMatchCycle();
        if (matches.length > 0) {
            logger.info("market_instant_match_triggered", {
                matches: matches.length,
                trigger_tx: signature,
            });
        }
    } catch (error: any) {
        logger.error("market_discovered_intent_error", { tx: signature }, error);
    }
}

// ==========================================
// LIFECYCLE
// ==========================================

export function startMarketDiscovery(): void {
    if (_isRunning) return;
    _isRunning = true;

    // Subscribe to on-chain discovered intents
    eventBus.subscribe("intent_discovered", handleDiscoveredIntent);

    // Run matching engine periodically
    _matchInterval = setInterval(async () => {
        if (!shutdownManager.canAcceptNewWork()) return;
        await expireOldIntents();
        await runMatchCycle();
    }, MATCH_CYCLE_MS);

    logger.info("market_discovery_started");
}

export function stopMarketDiscovery(): void {
    _isRunning = false;
    if (_matchInterval) {
        clearInterval(_matchInterval);
        _matchInterval = null;
    }
    logger.info("market_discovery_stopped");
}

/**
 * Get market discovery stats for health endpoint.
 */
export async function getMarketStats() {
    const active = await prisma.tradeIntent.count({ where: { status: "active" } });
    const matched = await prisma.tradeIntent.count({ where: { status: "matched" } });
    const expired = await prisma.tradeIntent.count({ where: { status: "expired" } });

    return { active, matched, expired, isRunning: _isRunning };
}
