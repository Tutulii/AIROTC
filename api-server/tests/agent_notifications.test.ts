import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
    agent: {
        findUnique: vi.fn(),
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

describe('agent notification channels', () => {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousThrottle = process.env.TELEGRAM_NOTIFICATION_MIN_INTERVAL_MS;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
        process.env.TELEGRAM_NOTIFICATION_MIN_INTERVAL_MS = '0';
        prismaMock.agent.findUnique.mockResolvedValue({ wallet: 'wallet-1' });
        prismaMock.agentNotificationChannel.findMany.mockResolvedValue([]);
        prismaMock.agentNotificationChannel.updateMany.mockResolvedValue({ count: 1 });
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    });

    afterEach(() => {
        if (previousToken === undefined) {
            delete process.env.TELEGRAM_BOT_TOKEN;
        } else {
            process.env.TELEGRAM_BOT_TOKEN = previousToken;
        }
        if (previousThrottle === undefined) {
            delete process.env.TELEGRAM_NOTIFICATION_MIN_INTERVAL_MS;
        } else {
            process.env.TELEGRAM_NOTIFICATION_MIN_INTERVAL_MS = previousThrottle;
        }
        vi.unstubAllGlobals();
    });

    it('rejects unsupported Telegram notification events', async () => {
        const { normalizeNotificationEvents } = await import('../src/services/agentNotification.service');

        expect(() => normalizeNotificationEvents(['dm.received', 'reputation.update'])).toThrow(
            'Unsupported notification event: reputation.update',
        );
    });

    it('redacts encrypted DM content in Telegram notification text', async () => {
        const { buildTelegramNotificationText } = await import('../src/services/agentNotification.service');

        const text = buildTelegramNotificationText({
            id: 'event-1',
            event: 'dm.received',
            wallet: 'wallet-1',
            timestamp: '2026-06-29T00:00:00.000Z',
            payload: {
                fromWallet: 'A4bCoAbesNR18wwsujY5h5hwrZqJG4574tJ8uiEzLF3V',
                encrypted: true,
                content: 'super secret api key',
            },
            expiresAt: '2026-07-06T00:00:00.000Z',
        });

        expect(text).toContain('New secure DM received');
        expect(text).not.toContain('super secret api key');
    });

    it('delivers Telegram notifications for enabled subscribed channels', async () => {
        prismaMock.agentNotificationChannel.findMany.mockResolvedValue([
            {
                id: 'channel-1',
                wallet: 'wallet-1',
                type: 'telegram',
                enabled: true,
                events: JSON.stringify(['dm.received']),
                config: { chatId: '-1004494003789', threadId: 42, mention: '@newraclaw_bot' },
                lastSentAt: null,
            },
        ]);

        const { deliverAgentNotifications } = await import('../src/services/agentNotification.service');
        const delivered = await deliverAgentNotifications({
            id: 'event-1',
            event: 'dm.received',
            wallet: 'wallet-1',
            timestamp: '2026-06-29T00:00:00.000Z',
            payload: {
                fromWallet: 'A4bCoAbesNR18wwsujY5h5hwrZqJG4574tJ8uiEzLF3V',
                preview: 'Yo big bro',
            },
            expiresAt: '2026-07-06T00:00:00.000Z',
        });

        expect(delivered).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, request] = (fetch as any).mock.calls[0];
        expect(url).toBe('https://api.telegram.org/bottest-telegram-token/sendMessage');
        expect(JSON.parse(request.body)).toMatchObject({
            chat_id: '-1004494003789',
            message_thread_id: 42,
        });
        expect(JSON.parse(request.body).text).toContain('@newraclaw_bot AIR OTC agent alert');
        expect(JSON.parse(request.body).text).toContain('Yo big bro');
        expect(prismaMock.agentNotificationChannel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'channel-1' },
            data: expect.objectContaining({ lastError: null }),
        }));
    });

    it('records the Telegram API failure reason on failed delivery', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}',
            { status: 400 },
        )));
        prismaMock.agentNotificationChannel.findMany.mockResolvedValue([
            {
                id: 'channel-1',
                wallet: 'wallet-1',
                type: 'telegram',
                enabled: true,
                events: JSON.stringify(['dm.received']),
                config: { chatId: '-1004494003789' },
                lastSentAt: null,
            },
        ]);

        const { deliverAgentNotifications } = await import('../src/services/agentNotification.service');
        const delivered = await deliverAgentNotifications({
            id: 'event-1',
            event: 'dm.received',
            wallet: 'wallet-1',
            timestamp: '2026-06-29T00:00:00.000Z',
            payload: {
                fromWallet: 'A4bCoAbesNR18wwsujY5h5hwrZqJG4574tJ8uiEzLF3V',
                preview: 'Yo big bro',
            },
            expiresAt: '2026-07-06T00:00:00.000Z',
        });

        expect(delivered).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(prismaMock.agentNotificationChannel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'channel-1' },
            data: { lastError: 'telegram_send_failed: Bad Request: chat not found' },
        }));
    });

    it('returns a clear configuration error for test sends when the platform bot token is missing', async () => {
        delete process.env.TELEGRAM_BOT_TOKEN;

        const { sendTestNotification } = await import('../src/services/agentNotification.service');

        await expect(sendTestNotification('EdUWKpttdUtWWiUpWzDasouXPvZzpuMpjytteHEzuk9Y')).rejects.toMatchObject({
            name: '503',
            message: 'telegram_not_configured',
        });
    });
});
