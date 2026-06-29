import { Prisma } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { AgentEventEnvelope } from './agentEventInbox';
import { AgentEventName, TELEGRAM_NOTIFICATION_EVENTS } from './eventCatalog';

type NotificationChannelType = 'telegram';

type TelegramConfig = {
    chatId: string;
    threadId?: number;
    mention?: string;
};

type NotificationChannelInput = {
    type?: unknown;
    enabled?: unknown;
    events?: unknown;
    config?: unknown;
};

type NormalizedNotificationChannel = {
    type: NotificationChannelType;
    enabled: boolean;
    events: AgentEventName[];
    config: TelegramConfig;
};

const TELEGRAM_EVENT_SET = new Set<string>(TELEGRAM_NOTIFICATION_EVENTS);
const DEFAULT_THROTTLE_MS = 1_000;
const TELEGRAM_TIMEOUT_MS = 5_000;
const TELEGRAM_RETRY_DELAYS_MS = [0, 500, 1_500];

export const DEFAULT_NOTIFICATION_EVENTS: AgentEventName[] = [...TELEGRAM_NOTIFICATION_EVENTS];

function apiError(message: string, status: number): Error {
    const error = new Error(message);
    error.name = String(status);
    return error;
}

function validateWallet(wallet: string): void {
    try {
        new PublicKey(wallet);
    } catch {
        throw apiError('Invalid wallet address', 400);
    }
}

function throttleMs(): number {
    const parsed = Number(process.env.TELEGRAM_NOTIFICATION_MIN_INTERVAL_MS);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_THROTTLE_MS;
    return Math.floor(parsed);
}

function telegramBotToken(): string {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
        throw apiError('telegram_not_configured', 503);
    }
    return token;
}

export function normalizeNotificationEvents(events: unknown): AgentEventName[] {
    if (events === undefined || events === null || events === '') {
        return [...DEFAULT_NOTIFICATION_EVENTS];
    }

    const items = Array.isArray(events)
        ? events
        : typeof events === 'string'
            ? events.split(',')
            : null;

    if (!items) {
        throw apiError('events must be an array or comma-separated string', 400);
    }

    const normalized = items
        .map((event) => {
            if (typeof event !== 'string') {
                throw apiError('events must contain only strings', 400);
            }
            return event.trim();
        })
        .filter(Boolean);

    for (const event of normalized) {
        if (!TELEGRAM_EVENT_SET.has(event)) {
            throw apiError(`Unsupported notification event: ${event}`, 400);
        }
    }

    return [...new Set(normalized)] as AgentEventName[];
}

function normalizeTelegramConfig(config: unknown): TelegramConfig {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw apiError('telegram config must be an object', 400);
    }

    const raw = config as Record<string, unknown>;
    const chatIdValue = raw.chatId;
    const chatId = typeof chatIdValue === 'number'
        ? String(chatIdValue)
        : typeof chatIdValue === 'string'
            ? chatIdValue.trim()
            : '';

    if (!/^(-?\d+|@[A-Za-z0-9_]{5,64})$/.test(chatId)) {
        throw apiError('telegram chatId must be a numeric chat id or @channel username', 400);
    }

    const threadIdValue = raw.threadId;
    let threadId: number | undefined;
    if (threadIdValue !== undefined && threadIdValue !== null && threadIdValue !== '') {
        const parsed = Number(threadIdValue);
        if (!Number.isInteger(parsed) || parsed <= 0) {
            throw apiError('telegram threadId must be a positive integer', 400);
        }
        threadId = parsed;
    }

    const mentionValue = raw.mention;
    let mention: string | undefined;
    if (mentionValue !== undefined && mentionValue !== null && mentionValue !== '') {
        mention = typeof mentionValue === 'string' ? mentionValue.trim() : '';
        if (!/^@[A-Za-z0-9_]{5,64}$/.test(mention)) {
            throw apiError('telegram mention must be a @username mention', 400);
        }
    }

    return {
        chatId,
        ...(threadId ? { threadId } : {}),
        ...(mention ? { mention } : {}),
    };
}

function normalizeChannel(input: NotificationChannelInput): NormalizedNotificationChannel {
    const type = input.type === undefined ? 'telegram' : input.type;
    if (type !== 'telegram') {
        throw apiError('Only telegram notification channels are supported', 400);
    }

    return {
        type,
        enabled: input.enabled !== false,
        events: normalizeNotificationEvents(input.events),
        config: normalizeTelegramConfig(input.config),
    };
}

function normalizeChannels(channels: unknown): NormalizedNotificationChannel[] {
    if (!Array.isArray(channels)) {
        throw apiError('channels must be an array', 400);
    }
    if (channels.length > 5) {
        throw apiError('At most 5 notification channels can be configured', 400);
    }

    return channels.map((channel) => {
        if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
            throw apiError('each channel must be an object', 400);
        }
        return normalizeChannel(channel as NotificationChannelInput);
    });
}

function parseStoredEvents(value: string | null | undefined): AgentEventName[] {
    if (!value) return [...DEFAULT_NOTIFICATION_EVENTS];
    try {
        return normalizeNotificationEvents(JSON.parse(value));
    } catch {
        logger.warn('notification_events_parse_failed', { value });
        return [...DEFAULT_NOTIFICATION_EVENTS];
    }
}

function toPublicChannel(row: any) {
    return {
        id: row.id,
        wallet: row.wallet,
        type: row.type,
        enabled: row.enabled,
        events: parseStoredEvents(row.events),
        config: row.config,
        lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : null,
        lastError: row.lastError,
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    };
}

async function requireRegisteredAgent(wallet: string): Promise<void> {
    const agent = await prisma.agent.findUnique({
        where: { wallet },
        select: { wallet: true },
    });
    if (!agent) {
        throw apiError('Agent not found', 404);
    }
}

function toJsonConfig(config: TelegramConfig): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(config)) as Prisma.InputJsonValue;
}

export async function replaceNotificationChannels(wallet: string, channels: unknown) {
    validateWallet(wallet);
    await requireRegisteredAgent(wallet);
    const normalized = normalizeChannels(channels);

    const rows = await prisma.$transaction(async (tx) => {
        await tx.agentNotificationChannel.deleteMany({ where: { wallet } });
        const created = [];
        for (const channel of normalized) {
            created.push(await tx.agentNotificationChannel.create({
                data: {
                    wallet,
                    type: channel.type,
                    enabled: channel.enabled,
                    events: JSON.stringify(channel.events),
                    config: toJsonConfig(channel.config),
                },
            }));
        }
        return created;
    });

    return {
        wallet,
        channels: rows.map(toPublicChannel),
    };
}

export async function listNotificationChannels(wallet: string) {
    validateWallet(wallet);
    await requireRegisteredAgent(wallet);
    const rows = await prisma.agentNotificationChannel.findMany({
        where: { wallet },
        orderBy: { createdAt: 'asc' },
    });

    return {
        wallet,
        supportedEvents: DEFAULT_NOTIFICATION_EVENTS,
        telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
        channels: rows.map(toPublicChannel),
    };
}

export async function deleteNotificationChannel(wallet: string, channelId: string) {
    validateWallet(wallet);
    if (!channelId || typeof channelId !== 'string') {
        throw apiError('channelId is required', 400);
    }

    const result = await prisma.agentNotificationChannel.deleteMany({
        where: { id: channelId, wallet },
    });

    return {
        id: channelId,
        deleted: result.count > 0,
    };
}

function safeString(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function telegramErrorMessage(status: number, responseText: string): string {
    let description = responseText;
    try {
        const parsed = JSON.parse(responseText);
        if (parsed && typeof parsed.description === 'string') {
            description = parsed.description;
        }
    } catch {
        // Keep the raw response text when Telegram returns a non-JSON body.
    }

    const safeDescription = safeString(description) || `HTTP ${status}`;
    return truncate(`telegram_send_failed: ${safeDescription}`, 220);
}

function shortId(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value) return undefined;
    return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function shortWallet(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value) return undefined;
    return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function dmPreview(payload: Record<string, unknown>): string {
    const contentType = safeString(payload.contentType).toLowerCase();
    const sensitiveTypes = new Set(['api_key', 'credentials', 'file', 'file_link']);
    if (payload.encrypted === true || sensitiveTypes.has(contentType)) {
        return 'New secure DM received. Open AIR OTC to read it.';
    }

    const preview = safeString(payload.preview) || safeString(payload.content) || safeString(payload.message);
    return preview ? truncate(preview, 180) : 'New DM received. Open AIR OTC to read it.';
}

export function buildTelegramNotificationText(envelope: AgentEventEnvelope, mention?: string): string {
    const payload = envelope.payload ?? {};
    const lines = [
        mention ? `${mention} AIR OTC agent alert` : 'AIR OTC agent alert',
        `Event: ${envelope.event}`,
    ];
    const ticketId = envelope.ticketId || shortId(payload.ticketId);
    const dealId = envelope.dealId || shortId(payload.dealId);

    if (ticketId) lines.push(`Ticket: ${ticketId}`);
    if (dealId) lines.push(`Deal: ${dealId}`);

    if (envelope.event === 'dm.received') {
        const from = shortWallet(payload.fromWallet);
        if (from) lines.push(`From: ${from}`);
        lines.push(dmPreview(payload));
    } else if (envelope.event === 'deal.message') {
        const sender = shortWallet(payload.sender);
        if (sender) lines.push(`Sender: ${sender}`);
        const preview = safeString(payload.preview);
        lines.push(preview ? `Message: ${truncate(preview, 180)}` : 'New ticket message. Open AIR OTC to respond.');
    } else if (envelope.event === 'deal.phase_changed') {
        const phase = safeString(payload.phase) || safeString(payload.status) || safeString(payload.to);
        lines.push(phase ? `Phase: ${truncate(phase, 80)}` : 'Deal phase changed.');
    } else if (envelope.event === 'deal.matched') {
        const asset = safeString(payload.asset);
        const price = payload.price === undefined ? '' : String(payload.price);
        lines.push(asset || price ? `Matched: ${[asset, price].filter(Boolean).join(' @ ')}` : 'Offer accepted and ticket opened.');
    } else if (envelope.event === 'deal.expiring') {
        lines.push('Deal is close to timeout. Action may be needed soon.');
    } else if (envelope.event === 'deal.escrow_created') {
        lines.push('Escrow was created.');
    } else if (envelope.event === 'deal.deposit_received') {
        lines.push('Deposit activity was detected.');
    } else if (envelope.event === 'deal.delivery_confirmed') {
        lines.push('Delivery was confirmed.');
    } else if (envelope.event === 'deal.completed') {
        lines.push('Deal completed successfully.');
    }

    lines.push(`Event ID: ${shortId(envelope.id) ?? envelope.id}`);
    return truncate(lines.join('\n'), 3900);
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegramMessage(config: TelegramConfig, text: string): Promise<void> {
    const token = telegramBotToken();
    const body: Record<string, unknown> = {
        chat_id: config.chatId,
        text,
        disable_web_page_preview: true,
    };
    if (config.threadId) {
        body.message_thread_id = config.threadId;
    }

    let lastError = 'telegram_send_failed';
    for (let attempt = 0; attempt < TELEGRAM_RETRY_DELAYS_MS.length; attempt++) {
        const delay = TELEGRAM_RETRY_DELAYS_MS[attempt] ?? 0;
        if (delay > 0) await sleep(delay);

        try {
            const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
            });

            if (response.ok) {
                return;
            }

            const responseText = await response.text().catch(() => '');
            lastError = telegramErrorMessage(response.status, responseText);
            logger.warn('telegram_notification_non_2xx', {
                status: response.status,
                attempt: attempt + 1,
                error: truncate(responseText, 180),
            });
        } catch (error: any) {
            lastError = truncate(`telegram_send_failed: ${safeString(error?.message) || 'unknown'}`, 220);
            logger.warn('telegram_notification_send_failed', {
                attempt: attempt + 1,
                error: error?.message || 'unknown',
            });
        }
    }

    throw new Error(lastError);
}

async function markChannelFailure(channelId: string, error: unknown): Promise<void> {
    await prisma.agentNotificationChannel.updateMany({
        where: { id: channelId },
        data: { lastError: error instanceof Error ? error.message : String(error) },
    }).catch((updateError: any) => {
        logger.warn('notification_channel_error_mark_failed', {
            channelId,
            error: updateError?.message || 'unknown',
        });
    });
}

async function markChannelSent(channelId: string): Promise<void> {
    await prisma.agentNotificationChannel.updateMany({
        where: { id: channelId },
        data: { lastSentAt: new Date(), lastError: null },
    }).catch((error: any) => {
        logger.warn('notification_channel_sent_mark_failed', {
            channelId,
            error: error?.message || 'unknown',
        });
    });
}

async function deliverTelegramChannel(channel: any, envelope: AgentEventEnvelope): Promise<boolean> {
    if (!parseStoredEvents(channel.events).includes(envelope.event)) {
        return false;
    }

    const minimumInterval = throttleMs();
    if (minimumInterval > 0 && channel.lastSentAt instanceof Date) {
        const age = Date.now() - channel.lastSentAt.getTime();
        if (age < minimumInterval) {
            logger.warn('telegram_notification_rate_limited', {
                wallet: envelope.wallet,
                event: envelope.event,
                channelId: channel.id,
                ageMs: age,
            });
            return false;
        }
    }

    try {
        const config = normalizeTelegramConfig(channel.config);
        await sendTelegramMessage(config, buildTelegramNotificationText(envelope, config.mention));
        await markChannelSent(channel.id);
        logger.info('telegram_notification_delivered', {
            wallet: envelope.wallet,
            event: envelope.event,
            channelId: channel.id,
        });
        return true;
    } catch (error: any) {
        await markChannelFailure(channel.id, error);
        logger.warn('telegram_notification_delivery_failed', {
            wallet: envelope.wallet,
            event: envelope.event,
            channelId: channel.id,
            error: error?.message || 'unknown',
        });
        return false;
    }
}

export async function deliverAgentNotifications(envelope: AgentEventEnvelope): Promise<boolean> {
    if (!TELEGRAM_EVENT_SET.has(envelope.event)) {
        return false;
    }

    const channels = await prisma.agentNotificationChannel.findMany({
        where: {
            wallet: envelope.wallet,
            enabled: true,
            type: 'telegram',
        },
    });

    if (channels.length === 0) {
        return false;
    }

    const results = await Promise.allSettled(
        channels.map((channel) => deliverTelegramChannel(channel, envelope)),
    );

    return results.some((result) => result.status === 'fulfilled' && result.value);
}

export async function sendTestNotification(wallet: string, channelId?: string) {
    validateWallet(wallet);
    await requireRegisteredAgent(wallet);
    telegramBotToken();

    const channels = await prisma.agentNotificationChannel.findMany({
        where: {
            wallet,
            enabled: true,
            type: 'telegram',
            ...(channelId ? { id: channelId } : {}),
        },
    });

    if (channels.length === 0) {
        throw apiError('No enabled telegram notification channel found', 404);
    }

    const envelope: AgentEventEnvelope = {
        id: `test-${Date.now()}`,
        event: 'dm.received',
        wallet,
        timestamp: new Date().toISOString(),
        payload: {
            fromWallet: 'AIR_OTC_SYSTEM',
            preview: 'Telegram wake-up notifications are ready.',
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    const results = await Promise.allSettled(
        channels.map((channel) => deliverTelegramChannel(channel, envelope)),
    );
    const sent = results.filter((result) => result.status === 'fulfilled' && result.value).length;

    return {
        wallet,
        sent,
        attempted: channels.length,
    };
}
