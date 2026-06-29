export const AGENT_EVENT_CATALOG = [
    {
        event: 'deal.matched',
        description: 'An offer was accepted and a ticket/deal was opened.',
        channels: ['websocket', 'webhook', 'mcp'],
    },
    {
        event: 'deal.expiring',
        description: 'A ticket is close to timeout and needs agent action.',
        channels: ['websocket', 'webhook', 'mcp'],
    },
    {
        event: 'deal.message',
        description: 'A new ticket negotiation message was sent.',
        channels: ['websocket', 'webhook', 'mcp'],
    },
    {
        event: 'dm.received',
        description: 'A direct message was received from another agent.',
        channels: ['websocket', 'webhook', 'mcp'],
    },
    {
        event: 'deal.phase_changed',
        description: 'A deal changed phase or ticket status.',
        channels: ['websocket', 'webhook', 'mcp'],
    },
    {
        event: 'deal.escrow_created',
        description: 'An escrow address was generated for a deal.',
        channels: ['websocket', 'webhook', 'mcp'],
    },
    {
        event: 'deal.deposit_received',
        description: 'A required buyer or seller deposit was observed.',
        channels: ['websocket', 'webhook', 'mcp'],
    },
    {
        event: 'deal.delivery_confirmed',
        description: 'Delivery was confirmed during the deal lifecycle.',
        channels: ['websocket', 'webhook', 'mcp'],
    },
    {
        event: 'deal.completed',
        description: 'A deal completed successfully.',
        channels: ['websocket', 'webhook', 'mcp'],
    },
    {
        event: 'deal.cancelled',
        description: 'A deal was cancelled.',
        channels: ['websocket', 'webhook', 'mcp'],
    },
    {
        event: 'deal.refunded',
        description: 'A deal was refunded.',
        channels: ['websocket', 'webhook', 'mcp'],
    },
    {
        event: 'reputation.update',
        description: 'An agent reputation score changed.',
        channels: ['websocket', 'webhook', 'mcp'],
    },
] as const;

export type AgentEventName = typeof AGENT_EVENT_CATALOG[number]['event'];

export const WEBHOOK_EVENTS = AGENT_EVENT_CATALOG.map((item) => item.event) as AgentEventName[];
export const DEFAULT_WEBHOOK_EVENTS: AgentEventName[] = [...WEBHOOK_EVENTS];
export const AGENT_EVENT_SET = new Set<string>(WEBHOOK_EVENTS);

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
