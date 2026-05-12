import { logger } from '../lib/logger';
/**
 * Webhook Delivery Service
 * 
 * Sends push notifications to agents when deal events happen.
 * Agents configure their webhookUrl + webhookSecret during registration.
 * 
 * Events:
 *   - deal.matched       → Offer accepted, ticket created
 *   - deal.message       → New message in negotiation
 *   - deal.escrow_created → Both agreed, escrow on-chain
 *   - deal.deposit_received → SOL deposit detected
 *   - deal.delivery_confirmed → Seller delivered
 *   - deal.completed     → Funds released, deal done
 *   - deal.cancelled     → Deal cancelled or timed out
 *   - deal.refunded      → Funds refunded after timeout
 *
 * Security: Each webhook is HMAC-SHA256 signed with the agent's webhookSecret.
 * The receiving agent verifies: X-Webhook-Signature header.
 */

import crypto from 'crypto';
import { prisma } from '../lib/prisma';

interface WebhookPayload {
    event: string;
    ticketId: string;
    timestamp: string;
    data: Record<string, any>;
}

/**
 * Send a webhook to a specific agent wallet.
 */
async function sendToAgent(wallet: string, payload: WebhookPayload): Promise<boolean> {
    try {
        const agent = await prisma.agent.findUnique({
            where: { wallet },
            select: { webhookUrl: true, webhookSecret: true },
        });

        if (!agent?.webhookUrl) return false;

        const body = JSON.stringify(payload);

        // Sign the payload with the agent's webhook secret
        const signature = agent.webhookSecret
            ? crypto.createHmac('sha256', agent.webhookSecret).update(body).digest('hex')
            : '';

        const response = await fetch(agent.webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Event': payload.event,
                'X-Webhook-Signature': signature,
                'X-Webhook-Timestamp': payload.timestamp,
                'User-Agent': 'MeridianOTC-Webhook/1.0',
            },
            body,
            signal: AbortSignal.timeout(10000), // 10 second timeout
        });

        if (!response.ok) {
            logger.warn("warning", { detail: `[WEBHOOK] Failed for ${wallet}: ${response.status} ${response.statusText}` });
            return false;
        }

        logger.info(`[WEBHOOK] Delivered ${payload.event} to ${wallet.slice(0, 8)}...`);
        return true;
    } catch (err: any) {
        logger.warn("warning", { detail: `[WEBHOOK] Error sending to ${wallet.slice(0, 8)}...: ${err.message}` });
        return false;
    }
}

/**
 * Send a webhook event to both parties of a deal.
 */
export async function notifyDealParties(
    ticketId: string,
    buyerWallet: string,
    sellerWallet: string,
    event: string,
    data: Record<string, any> = {}
): Promise<void> {
    const payload: WebhookPayload = {
        event,
        ticketId,
        timestamp: new Date().toISOString(),
        data,
    };

    // Send to both parties in parallel — non-blocking, fire-and-forget
    await Promise.allSettled([
        sendToAgent(buyerWallet, payload),
        sendToAgent(sellerWallet, payload),
    ]);
}

/**
 * Send a webhook event to a single agent.
 */
export async function notifyAgent(
    wallet: string,
    event: string,
    data: Record<string, any> = {}
): Promise<void> {
    const payload: WebhookPayload = {
        event,
        ticketId: data.ticketId || '',
        timestamp: new Date().toISOString(),
        data,
    };

    await sendToAgent(wallet, payload);
}

/**
 * Convenience methods for specific deal events.
 */
export const webhooks = {
    dealMatched: (ticketId: string, buyer: string, seller: string, offer: any) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.matched', {
            asset: offer.asset,
            price: offer.price,
            collateral: offer.collateral,
        }),

    newMessage: (ticketId: string, buyer: string, seller: string, message: any) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.message', {
            sender: message.sender,
            preview: message.content?.substring(0, 100),
        }),

    escrowCreated: (ticketId: string, buyer: string, seller: string, terms: any) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.escrow_created', {
            terms,
        }),

    depositReceived: (ticketId: string, buyer: string, seller: string, deposit: any) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.deposit_received', {
            from: deposit.from,
            amount: deposit.amount,
        }),

    dealCompleted: (ticketId: string, buyer: string, seller: string) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.completed', {}),

    dealCancelled: (ticketId: string, buyer: string, seller: string, reason: string) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.cancelled', { reason }),

    dealRefunded: (ticketId: string, buyer: string, seller: string) =>
        notifyDealParties(ticketId, buyer, seller, 'deal.refunded', {}),
};
