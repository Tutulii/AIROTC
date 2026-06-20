import dotenv from 'dotenv';
import app from './app';

import http from 'http';
import { initializeWebSocket } from './ws/socket';
import { initializeEventListener } from './solana/eventListener';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { ensureApiSchema } from './lib/ensureApiSchema';
import { startTransactionMonitor, stopTransactionMonitor } from './services/transactionMonitor';
import { shouldInitializeSolanaEventListener } from './config/solanaEventListener';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    try {
        await ensureApiSchema(prisma);
        const server = http.createServer(app);

        // Initialize WebSockets and Listeners
        initializeWebSocket(server);
        if (shouldInitializeSolanaEventListener()) {
            initializeEventListener();
        } else {
            logger.info('solana_event_listener_disabled', {
                reason: 'set ENABLE_SOLANA_EVENT_LISTENER=true to enable API-side Solana log subscriptions',
            });
        }

        // Start transaction monitoring (stale deal detection, settlement rate alerts)
        startTransactionMonitor();

        server.listen(PORT, () => {
            logger.info('server_started', {
                port: PORT,
                health: `http://localhost:${PORT}/health`,
                docs: `http://localhost:${PORT}/docs`,
                metrics: `http://localhost:${PORT}/v1/metrics`,
                env: process.env.NODE_ENV || 'development',
            });
        });

        // ══════════════════════════════════════
        // GRACEFUL SHUTDOWN
        // Handles SIGTERM (Docker/K8s) and SIGINT (Ctrl+C)
        // ══════════════════════════════════════
        let isShuttingDown = false;

        const gracefulShutdown = async (signal: string) => {
            if (isShuttingDown) return;
            isShuttingDown = true;

            logger.info('shutdown_initiated', { signal });

            // 1. Stop monitoring
            stopTransactionMonitor();

            // 2. Stop accepting new connections
            server.close(() => {
                logger.info('http_server_closed');
            });

            // 3. Give active requests 10 seconds to finish
            await new Promise(resolve => setTimeout(resolve, 10000));

            // 4. Disconnect database
            try {
                const { PrismaClient } = require('@prisma/client');
                const prisma = new PrismaClient();
                await prisma.$disconnect();
                logger.info('database_disconnected');
            } catch {
                // Already disconnected
            }

            logger.info('shutdown_complete');
            process.exit(0);
        };

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    } catch (error) {
        logger.error('server_start_failed', {}, error);
        process.exit(1);
    }
};

void startServer();
