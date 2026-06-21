import crypto from 'crypto';
import { PublicKey } from '@solana/web3.js';

export type McpScope =
    | 'offers:read'
    | 'offers:write'
    | 'deals:read'
    | 'per:run'
    | 'proofs:read'
    | 'vault:read'
    | 'umbra:read'
    | 'policies:read'
    | 'policies:write';

export type McpScopePreset = 'read' | 'trade';

export type McpAccessTokenPayload = {
    v: 1;
    iss: 'air-otc-api';
    aud: 'air-otc-mcp';
    sub: string;
    scopes: McpScope[];
    iat: number;
    exp: number;
    jti: string;
};

export const MCP_ACCESS_TOKEN_PREFIX = 'mcp_v1';
export const MCP_ACCESS_TOKEN_AUDIENCE = 'air-otc-mcp';
export const MCP_ACCESS_TOKEN_ISSUER = 'air-otc-api';
export const MCP_ACCESS_TOKEN_MAX_HOURS = 24 * 30;
export const MCP_ACCESS_TOKEN_DEFAULT_HOURS = 24 * 7;

export const MCP_SCOPE_PRESETS: Record<McpScopePreset, McpScope[]> = {
    read: ['offers:read', 'deals:read', 'proofs:read', 'vault:read', 'umbra:read'],
    trade: ['offers:read', 'offers:write', 'deals:read', 'proofs:read', 'vault:read', 'umbra:read'],
};

function signingSecret(): string {
    return (
        process.env.AIR_OTC_MCP_ACCESS_TOKEN_SECRET ||
        process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET ||
        process.env.AIR_OTC_MCP_DELEGATION_TOKEN ||
        ''
    );
}

export function requireMcpAccessTokenSecret(secret = signingSecret()): string {
    if (!secret || secret.length < 16) {
        throw new Error('mcp_access_token_secret_not_configured');
    }
    return secret;
}

function normalizeWallet(wallet: string): string {
    return new PublicKey(wallet).toBase58();
}

function normalizeExpiresInHours(value: unknown): number {
    const parsed = Number(value ?? MCP_ACCESS_TOKEN_DEFAULT_HOURS);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return MCP_ACCESS_TOKEN_DEFAULT_HOURS;
    }
    return Math.min(Math.ceil(parsed), MCP_ACCESS_TOKEN_MAX_HOURS);
}

function resolvePreset(value: unknown): McpScopePreset {
    return value === 'read' || value === 'trade' ? value : 'trade';
}

function base64UrlEncode(input: Buffer | string): string {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
    return buffer
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Buffer {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    return Buffer.from(padded, 'base64');
}

function sign(unsigned: string, secret: string): string {
    return base64UrlEncode(crypto.createHmac('sha256', secret).update(unsigned).digest());
}

function safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function issueMcpAccessToken(input: {
    wallet: string;
    scopePreset?: unknown;
    expiresInHours?: unknown;
    now?: number;
    secret?: string;
}): {
    token: string;
    wallet: string;
    scopes: McpScope[];
    expiresAt: string;
    expiresInHours: number;
    payload: McpAccessTokenPayload;
} {
    const secret = requireMcpAccessTokenSecret(input.secret);
    const wallet = normalizeWallet(input.wallet);
    const scopePreset = resolvePreset(input.scopePreset);
    const expiresInHours = normalizeExpiresInHours(input.expiresInHours);
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const exp = now + expiresInHours * 60 * 60;
    const payload: McpAccessTokenPayload = {
        v: 1,
        iss: MCP_ACCESS_TOKEN_ISSUER,
        aud: MCP_ACCESS_TOKEN_AUDIENCE,
        sub: wallet,
        scopes: [...MCP_SCOPE_PRESETS[scopePreset]],
        iat: now,
        exp,
        jti: crypto.randomBytes(16).toString('hex'),
    };

    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signature = sign(encodedPayload, secret);

    return {
        token: `${MCP_ACCESS_TOKEN_PREFIX}.${encodedPayload}.${signature}`,
        wallet,
        scopes: payload.scopes,
        expiresAt: new Date(exp * 1000).toISOString(),
        expiresInHours,
        payload,
    };
}

export function verifyMcpAccessToken(
    token: string,
    options: { secret?: string; now?: number } = {}
): McpAccessTokenPayload {
    const secret = requireMcpAccessTokenSecret(options.secret);
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== MCP_ACCESS_TOKEN_PREFIX) {
        throw new Error('mcp_access_token_malformed');
    }

    const [, encodedPayload, signature] = parts;
    const expected = sign(encodedPayload, secret);
    if (!safeEqual(signature, expected)) {
        throw new Error('mcp_access_token_invalid_signature');
    }

    let payload: McpAccessTokenPayload;
    try {
        payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
    } catch {
        throw new Error('mcp_access_token_invalid_payload');
    }

    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (
        payload.v !== 1 ||
        payload.iss !== MCP_ACCESS_TOKEN_ISSUER ||
        payload.aud !== MCP_ACCESS_TOKEN_AUDIENCE ||
        typeof payload.sub !== 'string' ||
        !Array.isArray(payload.scopes) ||
        typeof payload.exp !== 'number' ||
        payload.exp <= now
    ) {
        throw new Error('mcp_access_token_rejected');
    }

    const wallet = normalizeWallet(payload.sub);
    const allowedScopes = new Set<McpScope>([...MCP_SCOPE_PRESETS.read, ...MCP_SCOPE_PRESETS.trade]);
    const scopes = payload.scopes.filter((scope): scope is McpScope => allowedScopes.has(scope as McpScope));
    if (scopes.length === 0 || scopes.length !== payload.scopes.length) {
        throw new Error('mcp_access_token_invalid_scopes');
    }

    return {
        ...payload,
        sub: wallet,
        scopes,
    };
}
