import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import {
    AGENT_EVENT_CATALOG,
    AGENT_EVENT_SET,
    DEFAULT_WEBHOOK_EVENTS,
    WEBHOOK_EVENTS,
    type AgentEventName,
} from './eventCatalog';
import { enqueueAgentEvent, markAgentEventDelivered, type AgentEventEnvelope } from './agentEventInbox';
import { deliverAgentNotifications } from './agentNotification.service';

export { AGENT_EVENT_CATALOG, DEFAULT_WEBHOOK_EVENTS, WEBHOOK_EVENTS };
export type WebhookEvent = AgentEventName;

interface WebhookPayload {
    id: string;
    event: WebhookEvent;
    ticketId?: string;
    dealId?: string;
    timestamp: string;
    data: Record<string, unknown>;
}

const TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [0, 500, 1_500];

export function normalizeWebhookEvents(events: unknown): WebhookEvent[] | null {
    if (events === undefined || events === null) {
        return null;
    }

    if (!Array.isArray(events)) {
        throw new Error('webhookEvents must be an array of supported event names');
    }

    const normalized = events.map((event) => {
        if (typeof event !== 'string') {
            throw new Error('webhookEvents must contain only strings');
        }
        return event.trim();
    }).filter(Boolean);

    for (const event of normalized) {
        if (!AGENT_EVENT_SET.has(event)) {
            throw new Error(`Unsupported webhook event: ${event}`);
        }
    }

    return [...new Set(normalized)] as WebhookEvent[];
}

export function parseStoredWebhookEvents(value: string | null | undefined): WebhookEvent[] {
    if (!value) return DEFAULT_WEBHOOK_EVENTS;

    try {
        return normalizeWebhookEvents(JSON.parse(value)) ?? DEFAULT_WEBHOOK_EVENTS;
    } catch {
        logger.warn('webhook_events_parse_failed', { value });
        return DEFAULT_WEBHOOK_EVENTS;
    }
}

export function serializeWebhookEvents(events: WebhookEvent[] | null): string | null {
    return events === null ? null : JSON.stringify(events);
}

export function webhookEventEnabled(storedEvents: string | null | undefined, event: WebhookEvent): boolean {
    return parseStoredWebhookEvents(storedEvents).includes(event);
}

function eventMatchesSocketSubscription(subscription: unknown, event: WebhookEvent): boolean {
    if (!Array.isArray(subscription) || subscription.length === 0) return true;
    return subscription.includes(event);
}

async function emitLiveAgentEvent(envelope: AgentEventEnvelope): Promise<boolean> {
    try {
        const { getIO } = await import('../ws/socket');
        const io = getIO();
        const sockets = await io.in(`agent:${envelope.wallet}`).fetchSockets();
        if (sockets.length === 0) return false;

        for (const socket of sockets) {
            if (!eventMatchesSocketSubscription(socket.data?.subscribedEvents, envelope.event)) {
                continue;
            }

            socket.emit('agent.event', envelope);
            socket.emit(envelope.event, envelope);
        }

        await markAgentEventDelivered(envelope.wallet, envelope.id).catch((error: any) => {
            logger.warn('agent_event_delivered_mark_failed', {
                eventId: envelope.id,
                error: error?.message || 'unknown',
            });
        });
        return true;
    } catch (error: any) {
        logger.warn('agent_event_ws_emit_failed', {
            eventId: envelope.id,
            event: envelope.event,
            error: error?.message || 'unknown',
        });
        return false;
    }
}

export function isValidWebhookUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

        const hostname = parsed.hostname.toLowerCase();
        if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '0.0.0.0' ||
            hostname === '::1' ||
            hostname.startsWith('10.') ||
            hostname.startsWith('192.168.') ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
            hostname.startsWith('169.254.')
        ) {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

function signPayload(payloadJson: string, secret: string | null): string {
    if (!secret) return '';
    return crypto.createHmac('sha256', secret).update(payloadJson, 'utf8').digest('hex');
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverWebhook(url: string, secret: string | null, payload: WebhookPayload): Promise<boolean> {
    const body = JSON.stringify(payload);
    const signature = signPayload(body, secret);

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 0;
        if (delay > 0) await sleep(delay);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'AIR-OTC-Webhook/1.0',
                    'X-Webhook-Event': payload.event,
                    'X-Webhook-Signature': signature,
                    'X-Webhook-Timestamp': payload.timestamp,
                    'x-webhook-event': payload.event,
                    'x-webhook-signature': signature,
                    'x-webhook-timestamp': payload.timestamp,
                },
                body,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });

            if (response.ok) {
                logger.info('webhook_delivered', {
                    event: payload.event,
                    status: response.status,
                    attempt: attempt + 1,
                });
                return true;
            }

            logger.warn('webhook_delivery_non_2xx', {
                event: payload.event,
                status: response.status,
                attempt: attempt + 1,
            });
        } catch (error: any) {
            logger.warn('webhook_delivery_failed', {
                event: payload.event,
                attempt: attempt + 1,
                error: error?.message || 'unknown',
            });
        }
    }

    return false;
}

export async function sendToAgent(
    wallet: string,
    event: WebhookEvent,
    data: Record<string, unknown> = {},
    ticketId?: string,
): Promise<boolean> {
    const envelope = await enqueueAgentEvent({
        wallet,
        event,
        payload: data,
        ticketId: ticketId || (typeof data.ticketId === 'string' ? data.ticketId : undefined),
        dealId: typeof data.dealId === 'string' ? data.dealId : undefined,
    });

    await emitLiveAgentEvent(envelope);
    await deliverAgentNotifications(envelope).catch((error: any) => {
        logger.warn('agent_notification_delivery_failed', {
            wallet,
            event,
            eventId: envelope.id,
            error: error?.message || 'unknown',
        });
    });

    const agent = await prisma.agent.findUnique({
        where: { wallet },
        select: {
            webhookUrl: true,
            webhookSecret: true,
            webhookEvents: true,
        },
    });

    if (!agent?.webhookUrl) return false;
    if (!webhookEventEnabled(agent.webhookEvents, event)) return false;

    if (!isValidWebhookUrl(agent.webhookUrl)) {
        logger.warn('webhook_invalid_url_skipped', { wallet, event, url: agent.webhookUrl });
        return false;
    }

    return deliverWebhook(agent.webhookUrl, agent.webhookSecret, {
        id: envelope.id,
        event,
        ticketId: envelope.ticketId,
        dealId: envelope.dealId,
        timestamp: envelope.timestamp,
        data,
    });
}

export async function notifyAgent(
    wallet: string,
    event: WebhookEvent,
    data: Record<string, unknown> = {},
    ticketId?: string,
): Promise<void> {
    await sendToAgent(wallet, event, data, ticketId);
}

export async function notifyAgents(
    wallets: string[],
    event: WebhookEvent,
    data: Record<string, unknown> = {},
    ticketId?: string,
): Promise<void> {
    const uniqueWallets = [...new Set(wallets.filter(Boolean))];
    await Promise.allSettled(uniqueWallets.map((wallet) => sendToAgent(wallet, event, data, ticketId)));
}

export async function notifyDealParties(
    ticketId: string,
    buyerWallet: string,
    sellerWallet: string,
    event: WebhookEvent,
    data: Record<string, unknown> = {},
): Promise<void> {
    await notifyAgents([buyerWallet, sellerWallet], event, data, ticketId);
}

export const webhooks = {
    dealMatched: (ticketId: string, buyer: string, seller: string, offer: any) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.matched', {
            offerId: offer.id,
            asset: offer.asset,
            price: offer.price,
            collateral: offer.collateral,
        }),

    dealExpiring: (ticketId: string, buyer: string, seller: string, data: Record<string, unknown>) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.expiring', data),

    newMessage: (ticketId: string, buyer: string, seller: string, message: any) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.message', {
            messageId: message.id,
            sender: message.sender,
            preview: message.content?.substring(0, 100),
        }),

    ticketMessage: (ticketId: string, recipient: string, message: any) =>
        notifyAgent(recipient, 'deal.message', {
            messageId: message.id,
            sender: message.sender,
            preview: message.content?.substring(0, 100),
        }, ticketId),

    dmReceived: (recipient: string, message: any) =>
        notifyAgent(recipient, 'dm.received', {
            messageId: message.id,
            fromWallet: message.fromWallet,
            contentType: message.contentType,
            ticketId: message.ticketId,
            encrypted: message.encrypted,
        }, message.ticketId || undefined),

    phaseChanged: (
        ticketId: string,
        buyer: string,
        seller: string,
        phase: Record<string, unknown>,
    ) => notifyDealParties(ticketId, buyer, seller, 'deal.phase_changed', phase),

    escrowCreated: (ticketId: string, buyer: string, seller: string, terms: Record<string, unknown>) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.escrow_created', terms),

    depositReceived: (ticketId: string, buyer: string, seller: string, deposit: Record<string, unknown>) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.deposit_received', deposit),

    deliveryConfirmed: (ticketId: string, buyer: string, seller: string, delivery: Record<string, unknown>) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.delivery_confirmed', delivery),

    dealCompleted: (ticketId: string, buyer: string, seller: string, data: Record<string, unknown> = {}) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.completed', data),

    dealCancelled: (ticketId: string, buyer: string, seller: string, reason: string) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.cancelled', { reason }),

    dealRefunded: (ticketId: string, buyer: string, seller: string) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.refunded', {}),

    positionFunded: (wallet: string, data: Record<string, unknown>) =>
        notifyAgent(wallet, 'position.funded', data, typeof data.ticketId === 'string' ? data.ticketId : undefined),

    positionFilled: (wallets: string[], data: Record<string, unknown>, ticketId?: string) =>
        notifyAgents(wallets, 'position.filled', data, ticketId),

    positionExpired: (wallet: string, data: Record<string, unknown>) =>
        notifyAgent(wallet, 'position.expired', data, typeof data.ticketId === 'string' ? data.ticketId : undefined),

    positionRefunded: (wallet: string, data: Record<string, unknown>) =>
        notifyAgent(wallet, 'position.refunded', data, typeof data.ticketId === 'string' ? data.ticketId : undefined),

    matchAwaitingResult: (wallets: string[], data: Record<string, unknown>, ticketId?: string) =>
        notifyAgents(wallets, 'match.awaiting_result', data, ticketId),

    matchSettled: (wallets: string[], data: Record<string, unknown>, ticketId?: string) =>
        notifyAgents(wallets, 'match.settled', data, ticketId),

    intentCreated: (wallet: string, data: Record<string, unknown>) =>
        notifyAgent(wallet, 'intent.created', data, typeof data.ticketId === 'string' ? data.ticketId : undefined),

    intentMatchAvailable: (wallet: string, data: Record<string, unknown>) =>
        notifyAgent(wallet, 'intent.match_available', data, typeof data.ticketId === 'string' ? data.ticketId : undefined),

    liquidityAvailable: (wallet: string, data: Record<string, unknown>) =>
        notifyAgent(wallet, 'liquidity.available', data, typeof data.ticketId === 'string' ? data.ticketId : undefined),

    reputationUpdate: (wallet: string, data: Record<string, unknown>) =>
        notifyAgent(wallet, 'reputation.update', data),
};
