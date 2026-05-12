/**
 * Auto-Healer Memory (Level 5 Autonomy)
 *
 * Caches error→strategy mappings to avoid redundant LLM calls.
 * If the same error signature has been diagnosed ≥3 times with
 * the same LLM verdict, use the cached strategy instantly.
 *
 * Architecture:
 *   1. Hash error messages deterministically (strip timestamps/IDs)
 *   2. Check DB cache before calling OpenAI
 *   3. After LLM diagnosis, persist to cache
 *   4. Periodically prune stale entries (>30 days)
 */

import * as crypto from "crypto";
import { prisma } from "../src/lib/prisma";
import { logger } from "../src/utils/logger";
import type { AutoHealStrategy, HealStrategyType } from "./autoHealer";

// ==========================================
// CONSTANTS
// ==========================================

const CACHE_HIT_THRESHOLD = 3;   // Use cached strategy after N identical diagnoses
const PRUNE_AGE_DAYS = 30;       // Remove entries older than this

// In-memory hot cache for ultra-fast lookups
const memoryCache = new Map<string, AutoHealStrategy>();

// ==========================================
// HASHING
// ==========================================

/**
 * Normalize and hash an error message.
 * Strips variable parts (timestamps, hex addresses, tx signatures)
 * to group semantically identical errors.
 */
function hashError(actionName: string, rawError: string): string {
    // Normalize: strip hex addresses, base58 tx sigs, timestamps, and numbers >6 digits
    const normalized = rawError
        .replace(/0x[0-9a-fA-F]+/g, "0xHEX")
        .replace(/[1-9A-HJ-NP-Za-km-z]{44,88}/g, "BASE58")
        .replace(/\d{7,}/g, "NUM")
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "TIMESTAMP")
        .toLowerCase()
        .trim();

    const input = `${actionName}::${normalized}`;
    return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ==========================================
// CORE: CACHE LOOKUP
// ==========================================

/**
 * Check if we have a cached strategy for this error pattern.
 * Returns the cached strategy if found and hit count is above threshold,
 * or null if the error needs LLM diagnosis.
 */
export async function getCachedStrategy(
    actionName: string,
    rawError: string
): Promise<AutoHealStrategy | null> {
    const hash = hashError(actionName, rawError);

    // Check in-memory first (hot path)
    if (memoryCache.has(hash)) {
        logger.debug("healer_memory_cache_hit_mem", { hash, action: actionName });
        return memoryCache.get(hash)!;
    }

    try {
        const cached = await prisma.errorPatternCache.findUnique({
            where: { errorHash: hash },
        });

        if (cached && cached.hitCount >= CACHE_HIT_THRESHOLD) {
            const strategy: AutoHealStrategy = {
                strategy: cached.strategy as HealStrategyType,
                userMessage: cached.userMessage,
            };

            // Promote to memory cache
            memoryCache.set(hash, strategy);

            // Increment hit count (fire-and-forget)
            prisma.errorPatternCache.update({
                where: { errorHash: hash },
                data: { hitCount: cached.hitCount + 1 },
            }).catch(() => { });

            logger.info("healer_memory_cache_hit_db", {
                hash,
                action: actionName,
                strategy: cached.strategy,
                hit_count: cached.hitCount + 1,
            });

            return strategy;
        }

        return null;
    } catch (error) {
        logger.error("healer_memory_cache_lookup_failed", { hash }, error);
        return null;
    }
}

// ==========================================
// CORE: CACHE STORE
// ==========================================

/**
 * Store a new LLM diagnosis result in the cache.
 * Called after the auto-healer gets a fresh LLM response.
 */
export async function cacheStrategy(
    actionName: string,
    rawError: string,
    strategy: AutoHealStrategy
): Promise<void> {
    const hash = hashError(actionName, rawError);

    try {
        await prisma.errorPatternCache.upsert({
            where: { errorHash: hash },
            update: {
                hitCount: { increment: 1 },
                strategy: strategy.strategy,
                userMessage: strategy.userMessage,
            },
            create: {
                errorHash: hash,
                errorSample: rawError.slice(0, 500), // Truncate long errors
                strategy: strategy.strategy,
                userMessage: strategy.userMessage,
                hitCount: 1,
            },
        });

        logger.debug("healer_memory_cached", {
            hash,
            action: actionName,
            strategy: strategy.strategy,
        });
    } catch (error) {
        logger.error("healer_memory_cache_store_failed", { hash }, error);
    }
}

// ==========================================
// MAINTENANCE: PRUNE STALE ENTRIES
// ==========================================

/**
 * Remove cache entries older than PRUNE_AGE_DAYS.
 * Call periodically (e.g., daily or on startup).
 */
export async function pruneStaleEntries(): Promise<number> {
    try {
        const cutoff = new Date(Date.now() - PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000);

        const result = await prisma.errorPatternCache.deleteMany({
            where: { updatedAt: { lt: cutoff } },
        });

        if (result.count > 0) {
            logger.info("healer_memory_pruned", { removed: result.count, cutoff_date: cutoff.toISOString() });
        }

        // Clear memory cache for pruned entries
        memoryCache.clear();

        return result.count;
    } catch (error) {
        logger.error("healer_memory_prune_failed", {}, error);
        return 0;
    }
}

/**
 * Get cache statistics for diagnostics.
 */
export async function getCacheStats(): Promise<{
    totalEntries: number;
    memoryCacheSize: number;
    topStrategies: Record<string, number>;
}> {
    const entries = await prisma.errorPatternCache.findMany();
    const topStrategies: Record<string, number> = {};

    for (const entry of entries) {
        topStrategies[entry.strategy] = (topStrategies[entry.strategy] || 0) + entry.hitCount;
    }

    return {
        totalEntries: entries.length,
        memoryCacheSize: memoryCache.size,
        topStrategies,
    };
}
