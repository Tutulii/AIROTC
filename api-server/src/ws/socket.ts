import { logger } from '../lib/logger';
import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { socketAuthenticate } from './auth';
import { handleJoinTicket, handleTyping, handleReadMessages } from './handlers';

let io: Server;

export const initializeWebSocket = (server: HttpServer): Server => {
    io = new Server(server, {
        cors: {
            origin: '*',
        }
    });

    // Mount Auth Middleware
    io.use(socketAuthenticate);

    io.on('connection', (socket: Socket) => {
        const wallet = socket.data.wallet;
        socket.join(`agent:${wallet}`);
        logger.info("info", { detail: `[WS] Connected: ${wallet} (Socket ID: ${socket.id})` });

        socket.on('join_ticket', (payload) => handleJoinTicket(socket, payload));
        socket.on('typing', (payload) => handleTyping(socket, payload));
        socket.on('read_messages', (payload) => handleReadMessages(socket, payload));

        socket.on('disconnect', () => {
            logger.info("info", { detail: `[WS] Disconnected: ${wallet}` });
        });
    });

    return io;
};

export const getIO = () => {
    if (!io) {
        throw new Error('Socket.io has not been initialized');
    }
    return io;
};
