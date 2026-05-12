/**
 * Telemetry Service — Agent Performance Metrics
 *
 * Tracks:
 * - Deals/hour (1h sliding window)
 * - Avg settlement time (running average)
 * - Failure rate (failed / total)
 * - Active deal count
 * - Uptime
 *
 * All metrics are in-memory with periodic DB snapshots.
 */

import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";

// ==========================================
// TYPES
// ==========================================

export interface TelemetrySnapshot {
    dealsPerHour: number;
    avgSettlementTimeSec: number;
    failureRate: number;
    activeDeals: number;
    totalDealsAllTime: number;
    completedDeals: number;
    failedDeals: number;
    uptimeSeconds: number;
    lastUpdated: number;
}

// ==========================================
// SLIDING WINDOW COUNTER
// ==========================================

class SlidingWindowCounter {
    private timestamps: number[] = [];
    private windowMs: number;

    constructor(windowMs: number) {
        this.windowMs = windowMs;
    }

    record(): void {
        this.timestamps.push(Date.now());
        this.prune();
    }

    count(): number {
        this.prune();
        return this.timestamps.length;
    }

    private prune(): void {
        const cutoff = Date.now() - this.windowMs;
        while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
            this.timestamps.shift();
        }
    }
}

// ==========================================
// TELEMETRY ENGINE
// ==========================================

class TelemetryService {
    private dealsWindow = new SlidingWindowCounter(60 * 60 * 1000); // 1 hour
    private settlementTimes: number[] = [];
    private completedCount = 0;
    private failedCount = 0;
    private startTime = Date.now();

    /**
     * Record a new deal entering the system.
     */
    recordDealCreated(): void {
        this.dealsWindow.record();
        logger.debug("telemetry_deal_recorded");
    }

    /**
     * Record a deal reaching completion with settlement duration.
     */
    recordDealCompleted(settlementTimeSec: number): void {
        this.completedCount++;
        this.settlementTimes.push(settlementTimeSec);
        // Keep only last 1000 samples for memory safety
        if (this.settlementTimes.length > 1000) {
            this.settlementTimes = this.settlementTimes.slice(-500);
        }
        logger.info("telemetry_deal_completed", { settlement_time_sec: settlementTimeSec });
    }

    /**
     * Record a deal failure (cancelled, timed out, refunded).
     */
    recordDealFailed(): void {
        this.failedCount++;
        logger.info("telemetry_deal_failed");
    }

    /**
     * Get current telemetry snapshot.
     */
    async getSnapshot(): Promise<TelemetrySnapshot> {
        let activeDeals = 0;
        let totalDeals = 0;

        try {
            [activeDeals, totalDeals] = await Promise.all([
                prisma.deal.count({
                    where: { status: { notIn: ["completed", "agreed", "cancelled", "refunded"] } },
                }),
                prisma.deal.count(),
            ]);
        } catch (e) {
            logger.warn("telemetry_db_query_failed", {}, e);
        }

        const totalRecorded = this.completedCount + this.failedCount;
        const avgSettlement =
            this.settlementTimes.length > 0
                ? this.settlementTimes.reduce((a, b) => a + b, 0) / this.settlementTimes.length
                : 0;

        return {
            dealsPerHour: this.dealsWindow.count(),
            avgSettlementTimeSec: Math.round(avgSettlement * 100) / 100,
            failureRate: totalRecorded > 0 ? Math.round((this.failedCount / totalRecorded) * 10000) / 100 : 0,
            activeDeals,
            totalDealsAllTime: totalDeals,
            completedDeals: this.completedCount,
            failedDeals: this.failedCount,
            uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
            lastUpdated: Date.now(),
        };
    }
}

export const telemetryService = new TelemetryService();
