import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
    agent: {
        count: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
        updateMany: vi.fn(),
    },
    offer: {
        create: vi.fn(),
    },
    ticket: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
    },
    dealReputationProcessing: {
        findUnique: vi.fn(),
        create: vi.fn(),
    },
};

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

async function sendJson(
    app: express.Express,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
) {
    const server = app.listen(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to bind test server');
    }

    try {
        const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(headers || {}),
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
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    }
}

describe('Signed internal bridge routes', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env.NODE_ENV = 'test';
        delete process.env.BRIDGE_SECRET;

        prismaMock.agent.count.mockReset();
        prismaMock.agent.findFirst.mockReset();
        prismaMock.agent.findUnique.mockReset();
        prismaMock.agent.update.mockReset();
        prismaMock.agent.upsert.mockReset();
        prismaMock.agent.updateMany.mockReset();
        prismaMock.offer.create.mockReset();
        prismaMock.ticket.findUnique.mockReset();
        prismaMock.ticket.create.mockReset();
        prismaMock.ticket.update.mockReset();
        prismaMock.dealReputationProcessing.findUnique.mockReset();
        prismaMock.dealReputationProcessing.create.mockReset();
    });

    afterEach(() => {
        delete process.env.BRIDGE_SECRET;
    });

    it('returns only sanitized diagnostics on signed /test-db', async () => {
        prismaMock.agent.count.mockResolvedValue(7);
        prismaMock.agent.findFirst.mockResolvedValue({
            createdAt: new Date('2026-04-29T12:00:00.000Z'),
        });

        const { signRequest } = await import('../src/services/hmacSigner');
        const testDbRoutes = (await import('../src/routes/testDb.route')).default;

        const app = express();
        app.use(express.json());
        app.use(testDbRoutes);

        const { signature, timestamp } = signRequest('GET', '/test-db', '');
        const response = await sendJson(app, 'GET', '/test-db', undefined, {
            'X-Bridge-Signature': signature,
            'X-Bridge-Timestamp': timestamp,
        });

        expect(response.status).toBe(200);
        expect(response.json).toEqual({
            success: true,
            data: {
                database: 'ok',
                agentCount: 7,
                latestAgentCreatedAt: '2026-04-29T12:00:00.000Z',
            },
        });
    });

    it('rejects known placeholder bridge secrets outside tests', async () => {
        vi.resetModules();
        process.env.NODE_ENV = 'production';
        process.env.BRIDGE_SECRET = 'meridian-bridge-secret-change-in-production';

        const { signRequest } = await import('../src/services/hmacSigner');

        expect(() => signRequest('GET', '/test-db', '')).toThrow(/placeholder/);
    });

    it('accepts valid signed bridge offer creation', async () => {
        prismaMock.agent.upsert.mockResolvedValue({ id: 'agent-1', wallet: 'wallet-1' });
        prismaMock.offer.create.mockResolvedValue({ id: 'offer-1', asset: 'SOL' });

        const { signRequest } = await import('../src/services/hmacSigner');
        const bridgeRoutes = (await import('../src/routes/bridge.routes')).default;

        const app = express();
        app.use(express.json());
        app.use('/v1/bridge', bridgeRoutes);

        const payload = {
            creatorWallet: 'wallet-1',
            asset: 'SOL',
            price: 1.25,
            amount: 2,
            mode: 'sell',
            collateral: 0.5,
        };
        const body = JSON.stringify(payload);
        const { signature, timestamp } = signRequest('POST', '/v1/bridge/offer', body);
        const response = await sendJson(app, 'POST', '/v1/bridge/offer', payload, {
            'X-Bridge-Signature': signature,
            'X-Bridge-Timestamp': timestamp,
        });

        expect(response.status).toBe(201);
        expect(prismaMock.agent.upsert).toHaveBeenCalledTimes(1);
        expect(prismaMock.offer.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                creatorId: 'agent-1',
                asset: 'SOL',
                price: 1.25,
                amount: 2,
                mode: 'sell',
                collateral: 0.5,
            }),
        }));
    });

    it('rejects invalid signed bridge status payloads before mutation', async () => {
        const { signRequest } = await import('../src/services/hmacSigner');
        const bridgeRoutes = (await import('../src/routes/bridge.routes')).default;

        const app = express();
        app.use(express.json());
        app.use('/v1/bridge', bridgeRoutes);

        const payload = { status: 'hacked' };
        const body = JSON.stringify(payload);
        const { signature, timestamp } = signRequest('PATCH', '/v1/bridge/ticket/ticket-1', body);
        const response = await sendJson(app, 'PATCH', '/v1/bridge/ticket/ticket-1', payload, {
            'X-Bridge-Signature': signature,
            'X-Bridge-Timestamp': timestamp,
        });

        expect(response.status).toBe(400);
        expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    });

    it('treats completed as the successful terminal status and leaves agreed as non-terminal', async () => {
        prismaMock.ticket.update.mockResolvedValue({
            id: 'ticket-1',
            offerId: 'offer-1',
            buyer: 'buyer-wallet',
            seller: 'seller-wallet',
        });
        prismaMock.dealReputationProcessing.findUnique.mockResolvedValue(null);
        const agentStats = {
            totalDeals: 0,
            successfulDeals: 0,
            cancelledDeals: 0,
            disputedDeals: 0,
            totalVolume: 0,
            avgSettlementTime: 0,
        };
        prismaMock.agent.findUnique
            .mockResolvedValueOnce({ id: 'buyer-agent', wallet: 'buyer-wallet', ...agentStats })
            .mockResolvedValueOnce({ id: 'seller-agent', wallet: 'seller-wallet', ...agentStats });
        prismaMock.agent.update.mockResolvedValue({});

        const { signRequest } = await import('../src/services/hmacSigner');
        const bridgeRoutes = (await import('../src/routes/bridge.routes')).default;

        const app = express();
        app.use(express.json());
        app.use('/v1/bridge', bridgeRoutes);

        const agreedPayload = { status: 'agreed' };
        const agreedBody = JSON.stringify(agreedPayload);
        const agreedSigned = signRequest('PATCH', '/v1/bridge/ticket/ticket-1', agreedBody);
        const agreedResponse = await sendJson(app, 'PATCH', '/v1/bridge/ticket/ticket-1', agreedPayload, {
            'X-Bridge-Signature': agreedSigned.signature,
            'X-Bridge-Timestamp': agreedSigned.timestamp,
        });

        expect(agreedResponse.status).toBe(200);
        expect(prismaMock.agent.update).not.toHaveBeenCalled();
        expect(prismaMock.dealReputationProcessing.create).not.toHaveBeenCalled();

        const completedPayload = { status: 'completed' };
        const completedBody = JSON.stringify(completedPayload);
        const completedSigned = signRequest('PATCH', '/v1/bridge/ticket/ticket-1', completedBody);
        const completedResponse = await sendJson(app, 'PATCH', '/v1/bridge/ticket/ticket-1', completedPayload, {
            'X-Bridge-Signature': completedSigned.signature,
            'X-Bridge-Timestamp': completedSigned.timestamp,
        });

        expect(completedResponse.status).toBe(200);
        expect(prismaMock.agent.update).toHaveBeenCalledTimes(2);
        expect(prismaMock.agent.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'buyer-agent' },
            data: expect.objectContaining({
                totalDeals: 1,
                successfulDeals: 1,
                cancelledDeals: 0,
                disputedDeals: 0,
            }),
        }));
        expect(prismaMock.agent.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'seller-agent' },
            data: expect.objectContaining({
                totalDeals: 1,
                successfulDeals: 1,
                cancelledDeals: 0,
                disputedDeals: 0,
            }),
        }));
        expect(prismaMock.dealReputationProcessing.create).toHaveBeenCalledWith({
            data: { dealId: 'offer-1_completed' },
        });
    });
});
