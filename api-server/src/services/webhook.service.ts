import { notifyAgent, notifyAgents, webhooks, type WebhookEvent } from './webhookDelivery';

export type { WebhookEvent };

type LegacyWebhookEvent = 'new_message' | 'deal_update' | 'reputation_update';

function mapLegacyEvent(event: LegacyWebhookEvent): WebhookEvent {
    if (event === 'new_message') return 'deal.message';
    if (event === 'reputation_update') return 'reputation.update';
    return 'deal.phase_changed';
}

export function sendWebhookToWallet(
    wallet: string,
    event: LegacyWebhookEvent | WebhookEvent,
    data: Record<string, unknown>,
): void {
    void notifyAgent(wallet, event.includes('.') ? event as WebhookEvent : mapLegacyEvent(event as LegacyWebhookEvent), data, data.ticketId as string | undefined);
}

export function sendWebhookToWallets(
    wallets: string[],
    event: LegacyWebhookEvent | WebhookEvent,
    data: Record<string, unknown>,
): void {
    void notifyAgents(wallets, event.includes('.') ? event as WebhookEvent : mapLegacyEvent(event as LegacyWebhookEvent), data, data.ticketId as string | undefined);
}

export function webhookNewMessage(params: {
    ticketId: string;
    messageId: string;
    sender: string;
    content: string;
    buyerWallet: string;
    sellerWallet: string;
}): void {
    const recipients = [params.buyerWallet, params.sellerWallet].filter(
        (wallet) => wallet !== params.sender
    );

    const data = {
        ticketId: params.ticketId,
        messageId: params.messageId,
        sender: params.sender,
        preview: params.content.substring(0, 100),
    };

    void notifyAgents(recipients, 'deal.message', data, params.ticketId);
}

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

    let event: WebhookEvent = 'deal.phase_changed';
    if (params.event === 'released') event = 'deal.completed';
    if (params.event === 'cancelled') event = 'deal.cancelled';
    if (params.event === 'buyer_deposit' || params.event === 'seller_deposit' || params.event === 'funded') {
        event = 'deal.deposit_received';
    }
    if (params.event === 'deal_created') event = 'deal.escrow_created';

    void notifyAgents(params.participantWallets, event, data, params.dealId);
}

export function webhookReputationUpdate(params: {
    wallet: string;
    oldScore: number;
    newScore: number;
    dealId: string;
    outcome: 'success' | 'cancelled';
}): void {
    void webhooks.reputationUpdate(params.wallet, {
        wallet: params.wallet,
        previousScore: params.oldScore,
        newScore: params.newScore,
        dealId: params.dealId,
        outcome: params.outcome,
    });
}
