/**
 * Global Error Handler — Structured error logging with request context.
 *
 * Replaces raw console.error with structured Pino output including:
 * - Request ID for correlation
 * - Error stack traces (production-safe)
 * - HTTP method + path for context
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';

export const errorHandler = (
    err: Error,
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const log = logger.child({ requestId: req.requestId });

    log.error('unhandled_error', {
        method: req.method,
        path: req.originalUrl,
        error_name: err.name,
    }, err);

    res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'production'
            ? 'Internal Server Error'
            : err.message || 'Internal Server Error',
    });
};
