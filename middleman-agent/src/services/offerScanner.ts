/**
 * offerScanner.ts — Autonomous Offer Scanner
 *
 * Periodically scans the marketplace for offers matching
 * configurable criteria, emitting events when matches are found.
 * Agents subscribe to these events to auto-accept lucrative deals.
 */

import { eventBus } from './eventBus';
import { logger } from '../utils/logger';

const prisma: any = null; // Offers are on the API server, not in middleman's DB

// ─── Configuration ───────────────────────────────────────

export interface ScanCriteria {
    assets?: string[];
    minAmount?: number;
    maxPrice?: number;
    mode?: 'buy' | 'sell';
    excludeWallets?: string[];
}

interface ScoredOffer {
    id: string;
    asset: string;
    price: number;
    amount: number;
    mode: string;
    wallet: string;
    score: number;
    reasons: string[];
}

// ─── Scanner State ───────────────────────────────────────

let scanInterval: NodeJS.Timeout | null = null;
let activeCriteria: ScanCriteria[] = [];
let lastScanTime = 0;
let totalScans = 0;
let totalMatches = 0;

const SCAN_INTERVAL_MS = parseInt(process.env.OFFER_SCAN_INTERVAL_MS || '30000'); // 30s default
const MIN_SCORE_THRESHOLD = parseFloat(process.env.OFFER_MIN_SCORE || '0.5');

// ─── Scoring Engine ──────────────────────────────────────

function scoreOffer(offer: any, criteria: ScanCriteria): ScoredOffer {
    const reasons: string[] = [];
    let score = 0;

    // Asset match (critical)
    if (criteria.assets?.length) {
        const assetMatch = criteria.assets.some(a =>
            offer.asset?.toLowerCase().includes(a.toLowerCase())
        );
        if (assetMatch) {
            score += 0.4;
            reasons.push(`Asset match: ${offer.asset}`);
        } else {
            return { ...offer, score: 0, reasons: ['Asset mismatch'] };
        }
    } else {
        score += 0.2; // No asset filter = partial match
    }

    // Mode match
    if (criteria.mode) {
        // If I want to buy, I look for sell offers and vice versa
        const targetMode = criteria.mode === 'buy' ? 'sell' : 'buy';
        if (offer.mode === targetMode) {
            score += 0.2;
            reasons.push(`Mode match: seeking ${criteria.mode}, found ${offer.mode}`);
        }
    }

    // Price check
    if (criteria.maxPrice && offer.price <= criteria.maxPrice) {
        score += 0.2;
        reasons.push(`Price within budget: ${offer.price} ≤ ${criteria.maxPrice}`);
    }

    // Amount check
    if (criteria.minAmount && offer.amount >= criteria.minAmount) {
        score += 0.1;
        reasons.push(`Amount sufficient: ${offer.amount} ≥ ${criteria.minAmount}`);
    }

    // Exclude known wallets
    if (criteria.excludeWallets?.includes(offer.wallet)) {
        return { ...offer, score: 0, reasons: ['Wallet excluded'] };
    }

    // Freshness bonus (newer offers score slightly higher)
    const ageMs = Date.now() - new Date(offer.createdAt || Date.now()).getTime();
    if (ageMs < 5 * 60 * 1000) {
        score += 0.1;
        reasons.push('Fresh offer (< 5 min)');
    }

    return {
        id: offer.id,
        asset: offer.asset,
        price: offer.price,
        amount: offer.amount,
        mode: offer.mode,
        wallet: offer.wallet,
        score: Math.min(score, 1.0),
        reasons,
    };
}

// ─── Core Scan Logic ─────────────────────────────────────

async function executeScan(): Promise<ScoredOffer[]> {
    totalScans++;
    lastScanTime = Date.now();

    try {
        const API_URL = process.env.API_SERVER_URL || 'http://localhost:3000';
        const res = await fetch(`${API_URL}/v1/offers?status=active&limit=100`);
        if (!res.ok) {
            logger.warn(`[OfferScanner] API fetch failed: ${res.status}`);
            return [];
        }
        const json = await res.json() as any;
        const activeOffers = json.data || [];

        if (activeOffers.length === 0) return [];

        const allMatches: ScoredOffer[] = [];

        for (const criteria of activeCriteria) {
            for (const offer of activeOffers) {
                const scored = scoreOffer(offer, criteria);
                if (scored.score >= MIN_SCORE_THRESHOLD) {
                    allMatches.push(scored);
                }
            }
        }

        // Deduplicate by offer ID, keeping highest score
        const deduped = new Map<string, ScoredOffer>();
        for (const match of allMatches) {
            const existing = deduped.get(match.id);
            if (!existing || match.score > existing.score) {
                deduped.set(match.id, match);
            }
        }

        const results = Array.from(deduped.values()).sort((a, b) => b.score - a.score);
        totalMatches += results.length;

        if (results.length > 0) {
            logger.info(`[OfferScanner] Found ${results.length} matching offers (scan #${totalScans})`);

            eventBus.publish('offer_scan_results' as any, {
                matches: results,
                scanNumber: totalScans,
                timestamp: Date.now(),
            } as any);

            for (const match of results.slice(0, 3)) {
                logger.info(`[OfferScanner]   → ${match.asset} ${match.mode} @ ${match.price} (score: ${match.score.toFixed(2)}) [${match.reasons.join(', ')}]`);
            }
        }

        return results;
    } catch (err: any) {
        logger.error(`[OfferScanner] Scan failed: ${err.message}`);
        return [];
    }
}

// ─── Public API ──────────────────────────────────────────

export const offerScanner = {
    /** Start periodic scanning with the given criteria */
    start(criteria: ScanCriteria[]): void {
        activeCriteria = criteria;
        if (scanInterval) clearInterval(scanInterval);

        logger.info(`[OfferScanner] Started with ${criteria.length} criteria set(s), interval ${SCAN_INTERVAL_MS}ms`);

        // Immediate first scan
        executeScan();

        scanInterval = setInterval(executeScan, SCAN_INTERVAL_MS);
    },

    /** Stop periodic scanning */
    stop(): void {
        if (scanInterval) {
            clearInterval(scanInterval);
            scanInterval = null;
        }
        logger.info('[OfferScanner] Stopped');
    },

    /** Add criteria without restarting */
    addCriteria(criteria: ScanCriteria): void {
        activeCriteria.push(criteria);
        logger.info(`[OfferScanner] Added criteria (total: ${activeCriteria.length})`);
    },

    /** Clear all criteria */
    clearCriteria(): void {
        activeCriteria = [];
        logger.info('[OfferScanner] Criteria cleared');
    },

    /** Run a one-shot scan (doesn't require start) */
    async scanOnce(criteria?: ScanCriteria[]): Promise<ScoredOffer[]> {
        if (criteria) activeCriteria = criteria;
        return executeScan();
    },

    /** Get scanner telemetry */
    getStatus() {
        return {
            running: scanInterval !== null,
            criteriaCount: activeCriteria.length,
            totalScans,
            totalMatches,
            lastScanTime,
            intervalMs: SCAN_INTERVAL_MS,
            minScoreThreshold: MIN_SCORE_THRESHOLD,
        };
    },

    /** Get current criteria */
    getCriteria(): ScanCriteria[] {
        return [...activeCriteria];
    },
};
