import { logger } from '../lib/logger';
import { Request, Response, NextFunction } from 'express';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { verifyAnyMcpToken } from '../services/mcpToken';

// Extend Express Request type
declare global {
    namespace Express {
        interface Request {
            wallet?: string;
            agentId?: string;
            authMethod?: 'wallet_signature' | 'api_key' | 'mcp_delegated_wallet';
        }
    }
}

/**
 * Generate a new API key with prefix for easy identification.
 * Format: mk_<32 random hex chars> = "mk_a1b2c3..."
 * Returns { raw, hash } — raw is shown once, hash is stored in DB.
 */
export function generateApiKey(): { raw: string; hash: string } {
    const raw = `mk_${crypto.randomBytes(24).toString('hex')}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return { raw, hash };
}

/**
 * Hash an API key for lookup.
 */
function hashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
}

const WALLET_AUTH_MAX_AGE_MS = 5 * 60 * 1000;
const MCP_DELEGATION_TOKEN = process.env.AIR_OTC_MCP_DELEGATION_TOKEN || '';

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}

function extractWalletSignaturePayload(req: Request): {
    message?: string;
    signature?: string;
    publicKey?: string;
} {
    const headerMessage = firstHeaderValue(req.headers['x-wallet-auth-message']);
    const headerSignature = firstHeaderValue(req.headers['x-wallet-auth-signature']);
    const headerPublicKey = firstHeaderValue(req.headers['x-wallet-public-key']);

    if (headerMessage && headerSignature && headerPublicKey) {
        return {
            message: headerMessage,
            signature: headerSignature,
            publicKey: headerPublicKey,
        };
    }

    return {
        message: req.body?.message,
        signature: req.body?.signature,
        publicKey: req.body?.publicKey,
    };
}

function isWalletAuthMessageFresh(req: Request, message: string): boolean {
    if (!message.startsWith('AgentOTC WalletAuth ')) {
        return true;
    }

    const parts = message.split(' ');
    if (parts.length < 5) {
        return false;
    }

    const messageMethod = parts[2];
    const messagePath = parts[3];
    const timestamp = Number(parts[4]);

    if (!Number.isFinite(timestamp)) {
        return false;
    }

    const requestPath = req.originalUrl.split('?')[0];
    const withinWindow = Math.abs(Date.now() - timestamp) <= WALLET_AUTH_MAX_AGE_MS;
    return (
        withinWindow &&
        messageMethod.toUpperCase() === req.method.toUpperCase() &&
        messagePath === requestPath
    );
}

function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isValidSolanaWallet(wallet: string): boolean {
    try {
        return bs58.decode(wallet).length === 32;
    } catch {
        return false;
    }
}

async function tryMcpDelegatedWallet(req: Request, res: Response): Promise<boolean> {
    const token = firstHeaderValue(req.headers['x-airotc-mcp-delegation-token']);
    const userToken = firstHeaderValue(req.headers['x-airotc-mcp-user-token']);
    const wallet = firstHeaderValue(req.headers['x-airotc-delegated-wallet']);

    if (!token && !userToken && !wallet) {
        return false;
    }

    if (!wallet || !isValidSolanaWallet(wallet)) {
        res.status(400).json({ success: false, error: 'Invalid MCP delegated wallet' });
        return true;
    }

    if (userToken) {
        try {
            await verifyAnyMcpToken(userToken);
        } catch (error: any) {
            res.status(401).json({ success: false, error: error?.message || 'Invalid MCP user token' });
            return true;
        }
    } else {
        if (!MCP_DELEGATION_TOKEN || !token || !safeEqual(token, MCP_DELEGATION_TOKEN)) {
            res.status(401).json({ success: false, error: 'Invalid MCP delegated wallet token' });
            return true;
        }

    }

    const agent = await prisma.agent.upsert({
        where: { wallet },
        update: {},
        create: { wallet }
    });

    req.wallet = wallet;
    req.agentId = agent.id;
    req.authMethod = 'mcp_delegated_wallet';
    return false;
}

/**
 * Dual Authentication Middleware
 * 
 * Supports TWO auth methods (auto-detected):
 * 
 * 1. API Key (Bearer token) — for OpenClaw, HTTP agents, any REST client
 *    Header: Authorization: Bearer mk_abc123...
 * 
 * 2. Wallet Signature (Ed25519) — for Solana-native agents, SDKs
 *    Body: { message, signature, publicKey }
 * 
 * Either method results in req.wallet and req.agentId being set.
 */
export const authenticateSolana = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const delegatedHandled = await tryMcpDelegatedWallet(req, res);
        if (delegatedHandled) {
            return;
        }
        if (req.authMethod === 'mcp_delegated_wallet') {
            next();
            return;
        }

        // ═══════════════════════════════════════
        // Try API Key first (check Authorization header)
        // ═══════════════════════════════════════
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer mk_')) {
            const apiKey = authHeader.replace('Bearer ', '');
            const keyHash = hashApiKey(apiKey);

            const agent = await prisma.agent.findUnique({
                where: { apiKeyHash: keyHash }
            });

            if (!agent) {
                res.status(401).json({ success: false, error: 'Invalid API key' });
                return;
            }

            req.wallet = agent.wallet;
            req.agentId = agent.id;
            req.authMethod = 'api_key';
            next();
            return;
        }

        // ═══════════════════════════════════════
        // Fallback: Wallet Signature (Ed25519)
        // ═══════════════════════════════════════
        const { message, signature, publicKey } = extractWalletSignaturePayload(req);

        if (!message || !signature || !publicKey) {
            res.status(400).json({
                success: false,
                error: 'Authentication required. Use either: (1) Header "Authorization: Bearer mk_..." or (2) wallet signature auth via headers or request body'
            });
            return;
        }

        if (!isWalletAuthMessageFresh(req, message)) {
            res.status(401).json({
                success: false,
                error: 'Wallet auth message is stale or does not match this request'
            });
            return;
        }

        // Decode base58
        let signatureUint8: Uint8Array;
        let publicKeyUint8: Uint8Array;

        try {
            signatureUint8 = bs58.decode(signature);
            publicKeyUint8 = bs58.decode(publicKey);
        } catch (e) {
            res.status(400).json({ success: false, error: 'Malformed base58 encoding in signature or publicKey' });
            return;
        }

        // Verify Ed25519 signature
        const messageUint8 = new TextEncoder().encode(message);
        const isValid = nacl.sign.detached.verify(messageUint8, signatureUint8, publicKeyUint8);

        if (!isValid) {
            res.status(401).json({ success: false, error: 'Invalid signature' });
            return;
        }

        // Upsert agent
        const agent = await prisma.agent.upsert({
            where: { wallet: publicKey },
            update: {},
            create: { wallet: publicKey }
        });

        req.wallet = publicKey;
        req.agentId = agent.id;
        req.authMethod = 'wallet_signature';

        next();
    } catch (error: any) {
        logger.error("error");
        res.status(500).json({ success: false, error: 'Internal Server Error during verification' });
        return;
    }
};
