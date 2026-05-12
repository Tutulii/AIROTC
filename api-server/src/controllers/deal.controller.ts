import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { getDealStateService, getDealTransactionsService } from '../services/deal.service';

export const getDeal = async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        const result = await getDealStateService(id);
        res.status(200).json(result);
    } catch (e: any) {
        logger.error("error");

        if (e.name === '400') {
            res.status(400).json({ success: false, error: e.message });
            return;
        }
        if (e.name === '404') {
            res.status(404).json({ success: false, error: e.message });
            return;
        }

        res.status(500).json({ success: false, error: 'Internal server error while resolving deal state' });
    }
};

export const getDealTransactions = async (req: Request, res: Response): Promise<void> => {
    try {
        const id = req.params.id as string;
        const limitParam = req.query.limit ? parseInt(req.query.limit as string) : 1000;
        const beforeParam = req.query.before as string | undefined;

        const result = await getDealTransactionsService(id, limitParam, beforeParam);
        res.status(200).json(result);
    } catch (e: any) {
        logger.error("error");
        if (e.name === '400') { res.status(400).json({ success: false, error: e.message }); return; }
        if (e.name === '404') { res.status(404).json({ success: false, error: e.message }); return; }
        res.status(500).json({ success: false, error: 'Internal server error while retrieving forensic transactions' });
    }
};
