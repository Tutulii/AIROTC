import { Router, Request, Response } from 'express';
import { authenticateSolana } from '../middleware/auth';
import {
    createSportOfferFromTemplate,
    deleteStrategyTemplate,
    discoverSportAgents,
    listMySportTrades,
    listStrategyTemplates,
    upsertStrategyTemplate,
} from '../services/sportAgentTools.service';
import {
    acceptSportPosition,
    listMySportPositions,
    listMySportTickets,
    listSportPositions,
    postSportPosition,
} from '../services/sportPosition.service';

const router = Router();

function sendError(res: Response, error: any, fallback: string): void {
    const status = Number(error?.statusCode) || Number(error?.name) || 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({
        success: false,
        error: error?.message || fallback,
    });
}

function requireWallet(req: Request): string {
    if (!req.wallet) {
        throw Object.assign(new Error('wallet_auth_required'), { statusCode: 401 });
    }
    return req.wallet;
}

router.post('/positions', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await postSportPosition(requireWallet(req), {
            fixtureId: req.body?.fixtureId,
            selection: req.body?.selection,
            side: req.body?.side,
            stakeSol: req.body?.stakeSol,
            clientOrderId: req.body?.clientOrderId,
        });
        res.status(data.matched === true ? 201 : 202).json({ success: true, data });
    } catch (error: any) {
        sendError(res, error, 'Failed to post SPORT position');
    }
});

router.post('/positions/:id/accept', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await acceptSportPosition(requireWallet(req), req.params.id, {
            clientOrderId: req.body?.clientOrderId,
        });
        res.status(201).json({ success: true, data });
    } catch (error: any) {
        sendError(res, error, 'Failed to accept SPORT position');
    }
});

router.get('/positions', async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await listSportPositions({
            fixtureId: req.query.fixtureId,
            status: req.query.status,
            limit: req.query.limit,
        });
        res.json({ success: true, data });
    } catch (error: any) {
        sendError(res, error, 'Failed to list SPORT positions');
    }
});

router.get('/positions/:fixtureId', async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await listSportPositions({
            fixtureId: req.params.fixtureId,
            status: req.query.status,
            limit: req.query.limit,
        });
        res.json({ success: true, data });
    } catch (error: any) {
        sendError(res, error, 'Failed to list SPORT positions');
    }
});

router.get('/me/positions', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await listMySportPositions(requireWallet(req), {
            status: req.query.status,
            limit: req.query.limit,
        });
        res.json({ success: true, data });
    } catch (error: any) {
        sendError(res, error, 'Failed to list wallet SPORT positions');
    }
});

router.get('/me/tickets', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await listMySportTickets(requireWallet(req), {
            limit: req.query.limit,
        });
        res.json({ success: true, data });
    } catch (error: any) {
        sendError(res, error, 'Failed to list wallet SPORT tickets');
    }
});

router.get('/me/history', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await listMySportTrades(requireWallet(req), {
            limit: req.query.limit,
            includeLegacy: req.query.includeLegacy,
        });
        res.json({ success: true, data });
    } catch (error: any) {
        sendError(res, error, 'Failed to list SPORT trade history');
    }
});

router.get('/strategy-templates', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await listStrategyTemplates(requireWallet(req));
        res.json({ success: true, data });
    } catch (error: any) {
        sendError(res, error, 'Failed to list SPORT strategy templates');
    }
});

router.put('/strategy-templates/:name', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await upsertStrategyTemplate(requireWallet(req), {
            name: req.params.name,
            description: req.body?.description,
            defaults: req.body?.defaults,
            enabled: req.body?.enabled,
        });
        res.json({ success: true, data });
    } catch (error: any) {
        sendError(res, error, 'Failed to upsert SPORT strategy template');
    }
});

router.delete('/strategy-templates/:name', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await deleteStrategyTemplate(requireWallet(req), req.params.name);
        res.json({ success: true, data });
    } catch (error: any) {
        sendError(res, error, 'Failed to delete SPORT strategy template');
    }
});

router.post('/strategy-templates/:name/offers', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await createSportOfferFromTemplate(requireWallet(req), req.params.name, {
            fixtureId: req.body?.fixtureId,
            overrides: req.body?.overrides,
        });
        res.status(201).json({ success: true, data });
    } catch (error: any) {
        sendError(res, error, 'Failed to create SPORT offer from strategy template');
    }
});

router.get('/agents/discovery', async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await discoverSportAgents({
            limit: req.query.limit,
            fixtureId: req.query.fixtureId,
            marketType: req.query.marketType,
            minSettledPredictions: req.query.minSettledPredictions,
        });
        res.json({ success: true, data });
    } catch (error: any) {
        sendError(res, error, 'Failed to discover SPORT agents');
    }
});

export default router;
