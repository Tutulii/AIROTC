import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    buildMcpTokenRequestMessage,
    issueMcpToken,
    normalizeMcpScopes,
    verifyMcpToken,
    verifyMcpTokenRequestSignature,
} from '../src/services/mcpToken';

describe('MCP wallet-bound token service', () => {
    const previousSecret = process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET;

    beforeEach(() => {
        process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET = 'test_mcp_signing_secret_1234567890';
    });

    afterEach(() => {
        if (previousSecret === undefined) {
            delete process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET;
        } else {
            process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET = previousSecret;
        }
    });

    it('issues and verifies a token from a fresh wallet signature', () => {
        const keypair = nacl.sign.keyPair();
        const publicKey = bs58.encode(keypair.publicKey);
        const scopes = normalizeMcpScopes(['offers:read', 'offers:write', 'deals:read', 'proofs:read']);
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

        const issued = issueMcpToken({ publicKey, scopes, expiresInSeconds });
        const verified = verifyMcpToken(issued.token);

        expect(issued.token).toMatch(/^mcp_v1\./);
        expect(verified.sub).toBe(publicKey);
        expect(verified.scopes).toEqual(scopes);
        expect(verified.exp).toBeGreaterThan(verified.iat);
    });

    it('rejects tampered MCP tokens', () => {
        const keypair = nacl.sign.keyPair();
        const publicKey = bs58.encode(keypair.publicKey);
        const issued = issueMcpToken({
            publicKey,
            scopes: normalizeMcpScopes(['offers:read']),
            expiresInSeconds: 60,
        });

        const [prefix, encodedPayload] = issued.token.split('.');
        const tampered = `${prefix}.${encodedPayload}.invalid_signature`;

        expect(() => verifyMcpToken(tampered)).toThrow('Invalid MCP token signature');
    });
});
