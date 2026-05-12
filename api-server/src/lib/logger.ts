/**
 * Structured Logger — API Server
 *
 * Production-grade logging mirroring the Middleman agent's Pino-powered logger.
 *
 * Features:
 * - Pino transport: JSON in production, pino-pretty in dev
 * - Ring buffer for SSE/WebSocket log streaming to Observatory
 * - Request ID correlation on every line
 * - Child loggers via .child() for scoped context
 * - Alert severity levels for transaction monitoring
 */

import pino from 'pino';
import type { Level } from 'pino';

// ═══════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info') as Level;
const RING_BUFFER_SIZE = parseInt(process.env.LOG_RING_BUFFER_SIZE || '500', 10);
const IS_DEV = process.env.NODE_ENV !== 'production';

// ═══════════════════════════════════════════════════════
// PINO INSTANCE
// ═══════════════════════════════════════════════════════

const pinoInstance = pino({
    level: LOG_LEVEL,
    transport: IS_DEV
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
        : undefined,
    base: { service: 'api-server', pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
        err: pino.stdSerializers.err,
        req: (req) => ({
            method: req.method,
            url: req.url,
            remoteAddress: req.socket?.remoteAddress,
        }),
    },
});

// ═══════════════════════════════════════════════════════
// RING BUFFER — Exposes recent logs for SSE streaming
// ═══════════════════════════════════════════════════════

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface LogEntry {
    level: LogLevel;
    event: string;
    timestamp: number;
    service: string;
    requestId?: string;
    severity?: AlertSeverity;
    context?: Record<string, any>;
}

class LogRingBuffer {
    private buffer: LogEntry[] = [];
    private maxSize: number;
    private subscribers: Set<(entry: LogEntry) => void> = new Set();

    constructor(maxSize: number) {
        this.maxSize = maxSize;
    }

    push(entry: LogEntry): void {
        this.buffer.push(entry);
        if (this.buffer.length > this.maxSize) {
            this.buffer.shift();
        }
        for (const sub of this.subscribers) {
            try { sub(entry); } catch { /* never block */ }
        }
    }

    getRecent(count: number = 50): LogEntry[] {
        return this.buffer.slice(-count);
    }

    getAlerts(severity?: AlertSeverity): LogEntry[] {
        return this.buffer.filter(e => e.severity && (!severity || e.severity === severity));
    }

    subscribe(callback: (entry: LogEntry) => void): () => void {
        this.subscribers.add(callback);
        return () => { this.subscribers.delete(callback); };
    }

    get size(): number { return this.buffer.length; }
}

export const logDrain = new LogRingBuffer(RING_BUFFER_SIZE);

// ═══════════════════════════════════════════════════════
// STRUCTURED LOGGER CLASS
// ═══════════════════════════════════════════════════════

interface LogContext {
    requestId?: string;
    severity?: AlertSeverity;
    [key: string]: any;
}

class StructuredLogger {
    private baseContext: LogContext = {};

    /** Create a child logger with persistent context fields */
    child(context: LogContext): StructuredLogger {
        const child = new StructuredLogger();
        child.baseContext = { ...this.baseContext, ...context };
        return child;
    }

    private emit(level: LogLevel, event: string, context?: LogContext, error?: unknown): void {
        const merged = { ...this.baseContext, ...context };

        const entry: LogEntry = {
            level,
            event,
            timestamp: Date.now(),
            service: 'api-server',
        };

        if (merged.requestId) { entry.requestId = merged.requestId; delete merged.requestId; }
        if (merged.severity) { entry.severity = merged.severity; delete merged.severity; }

        if (error) {
            merged.error_message = error instanceof Error ? error.message : String(error);
            if (level === 'error' && error instanceof Error) {
                merged.error_stack = error.stack;
            }
        }

        if (Object.keys(merged).length > 0) {
            entry.context = merged;
        }

        logDrain.push(entry);

        const payload = { event, ...entry.context, requestId: entry.requestId };
        switch (level) {
            case 'debug': pinoInstance.debug(payload, event); break;
            case 'info': pinoInstance.info(payload, event); break;
            case 'warn': pinoInstance.warn(payload, event); break;
            case 'error': pinoInstance.error(payload, event); break;
        }
    }

    debug(event: string, context?: LogContext): void { this.emit('debug', event, context); }
    info(event: string, context?: LogContext): void { this.emit('info', event, context); }
    warn(event: string, context?: LogContext, error?: unknown): void { this.emit('warn', event, context, error); }
    error(event: string, context?: LogContext, error?: unknown): void { this.emit('error', event, context, error); }
}

export const logger = new StructuredLogger();
