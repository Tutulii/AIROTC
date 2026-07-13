const LIVE_CHANNELS = ['websocket', 'webhook', 'mcp'] as const;
const LIVE_AND_TELEGRAM_CHANNELS = ['websocket', 'webhook', 'mcp', 'telegram'] as const;

export const AGENT_EVENT_CATALOG = [
    {
        event: 'deal.matched',
        description: 'An offer was accepted and a ticket/deal was opened.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'deal.expiring',
        description: 'A ticket is close to timeout and needs agent action.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'deal.message',
        description: 'A new ticket negotiation message was sent.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'dm.received',
        description: 'A direct message was received from another agent.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'deal.phase_changed',
        description: 'A deal changed phase or ticket status.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'deal.escrow_created',
        description: 'An escrow address was generated for a deal.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'deal.deposit_received',
        description: 'A required buyer or seller deposit was observed.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'deal.delivery_confirmed',
        description: 'Delivery was confirmed during the deal lifecycle.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'deal.completed',
        description: 'A deal completed successfully.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'deal.cancelled',
        description: 'A deal was cancelled.',
        channels: LIVE_CHANNELS,
    },
    {
        event: 'deal.refunded',
        description: 'A deal was refunded.',
        channels: LIVE_CHANNELS,
    },
    {
        event: 'position.funded',
        description: 'A SPORT position stake was locked and became live liquidity.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'position.filled',
        description: 'A SPORT position was filled or partially filled against another agent.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'position.expired',
        description: 'A SPORT position expired before being filled.',
        channels: LIVE_CHANNELS,
    },
    {
        event: 'position.refunded',
        description: 'Unmatched SPORT position liquidity was refunded.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'match.awaiting_result',
        description: 'A SPORT match/ticket is funded and waiting for the TxLINE result.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'match.settled',
        description: 'A SPORT match was settled from a TxLINE final result.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'intent.created',
        description: 'A SPORT discovery intent was registered for future liquidity matching.',
        channels: LIVE_CHANNELS,
    },
    {
        event: 'intent.match_available',
        description: 'A funded SPORT position is available for one of the agent wallet intents.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'liquidity.available',
        description: 'New SPORT liquidity became available for a subscribed fixture/selection/side.',
        channels: LIVE_AND_TELEGRAM_CHANNELS,
    },
    {
        event: 'reputation.update',
        description: 'An agent reputation score changed.',
        channels: LIVE_CHANNELS,
    },
] as const;

export type AgentEventName = typeof AGENT_EVENT_CATALOG[number]['event'];

export const WEBHOOK_EVENTS = AGENT_EVENT_CATALOG.map((item) => item.event) as AgentEventName[];
export const DEFAULT_WEBHOOK_EVENTS: AgentEventName[] = [...WEBHOOK_EVENTS];
export const AGENT_EVENT_SET = new Set<string>(WEBHOOK_EVENTS);
export const TELEGRAM_NOTIFICATION_EVENTS = AGENT_EVENT_CATALOG
    .filter((item) => (item.channels as readonly string[]).includes('telegram'))
    .map((item) => item.event) as AgentEventName[];

export const LEGACY_WS_EVENT_ALIASES: Partial<Record<AgentEventName, string[]>> = {
    'dm.received': ['dm_received'],
    'deal.message': ['new_message', 'ticket_message_received'],
    'deal.phase_changed': ['deal_phase_changed', 'ticket_status_changed'],
    'deal.expiring': ['deal_expiring'],
    'deal.escrow_created': ['deal_phase_changed'],
    'deal.deposit_received': ['deal_phase_changed'],
    'deal.delivery_confirmed': ['deal_phase_changed'],
    'deal.completed': ['deal_phase_changed'],
    'deal.cancelled': ['deal_phase_changed'],
    'deal.refunded': ['deal_phase_changed'],
    'position.funded': ['position_funded'],
    'position.filled': ['position_filled'],
    'position.expired': ['position_expired'],
    'position.refunded': ['position_refunded'],
    'match.awaiting_result': ['match_awaiting_result'],
    'match.settled': ['match_settled'],
    'intent.created': ['intent_created'],
    'intent.match_available': ['intent_match_available'],
    'liquidity.available': ['liquidity_available'],
    'reputation.update': ['reputation_update'],
};

export function normalizeAgentEventNames(events: unknown): AgentEventName[] | null {
    if (events === undefined || events === null || events === '') {
        return null;
    }

    const items = Array.isArray(events)
        ? events
        : typeof events === 'string'
            ? events.split(',')
            : null;

    if (!items) {
        throw new Error('events must be an array or comma-separated string');
    }

    const normalized = items
        .map((event) => {
            if (typeof event !== 'string') {
                throw new Error('events must contain only strings');
            }
            return event.trim();
        })
        .filter(Boolean);

    for (const event of normalized) {
        if (!AGENT_EVENT_SET.has(event)) {
            throw new Error(`Unsupported event: ${event}`);
        }
    }

    return [...new Set(normalized)] as AgentEventName[];
}
