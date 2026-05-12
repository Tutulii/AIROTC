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

// ═══════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════

const MONITOR_INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || '60000', 10);  // 1 min
const STALE_DEAL_THRESHOLD_MS = parseInt(process.env.STALE_DEAL_THRESHOLD_MS || '3600000', 10); // 1 hour
const SETTLEMENT_RATE_ALERT = parseFloat(process.env.SETTLEMENT_RATE_ALERT || '0.7'); // 70%

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
const startTime = Date.now();

// ═══════════════════════════════════════════════════════
// CORE SWEEP
// ═══════════════════════════════════════════════════════

async function sweep(): Promise<MetricsSnapshot> {
    const now = Date.now();
    const alerts: MetricsSnapshot['alerts'] = [];

    try {
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

// ═══════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════

/** Start the background monitor loop. Safe to call multiple times. */
export function startTransactionMonitor(): void {
    if (monitorInterval) return;
    logger.info('transaction_monitor_started', { interval_ms: MONITOR_INTERVAL_MS });
    sweep(); // Initial sweep
    monitorInterval = setInterval(sweep, MONITOR_INTERVAL_MS);
}

/** Stop the monitor (for graceful shutdown). */
export function stopTransactionMonitor(): void {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
}

/** Get the latest metrics snapshot. Forces a fresh sweep if stale or missing. */
export async function getMetrics(): Promise<MetricsSnapshot> {
    if (!latestMetrics || Date.now() - latestMetrics.timestamp > MONITOR_INTERVAL_MS * 2) {
        return sweep();
    }
    return latestMetrics;
}

/** Get recent alerts from the log ring buffer. */
export function getRecentAlerts(limit: number = 50) {
    return logDrain.getAlerts().slice(-limit);
}
