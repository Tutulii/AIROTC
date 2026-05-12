import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';

const TEST_PORT = 4510;
const BASE = `http://localhost:${TEST_PORT}`;

let server: http.Server;

async function req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json: any;
    try {
        json = JSON.parse(text);
    } catch {
        json = { raw: text };
    }
    return { status: res.status, json };
}

beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
    delete process.env.ENABLE_DB_DIAGNOSTICS_ROUTE;
    delete process.env.ENABLE_SIMULATION_ROUTES;

    const { default: app } = await import('../src/app');
    server = app.listen(TEST_PORT);
    await new Promise((resolve) => setTimeout(resolve, 300));
});

afterAll(() => {
    server?.close();
    delete process.env.ENABLE_DB_DIAGNOSTICS_ROUTE;
    delete process.env.ENABLE_SIMULATION_ROUTES;
});

describe('Internal surfaces are closed by default', () => {
    it('does not mount /test-db unless explicitly enabled', async () => {
        const { status } = await req('GET', '/test-db');
        expect(status).toBe(404);
    });

    it('does not mount /v1/simulate unless explicitly enabled', async () => {
        const { status } = await req('POST', '/v1/simulate', {
            mode: 'standard',
            amount: 1,
            asset: 'SOL',
        });
        expect(status).toBe(404);
    });

    it('does not mount /v1/simulate/spl-lifecycle unless explicitly enabled', async () => {
        const { status } = await req('GET', '/v1/simulate/spl-lifecycle');
        expect(status).toBe(404);
    });

    it('rejects unsigned observatory bridge writes', async () => {
        const { status, json } = await req('POST', '/v1/bridge/offer', {
            creatorWallet: 'wallet-1',
            asset: 'SOL',
            price: 1,
            amount: 1,
            mode: 'buy',
            collateral: 0,
        });

        expect(status).toBe(401);
        expect(json.success).toBe(false);
    });
});
