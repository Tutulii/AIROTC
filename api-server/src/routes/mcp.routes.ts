import { Router, Request, Response } from 'express';
import { authenticateSolana } from '../middleware/auth';
import { issueMcpAccessToken } from '../services/mcpAccessToken';

const router = Router();

router.post('/access-token', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        if (!req.wallet) {
            res.status(401).json({ success: false, error: 'wallet_auth_required' });
            return;
        }

        const issued = issueMcpAccessToken({
            wallet: req.wallet,
            scopePreset: req.body?.scopePreset,
            expiresInHours: req.body?.expiresInHours,
        });

        res.status(201).json({
            success: true,
            data: {
                token: issued.token,
                tokenType: 'bearer',
                wallet: issued.wallet,
                scopes: issued.scopes,
                expiresAt: issued.expiresAt,
                expiresInHours: issued.expiresInHours,
                mcpUrl: process.env.AIR_OTC_PUBLIC_MCP_URL || 'https://air-otc-mcp-production.up.railway.app/mcp',
                usage: {
                    authTokenField: 'authToken',
                    note: 'Use this token as the MCP authToken value. It is wallet-bound and should be stored like a secret.',
                },
            },
        });
    } catch (error: any) {
        if (error?.message === 'mcp_access_token_secret_not_configured') {
            res.status(503).json({ success: false, error: error.message });
            return;
        }

        res.status(400).json({
            success: false,
            error: error?.message || 'mcp_access_token_issue_failed',
        });
    }
});

export default router;
