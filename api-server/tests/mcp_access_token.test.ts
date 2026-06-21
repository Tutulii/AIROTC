import { describe, expect, it } from 'vitest';
import {
    issueMcpAccessToken,
    MCP_ACCESS_TOKEN_MAX_HOURS,
    verifyMcpAccessToken,
} from '../src/services/mcpAccessToken';

const wallet = '11111111111111111111111111111111';
const secret = 'test-mcp-access-token-secret-32-bytes';

describe('MCP access tokens', () => {
    it('issues wallet-bound trade tokens with bounded expiry', () => {
        const issued = issueMcpAccessToken({
            wallet,
            scopePreset: 'trade',
            expiresInHours: MCP_ACCESS_TOKEN_MAX_HOURS + 100,
            now: 1_700_000_000,
            secret,
        });

        expect(issued.wallet).toBe(wallet);
        expect(issued.expiresInHours).toBe(MCP_ACCESS_TOKEN_MAX_HOURS);
        expect(issued.scopes).toContain('offers:write');
        expect(issued.token).toMatch(/^mcp_v1\./);

        const payload = verifyMcpAccessToken(issued.token, {
            now: 1_700_000_001,
            secret,
        });

        expect(payload.sub).toBe(wallet);
        expect(payload.scopes).toContain('offers:write');
    });

    it('issues read-only tokens without mutation scopes', () => {
        const issued = issueMcpAccessToken({
            wallet,
            scopePreset: 'read',
            now: 1_700_000_000,
            secret,
        });

        expect(issued.scopes).not.toContain('offers:write');
        expect(verifyMcpAccessToken(issued.token, { now: 1_700_000_001, secret }).scopes).not.toContain('offers:write');
    });

    it('rejects tampered tokens and expired tokens', () => {
        const issued = issueMcpAccessToken({
            wallet,
            now: 1_700_000_000,
            expiresInHours: 1,
            secret,
        });

        expect(() => verifyMcpAccessToken(`${issued.token}tampered`, { now: 1_700_000_001, secret })).toThrow(
            'mcp_access_token_invalid_signature'
        );
        expect(() => verifyMcpAccessToken(issued.token, { now: 1_700_003_601, secret })).toThrow(
            'mcp_access_token_rejected'
        );
    });
});
