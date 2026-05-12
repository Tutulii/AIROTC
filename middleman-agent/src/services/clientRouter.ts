/**
 * ClientRouter — Unified Message Routing Across All Channels
 * 
 * Single entry point for the agent's brain.
 * All clients (Discord, Telegram, X, WebSocket, REST) feed into this router.
 * The brain processes once, router formats response for each channel.
 * 
 * Inspired by ElizaOS's client-agnostic architecture.
 */

import { logger } from '../utils/logger';


// ─── Types ──────────────────────────────────────────────────

export type MessageSource = 'discord' | 'telegram' | 'twitter' | 'websocket' | 'rest' | 'internal';

export interface IncomingMessage {
    id: string;
    source: MessageSource;
    userId: string;
    userName?: string;
    channelId?: string;
    content: string;
    attachments?: string[];          // URLs
    replyToId?: string;
    metadata?: Record<string, any>;  // Source-specific data
    timestamp: Date;
}

export interface OutgoingResponse {
    content: string;
    embeds?: Array<{                 // Rich embeds (Discord/Telegram)
        title?: string;
        description?: string;
        color?: number;
        fields?: Array<{ name: string; value: string; inline?: boolean }>;
        image?: string;
    }>;
    buttons?: Array<{                // Inline buttons (Telegram/Discord)
        label: string;
        action: string;
        data?: string;
    }>;
    replyToId?: string;
    isPrivate?: boolean;             // DM vs channel
}

export type MessageHandler = (msg: IncomingMessage) => Promise<OutgoingResponse | null>;

// ─── Router ─────────────────────────────────────────────────

const handlers: MessageHandler[] = [];
const clientSenders = new Map<MessageSource, (response: OutgoingResponse, originalMsg: IncomingMessage) => Promise<void>>();

/**
 * Register a message handler (usually the brain/negotiation engine).
 * Handlers are called in order until one returns a response.
 */
export function registerHandler(handler: MessageHandler): void {
    handlers.push(handler);
    logger.debug('client_router_handler_registered', { total: handlers.length });
}

/**
 * Register a client's send function.
 * Each client (Discord, Telegram, etc.) registers how to send responses.
 */
export function registerClient(source: MessageSource, sender: (response: OutgoingResponse, originalMsg: IncomingMessage) => Promise<void>): void {
    clientSenders.set(source, sender);
    logger.info('client_registered', { source });
}

/**
 * Route an incoming message through all handlers.
 * Returns the response (if any) and sends it back via the source client.
 */
export async function routeMessage(msg: IncomingMessage): Promise<OutgoingResponse | null> {
    logger.debug('message_routed', { source: msg.source, user: msg.userId, content: msg.content.substring(0, 100) });

    // Emit event for logging/analytics
    logger.info('message_received', {
        source: msg.source,
        userId: msg.userId,
        contentLength: msg.content.length,
    });

    // Process through handlers
    let response: OutgoingResponse | null = null;
    for (const handler of handlers) {
        try {
            response = await handler(msg);
            if (response) break;
        } catch (err: any) {
            logger.error('handler_error', { source: msg.source, error: err.message });
        }
    }

    if (!response) {
        logger.debug('no_handler_response', { source: msg.source });
        return null;
    }

    // Send response back via the source client
    const sender = clientSenders.get(msg.source);
    if (sender) {
        try {
            await sender(response, msg);
        } catch (err: any) {
            logger.error('client_send_error', { source: msg.source, error: err.message });
        }
    }

    logger.info('message_sent', {
        source: msg.source,
        userId: msg.userId,
        responseLength: response.content.length,
    });

    return response;
}

/**
 * Broadcast a message to all registered clients.
 * Useful for announcements, deal updates, etc.
 */
export async function broadcast(
    content: string,
    opts: { excludeSources?: MessageSource[]; embeds?: OutgoingResponse['embeds'] } = {},
): Promise<void> {
    const response: OutgoingResponse = { content, embeds: opts.embeds };
    const fakeMsg: IncomingMessage = {
        id: 'broadcast',
        source: 'internal',
        userId: 'system',
        content: '',
        timestamp: new Date(),
    };

    for (const [source, sender] of clientSenders) {
        if (opts.excludeSources?.includes(source)) continue;
        try {
            await sender(response, fakeMsg);
        } catch (err: any) {
            logger.error('broadcast_error', { source, error: err.message });
        }
    }
}

/**
 * Get list of active client channels.
 */
export function getActiveClients(): MessageSource[] {
    return Array.from(clientSenders.keys());
}
