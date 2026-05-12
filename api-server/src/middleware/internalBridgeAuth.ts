import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger';
import { isBridgeSecretConfigured, verifyRequest } from '../services/hmacSigner';

function getSignedPath(req: Request): string {
    return `${req.baseUrl || ''}${req.path}`;
}

export function requireInternalBridgeAuth(req: Request, res: Response, next: NextFunction): void {
    if (!isBridgeSecretConfigured()) {
        logger.error('internal_bridge_auth_misconfigured', {
            method: req.method,
            path: getSignedPath(req),
        });
        res.status(503).json({
            success: false,
            error: 'Internal bridge authentication is not configured',
        });
        return;
    }

    const signature = req.header('X-Bridge-Signature');
    const timestamp = req.header('X-Bridge-Timestamp');
    if (!signature || !timestamp) {
        logger.warn('internal_bridge_auth_missing', {
            method: req.method,
            path: getSignedPath(req),
            ip: req.ip,
        });
        res.status(401).json({
            success: false,
            error: 'Missing internal bridge authentication headers',
        });
        return;
    }

    const body = req.method === 'GET' ? '' : JSON.stringify(req.body ?? {});
    const verification = verifyRequest(
        req.method,
        getSignedPath(req),
        body,
        signature,
        timestamp,
    );

    if (!verification.valid) {
        logger.warn('internal_bridge_auth_rejected', {
            method: req.method,
            path: getSignedPath(req),
            ip: req.ip,
            reason: verification.reason,
        });
        res.status(401).json({
            success: false,
            error: verification.reason || 'Invalid internal bridge signature',
        });
        return;
    }

    next();
}
