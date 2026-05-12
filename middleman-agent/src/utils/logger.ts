/**
 * Structured Logger — Pino-powered with Ring Buffer Drain
 *
 * Production-grade structured logging:
 * - Pino transport for high-perf JSON output
 * - Ring buffer (configurable via LOG_RING_BUFFER_SIZE) for SSE streaming
 * - Correlation IDs: ticket_id, deal_id, agent_id, correlation_id on every line
 * - Environment-aware: pretty in dev, JSON in prod
 * - Zero breaking changes to existing .info()/.warn()/.error() API
 */

import pino from "pino";

// ==========================================
// CONFIGURATION
// ==========================================

const LOG_LEVEL = (process.env.LOG_LEVEL || "info") as pino.Level;
const RING_BUFFER_SIZE = parseInt(process.env.LOG_RING_BUFFER_SIZE || "500", 10);
const IS_DEV = process.env.NODE_ENV !== "production";
const ENABLE_PRETTY_LOGS = process.env.ENABLE_PRETTY_LOGS === "true";

// ==========================================
// PINO INSTANCE
// ==========================================

const pinoLogger = pino({
  level: LOG_LEVEL,
  transport: IS_DEV && ENABLE_PRETTY_LOGS
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } }
    : undefined,
  base: { service: "middleman-agent", pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ==========================================
// RING BUFFER LOG DRAIN
// ==========================================

export type LogLevel = "debug" | "info" | "warn" | "error";

export type AlertSeverity = "info" | "warning" | "critical";

export interface LogEntry {
  level: LogLevel;
  event: string;
  timestamp: number;
  service: string;
  ticket_id?: string;
  deal_id?: string;
  agent_id?: string;
  correlation_id?: string;
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
    // Notify all SSE subscribers
    for (const subscriber of this.subscribers) {
      try {
        subscriber(entry);
      } catch {
        // Subscriber error — do not block logging
      }
    }
  }

  getRecent(count: number = 50): LogEntry[] {
    return this.buffer.slice(-count);
  }

  subscribe(callback: (entry: LogEntry) => void): () => void {
    this.subscribers.add(callback);
    return () => { this.subscribers.delete(callback); };
  }

  get size(): number {
    return this.buffer.length;
  }
}

export const logDrain = new LogRingBuffer(RING_BUFFER_SIZE);

// ==========================================
// STRUCTURED LOGGER (API-Compatible Wrapper)
// ==========================================

interface LogContext {
  ticket_id?: string;
  deal_id?: string;
  agent_id?: string;
  correlation_id?: string;
  severity?: AlertSeverity;
  [key: string]: any;
}

class StructuredLogger {
  private baseContext: LogContext = {};

  public withContext(context: LogContext): StructuredLogger {
    const scopedLogger = new StructuredLogger();
    scopedLogger.baseContext = { ...this.baseContext, ...context };
    return scopedLogger;
  }

  private emit(level: LogLevel, event: string, context?: LogContext, error?: unknown): void {
    const mergedContext = { ...this.baseContext, ...context };

    // Build the structured log entry
    const entry: LogEntry = {
      level,
      event,
      timestamp: Date.now(),
      service: "middleman-agent",
    };

    // Extract first-class correlation fields
    if (mergedContext.ticket_id) { entry.ticket_id = mergedContext.ticket_id; delete mergedContext.ticket_id; }
    if (mergedContext.deal_id) { entry.deal_id = mergedContext.deal_id; delete mergedContext.deal_id; }
    if (mergedContext.agent_id) { entry.agent_id = mergedContext.agent_id; delete mergedContext.agent_id; }
    if (mergedContext.correlation_id) { entry.correlation_id = mergedContext.correlation_id; delete mergedContext.correlation_id; }
    if (mergedContext.severity) { entry.severity = mergedContext.severity; delete mergedContext.severity; }

    // Attach error info
    if (error) {
      mergedContext.error_message = error instanceof Error ? error.message : String(error);
      if (level === "error" && error instanceof Error) {
        mergedContext.error_stack = error.stack;
      }
    }

    // Remaining context
    if (Object.keys(mergedContext).length > 0) {
      entry.context = mergedContext;
    }

    // Push to ring buffer for SSE streaming
    logDrain.push(entry);

    // Pipe to Pino for file/stdout output
    const pinoPayload = { event, ...entry.context, ticket_id: entry.ticket_id, deal_id: entry.deal_id, agent_id: entry.agent_id, correlation_id: entry.correlation_id };
    switch (level) {
      case "debug": pinoLogger.debug(pinoPayload, event); break;
      case "info": pinoLogger.info(pinoPayload, event); break;
      case "warn": pinoLogger.warn(pinoPayload, event); break;
      case "error": pinoLogger.error(pinoPayload, event); break;
    }
  }

  public debug(event: string, context?: LogContext): void { this.emit("debug", event, context); }
  public info(event: string, context?: LogContext): void { this.emit("info", event, context); }
  public warn(event: string, context?: LogContext, error?: unknown): void { this.emit("warn", event, context, error); }
  public error(event: string, context?: LogContext, error?: unknown): void { this.emit("error", event, context, error); }
}

export const logger = new StructuredLogger();
