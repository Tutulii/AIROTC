import { logger } from '../lib/logger';
import { Socket } from 'socket.io';
import { getTicketByIdService } from '../services/ticket.service';
import { ackAgentEvent, ackAgentEvents, listAgentEvents } from '../services/agentEventInbox';
import { normalizeAgentEventNames } from '../services/eventCatalog';

export const handleJoinTicket = async (socket: Socket, payload: any) => {
    try {
        const { ticketId } = payload;
        const wallet = socket.data.wallet;

        if (!ticketId || typeof ticketId !== 'string') {
            socket.emit('error', { message: 'Invalid ticketId' });
            return;
        }

        const roomName = `ticket:${ticketId}`;

        // Duplicate join protection
        if (socket.rooms.has(roomName)) {
            return;
        }

        // Utilize robust validated read from the service to guarantee participation
        await getTicketByIdService(ticketId, wallet);

        // Join successful
        socket.join(roomName);
        logger.info("info", { detail: { detail: `[WS] ${wallet} listening to ticket ${ticketId}` } });

        socket.emit('joined_ticket', { ticketId });
    } catch (error: any) {
        // Disconnect or push warning depending on unauthorized condition
        logger.error("error", { detail: error.message });
        socket.emit('error', { message: error.message || 'Unauthorized or ticket unavailable' });
    }
};

export const handleTyping = (socket: Socket, payload: any) => {
    try {
        const { ticketId, isTyping } = payload;
        const wallet = socket.data.wallet;

        if (!ticketId || typeof ticketId !== 'string') return;

        const roomName = `ticket:${ticketId}`;

        // 0-DB Access Check: Native room validation
        if (!socket.rooms.has(roomName)) return;

        socket.to(roomName).emit('typing', {
            ticketId,
            sender: wallet,
            isTyping: !!isTyping,
            timestamp: new Date().toISOString()
        });

        logger.info(`[WS EVENT] Typing event`, { ticketId, sender: wallet });
    } catch (e: any) {
        logger.warn("warning");
    }
};

export const handleReadMessages = (socket: Socket, payload: any) => {
    try {
        const { ticketId, messageIds } = payload;
        const wallet = socket.data.wallet;

        if (!ticketId || typeof ticketId !== 'string' || !Array.isArray(messageIds)) return;

        const roomName = `ticket:${ticketId}`;

        if (!socket.rooms.has(roomName)) return;

        // TODO: persist read receipts in DB
        socket.to(roomName).emit('messages_read', {
            ticketId,
            reader: wallet,
            messageIds,
            timestamp: new Date().toISOString()
        });

        logger.info(`[WS EVENT] Read receipt`, { ticketId, reader: wallet });
    } catch (e: any) {
        logger.warn("warning");
    }
};

export const replayAgentEventsToSocket = async (socket: Socket, payload: any = {}) => {
    try {
        const wallet = socket.data.wallet;
        const subscribedEvents = Array.isArray(socket.data.subscribedEvents) ? socket.data.subscribedEvents : undefined;
        const result = await listAgentEvents(wallet, {
            events: payload.events ?? subscribedEvents,
            since: payload.replayFrom,
            cursor: payload.cursor,
            limit: payload.limit ?? 100,
            includeAcked: payload.includeAcked === true,
        });

        socket.emit('events.replay', result);
    } catch (error: any) {
        logger.warn('ws_event_replay_failed', {
            wallet: socket.data.wallet,
            error: error?.message || 'unknown',
        });
        socket.emit('events.error', { message: error?.message || 'Failed to replay events' });
    }
};

export const handleSubscribe = async (socket: Socket, payload: any) => {
    try {
        const events = normalizeAgentEventNames(payload?.events);
        socket.data.subscribedEvents = events ?? [];
        socket.emit('subscribed', {
            events: events ?? 'all',
            timestamp: new Date().toISOString(),
        });

        await replayAgentEventsToSocket(socket, {
            replayFrom: payload?.replayFrom,
            cursor: payload?.cursor,
            limit: payload?.limit,
            includeAcked: payload?.includeAcked,
        });
    } catch (error: any) {
        socket.emit('events.error', { message: error?.message || 'Invalid subscription' });
    }
};

export const handleAckEvent = async (socket: Socket, payload: any) => {
    try {
        const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
        if (!id) {
            socket.emit('events.error', { message: 'id is required' });
            return;
        }

        const acked = await ackAgentEvent(socket.data.wallet, id);
        socket.emit('event.ack', { id, acked, timestamp: new Date().toISOString() });
    } catch (error: any) {
        socket.emit('events.error', { message: error?.message || 'Failed to ACK event' });
    }
};

export const handleAckEvents = async (socket: Socket, payload: any) => {
    try {
        const eventIds = Array.isArray(payload?.eventIds) ? payload.eventIds : [];
        const ids = eventIds.filter((id: unknown): id is string => typeof id === 'string');
        const result = await ackAgentEvents(socket.data.wallet, ids);
        socket.emit('events.ack', { ...result, timestamp: new Date().toISOString() });
    } catch (error: any) {
        socket.emit('events.error', { message: error?.message || 'Failed to ACK events' });
    }
};
