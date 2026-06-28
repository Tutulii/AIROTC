import crypto from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { prisma } from '../lib/prisma';

export type McpScope =
    | 'offers:read'
    | 'offers:write'
    | 'deals:read'
    | 'dm:read'
    | 'dm:write'
    | 'per:run'
    | 'proofs:read'
    | 'vault:read'
    | 'umbra:read';

export interface McpTokenPayload {
    v: 1;
    iss: 'air-otc-api';
    aud: 'air-otc-mcp';
    sub: string;
    scopes: McpScope[];
    iat: number;
    exp: number;
    jti: string;
}

export type McpTokenFormat = 'airotc_sk' | 'mcp_v1';

export interface VerifiedMcpToken {
    wallet: string;
    scopes: McpScope[];
    expiresAt: number;
    tokenFormat: McpTokenFormat;
    tokenId?: string;
}

export const MCP_FULL_AGENT_SCOPES: McpScope[] = [
    'offers:read',
    'offers:write',
    'deals:read',
    'dm:read',
    'dm:write',
    'per:run',
    'proofs:read',
    'vault:read',
    'umbra:read',
];

export const MCP_READ_ONLY_SCOPES: McpScope[] = [
    'offers:read',
    'deals:read',
    'dm:read',
    'proofs:read',
    'vault:read',
    'umbra:read',
];

export const MCP_DEFAULT_SCOPES = MCP_FULL_AGENT_SCOPES;
export const MCP_SHORT_TOKEN_PREFIX = 'airotc_sk_';

const VALID_SCOPES = new Set<McpScope>(MCP_FULL_AGENT_SCOPES);
const MAX_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000;

export function mcpTokenSigningSecret(): string {
    return (
        process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET ||
        process.env.AIR_OTC_MCP_DELEGATION_TOKEN ||
        process.env.AIR_OTC_MCP_TOKEN ||
        ''
    );
}

function base64UrlEncode(input: Buffer | string): string {
    return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): Buffer {
    return Buffer.from(input, 'base64url');
}

function signPayload(encodedPayload: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function clampExpirySeconds(value: number): number {
    return Math.min(Math.max(Math.floor(value), 60), MAX_EXPIRY_SECONDS);
}

function parseScopeItems(scopes: string | string[]): string[] {
    if (Array.isArray(scopes)) return scopes;
    return scopes.split(/[\s,]+/);
}

export function normalizeMcpScopes(scopes: unknown): McpScope[] {
    if (!Array.isArray(scopes) && typeof scopes !== 'string') {
        return [...MCP_DEFAULT_SCOPES];
    }
    const normalized = parseScopeItems(scopes)
        .filter((scope): scope is string => typeof scope === 'string')
        .map((scope) => scope.trim())
        .filter((scope): scope is McpScope => VALID_SCOPES.has(scope as McpScope));
    return normalized.length > 0 ? Array.from(new Set(normalized)) : [...MCP_DEFAULT_SCOPES];
}

export function fullMcpAgentScopes(): McpScope[] {
    return [...MCP_FULL_AGENT_SCOPES];
}

export function buildMcpTokenRequestMessage(params: {
    publicKey: string;
    scopes: McpScope[];
    expiresInSeconds: number;
    timestamp: number;
}): string {
    return [
        'AIR OTC MCP token request',
        `wallet:${params.publicKey}`,
        `scopes:${params.scopes.join(',')}`,
        `expiresInSeconds:${params.expiresInSeconds}`,
        `timestamp:${params.timestamp}`,
    ].join('\n');
}

export function verifyMcpTokenRequestSignature(params: {
    publicKey: string;
    message: string;
    signature: string;
    scopes: McpScope[];
    expiresInSeconds: number;
}): void {
    if (!params.message.startsWith('AIR OTC MCP token request\n')) {
        throw new Error('Invalid MCP token request message');
    }
    if (!params.message.includes(`wallet:${params.publicKey}`)) {
        throw new Error('MCP token request wallet mismatch');
    }
    if (!params.message.includes(`scopes:${params.scopes.join(',')}`)) {
        throw new Error('MCP token request scope mismatch');
    }
    if (!params.message.includes(`expiresInSeconds:${params.expiresInSeconds}`)) {
        throw new Error('MCP token request expiry mismatch');
    }

    const timestampMatch = params.message.match(/^timestamp:(\d+)$/m);
    const timestamp = timestampMatch ? Number(timestampMatch[1]) : NaN;
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > MAX_MESSAGE_AGE_MS) {
        throw new Error('MCP token request message is stale');
    }

    let publicKeyBytes: Uint8Array;
    let signatureBytes: Uint8Array;
    try {
        publicKeyBytes = bs58.decode(params.publicKey);
        signatureBytes = bs58.decode(params.signature);
    } catch {
        throw new Error('Malformed MCP token request signature or public key');
    }

    if (publicKeyBytes.length !== 32) {
        throw new Error('Invalid Solana public key');
    }

    const ok = nacl.sign.detached.verify(
        Buffer.from(params.message, 'utf8'),
        signatureBytes,
        publicKeyBytes,
    );
    if (!ok) {
        throw new Error('Invalid MCP token request signature');
    }
}

export function createMcpOpaqueToken(randomBytes: (size: number) => Buffer = crypto.randomBytes): string {
    return `${MCP_SHORT_TOKEN_PREFIX}${randomBytes(16).toString('base64url')}`;
}

export function hashMcpAccessToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function issueMcpToken(params: {
    publicKey: string;
    scopes: McpScope[];
    expiresInSeconds: number;
}): Promise<{ token: string; payload: McpTokenPayload; tokenFormat: 'airotc_sk' }> {
    const scopes = fullMcpAgentScopes();
    const expiresInSeconds = clampExpirySeconds(params.expiresInSeconds);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((now + expiresInSeconds) * 1000);
    const token = createMcpOpaqueToken();
    const tokenHash = hashMcpAccessToken(token);

    const record = await prisma.mcpAccessToken.create({
        data: {
            tokenHash,
            tokenPrefix: token.slice(0, 18),
            wallet: params.publicKey,
            scopes: JSON.stringify(scopes),
            expiresAt,
        },
    });

    return {
        token,
        tokenFormat: 'airotc_sk',
        payload: {
            v: 1,
            iss: 'air-otc-api',
            aud: 'air-otc-mcp',
            sub: params.publicKey,
            scopes,
            iat: now,
            exp: Math.floor(expiresAt.getTime() / 1000),
            jti: record.id,
        },
    };
}

export function issueLegacyMcpToken(params: {
    publicKey: string;
    scopes: McpScope[];
    expiresInSeconds: number;
}): { token: string; payload: McpTokenPayload; tokenFormat: 'mcp_v1' } {
    const secret = mcpTokenSigningSecret();
    if (!secret || secret.length < 16) {
        throw new Error('MCP token signing secret is not configured');
    }

    const expiresInSeconds = clampExpirySeconds(params.expiresInSeconds);
    const now = Math.floor(Date.now() / 1000);
    const payload: McpTokenPayload = {
        v: 1,
        iss: 'air-otc-api',
        aud: 'air-otc-mcp',
        sub: params.publicKey,
        scopes: fullMcpAgentScopes(),
        iat: now,
        exp: now + expiresInSeconds,
        jti: crypto.randomBytes(16).toString('hex'),
    };

    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signature = signPayload(encodedPayload, secret);
    return {
        token: `mcp_v1.${encodedPayload}.${signature}`,
        payload,
        tokenFormat: 'mcp_v1',
    };
}

export function verifyMcpToken(token: string): McpTokenPayload {
    const secret = mcpTokenSigningSecret();
    if (!secret || secret.length < 16) {
        throw new Error('MCP token signing secret is not configured');
    }

    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'mcp_v1') {
        throw new Error('Invalid MCP token format');
    }

    const [, encodedPayload, signature] = parts;
    const expected = signPayload(encodedPayload, secret);
    if (!safeEqual(signature, expected)) {
        throw new Error('Invalid MCP token signature');
    }

    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as McpTokenPayload;
    const now = Math.floor(Date.now() / 1000);
    if (payload.v !== 1 || payload.iss !== 'air-otc-api' || payload.aud !== 'air-otc-mcp') {
        throw new Error('Invalid MCP token claims');
    }
    if (!payload.sub || !Array.isArray(payload.scopes) || payload.exp <= now) {
        throw new Error('Expired or malformed MCP token');
    }
    payload.scopes = fullMcpAgentScopes();
    return payload;
}

export async function verifyOpaqueMcpToken(token: string): Promise<VerifiedMcpToken> {
    if (!token.startsWith(MCP_SHORT_TOKEN_PREFIX)) {
        throw new Error('Invalid MCP token format');
    }

    const tokenHash = hashMcpAccessToken(token);
    const record = await prisma.mcpAccessToken.findUnique({ where: { tokenHash } });
    if (!record) {
        throw new Error('Invalid MCP token');
    }
    if (record.revokedAt) {
        throw new Error('MCP token revoked');
    }
    const now = new Date();
    if (record.expiresAt <= now) {
        throw new Error('MCP token expired');
    }

    await prisma.mcpAccessToken
        .update({
            where: { id: record.id },
            data: { lastUsedAt: now },
        })
        .catch(() => undefined);

    return {
        wallet: record.wallet,
        scopes: fullMcpAgentScopes(),
        expiresAt: Math.floor(record.expiresAt.getTime() / 1000),
        tokenFormat: 'airotc_sk',
        tokenId: record.id,
    };
}

export async function verifyAnyMcpToken(token: string): Promise<VerifiedMcpToken> {
    if (token.startsWith(MCP_SHORT_TOKEN_PREFIX)) {
        return verifyOpaqueMcpToken(token);
    }
    const payload = verifyMcpToken(token);
    return {
        wallet: payload.sub,
        scopes: payload.scopes,
        expiresAt: payload.exp,
        tokenFormat: 'mcp_v1',
        tokenId: payload.jti,
    };
}
