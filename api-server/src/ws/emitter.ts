import { logger } from '../lib/logger';
import { getIO } from './socket';

/**
 * Centrally manages WebSocket broadcasting to guarantee logging and isolation.
 * To be used by Escrow, Deposit, Release, and Cancel services.
 */
export const emitToTicket = (ticketId: string, event: string, payload: any) => {
    try {
        const io = getIO();
        io.to(`ticket:${ticketId}`).emit(event, payload);
        logger.info("ws_event_emitted", {
            ticketId,
            event,
            status: payload.status
        });
    } catch (e: any) {
        logger.warn("ws_emit_failed", { ticketId, event, err: e.message });
    }
};
