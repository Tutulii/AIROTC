import { Router, Request, Response } from 'express';
import {
    buildMcpTokenRequestMessage,
    issueMcpToken,
    mcpTokenSigningSecret,
    normalizeMcpScopes,
    verifyMcpTokenRequestSignature,
} from '../services/mcpToken';

const router = Router();

function clampExpiry(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return 7 * 24 * 60 * 60;
    }
    return Math.min(Math.max(Math.floor(parsed), 60), 30 * 24 * 60 * 60);
}

router.get('/config', (_req: Request, res: Response) => {
    res.json({
        success: true,
        data: {
            tokenFormat: 'mcp_v1',
            tokenIssuerReady: mcpTokenSigningSecret().length >= 16,
            mcpUrl: process.env.AIR_OTC_PUBLIC_MCP_URL || process.env.NEXT_PUBLIC_MCP_URL || '',
            defaultExpiresInSeconds: 7 * 24 * 60 * 60,
        },
    });
});

router.post('/message', (req: Request, res: Response) => {
    const publicKey = String(req.body?.publicKey || '').trim();
    const scopes = normalizeMcpScopes(req.body?.scopes);
    const expiresInSeconds = clampExpiry(req.body?.expiresInSeconds);
    const timestamp = Date.now();

    if (!publicKey) {
        res.status(400).json({ success: false, error: 'publicKey is required' });
        return;
    }

    res.json({
        success: true,
        data: {
            message: buildMcpTokenRequestMessage({ publicKey, scopes, expiresInSeconds, timestamp }),
            scopes,
            expiresInSeconds,
            timestamp,
        },
    });
});

router.post('/token', (req: Request, res: Response) => {
    try {
        const publicKey = String(req.body?.publicKey || '').trim();
        const signature = String(req.body?.signature || '').trim();
        const message = String(req.body?.message || '');
        const scopes = normalizeMcpScopes(req.body?.scopes);
        const expiresInSeconds = clampExpiry(req.body?.expiresInSeconds);

        if (!publicKey || !signature || !message) {
            res.status(400).json({ success: false, error: 'publicKey, message, and signature are required' });
            return;
        }

        verifyMcpTokenRequestSignature({
            publicKey,
            message,
            signature,
            scopes,
            expiresInSeconds,
        });

        const issued = issueMcpToken({ publicKey, scopes, expiresInSeconds });
        res.json({
            success: true,
            data: {
                token: issued.token,
                mcpUrl: process.env.AIR_OTC_PUBLIC_MCP_URL || process.env.NEXT_PUBLIC_MCP_URL || '',
                wallet: issued.payload.sub,
                scopes: issued.payload.scopes,
                issuedAt: issued.payload.iat,
                expiresAt: issued.payload.exp,
                tokenFormat: 'mcp_v1',
            },
        });
    } catch (error: any) {
        const message = error?.message || 'Failed to issue MCP token';
        const status = message.includes('signing secret') ? 503 : 400;
        res.status(status).json({ success: false, error: message });
    }
});

export default router;
