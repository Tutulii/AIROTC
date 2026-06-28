import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import {
    buildMcpTokenRequestMessage,
    issueMcpToken,
    MCP_FULL_AGENT_SCOPES,
    mcpTokenSigningSecret,
    verifyAnyMcpToken,
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

function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function bearerToken(req: Request): string {
    const authorization = String(req.headers.authorization || '').trim();
    if (authorization.toLowerCase().startsWith('bearer ')) {
        return authorization.slice(7).trim();
    }
    const delegated = req.headers['x-airotc-mcp-delegation-token'];
    return Array.isArray(delegated) ? String(delegated[0] || '').trim() : String(delegated || '').trim();
}

function requireInternalMcpAuth(req: Request, res: Response): boolean {
    const expected = process.env.AIR_OTC_MCP_DELEGATION_TOKEN || '';
    const token = bearerToken(req);
    if (!expected || !token || !safeEqual(token, expected)) {
        res.status(401).json({ success: false, error: 'Invalid MCP internal verification token' });
        return false;
    }
    return true;
}

router.get('/config', (_req: Request, res: Response) => {
    res.json({
        success: true,
        data: {
            tokenFormat: 'airotc_sk',
            legacyTokenFormat: 'mcp_v1',
            tokenIssuerReady: true,
            legacyTokenIssuerReady: mcpTokenSigningSecret().length >= 16,
            mcpUrl: process.env.AIR_OTC_PUBLIC_MCP_URL || process.env.NEXT_PUBLIC_MCP_URL || '',
            defaultExpiresInSeconds: 7 * 24 * 60 * 60,
            scopePresets: {
                trade: MCP_FULL_AGENT_SCOPES,
            },
        },
    });
});

router.post('/message', (req: Request, res: Response) => {
    const publicKey = String(req.body?.publicKey || '').trim();
    const scopes = MCP_FULL_AGENT_SCOPES;
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

router.post('/token', async (req: Request, res: Response) => {
    try {
        const publicKey = String(req.body?.publicKey || '').trim();
        const signature = String(req.body?.signature || '').trim();
        const message = String(req.body?.message || '');
        const scopes = MCP_FULL_AGENT_SCOPES;
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

        const issued = await issueMcpToken({ publicKey, scopes, expiresInSeconds });
        res.json({
            success: true,
            data: {
                token: issued.token,
                mcpUrl: process.env.AIR_OTC_PUBLIC_MCP_URL || process.env.NEXT_PUBLIC_MCP_URL || '',
                wallet: issued.payload.sub,
                scopes: issued.payload.scopes,
                issuedAt: issued.payload.iat,
                expiresAt: issued.payload.exp,
                tokenFormat: issued.tokenFormat,
            },
        });
    } catch (error: any) {
        const message = error?.message || 'Failed to issue MCP token';
        const status = message.includes('signing secret') ? 503 : 400;
        res.status(status).json({ success: false, error: message });
    }
});

router.post('/verify', async (req: Request, res: Response) => {
    if (!requireInternalMcpAuth(req, res)) return;
    try {
        const token = String(req.body?.token || '').trim();
        if (!token) {
            res.status(400).json({ success: false, error: 'token is required' });
            return;
        }

        const verified = await verifyAnyMcpToken(token);

        res.json({
            success: true,
            data: {
                wallet: verified.wallet,
                scopes: verified.scopes,
                expiresAt: verified.expiresAt,
                tokenFormat: verified.tokenFormat,
            },
        });
    } catch (error: any) {
        const message = error?.message || 'Invalid MCP token';
        const status = message.includes('expired') ? 401 : message.includes('revoked') ? 403 : 401;
        res.status(status).json({ success: false, error: message });
    }
});

export default router;
