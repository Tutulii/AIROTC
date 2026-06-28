import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
    agent: {
        findUnique: vi.fn(),
    },
};

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

vi.mock('../src/lib/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

describe('webhook delivery', () => {
    beforeEach(() => {
        vi.resetModules();
        prismaMock.agent.findUnique.mockReset();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    });

    it('delivers supported events when no event allowlist is configured', async () => {
        prismaMock.agent.findUnique.mockResolvedValue({
            webhookUrl: 'https://agent.example/webhook',
            webhookSecret: 'secret',
            webhookEvents: null,
        });

        const { sendToAgent } = await import('../src/services/webhookDelivery');
        const delivered = await sendToAgent('wallet-1', 'dm.received', { messageId: 'dm-1' });

        expect(delivered).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        const [, request] = (fetch as any).mock.calls[0];
        expect(request.headers['X-Webhook-Event']).toBe('dm.received');
        expect(request.headers['X-Webhook-Signature']).toMatch(/^[a-f0-9]{64}$/);
    });

    it('skips events outside the agent event allowlist', async () => {
        prismaMock.agent.findUnique.mockResolvedValue({
            webhookUrl: 'https://agent.example/webhook',
            webhookSecret: 'secret',
            webhookEvents: JSON.stringify(['deal.expiring']),
        });

        const { sendToAgent } = await import('../src/services/webhookDelivery');
        const delivered = await sendToAgent('wallet-1', 'dm.received', { messageId: 'dm-1' });

        expect(delivered).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('skips private or localhost webhook URLs', async () => {
        prismaMock.agent.findUnique.mockResolvedValue({
            webhookUrl: 'http://127.0.0.1:3000/webhook',
            webhookSecret: 'secret',
            webhookEvents: null,
        });

        const { sendToAgent } = await import('../src/services/webhookDelivery');
        const delivered = await sendToAgent('wallet-1', 'deal.message', { messageId: 'msg-1' });

        expect(delivered).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects unsupported webhook event names', async () => {
        const { normalizeWebhookEvents } = await import('../src/services/webhookDelivery');

        expect(() => normalizeWebhookEvents(['dm.received', 'bad.event'])).toThrow('Unsupported webhook event');
    });
});
