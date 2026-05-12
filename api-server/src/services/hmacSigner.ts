/**
 * HMAC Signer — Secures signed internal bridges.
 *
 * Every outgoing request from the API Server to trusted internal services includes:
 *   - X-Bridge-Signature: HMAC-SHA256(timestamp + method + path + body)
 *   - X-Bridge-Timestamp: epoch milliseconds
 *
 * The Middleman verifies the signature and rejects requests that:
 *   - Have no signature
 *   - Have an expired timestamp (>30 seconds)
 *   - Have an invalid HMAC
 *
 * Set BRIDGE_SECRET in both .env files (must match).
 */

import crypto from 'crypto';

const TEST_BRIDGE_SECRET = 'test-bridge-secret';

function resolveBridgeSecret(): string {
    const configured = process.env.BRIDGE_SECRET?.trim();
    if (configured) return configured;
    if (process.env.NODE_ENV === 'test') return TEST_BRIDGE_SECRET;
    throw new Error('BRIDGE_SECRET is required for internal bridge authentication');
}

export function signRequest(method: string, path: string, body: string): {
    signature: string;
    timestamp: string;
} {
    const bridgeSecret = resolveBridgeSecret();
    const timestamp = Date.now().toString();
    const payload = `${timestamp}:${method.toUpperCase()}:${path}:${body}`;
    const signature = crypto
        .createHmac('sha256', bridgeSecret)
        .update(payload)
        .digest('hex');

    return { signature, timestamp };
}

export function verifyRequest(
    method: string,
    path: string,
    body: string,
    signature: string,
    timestamp: string
): { valid: boolean; reason?: string } {
    let bridgeSecret: string;
    try {
        bridgeSecret = resolveBridgeSecret();
    } catch (error) {
        return { valid: false, reason: error instanceof Error ? error.message : 'Bridge secret unavailable' };
    }

    // Check timestamp freshness (30 second window)
    const now = Date.now();
    const reqTime = parseInt(timestamp, 10);
    if (isNaN(reqTime) || Math.abs(now - reqTime) > 30000) {
        return { valid: false, reason: 'Timestamp expired or invalid (>30s)' };
    }

    // Recompute HMAC
    const payload = `${timestamp}:${method.toUpperCase()}:${path}:${body}`;
    const expected = crypto
        .createHmac('sha256', bridgeSecret)
        .update(payload)
        .digest('hex');

    // Constant-time comparison to prevent timing attacks
    if (signature.length !== expected.length) {
        return { valid: false, reason: 'Invalid signature length' };
    }

    const valid = crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expected, 'hex')
    );

    return valid ? { valid: true } : { valid: false, reason: 'Signature mismatch' };
}

export function isBridgeSecretConfigured(): boolean {
    return Boolean(process.env.BRIDGE_SECRET?.trim()) || process.env.NODE_ENV === 'test';
}
