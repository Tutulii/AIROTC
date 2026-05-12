/**
 * Metrics & Telemetry Routes
 *
 * Exposes platform telemetry for:
 * - Observatory System Logs panel
 * - Grafana / external monitoring
 * - Transaction health alerting
 *
 * All data is derived from the transaction monitor and log ring buffer.
 */

import { Router, Request, Response } from 'express';
import { getMetrics, getRecentAlerts } from '../services/transactionMonitor';
import { logDrain } from '../lib/logger';

const router = Router();

/**
 * @swagger
 * /v1/metrics:
 *   get:
 *     tags: [Health]
 *     summary: Platform telemetry metrics
 *     description: |
 *       Returns a comprehensive snapshot of platform health including:
 *       - Active/total deals, settlement rate
 *       - Stale deal count
 *       - Registered agents, active/total offers
 *       - Memory usage, uptime
 *       - Active alerts
 *     responses:
 *       200:
 *         description: Metrics snapshot
 */
router.get('/', async (req: Request, res: Response) => {
    const metrics = await getMetrics();
    res.json({ success: true, data: metrics });
});

/**
 * @swagger
 * /v1/metrics/alerts:
 *   get:
 *     tags: [Health]
 *     summary: Active alerts
 *     description: Returns recent alerts from transaction monitoring (stale deals, low settlement rate, etc.)
 *     responses:
 *       200:
 *         description: List of alerts
 */
router.get('/alerts', (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const alerts = getRecentAlerts(limit);
    res.json({ success: true, data: alerts });
});

/**
 * @swagger
 * /v1/metrics/logs:
 *   get:
 *     tags: [Health]
 *     summary: Recent structured logs
 *     description: Returns the most recent log entries from the ring buffer. Used by the Observatory System Logs panel.
 *     parameters:
 *       - in: query
 *         name: count
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 200
 *         description: Number of recent logs to return
 *       - in: query
 *         name: level
 *         schema:
 *           type: string
 *           enum: [debug, info, warn, error]
 *         description: Filter by log level
 *     responses:
 *       200:
 *         description: Recent log entries
 */
router.get('/logs', (req: Request, res: Response) => {
    const count = Math.min(parseInt(req.query.count as string) || 50, 200);
    const level = req.query.level as string | undefined;
    let logs = logDrain.getRecent(count);

    if (level && ['debug', 'info', 'warn', 'error'].includes(level)) {
        logs = logs.filter(l => l.level === level);
    }

    res.json({ success: true, data: logs });
});

/**
 * @swagger
 * /v1/metrics/logs/stream:
 *   get:
 *     tags: [Health]
 *     summary: SSE log stream
 *     description: |
 *       Server-Sent Events stream of structured logs in real-time.
 *       Connect with `EventSource('/v1/metrics/logs/stream')` for live Observatory updates.
 *     responses:
 *       200:
 *         description: SSE event stream
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
router.get('/logs/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx proxy compat
    res.flushHeaders();

    // Send recent logs as initial batch
    const recent = logDrain.getRecent(20);
    for (const entry of recent) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    // Subscribe to live entries
    const unsubscribe = logDrain.subscribe((entry) => {
        try {
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
        } catch {
            unsubscribe();
        }
    });

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 15000);

    req.on('close', () => {
        unsubscribe();
        clearInterval(heartbeat);
    });
});

export default router;
