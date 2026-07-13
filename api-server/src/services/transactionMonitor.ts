/**
 * Transaction Monitor — Alerts on stuck, failed, or anomalous deals.
 *
 * Runs a periodic sweep of active deals and emits alerts when:
 * - A deal has been in "negotiating" state for > STALE_THRESHOLD_MS
 * - Settlement rate drops below SETTLEMENT_RATE_ALERT_THRESHOLD
 * - Hourly deal volume exceeds VOLUME_SPIKE_MULTIPLIER × average
 *
 * All alerts are pushed to the structured log ring buffer with severity levels,
 * making them visible in the Observatory System Logs panel in real-time.
 */

import { prisma } from '../lib/prisma';
import { logger, logDrain, type AlertSeverity } from '../lib/logger';
import { SUCCESSFUL_TICKET_STATUSES } from './ticketStatusPolicy';
import { runSportSettlement } from './arena/sportSettlementEngine';
import { sweepExpiredSportPositionRefunds } from './sportPosition.service';

// ═══════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════

const MONITOR_INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || '60000', 10);  // 1 min
const STALE_DEAL_THRESHOLD_MS = parseInt(process.env.STALE_DEAL_THRESHOLD_MS || '3600000', 10); // 1 hour
const STALE_NEGOTIATION_CANCEL_MS = parseInt(process.env.STALE_NEGOTIATION_CANCEL_MS || '86400000', 10); // 24 hours
const STALE_NEGOTIATION_AUTO_CANCEL =
    (process.env.STALE_NEGOTIATION_AUTO_CANCEL || 'true').toLowerCase() !== 'false';
const SETTLEMENT_RATE_ALERT = parseFloat(process.env.SETTLEMENT_RATE_ALERT || '0.7'); // 70%
const SPORT_SETTLEMENT_MONITOR_ENABLED =
    (process.env.SPORT_SETTLEMENT_MONITOR_ENABLED || 'true').toLowerCase() !== 'false';
const SPORT_SETTLEMENT_INTERVAL_MS = Math.max(
    parseInt(process.env.SPORT_SETTLEMENT_INTERVAL_MS || '120000', 10),
    30_000
);
const SPORT_SETTLEMENT_MONITOR_LIMIT = Math.min(
    Math.max(parseInt(process.env.SPORT_SETTLEMENT_MONITOR_LIMIT || '25', 10), 1),
    100
);

// ═══════════════════════════════════════════════════════
// METRICS STORE (in-memory, reset on restart)
// ═══════════════════════════════════════════════════════

interface MetricsSnapshot {
    timestamp: number;
    activeDeals: number;
    staleDeals: number;
    totalDeals: number;
    completedDeals: number;
    cancelledDeals: number;
    settlementRate: number;
    registeredAgents: number;
    offersActive: number;
    offersTotal: number;
    messagesTotal: number;
    uptime: number;
    memoryMB: number;
    alerts: Array<{ severity: AlertSeverity; message: string; timestamp: number }>;
}

let latestMetrics: MetricsSnapshot | null = null;
let monitorInterval: ReturnType<typeof setInterval> | null = null;
let sportSettlementInterval: ReturnType<typeof setInterval> | null = null;
let latestSportSettlementRun: {
    running: boolean;
    lastRunAt: string | null;
    lastDurationMs: number | null;
    lastResult: Record<string, unknown> | null;
    lastError: string | null;
} = {
    running: false,
    lastRunAt: null,
    lastDurationMs: null,
    lastResult: null,
    lastError: null,
};
const startTime = Date.now();

export async function cancelStaleNegotiationTickets(now: number = Date.now()): Promise<number> {
    if (!STALE_NEGOTIATION_AUTO_CANCEL || STALE_NEGOTIATION_CANCEL_MS <= 0) {
        return 0;
    }

    const cutoff = new Date(now - STALE_NEGOTIATION_CANCEL_MS);
    const candidates = await prisma.ticket.findMany({
        where: {
            status: 'negotiating',
            createdAt: { lt: cutoff },
        },
        select: {
            id: true,
            offerId: true,
            createdAt: true,
            messages: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { createdAt: true },
            },
        },
    });

    let cancelled = 0;
    for (const ticket of candidates) {
        const lastActivity = ticket.messages[0]?.createdAt || ticket.createdAt;
        if (lastActivity >= cutoff) {
            continue;
        }

        const [ticketUpdate] = await prisma.$transaction([
            prisma.ticket.updateMany({
                where: { id: ticket.id, status: 'negotiating' },
                data: { status: 'cancelled' },
            }),
            prisma.offer.updateMany({
                where: { id: ticket.offerId, status: 'matched' },
                data: { status: 'cancelled' },
            }),
        ]);

        if (ticketUpdate.count > 0) {
            cancelled += ticketUpdate.count;
            logger.warn('stale_negotiation_auto_cancelled', {
                ticketId: ticket.id,
                offerId: ticket.offerId,
                lastActivity: lastActivity.toISOString(),
                cutoff: cutoff.toISOString(),
            });
        }
    }

    return cancelled;
}

// ═══════════════════════════════════════════════════════
// CORE SWEEP
// ═══════════════════════════════════════════════════════

async function sweep(): Promise<MetricsSnapshot> {
    const now = Date.now();
    const alerts: MetricsSnapshot['alerts'] = [];

    try {
        const autoCancelledStaleDeals = await cancelStaleNegotiationTickets(now);

        // ── Parallel DB queries ──
        const [
            activeDeals,
            totalDeals,
            completedDeals,
            cancelledDeals,
            registeredAgents,
            offersActive,
            offersTotal,
            messagesTotal,
            staleDeals,
        ] = await Promise.all([
            prisma.ticket.count({ where: { status: 'negotiating' } }),
            prisma.ticket.count(),
            prisma.ticket.count({ where: { status: { in: [...SUCCESSFUL_TICKET_STATUSES] } } }),
            prisma.ticket.count({ where: { status: 'cancelled' } }),
            prisma.agent.count(),
            prisma.offer.count({ where: { status: 'active' } }),
            prisma.offer.count(),
            prisma.message.count(),
            prisma.ticket.count({
                where: {
                    status: 'negotiating',
                    createdAt: { lt: new Date(now - STALE_DEAL_THRESHOLD_MS) },
                },
            }),
        ]);

        const settlementRate = totalDeals > 0 ? completedDeals / totalDeals : 1;

        // ── Alert: Stale deals ──
        if (staleDeals > 0) {
            const msg = `${staleDeals} deal(s) stuck in negotiating for > ${STALE_DEAL_THRESHOLD_MS / 60000}min`;
            alerts.push({ severity: 'warning', message: msg, timestamp: now });
            logger.warn('stale_deals_detected', { staleDeals, severity: 'warning' as AlertSeverity });
        }

        if (autoCancelledStaleDeals > 0) {
            const msg = `${autoCancelledStaleDeals} stale negotiation ticket(s) auto-cancelled after ${STALE_NEGOTIATION_CANCEL_MS / 60000}min without activity`;
            alerts.push({ severity: 'warning', message: msg, timestamp: now });
            logger.warn('stale_negotiations_auto_cancelled', {
                count: autoCancelledStaleDeals,
                timeout_ms: STALE_NEGOTIATION_CANCEL_MS,
                severity: 'warning' as AlertSeverity,
            });
        }

        // ── Alert: Low settlement rate ──
        if (totalDeals >= 5 && settlementRate < SETTLEMENT_RATE_ALERT) {
            const pct = (settlementRate * 100).toFixed(1);
            const msg = `Settlement rate dropped to ${pct}% (threshold: ${SETTLEMENT_RATE_ALERT * 100}%)`;
            alerts.push({ severity: 'critical', message: msg, timestamp: now });
            logger.warn('low_settlement_rate', { settlementRate, threshold: SETTLEMENT_RATE_ALERT, severity: 'critical' as AlertSeverity });
        }

        const mem = process.memoryUsage();

        const snapshot: MetricsSnapshot = {
            timestamp: now,
            activeDeals,
            staleDeals,
            totalDeals,
            completedDeals,
            cancelledDeals,
            settlementRate,
            registeredAgents,
            offersActive,
            offersTotal,
            messagesTotal,
            uptime: Math.floor((now - startTime) / 1000),
            memoryMB: Math.round(mem.heapUsed / 1024 / 1024),
            alerts,
        };

        latestMetrics = snapshot;

        logger.debug('metrics_sweep_complete', {
            activeDeals,
            staleDeals,
            settlementRate: settlementRate.toFixed(3),
            memoryMB: snapshot.memoryMB,
        });

        return snapshot;
    } catch (err) {
        logger.error('metrics_sweep_failed', {}, err);
        return latestMetrics || {
            timestamp: now, activeDeals: 0, staleDeals: 0, totalDeals: 0,
            completedDeals: 0, cancelledDeals: 0, settlementRate: 0,
            registeredAgents: 0, offersActive: 0, offersTotal: 0,
            messagesTotal: 0, uptime: Math.floor((now - startTime) / 1000),
            memoryMB: 0, alerts: [],
        };
    }
}

export async function sweepSportSettlement(): Promise<Record<string, unknown>> {
    if (!SPORT_SETTLEMENT_MONITOR_ENABLED) {
        latestSportSettlementRun = {
            running: false,
            lastRunAt: new Date().toISOString(),
            lastDurationMs: 0,
            lastResult: {
                mode: 'SPORT',
                skipped: true,
                reason: 'sport_settlement_monitor_disabled',
            },
            lastError: null,
        };
        return {
            mode: 'SPORT',
            skipped: true,
            reason: 'sport_settlement_monitor_disabled',
        };
    }

    const startedAt = Date.now();
    latestSportSettlementRun = {
        ...latestSportSettlementRun,
        running: true,
        lastRunAt: new Date(startedAt).toISOString(),
        lastError: null,
    };

    try {
        const sportSettlement = await runSportSettlement({
            limit: SPORT_SETTLEMENT_MONITOR_LIMIT,
            refreshOutcomes: true,
        });
        const expiredPositionRefunds = await sweepExpiredSportPositionRefunds({
            limit: SPORT_SETTLEMENT_MONITOR_LIMIT,
        });
        const sportMonitorResult = {
            ...sportSettlement,
            expiredPositionRefunds,
        };
        latestSportSettlementRun = {
            running: false,
            lastRunAt: new Date(startedAt).toISOString(),
            lastDurationMs: Date.now() - startedAt,
            lastResult: sportMonitorResult,
            lastError: null,
        };
        if (
            (sportSettlement as any).settledCount > 0
            || (sportSettlement as any).skippedCount > 0
            || (expiredPositionRefunds as any).refundedCount > 0
            || (expiredPositionRefunds as any).skippedCount > 0
        ) {
            logger.info('sport_settlement_monitor_sweep', {
                scanned: (sportSettlement as any).scanned,
                settledCount: (sportSettlement as any).settledCount,
                skippedCount: (sportSettlement as any).skippedCount,
                expiredRefundedCount: (expiredPositionRefunds as any).refundedCount,
                expiredRefundSkippedCount: (expiredPositionRefunds as any).skippedCount,
                skippedReasons: summarizeSportSettlementSkips(sportSettlement),
            });
        }
        return sportMonitorResult;
    } catch (error: any) {
        latestSportSettlementRun = {
            running: false,
            lastRunAt: new Date(startedAt).toISOString(),
            lastDurationMs: Date.now() - startedAt,
            lastResult: null,
            lastError: error?.message || 'sport_settlement_monitor_failed',
        };
        logger.warn('sport_settlement_monitor_failed', { error: error?.message });
        return {
            mode: 'SPORT',
            success: false,
            error: error?.message || 'sport_settlement_monitor_failed',
        };
    }
}

function summarizeSportSettlementSkips(sportSettlement: Record<string, unknown>): Record<string, number> {
    const skipped = Array.isArray((sportSettlement as any).skipped) ? (sportSettlement as any).skipped : [];
    return skipped.reduce((summary: Record<string, number>, item: any) => {
        const reason = typeof item?.reason === 'string' && item.reason.trim()
            ? item.reason.trim()
            : 'unknown';
        summary[reason] = (summary[reason] || 0) + 1;
        return summary;
    }, {});
}

// ═══════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════

/** Start the background monitor loop. Safe to call multiple times. */
export function startTransactionMonitor(): void {
    if (monitorInterval) return;
    logger.info('transaction_monitor_started', { interval_ms: MONITOR_INTERVAL_MS });
    sweep(); // Initial sweep
    monitorInterval = setInterval(sweep, MONITOR_INTERVAL_MS);

    if (SPORT_SETTLEMENT_MONITOR_ENABLED && !sportSettlementInterval) {
        logger.info('sport_settlement_monitor_started', { interval_ms: SPORT_SETTLEMENT_INTERVAL_MS });
        sweepSportSettlement();
        sportSettlementInterval = setInterval(sweepSportSettlement, SPORT_SETTLEMENT_INTERVAL_MS);
    }
}

/** Stop the monitor (for graceful shutdown). */
export function stopTransactionMonitor(): void {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
    if (sportSettlementInterval) {
        clearInterval(sportSettlementInterval);
        sportSettlementInterval = null;
    }
}

/** Get the latest metrics snapshot. Forces a fresh sweep if stale or missing. */
export async function getMetrics(): Promise<MetricsSnapshot> {
    if (!latestMetrics || Date.now() - latestMetrics.timestamp > MONITOR_INTERVAL_MS * 2) {
        return sweep();
    }
    return latestMetrics;
}

export function getSportSettlementMonitorStatus(): Record<string, unknown> {
    return {
        mode: 'SPORT',
        enabled: SPORT_SETTLEMENT_MONITOR_ENABLED,
        intervalMs: SPORT_SETTLEMENT_INTERVAL_MS,
        limit: SPORT_SETTLEMENT_MONITOR_LIMIT,
        running: Boolean(sportSettlementInterval),
        activeRun: latestSportSettlementRun.running,
        lastRunAt: latestSportSettlementRun.lastRunAt,
        lastDurationMs: latestSportSettlementRun.lastDurationMs,
        lastError: latestSportSettlementRun.lastError,
        lastResult: latestSportSettlementRun.lastResult,
        setAndForget: SPORT_SETTLEMENT_MONITOR_ENABLED,
        note: SPORT_SETTLEMENT_MONITOR_ENABLED
            ? 'SPORT settlement sweeps automatically on the API server; admin run_once is only a manual rescue path.'
            : 'SPORT settlement automation is disabled by SPORT_SETTLEMENT_MONITOR_ENABLED=false.',
    };
}

/** Get recent alerts from the log ring buffer. */
export function getRecentAlerts(limit: number = 50) {
    return logDrain.getAlerts().slice(-limit);
}
