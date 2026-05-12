import rateLimit from 'express-rate-limit';

/**
 * Production Rate Limiters — Per-endpoint protection
 * 
 * Global: 100 req/min baseline
 * Write operations have tighter limits to prevent abuse.
 */

// Global baseline — applies to all endpoints
export const apiRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100,
    message: {
        success: false,
        error: "Too many requests, please try again later"
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Offer creation — 10/min per wallet
export const offerCreateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: {
        success: false,
        error: "Too many offers created. Max 10 per minute."
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    keyGenerator: (req) => (req as any).wallet || 'anon',
});

// Offer acceptance — 5/min per wallet
export const offerAcceptLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: {
        success: false,
        error: "Too many offer acceptances. Max 5 per minute."
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    keyGenerator: (req) => (req as any).wallet || 'anon',
});

// Message sending — 30/min per wallet
export const messageSendLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: {
        success: false,
        error: "Too many messages. Max 30 per minute."
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    keyGenerator: (req) => (req as any).wallet || 'anon',
});

// Agent registration — 5/min per IP
export const registrationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: {
        success: false,
        error: "Too many registration attempts. Max 5 per minute."
    },
    standardHeaders: true,
    legacyHeaders: false,
});
