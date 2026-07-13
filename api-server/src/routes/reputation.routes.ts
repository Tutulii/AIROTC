import { Router, Request, Response } from 'express';
import {
    getReputationBatch,
    getReputationLeaderboard,
    getReputationProfile,
} from '../services/reputationProfile.service';
import { logger } from '../lib/logger';

const router = Router();

function parseBoolean(value: unknown, fallback: boolean): boolean {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
    return fallback;
}

function parseLimit(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function handleReputationError(res: Response, error: any, context: Record<string, unknown>): void {
    const status = Number(error?.statusCode) || Number(error?.name) || 500;
    if (status >= 500) {
        logger.error('reputation_request_failed', context, error);
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({
        success: false,
        error: error?.message || 'reputation_request_failed',
    });
}

router.get('/v1/reputation/leaderboard', async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await getReputationLeaderboard({
            includeHistory: false,
            recentLimit: parseLimit(req.query.recentLimit),
            limit: parseLimit(req.query.limit),
            minSettledPredictions: parseLimit(req.query.minSettledPredictions),
        });
        res.json(data);
    } catch (error: any) {
        handleReputationError(res, error, { route: 'leaderboard' });
    }
});

router.post('/v1/reputation/batch', async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await getReputationBatch(req.body?.wallets, {
            includeHistory: parseBoolean(req.body?.includeHistory, false),
            recentLimit: parseLimit(req.body?.recentLimit),
        });
        res.json(data);
    } catch (error: any) {
        handleReputationError(res, error, { route: 'batch' });
    }
});

router.get('/v1/reputation/:wallet', async (req: Request, res: Response): Promise<void> => {
    try {
        const data = await getReputationProfile(String(req.params.wallet || ''), {
            includeHistory: parseBoolean(req.query.includeHistory, true),
            recentLimit: parseLimit(req.query.recentLimit),
        });
        res.json({ success: true, data });
    } catch (error: any) {
        handleReputationError(res, error, { route: 'profile', wallet: req.params.wallet });
    }
});

export default router;
