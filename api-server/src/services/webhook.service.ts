import { logger } from '../lib/logger';
import crypto from 'crypto';
import axios from 'axios';
import { prisma } from '../lib/prisma';

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

export type WebhookEvent = 'new_message' | 'deal_update' | 'reputation_update';

interface WebhookPayload {
    event: WebhookEvent;
    timestamp: string;
    data: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const TIMEOUT_MS = 3000;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [0, 500, 1500];

// ─────────────────────────────────────────────────────────
// SIGNATURE
// ─────────────────────────────────────────────────────────

function signPayload(payloadJson: string, secret: string): string {
    return crypto
        .createHmac('sha256', secret)
        .update(payloadJson, 'utf-8')
        .digest('hex');
}

// ─────────────────────────────────────────────────────────
// URL VALIDATION
// ─────────────────────────────────────────────────────────

function isValidWebhookUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

        // Block private/internal IPs (basic guard)
        const hostname = parsed.hostname;
        if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '0.0.0.0' ||
            hostname.startsWith('10.') ||
            hostname.startsWith('172.') ||
            hostname.startsWith('192.168.') ||
            hostname === '::1'
        ) {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────────────────
// DELIVERY ENGINE (with retry)
// ─────────────────────────────────────────────────────────

async function deliverWebhook(
    url: string,
    payload: WebhookPayload,
    secret: string | null
): Promise<void> {
    const payloadJson = JSON.stringify(payload);

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'AgentOTC-Webhook/1.0',
    };

    // Sign if secret is available; always attach header
    if (secret) {
        headers['x-webhook-signature'] = signPayload(payloadJson, secret);
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        // Apply backoff delay
        const delay = RETRY_DELAYS_MS[attempt] ?? 0;
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        try {
            const response = await axios.post(url, payloadJson, {
                headers,
                timeout: TIMEOUT_MS,
                validateStatus: (status: number) => status >= 200 && status < 300,
            });

            logger.info(
                `[WEBHOOK] Event: ${payload.event} | Target: ${url} | Status: ${response.status} | Attempt: ${attempt + 1}`
            );
            return; // Success — exit loop
        } catch (error: any) {
            const statusCode = error.response?.status ?? 'NETWORK_ERROR';
            const errorMsg = error.message || 'Unknown error';

            if (attempt < MAX_RETRIES - 1) {
                logger.warn(
                    `[WEBHOOK RETRY] Event: ${payload.event} | Target: ${url} | Attempt: ${attempt + 1}/${MAX_RETRIES} | Status: ${statusCode} | Error: ${errorMsg}`
                );
            } else {
                logger.error(
                    `[WEBHOOK FAILED] Event: ${payload.event} | Target: ${url} | All ${MAX_RETRIES} attempts exhausted | Last error: ${errorMsg}`
                );
            }
        }
    }
}

// ─────────────────────────────────────────────────────────
// PUBLIC API — Fire-and-forget dispatchers
// ─────────────────────────────────────────────────────────

/**
 * Send a webhook to a specific wallet's registered endpoint.
 * Non-blocking: errors are logged, never thrown.
 */
export function sendWebhookToWallet(
    wallet: string,
    event: WebhookEvent,
    data: Record<string, unknown>
): void {
    // Fire-and-forget — intentionally not awaited
    void (async () => {
        try {
            const agent = await prisma.agent.findUnique({
                where: { wallet },
                select: { webhookUrl: true, webhookSecret: true },
            });

            if (!agent?.webhookUrl) return; // No webhook configured — silent skip

            if (!isValidWebhookUrl(agent.webhookUrl)) {
                logger.warn("warning", { detail: { detail: `[WEBHOOK SKIP] Invalid URL for wallet ${wallet}: ${agent.webhookUrl}` } });
                return;
            }

            const payload: WebhookPayload = {
                event,
                timestamp: new Date().toISOString(),
                data,
            };

            await deliverWebhook(agent.webhookUrl, payload, agent.webhookSecret);
        } catch (error: any) {
            logger.error("error", { detail: error.message });
        }
    })();
}

/**
 * Send a webhook to multiple wallets simultaneously.
 * Non-blocking: errors per-wallet are logged independently.
 */
export function sendWebhookToWallets(
    wallets: string[],
    event: WebhookEvent,
    data: Record<string, unknown>
): void {
    for (const wallet of wallets) {
        sendWebhookToWallet(wallet, event, data);
    }
}

// ─────────────────────────────────────────────────────────
// CONVENIENCE DISPATCHERS (called from integration points)
// ─────────────────────────────────────────────────────────

/**
 * Trigger: After a new message is created in a ticket.
 * Recipients: Both buyer and seller wallets.
 */
export function webhookNewMessage(params: {
    ticketId: string;
    messageId: string;
    sender: string;
    content: string;
    buyerWallet: string;
    sellerWallet: string;
}): void {
    const data = {
        ticketId: params.ticketId,
        messageId: params.messageId,
        sender: params.sender,
        content: params.content,
    };

    // Notify the OTHER party (not the sender)
    const recipients = [params.buyerWallet, params.sellerWallet].filter(
        w => w !== params.sender
    );
    sendWebhookToWallets(recipients, 'new_message', data);
}

/**
 * Trigger: After an on-chain deal event (created, funded, released, cancelled).
 * Recipients: All deal participants.
 */
export function webhookDealUpdate(params: {
    dealId: string;
    event: string;
    actor: string;
    amount?: string;
    signature: string;
    timestamp: string;
    participantWallets: string[];
}): void {
    const data = {
        dealId: params.dealId,
        action: params.event,
        actor: params.actor,
        amount: params.amount ?? null,
        txSignature: params.signature,
        onChainTimestamp: params.timestamp,
    };

    sendWebhookToWallets(params.participantWallets, 'deal_update', data);
}

/**
 * Trigger: After reputation score recalculation.
 * Recipients: The wallet whose reputation changed.
 */
export function webhookReputationUpdate(params: {
    wallet: string;
    oldScore: number;
    newScore: number;
    dealId: string;
    outcome: 'success' | 'cancelled';
}): void {
    const data = {
        wallet: params.wallet,
        previousScore: params.oldScore,
        newScore: params.newScore,
        dealId: params.dealId,
        outcome: params.outcome,
    };

    sendWebhookToWallet(params.wallet, 'reputation_update', data);
}
