import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
    agent: {
        findUnique: vi.fn(),
    },
    agentEvent: {
        create: vi.fn(),
        updateMany: vi.fn(),
    },
    agentNotificationChannel: {
        findMany: vi.fn(),
        updateMany: vi.fn(),
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
        prismaMock.agentEvent.create.mockReset();
        prismaMock.agentEvent.updateMany.mockReset();
        prismaMock.agentNotificationChannel.findMany.mockReset();
        prismaMock.agentNotificationChannel.updateMany.mockReset();
        prismaMock.agentEvent.create.mockImplementation(async ({ data }) => ({
            id: 'event-1',
            createdAt: new Date('2026-06-29T00:00:00.000Z'),
            deliveredAt: null,
            ackedAt: null,
            ...data,
        }));
        prismaMock.agentEvent.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.agentNotificationChannel.findMany.mockResolvedValue([]);
        prismaMock.agentNotificationChannel.updateMany.mockResolvedValue({ count: 0 });
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
        expect(prismaMock.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                wallet: 'wallet-1',
                event: 'dm.received',
                payload: expect.objectContaining({ messageId: 'dm-1' }),
            }),
        }));
        expect(fetch).toHaveBeenCalledTimes(1);
        const [, request] = (fetch as any).mock.calls[0];
        expect(request.headers['X-Webhook-Event']).toBe('dm.received');
        expect(request.headers['X-Webhook-Signature']).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.parse(request.body).id).toBe('event-1');
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
        expect(prismaMock.agentEvent.create).toHaveBeenCalledTimes(1);
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

    it('keeps webhook delivery working when Telegram notification delivery fails', async () => {
        prismaMock.agent.findUnique.mockResolvedValue({
            webhookUrl: 'https://agent.example/webhook',
            webhookSecret: 'secret',
            webhookEvents: null,
        });
        prismaMock.agentNotificationChannel.findMany.mockResolvedValue([
            {
                id: 'channel-1',
                wallet: 'wallet-1',
                type: 'telegram',
                enabled: true,
                events: JSON.stringify(['dm.received']),
                config: { chatId: '123456' },
                lastSentAt: null,
            },
        ]);

        const { sendToAgent } = await import('../src/services/webhookDelivery');
        const delivered = await sendToAgent('wallet-1', 'dm.received', { messageId: 'dm-1' });

        expect(delivered).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(prismaMock.agentNotificationChannel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'channel-1' },
            data: expect.objectContaining({ lastError: 'telegram_not_configured' }),
        }));
    });
});
