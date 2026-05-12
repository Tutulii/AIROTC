import { logger } from '../lib/logger';
import { Socket } from 'socket.io';
import { getTicketByIdService } from '../services/ticket.service';

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
