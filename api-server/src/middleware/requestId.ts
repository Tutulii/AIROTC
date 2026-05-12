/**
 * Request ID Middleware — Assigns a unique ID to every HTTP request.
 *
 * Enables:
 * - End-to-end tracing across logs, errors, and webhook deliveries
 * - Correlation between API server → Middleman forwarding
 *
 * Uses crypto.randomUUID() for high-entropy, collision-free IDs.
 * Respects incoming X-Request-ID header if provided (for distributed tracing).
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../lib/logger';

// Extend Express Request type
declare global {
    namespace Express {
        interface Request {
            requestId?: string;
        }
    }
}

export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    // Accept upstream request ID or generate one
    // Sanitize to prevent XSS injection via header reflection
    const rawId = req.headers['x-request-id'] as string | undefined;
    const SAFE_ID_PATTERN = /^[a-zA-Z0-9\-_]{1,128}$/;
    const requestId = (rawId && SAFE_ID_PATTERN.test(rawId)) ? rawId : crypto.randomUUID();
    req.requestId = requestId;

    // Attach to response headers for client-side correlation
    res.setHeader('X-Request-ID', requestId);

    next();
};

/**
 * HTTP Request Logger Middleware — Structured replacement for console.log.
 *
 * Logs: method, path, status code, duration, content-length.
 * Uses the structured logger with requestId correlation.
 */
export const httpLogger = (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

        const log = logger.child({ requestId: req.requestId });
        log[level]('http_request', {
            method: req.method,
            path: req.originalUrl,
            status,
            duration_ms: duration,
            content_length: res.getHeader('content-length') || 0,
            user_agent: req.headers['user-agent']?.substring(0, 100),
            ip: req.ip,
        });
    });

    next();
};
