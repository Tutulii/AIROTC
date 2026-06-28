import crypto from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

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

export const MCP_DEFAULT_SCOPES: McpScope[] = [
    'offers:read',
    'offers:write',
    'deals:read',
    'dm:read',
    'dm:write',
    'proofs:read',
    'vault:read',
    'umbra:read',
];

const VALID_SCOPES = new Set<McpScope>([
    'offers:read',
    'offers:write',
    'deals:read',
    'dm:read',
    'dm:write',
    'per:run',
    'proofs:read',
    'vault:read',
    'umbra:read',
]);

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

export function normalizeMcpScopes(scopes: unknown): McpScope[] {
    if (!Array.isArray(scopes)) {
        return [...MCP_DEFAULT_SCOPES];
    }
    const normalized = scopes
        .filter((scope): scope is string => typeof scope === 'string')
        .map((scope) => scope.trim())
        .filter((scope): scope is McpScope => VALID_SCOPES.has(scope as McpScope));
    return normalized.length > 0 ? Array.from(new Set(normalized)) : [...MCP_DEFAULT_SCOPES];
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

export function issueMcpToken(params: {
    publicKey: string;
    scopes: McpScope[];
    expiresInSeconds: number;
}): { token: string; payload: McpTokenPayload } {
    const secret = mcpTokenSigningSecret();
    if (!secret || secret.length < 16) {
        throw new Error('MCP token signing secret is not configured');
    }

    const expiresInSeconds = Math.min(
        Math.max(Math.floor(params.expiresInSeconds), 60),
        MAX_EXPIRY_SECONDS,
    );
    const now = Math.floor(Date.now() / 1000);
    const payload: McpTokenPayload = {
        v: 1,
        iss: 'air-otc-api',
        aud: 'air-otc-mcp',
        sub: params.publicKey,
        scopes: params.scopes,
        iat: now,
        exp: now + expiresInSeconds,
        jti: crypto.randomBytes(16).toString('hex'),
    };

    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signature = signPayload(encodedPayload, secret);
    return {
        token: `mcp_v1.${encodedPayload}.${signature}`,
        payload,
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
    payload.scopes = normalizeMcpScopes(payload.scopes);
    return payload;
}
