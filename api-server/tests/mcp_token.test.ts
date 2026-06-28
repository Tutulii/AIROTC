import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tokenRows = new Map<string, any>();

vi.mock('../src/lib/prisma', () => ({
    prisma: {
        mcpAccessToken: {
            create: vi.fn(async ({ data }) => {
                const row = { id: `token-${tokenRows.size + 1}`, createdAt: new Date(), ...data };
                tokenRows.set(data.tokenHash, row);
                return row;
            }),
            findUnique: vi.fn(async ({ where }) => tokenRows.get(where.tokenHash) || null),
            update: vi.fn(async ({ where, data }) => {
                for (const [hash, row] of tokenRows.entries()) {
                    if (row.id === where.id) {
                        const updated = { ...row, ...data };
                        tokenRows.set(hash, updated);
                        return updated;
                    }
                }
                return null;
            }),
        },
    },
}));

import {
    buildMcpTokenRequestMessage,
    createMcpOpaqueToken,
    hashMcpAccessToken,
    issueLegacyMcpToken,
    issueMcpToken,
    MCP_FULL_AGENT_SCOPES,
    MCP_READ_ONLY_SCOPES,
    normalizeMcpScopes,
    verifyAnyMcpToken,
    verifyMcpToken,
    verifyMcpTokenRequestSignature,
} from '../src/services/mcpToken';

describe('MCP trade-agent token service', () => {
    const previousSecret = process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET;

    beforeEach(() => {
        tokenRows.clear();
        process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET = 'test_mcp_signing_secret_1234567890';
    });

    afterEach(() => {
        if (previousSecret === undefined) {
            delete process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET;
        } else {
            process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET = previousSecret;
        }
    });

    it('normalizes default full-agent scopes including DM and PER access', () => {
        expect(normalizeMcpScopes(undefined)).toEqual(MCP_FULL_AGENT_SCOPES);
        expect(MCP_FULL_AGENT_SCOPES).toEqual([
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
        expect(MCP_READ_ONLY_SCOPES).toEqual([
            'offers:read',
            'deals:read',
            'dm:read',
            'proofs:read',
            'vault:read',
            'umbra:read',
        ]);
    });

    it('issues and verifies a short opaque token from a fresh wallet signature', async () => {
        const keypair = nacl.sign.keyPair();
        const publicKey = bs58.encode(keypair.publicKey);
        const scopes = normalizeMcpScopes(['offers:read', 'offers:write', 'deals:read', 'dm:read', 'dm:write', 'per:run']);
        const expiresInSeconds = 7 * 24 * 60 * 60;
        const message = buildMcpTokenRequestMessage({
            publicKey,
            scopes,
            expiresInSeconds,
            timestamp: Date.now(),
        });
        const signature = bs58.encode(nacl.sign.detached(Buffer.from(message, 'utf8'), keypair.secretKey));

        expect(() => verifyMcpTokenRequestSignature({
            publicKey,
            message,
            signature,
            scopes,
            expiresInSeconds,
        })).not.toThrow();

        const issued = await issueMcpToken({ publicKey, scopes, expiresInSeconds });
        const verified = await verifyAnyMcpToken(issued.token);

        expect(issued.token).toMatch(/^airotc_sk_/);
        expect(issued.token).toHaveLength(32);
        expect(issued.tokenFormat).toBe('airotc_sk');
        expect(verified.wallet).toBe(publicKey);
        expect(verified.scopes).toEqual(MCP_FULL_AGENT_SCOPES);
        expect(verified.expiresAt).toBeGreaterThan(issued.payload.iat);
    });

    it('upgrades old short-token records to full trade-agent scopes', async () => {
        const token = createMcpOpaqueToken(() => Buffer.alloc(16, 3));
        const tokenHash = hashMcpAccessToken(token);
        tokenRows.set(tokenHash, {
            id: 'old-narrow-token',
            tokenHash,
            tokenPrefix: token.slice(0, 18),
            wallet: bs58.encode(nacl.sign.keyPair().publicKey),
            scopes: JSON.stringify(['offers:read']),
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
        });

        const verified = await verifyAnyMcpToken(token);
        expect(verified.scopes).toEqual(MCP_FULL_AGENT_SCOPES);
    });

    it('rejects expired and revoked short tokens', async () => {
        const token = createMcpOpaqueToken(() => Buffer.alloc(16, 1));
        const tokenHash = hashMcpAccessToken(token);
        tokenRows.set(tokenHash, {
            id: 'expired',
            tokenHash,
            tokenPrefix: token.slice(0, 18),
            wallet: bs58.encode(nacl.sign.keyPair().publicKey),
            scopes: JSON.stringify(['offers:read']),
            expiresAt: new Date(Date.now() - 1000),
            revokedAt: null,
        });
        await expect(verifyAnyMcpToken(token)).rejects.toThrow('MCP token expired');

        const revoked = createMcpOpaqueToken(() => Buffer.alloc(16, 2));
        const revokedHash = hashMcpAccessToken(revoked);
        tokenRows.set(revokedHash, {
            id: 'revoked',
            tokenHash: revokedHash,
            tokenPrefix: revoked.slice(0, 18),
            wallet: bs58.encode(nacl.sign.keyPair().publicKey),
            scopes: JSON.stringify(['offers:read']),
            expiresAt: new Date(Date.now() + 1000),
            revokedAt: new Date(),
        });
        await expect(verifyAnyMcpToken(revoked)).rejects.toThrow('MCP token revoked');
    });

    it('keeps legacy mcp_v1 token compatibility', () => {
        const keypair = nacl.sign.keyPair();
        const publicKey = bs58.encode(keypair.publicKey);
        const scopes = normalizeMcpScopes(['offers:read']);
        const issued = issueLegacyMcpToken({ publicKey, scopes, expiresInSeconds: 60 });
        const verified = verifyMcpToken(issued.token);

        expect(issued.token).toMatch(/^mcp_v1\./);
        expect(verified.sub).toBe(publicKey);
        expect(verified.scopes).toEqual(MCP_FULL_AGENT_SCOPES);

        const [prefix, encodedPayload] = issued.token.split('.');
        const tampered = `${prefix}.${encodedPayload}.invalid_signature`;
        expect(() => verifyMcpToken(tampered)).toThrow('Invalid MCP token signature');
    });
});
