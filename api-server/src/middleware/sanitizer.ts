/**
 * Input Sanitizer Middleware — Strips malicious content from request bodies.
 * 
 * Protects against:
 *   - XSS (script injection in message content)
 *   - HTML injection
 *   - Oversized payloads
 *   - Control character injection
 */

import { Request, Response, NextFunction } from 'express';

// Dangerous patterns that should never appear in user content
const DANGEROUS_PATTERNS = [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,  // script tags
    /javascript:/gi,                                          // javascript: URIs
    /on\w+\s*=\s*["'][^"']*["']/gi,                          // event handlers
    /<iframe\b[^>]*>/gi,                                      // iframes
    /<object\b[^>]*>/gi,                                      // objects
    /<embed\b[^>]*>/gi,                                       // embeds
];

/**
 * Strip HTML tags from a string while preserving text content.
 */
function stripHtml(str: string): string {
    return str.replace(/<[^>]*>/g, '');
}

/**
 * Remove control characters except newlines and tabs.
 */
function stripControlChars(str: string): string {
    return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Sanitize a message string — remove dangerous patterns, HTML, control chars.
 */
export function sanitizeContent(raw: string): string {
    if (typeof raw !== 'string') return '';

    let clean = raw;

    // Remove dangerous patterns
    for (const pattern of DANGEROUS_PATTERNS) {
        clean = clean.replace(pattern, '');
    }

    // Strip remaining HTML tags
    clean = stripHtml(clean);

    // Strip control characters
    clean = stripControlChars(clean);

    // Trim whitespace
    clean = clean.trim();

    return clean;
}

/**
 * Express middleware — sanitizes `content` field in request body.
 * Applied to message-sending endpoints.
 */
export function sanitizeMessageMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.body && typeof req.body.content === 'string') {
        const original = req.body.content;
        req.body.content = sanitizeContent(original);

        // Reject if sanitization removed everything meaningful
        if (req.body.content.length === 0 && original.length > 0) {
            res.status(400).json({
                success: false,
                error: 'Message content contains only unsafe characters and was rejected.'
            });
            return;
        }

        // Enforce max length
        if (req.body.content.length > 2000) {
            req.body.content = req.body.content.substring(0, 2000);
        }
    }

    // Sanitize asset name in offers
    if (req.body && typeof req.body.asset === 'string') {
        req.body.asset = sanitizeContent(req.body.asset).substring(0, 200);
    }

    next();
}
