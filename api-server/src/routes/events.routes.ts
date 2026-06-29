import { Router, Request, Response } from 'express';
import { authenticateSolana } from '../middleware/auth';
import { AGENT_EVENT_CATALOG, normalizeAgentEventNames } from '../services/eventCatalog';
import { ackAgentEvent, ackAgentEvents, listAgentEvents } from '../services/agentEventInbox';
import { logger } from '../lib/logger';

const router = Router();

router.get('/v1/events/catalog', (_req: Request, res: Response) => {
    res.json({
        success: true,
        data: {
            events: AGENT_EVENT_CATALOG,
            canonicalFormat: 'dot',
            websocket: {
                event: 'agent.event',
                path: '/socket.io/',
                ack: 'ack_event',
                replay: 'events.replay',
            },
            retentionDays: 7,
        },
    });
});

router.get('/v1/events', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet;
        if (!wallet) {
            res.status(401).json({ success: false, error: 'Wallet auth missing' });
            return;
        }

        const result = await listAgentEvents(wallet, {
            events: req.query.events,
            since: req.query.since,
            cursor: req.query.cursor,
            limit: req.query.limit,
            includeAcked: req.query.includeAcked,
        });

        res.json({ success: true, data: result });
    } catch (error: any) {
        const message = error?.message || 'Failed to list events';
        res.status(message.startsWith('Unsupported event') ? 400 : 500).json({ success: false, error: message });
    }
});

router.post('/v1/events/:id/ack', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet;
        if (!wallet) {
            res.status(401).json({ success: false, error: 'Wallet auth missing' });
            return;
        }

        const eventId = String(req.params.id || '');
        const acked = await ackAgentEvent(wallet, eventId);
        res.json({ success: true, data: { id: eventId, acked } });
    } catch (error: any) {
        logger.warn('agent_event_ack_failed', { id: req.params.id, error: error?.message || 'unknown' });
        res.status(500).json({ success: false, error: 'Failed to ACK event' });
    }
});

router.post('/v1/events/ack', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet;
        if (!wallet) {
            res.status(401).json({ success: false, error: 'Wallet auth missing' });
            return;
        }

        const eventIds = Array.isArray(req.body?.eventIds) ? req.body.eventIds : [];
        const ids = eventIds.filter((id: unknown): id is string => typeof id === 'string');
        const result = await ackAgentEvents(wallet, ids);
        res.json({ success: true, data: result });
    } catch (error: any) {
        logger.warn('agent_events_ack_failed', { error: error?.message || 'unknown' });
        res.status(500).json({ success: false, error: 'Failed to ACK events' });
    }
});

router.post('/v1/events/validate', (_req: Request, res: Response): void => {
    try {
        const events = normalizeAgentEventNames(_req.body?.events);
        res.json({ success: true, data: { events: events ?? AGENT_EVENT_CATALOG.map((item) => item.event) } });
    } catch (error: any) {
        res.status(400).json({ success: false, error: error?.message || 'Invalid events' });
    }
});

export default router;
