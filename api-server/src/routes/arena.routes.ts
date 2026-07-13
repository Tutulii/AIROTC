import { Router, Request, Response, NextFunction } from 'express';
import {
    attachArenaTicket,
    createArenaMatch,
    getArenaMatch,
    getArenaMatchProof,
    getArenaSettlementStatusByTicket,
    settleArenaMatch,
    startArenaMatch,
} from '../services/arena/arenaMatch.service';
import { runSportSettlement } from '../services/arena/sportSettlementEngine';
import { getSportSettlementMonitorStatus } from '../services/transactionMonitor';
import { sweepExpiredSportPositionRefunds } from '../services/sportPosition.service';

const router = Router();

function pathParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] : value || '';
}

function requireArenaAdmin(req: Request, res: Response, next: NextFunction): void {
    const expected = process.env.ARENA_ADMIN_TOKEN || process.env.TXLINE_ADMIN_TOKEN || '';
    if (!expected && process.env.NODE_ENV !== 'production') {
        next();
        return;
    }

    const auth = req.headers.authorization || '';
    const bearerToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    const headerToken = typeof req.headers['x-arena-admin-token'] === 'string'
        ? req.headers['x-arena-admin-token']
        : '';
    const token = bearerToken || headerToken;
    if (!expected || token !== expected) {
        res.status(401).json({ success: false, error: 'arena_admin_auth_required' });
        return;
    }
    next();
}

function sendError(res: Response, error: any, fallback: string): void {
    const status = Number(error?.statusCode) || 500;
    res.status(status).json({ success: false, error: error?.message || fallback });
}

router.post('/v1/arena/matches', requireArenaAdmin, async (req: Request, res: Response) => {
    try {
        const match = await createArenaMatch(req.body || {});
        res.status(201).json({ success: true, data: match });
    } catch (error: any) {
        sendError(res, error, 'Failed to create Arena match');
    }
});

router.get('/v1/arena/matches/:id', async (req: Request, res: Response) => {
    try {
        const match = await getArenaMatch(pathParam(req.params.id));
        res.json({ success: true, data: match });
    } catch (error: any) {
        sendError(res, error, 'Failed to get Arena match');
    }
});

router.get('/v1/arena/tickets/:ticketId/settlement-status', async (req: Request, res: Response) => {
    try {
        const status = await getArenaSettlementStatusByTicket(pathParam(req.params.ticketId));
        res.json({ success: true, data: status });
    } catch (error: any) {
        sendError(res, error, 'Failed to get SPORT settlement status');
    }
});

router.post('/v1/arena/matches/:id/start', requireArenaAdmin, async (req: Request, res: Response) => {
    try {
        const result = await startArenaMatch(pathParam(req.params.id), req.body || {});
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to start Arena match');
    }
});

router.post('/v1/arena/matches/:id/attach-ticket', requireArenaAdmin, async (req: Request, res: Response) => {
    try {
        const result = await attachArenaTicket(pathParam(req.params.id), req.body || {});
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to attach Arena ticket');
    }
});

router.post('/v1/arena/matches/:id/settle', requireArenaAdmin, async (req: Request, res: Response) => {
    try {
        const result = await settleArenaMatch(pathParam(req.params.id), req.body || {});
        res.json({ success: true, data: result });
    } catch (error: any) {
        sendError(res, error, 'Failed to settle Arena match');
    }
});

router.post('/v1/arena/settlement/run', requireArenaAdmin, async (req: Request, res: Response) => {
    try {
        const settlement = await runSportSettlement(req.body || {});
        const expiredPositionRefunds = await sweepExpiredSportPositionRefunds({
            limit: req.body?.limit,
        });
        res.json({
            success: true,
            data: {
                ...settlement,
                expiredPositionRefunds,
            },
        });
    } catch (error: any) {
        sendError(res, error, 'Failed to run SPORT settlement');
    }
});

router.get('/v1/arena/settlement/automation', (_req: Request, res: Response) => {
    res.json({ success: true, data: getSportSettlementMonitorStatus() });
});

router.get('/v1/arena/matches/:id/proof', async (req: Request, res: Response) => {
    try {
        const proof = await getArenaMatchProof(pathParam(req.params.id));
        res.json({ success: true, data: proof });
    } catch (error: any) {
        sendError(res, error, 'Failed to get Arena match proof');
    }
});

export default router;
