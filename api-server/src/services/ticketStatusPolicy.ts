export const SUCCESSFUL_TICKET_STATUSES = ['completed'] as const;
export const TERMINAL_TICKET_STATUSES = ['completed', 'cancelled', 'disputed', 'refunded'] as const;
export const IN_PROGRESS_TICKET_STATUSES = ['negotiating', 'agreed'] as const;

export function isSuccessfulTicketStatus(status: string): boolean {
    return SUCCESSFUL_TICKET_STATUSES.includes(status as (typeof SUCCESSFUL_TICKET_STATUSES)[number]);
}

export function isTerminalTicketStatus(status: string): boolean {
    return TERMINAL_TICKET_STATUSES.includes(status as (typeof TERMINAL_TICKET_STATUSES)[number]);
}
