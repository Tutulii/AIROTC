import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { registerAgentService, getAgentProfile, updateWebhookConfig } from '../services/agent.service';

export const registerAgent = async (req: Request, res: Response): Promise<void> => {
    try {
        const { wallet } = req.body;

        if (!wallet || typeof wallet !== 'string') {
            res.status(400).json({ success: false, error: 'INVALID_WALLET' });
            return;
        }

        const result = await registerAgentService(wallet.trim());
        res.status(200).json(result);

    } catch (e: any) {
        logger.error("error");

        if (e.name === '400') {
            res.status(400).json({ success: false, error: e.message });
            return;
        }

        res.status(500).json({ success: false, error: 'Internal server error while evaluating agent identity bounds' });
    }
};

export const getAgentProfileHandler = async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.params.wallet as string;
        const result = await getAgentProfile(wallet);
        res.status(200).json(result);
    } catch (e: any) {
        if (e.name === '400') {
            res.status(400).json({ error: e.message });
            return;
        }
        if (e.name === '404') {
            res.status(404).json({ error: e.message });
            return;
        }
        res.status(500).json({ error: 'Internal server error resolving agent profile' });
    }
};

export const updateWebhookHandler = async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet;
        if (!wallet) {
            res.status(401).json({ success: false, error: 'Unauthorized: Wallet missing' });
            return;
        }

        const { webhookUrl } = req.body;

        // Allow null to remove webhook, otherwise must be string
        if (webhookUrl !== null && webhookUrl !== undefined && typeof webhookUrl !== 'string') {
            res.status(400).json({ success: false, error: 'webhookUrl must be a string or null' });
            return;
        }

        const result = await updateWebhookConfig(wallet, webhookUrl ?? null);
        res.status(200).json({ success: true, ...result });
    } catch (e: any) {
        if (e.name === '400') {
            res.status(400).json({ success: false, error: e.message });
            return;
        }
        if (e.name === '404') {
            res.status(404).json({ success: false, error: e.message });
            return;
        }
        logger.error("error");
        res.status(500).json({ success: false, error: 'Internal server error updating webhook config' });
    }
};
