/**
 * Matching Engine (Sprint 3)
 *
 * Autonomously matches buy and sell intents discovered on-chain.
 * When two intents overlap in asset, price range, and quantity,
 * the engine creates a deal ticket and notifies both parties.
 *
 * Architecture:
 *   intentListener → eventBus("intent_discovered") → matchingEngine (this file)
 *   matchingEngine → dealPhaseManager.createDeal() → outboundRouter → agents
 *
 * Matching Rules:
 *   1. Asset must be identical (case-insensitive)
 *   2. Price ranges must overlap: buyer.maxPrice >= seller.minPrice
 *   3. Quantity must have at least 50% overlap
 *   4. Neither intent can be expired
 *   5. An intent cannot match against itself (same agentEndpoint)
 *   6. Each intent can only match once
 *
 * Scoring:
 *   Match quality = price_overlap_score * quantity_overlap_score
 *   Higher scores are executed first.
 *
 * Safety:
 *   - economicSafety.preTradeCheck() runs before deal creation
 *   - treasuryManager.canAcceptNewDeals() must return true
 *   - Circuit breaker prevents matching during RPC instability
 *
 * @module matchingEngine
 */

import { MemoIntentPayload } from './intentBroadcaster';
import { eventBus } from './eventBus';
import { logger } from '../utils/logger';
import { dealPhaseManager } from '../../core/dealPhaseManager';
import { canAcceptNewDeals } from './treasuryManager';
import { circuitBreaker } from '../utils/circuitBreaker';
import { experienceMemory } from './experienceMemory';
import { soulEngine } from './soulEngine';

// ==========================================
// TYPES
// ==========================================

interface StoredIntent {
    signature: string;
    intent: MemoIntentPayload;
    discoveredAt: number;
    matched: boolean;
}

interface MatchCandidate {
    buyIntent: StoredIntent;
    sellIntent: StoredIntent;
    matchScore: number;
    midPrice: number;
    matchedQuantity: number;
}

export interface MatchResult {
    success: boolean;
    ticketId?: string;
    buyer: string;
    seller: string;
    asset: string;
    price: number;
    quantity: number;
    error?: string;
}

// ==========================================
// STATE
// ==========================================

/** Live intent book — pruned every cycle */
const _intentBook: Map<string, StoredIntent> = new Map();

/** Matched pairs — prevents double-matching */
const _matchedPairs: Set<string> = new Set();

/** Stats */
let _totalMatched = 0;
let _totalIntentsProcessed = 0;
let _cycleCount = 0;

// ==========================================
// CONFIGURATION
// ==========================================

/** Minimum match score to trigger a deal (0-1) */
const MIN_MATCH_SCORE = 0.3;

/** Maximum age of an intent before it's pruned (ms) */
const MAX_INTENT_AGE_MS = 60 * 60 * 1000; // 1 hour

/** Minimum quantity overlap ratio */
const MIN_QUANTITY_OVERLAP = 0.5;

/** Maximum concurrent active matches per cycle */
const MAX_MATCHES_PER_CYCLE = 5;

// ==========================================
// INTENT MANAGEMENT
// ==========================================

/**
 * Add an intent to the order book.
 * Called via eventBus subscription.
 */
export function addIntent(signature: string, intent: MemoIntentPayload, discoveredAt: number): void {
    // Skip if already in book
    if (_intentBook.has(signature)) return;

    // Skip expired
    if (intent.expiresAt < Date.now()) {
        logger.debug('matching_intent_expired_on_arrival', { signature, expiresAt: intent.expiresAt });
        return;
    }

    // Validate fields
    if (!intent.side || !intent.asset || !intent.agentEndpoint) {
        logger.debug('matching_intent_invalid', { signature });
        return;
    }

    _intentBook.set(signature, {
        signature,
        intent,
        discoveredAt,
        matched: false,
    });

    _totalIntentsProcessed++;
    logger.info('matching_intent_added', {
        signature: signature.substring(0, 16),
        side: intent.side,
        asset: intent.asset,
        price_range: `${intent.minPrice}-${intent.maxPrice}`,
        quantity: intent.quantity,
        book_size: _intentBook.size,
    });
}

/**
 * Remove expired and matched intents from the book.
 */
export function pruneBook(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [sig, entry] of _intentBook) {
        const expired = entry.intent.expiresAt < now;
        const tooOld = (now - entry.discoveredAt) > MAX_INTENT_AGE_MS;
        const alreadyMatched = entry.matched;

        if (expired || tooOld || alreadyMatched) {
            _intentBook.delete(sig);
            pruned++;
        }
    }

    if (pruned > 0) {
        logger.debug('matching_book_pruned', { pruned, remaining: _intentBook.size });
    }

    return pruned;
}

// ==========================================
// MATCHING ALGORITHM
// ==========================================

/**
 * Score a potential match between a buy and sell intent.
 * Returns 0 if no valid match, 0-1 for match quality.
 */
export function scoreMatch(buy: MemoIntentPayload, sell: MemoIntentPayload): number {
    // Rule 1: Asset must match
    if (buy.asset.toLowerCase() !== sell.asset.toLowerCase()) return 0;

    // Rule 2: Price ranges must overlap
    // Buyer's max must be >= seller's min
    if (buy.maxPrice < sell.minPrice) return 0;

    // Rule 3: Quantity overlap
    const minQty = Math.min(buy.quantity, sell.quantity);
    const maxQty = Math.max(buy.quantity, sell.quantity);
    const qtyOverlap = minQty / maxQty;
    if (qtyOverlap < MIN_QUANTITY_OVERLAP) return 0;

    // Price overlap score: how much do the ranges overlap?
    const overlapMin = Math.max(buy.minPrice, sell.minPrice);
    const overlapMax = Math.min(buy.maxPrice, sell.maxPrice);
    const overlapRange = Math.max(0, overlapMax - overlapMin);
    const totalRange = Math.max(buy.maxPrice, sell.maxPrice) - Math.min(buy.minPrice, sell.minPrice);
    const priceScore = totalRange > 0 ? overlapRange / totalRange : 0;

    // Combined score
    return priceScore * qtyOverlap;
}

/**
 * Calculate the fair mid-price for a matched pair.
 */
export function calculateMidPrice(buy: MemoIntentPayload, sell: MemoIntentPayload): number {
    const overlapMin = Math.max(buy.minPrice, sell.minPrice);
    const overlapMax = Math.min(buy.maxPrice, sell.maxPrice);
    return (overlapMin + overlapMax) / 2;
}

/**
 * Find all valid matches in the current order book.
 * Returns matches sorted by score (best first).
 */
export function findMatches(): MatchCandidate[] {
    const buys: StoredIntent[] = [];
    const sells: StoredIntent[] = [];

    for (const entry of _intentBook.values()) {
        if (entry.matched) continue;
        if (entry.intent.expiresAt < Date.now()) continue;

        if (entry.intent.side === 'buy') buys.push(entry);
        else sells.push(entry);
    }

    const candidates: MatchCandidate[] = [];

    for (const buy of buys) {
        for (const sell of sells) {
            // Rule 5: Cannot match against yourself
            if (buy.intent.agentEndpoint === sell.intent.agentEndpoint) continue;

            // Rule 6: Cannot re-match a pair
            const pairKey = [buy.signature, sell.signature].sort().join(':');
            if (_matchedPairs.has(pairKey)) continue;

            const score = scoreMatch(buy.intent, sell.intent);
            if (score < MIN_MATCH_SCORE) continue;

            candidates.push({
                buyIntent: buy,
                sellIntent: sell,
                matchScore: score,
                midPrice: calculateMidPrice(buy.intent, sell.intent),
                matchedQuantity: Math.min(buy.intent.quantity, sell.intent.quantity),
            });
        }
    }

    // Sort by score descending — best matches first
    candidates.sort((a, b) => b.matchScore - a.matchScore);

    return candidates;
}

// ==========================================
// MATCH EXECUTION
// ==========================================

/**
 * Execute a match: create a deal ticket and notify both parties.
 */
async function executeMatch(candidate: MatchCandidate): Promise<MatchResult> {
    const { buyIntent, sellIntent, midPrice, matchedQuantity } = candidate;
    const buy = buyIntent.intent;
    const sell = sellIntent.intent;

    const result: MatchResult = {
        success: false,
        buyer: buy.agentEndpoint,
        seller: sell.agentEndpoint,
        asset: buy.asset,
        price: midPrice,
        quantity: matchedQuantity,
    };

    try {
        // Safety gate: treasury must accept new deals
        if (!canAcceptNewDeals()) {
            result.error = 'treasury_emergency_no_new_deals';
            logger.warn('matching_blocked_treasury', { reason: result.error });
            return result;
        }

        // Safety gate: circuit breaker must be closed
        const cbStatus = circuitBreaker.getStatus();
        if (cbStatus.state === 'OPEN') {
            result.error = 'circuit_breaker_open';
            logger.warn('matching_blocked_circuit_breaker', { reason: result.error });
            return result;
        }

        // Calculate collateral (default: 10% of deal value)
        const collateral = midPrice * 0.1;

        // Create deal ticket
        const ticketId = `match-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        dealPhaseManager.initDeal(ticketId, buy.agentEndpoint, sell.agentEndpoint);

        // Mark both intents as matched
        buyIntent.matched = true;
        sellIntent.matched = true;

        const pairKey = [buyIntent.signature, sellIntent.signature].sort().join(':');
        _matchedPairs.add(pairKey);

        // Prune old match records
        if (_matchedPairs.size > 500) {
            const entries = Array.from(_matchedPairs);
            for (let i = 0; i < 250; i++) _matchedPairs.delete(entries[i]);
        }

        _totalMatched++;

        // Record experience
        experienceMemory.record(
            'deal_completed',
            `Autonomously matched ${buy.asset} trade: ${buy.agentEndpoint} buys from ${sell.agentEndpoint} at ${midPrice} SOL (score: ${candidate.matchScore.toFixed(2)})`,
            {
                ticketId,
                asset: buy.asset,
                price: midPrice,
                quantity: matchedQuantity,
                matchScore: candidate.matchScore,
                buySignature: buyIntent.signature.substring(0, 16),
                sellSignature: sellIntent.signature.substring(0, 16),
            }
        );

        // Mood boost — the agent found a match, that's satisfying
        soulEngine.updateMood('deal_completed');

        result.success = true;
        result.ticketId = ticketId;

        logger.info('matching_deal_created', {
            ticket_id: ticketId,
            asset: buy.asset,
            price: midPrice,
            quantity: matchedQuantity,
            score: candidate.matchScore.toFixed(3),
            buyer: buy.agentEndpoint,
            seller: sell.agentEndpoint,
        });

        // Notify both parties via outbound event
        eventBus.publish('agreement_detected', {
            ticketId,
            price: midPrice,
            collateral_buyer: collateral,
            collateral_seller: collateral,
            asset_type: buy.asset,
            confidence: Math.round(candidate.matchScore * 100),
            buyer: buy.agentEndpoint,
            seller: sell.agentEndpoint,
        });

        return result;

    } catch (err: any) {
        result.error = err.message;
        logger.error('matching_execution_failed', {
            asset: buy.asset,
            buyer: buy.agentEndpoint,
            seller: sell.agentEndpoint,
        }, err);
        return result;
    }
}

// ==========================================
// MATCHING CYCLE
// ==========================================

/**
 * Run one matching cycle: prune → find → execute.
 * Called from the heartbeat loop.
 */
export async function matchingTick(): Promise<void> {
    _cycleCount++;

    // 1. Prune stale intents
    pruneBook();

    // 2. Need at least 1 buy + 1 sell
    const buys = Array.from(_intentBook.values()).filter(e => !e.matched && e.intent.side === 'buy');
    const sells = Array.from(_intentBook.values()).filter(e => !e.matched && e.intent.side === 'sell');

    if (buys.length === 0 || sells.length === 0) return;

    // 3. Find valid matches
    const candidates = findMatches();
    if (candidates.length === 0) return;

    logger.info('matching_candidates_found', {
        candidates: candidates.length,
        book_buys: buys.length,
        book_sells: sells.length,
    });

    // 4. Execute top matches (up to MAX per cycle)
    let executed = 0;
    for (const candidate of candidates) {
        if (executed >= MAX_MATCHES_PER_CYCLE) break;

        // Double-check neither intent was matched by a previous iteration
        if (candidate.buyIntent.matched || candidate.sellIntent.matched) continue;

        const result = await executeMatch(candidate);
        if (result.success) executed++;
    }

    if (executed > 0) {
        logger.info('matching_cycle_complete', {
            matched: executed,
            total_matched_lifetime: _totalMatched,
            remaining_book_size: _intentBook.size,
        });
    }
}

// ==========================================
// STATS & DIAGNOSTICS
// ==========================================

export function getMatchingStats(): {
    bookSize: number;
    buys: number;
    sells: number;
    totalMatched: number;
    totalProcessed: number;
    cycles: number;
} {
    const buys = Array.from(_intentBook.values()).filter(e => !e.matched && e.intent.side === 'buy').length;
    const sells = Array.from(_intentBook.values()).filter(e => !e.matched && e.intent.side === 'sell').length;

    return {
        bookSize: _intentBook.size,
        buys,
        sells,
        totalMatched: _totalMatched,
        totalProcessed: _totalIntentsProcessed,
        cycles: _cycleCount,
    };
}

/**
 * Get the current order book snapshot (for debugging / API).
 */
export function getOrderBook(): { buys: StoredIntent[]; sells: StoredIntent[] } {
    const buys: StoredIntent[] = [];
    const sells: StoredIntent[] = [];

    for (const entry of _intentBook.values()) {
        if (entry.matched) continue;
        if (entry.intent.expiresAt < Date.now()) continue;

        if (entry.intent.side === 'buy') buys.push(entry);
        else sells.push(entry);
    }

    // Sort buys by maxPrice desc (best buyer first)
    buys.sort((a, b) => b.intent.maxPrice - a.intent.maxPrice);
    // Sort sells by minPrice asc (cheapest seller first)
    sells.sort((a, b) => a.intent.minPrice - b.intent.minPrice);

    return { buys, sells };
}

// ==========================================
// LIFECYCLE
// ==========================================

/**
 * Initialize the matching engine.
 * Subscribes to intent_discovered events from intentListener.
 */
export function startMatchingEngine(): void {
    eventBus.subscribe('intent_discovered', (payload: any) => {
        addIntent(payload.signature, payload.intent, payload.discoveredAt);
    });

    logger.info('matching_engine_started', {
        min_score: MIN_MATCH_SCORE,
        max_intent_age_ms: MAX_INTENT_AGE_MS,
        max_matches_per_cycle: MAX_MATCHES_PER_CYCLE,
    });
}

/**
 * Clear all state (for testing).
 */
export function resetMatchingEngine(): void {
    _intentBook.clear();
    _matchedPairs.clear();
    _totalMatched = 0;
    _totalIntentsProcessed = 0;
    _cycleCount = 0;
}
