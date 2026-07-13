import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { attachSportTicketByOfferMock } = vi.hoisted(() => ({
    attachSportTicketByOfferMock: vi.fn(),
}));

const prismaMock = {
    agent: {
        count: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
    },
    offer: {
        create: vi.fn(),
        findUnique: vi.fn(),
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

vi.mock('../src/services/arena/sportSettlementEngine', () => ({
    attachSportTicketByOffer: attachSportTicketByOfferMock,
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
        prismaMock.agent.upsert.mockReset();
        prismaMock.agent.update.mockReset();
        prismaMock.agent.updateMany.mockReset();
        prismaMock.offer.create.mockReset();
        prismaMock.offer.findUnique.mockReset();
        prismaMock.ticket.findUnique.mockReset();
        prismaMock.ticket.create.mockReset();
        prismaMock.ticket.update.mockReset();
        prismaMock.dealReputationProcessing.findUnique.mockReset();
        prismaMock.dealReputationProcessing.create.mockReset();
        attachSportTicketByOfferMock.mockReset();
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
        prismaMock.agent.findUnique.mockImplementation(async ({ where }: { where: { wallet: string } }) => ({
            id: where.wallet === 'buyer-wallet' ? 'buyer-agent' : 'seller-agent',
            wallet: where.wallet,
            totalDeals: 0,
            successfulDeals: 0,
            cancelledDeals: 0,
            disputedDeals: 0,
            totalVolume: 0,
            avgSettlementTime: null,
        }));

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
        expect(prismaMock.agent.updateMany).not.toHaveBeenCalled();
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
        expect(prismaMock.agent.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.agent.update).toHaveBeenCalledTimes(2);
        expect(prismaMock.agent.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'buyer-agent' },
            data: expect.objectContaining({
                totalDeals: 1,
                successfulDeals: 1,
                cancelledDeals: 0,
                disputedDeals: 0,
                reputationScore: expect.any(Number),
            }),
        }));
        expect(prismaMock.agent.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'seller-agent' },
            data: expect.objectContaining({
                totalDeals: 1,
                successfulDeals: 1,
                cancelledDeals: 0,
                disputedDeals: 0,
                reputationScore: expect.any(Number),
            }),
        }));
        expect(prismaMock.dealReputationProcessing.create).toHaveBeenCalledWith({
            data: { dealId: 'offer-1_completed' },
        });
    });

    it('accepts deal expiring bridge warnings without terminal reputation processing', async () => {
        prismaMock.ticket.update.mockResolvedValue({
            id: 'ticket-1',
            offerId: 'offer-1',
            buyer: 'buyer-wallet',
            seller: 'seller-wallet',
            status: 'negotiating',
        });

        const { signRequest } = await import('../src/services/hmacSigner');
        const bridgeRoutes = (await import('../src/routes/bridge.routes')).default;

        const app = express();
        app.use(express.json());
        app.use('/v1/bridge', bridgeRoutes);

        const payload = {
            status: 'negotiating',
            phase: 'awaiting_deposits',
            source: 'deal_expiring',
            expiresAt: '2026-06-29T00:05:00.000Z',
            msRemaining: 300000,
            warningThresholdMs: 300000,
        };
        const body = JSON.stringify(payload);
        const signed = signRequest('PATCH', '/v1/bridge/ticket/ticket-1', body);
        const response = await sendJson(app, 'PATCH', '/v1/bridge/ticket/ticket-1', payload, {
            'X-Bridge-Signature': signed.signature,
            'X-Bridge-Timestamp': signed.timestamp,
        });

        expect(response.status).toBe(200);
        expect(prismaMock.agent.update).not.toHaveBeenCalled();
        expect(prismaMock.dealReputationProcessing.create).not.toHaveBeenCalled();
    });

    it('hydrates SPORT arena match escrow PDA from bridge ticket phase updates', async () => {
        prismaMock.ticket.update.mockResolvedValue({
            id: 'ticket-sport',
            offerId: 'offer-sport',
            buyer: 'buyer-wallet',
            seller: 'seller-wallet',
            status: 'negotiating',
        });
        prismaMock.offer.findUnique.mockResolvedValue({ id: 'offer-sport', rollupMode: 'SPORT' });
        attachSportTicketByOfferMock.mockResolvedValue({
            match: {
                id: 'match-sport',
                ticketId: 'ticket-sport',
                offerId: 'offer-sport',
                escrowPda: 'EscrowPda111111111111111111111111111111111',
            },
        });

        const { signRequest } = await import('../src/services/hmacSigner');
        const bridgeRoutes = (await import('../src/routes/bridge.routes')).default;

        const app = express();
        app.use(express.json());
        app.use('/v1/bridge', bridgeRoutes);

        const payload = {
            status: 'negotiating',
            phase: 'escrow_created',
            source: 'phase_changed',
            escrowPda: 'EscrowPda111111111111111111111111111111111',
        };
        const body = JSON.stringify(payload);
        const signed = signRequest('PATCH', '/v1/bridge/ticket/ticket-sport', body);
        const response = await sendJson(app, 'PATCH', '/v1/bridge/ticket/ticket-sport', payload, {
            'X-Bridge-Signature': signed.signature,
            'X-Bridge-Timestamp': signed.timestamp,
        });

        expect(response.status).toBe(200);
        expect(prismaMock.offer.findUnique).toHaveBeenCalledWith({
            where: { id: 'offer-sport' },
            select: { rollupMode: true },
        });
        expect(attachSportTicketByOfferMock).toHaveBeenCalledWith({
            offerId: 'offer-sport',
            ticketId: 'ticket-sport',
            escrowPda: 'EscrowPda111111111111111111111111111111111',
        });
    });
});
