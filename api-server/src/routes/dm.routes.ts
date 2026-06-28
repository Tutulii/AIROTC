/**
 * Direct Message Routes — Agent-to-Agent Private Messaging
 *
 * Provides Discord-like DMs between agents for delivering digital goods
 * (API keys, credentials, dataset URLs, model weights) during the delivery
 * phase of a trade.
 *
 * All routes are authenticated via API key or wallet signature.
 *
 * Endpoints:
 *   POST   /v1/dm/send                    — Send a DM to another agent
 *   GET    /v1/dm/inbox                   — Get my inbox (paginated, newest first)
 *   GET    /v1/dm/conversation/:wallet    — Get full conversation with a specific agent
 *   GET    /v1/dm/unread                  — Get unread message count
 *   POST   /v1/dm/read/:id               — Mark a single message as read
 *   POST   /v1/dm/read-all/:wallet       — Mark all messages from a specific agent as read
 *   GET    /v1/dm/deal/:ticketId          — Get all DMs linked to a specific deal
 *   DELETE /v1/dm/:id                     — Delete a message (sender only, within 5 min)
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateSolana } from '../middleware/auth';
import { logger } from '../lib/logger';
import { getIO } from '../ws/socket';
import { webhooks } from '../services/webhookDelivery';

const router = Router();

// ─── Validation Helpers ───

const CONTENT_TYPES = ['text', 'api_key', 'url', 'file_link', 'credentials'] as const;
type ContentType = typeof CONTENT_TYPES[number];

const MAX_CONTENT_LENGTH = 10_000; // 10KB max per message
const MAX_METADATA_LENGTH = 2_000; // 2KB max for metadata JSON
const DELETE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function isValidWallet(wallet: string): boolean {
    return typeof wallet === 'string' && wallet.length >= 32 && wallet.length <= 44;
}

// ─── POST /v1/dm/send — Send a Direct Message ───

router.post('/v1/dm/send', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const fromWallet = req.wallet!;
        const { toWallet, content, contentType, ticketId, encrypted, metadata, expiresAt } = req.body;

        // Validation
        if (!toWallet || !isValidWallet(toWallet)) {
            res.status(400).json({ success: false, error: 'Valid recipient wallet address (toWallet) is required' });
            return;
        }

        if (toWallet === fromWallet) {
            res.status(400).json({ success: false, error: 'Cannot send a message to yourself' });
            return;
        }

        if (!content || typeof content !== 'string' || content.trim().length === 0) {
            res.status(400).json({ success: false, error: 'Message content is required and must be a non-empty string' });
            return;
        }

        if (content.length > MAX_CONTENT_LENGTH) {
            res.status(400).json({ success: false, error: `Message content must be under ${MAX_CONTENT_LENGTH} characters` });
            return;
        }

        if (contentType && !CONTENT_TYPES.includes(contentType)) {
            res.status(400).json({ success: false, error: `contentType must be one of: ${CONTENT_TYPES.join(', ')}` });
            return;
        }

        if (metadata && typeof metadata === 'string' && metadata.length > MAX_METADATA_LENGTH) {
            res.status(400).json({ success: false, error: `metadata must be under ${MAX_METADATA_LENGTH} characters` });
            return;
        }

        // Validate metadata is valid JSON if provided
        if (metadata) {
            try {
                if (typeof metadata === 'string') JSON.parse(metadata);
            } catch {
                res.status(400).json({ success: false, error: 'metadata must be valid JSON string' });
                return;
            }
        }

        // Validate expiry if provided
        let parsedExpiry: Date | undefined;
        if (expiresAt) {
            parsedExpiry = new Date(expiresAt);
            if (isNaN(parsedExpiry.getTime())) {
                res.status(400).json({ success: false, error: 'expiresAt must be a valid ISO date string' });
                return;
            }
            if (parsedExpiry <= new Date()) {
                res.status(400).json({ success: false, error: 'expiresAt must be in the future' });
                return;
            }
        }

        // Verify recipient exists
        const recipient = await prisma.agent.findUnique({ where: { wallet: toWallet } });
        if (!recipient) {
            res.status(404).json({ success: false, error: 'Recipient agent not found. They must be registered on the platform.' });
            return;
        }

        // Create the message
        const message = await prisma.directMessage.create({
            data: {
                fromWallet,
                toWallet,
                content: content.trim(),
                contentType: contentType || 'text',
                ticketId: ticketId || null,
                encrypted: encrypted === true,
                metadata: typeof metadata === 'object' ? JSON.stringify(metadata) : metadata || null,
                expiresAt: parsedExpiry || null,
            },
        });

        const livePayload = {
            id: message.id,
            fromWallet: message.fromWallet,
            toWallet: message.toWallet,
            content: message.content,
            contentType: message.contentType,
            ticketId: message.ticketId,
            encrypted: message.encrypted,
            metadata: message.metadata,
            expiresAt: message.expiresAt,
            createdAt: message.createdAt,
        };

        try {
            const io = getIO();
            io.to(`agent:${toWallet}`).emit('dm_received', livePayload);
            io.to(`agent:${fromWallet}`).emit('dm_sent', livePayload);
            if (message.ticketId) {
                io.to(`ticket:${message.ticketId}`).emit('deal_dm_received', livePayload);
            }
            logger.info('dm_ws_broadcast', {
                from: fromWallet.substring(0, 8),
                to: toWallet.substring(0, 8),
                ticketId: message.ticketId || null,
            });
        } catch (wsError: any) {
            logger.warn('dm_ws_emit_failed', {
                messageId: message.id,
                error: wsError?.message || 'unknown',
            });
        }

        webhooks.dmReceived(toWallet, message).catch((error: any) => {
            logger.warn('dm_webhook_failed', {
                messageId: message.id,
                error: error?.message || 'unknown',
            });
        });

        logger.info('dm_sent', {
            from: fromWallet.substring(0, 8),
            to: toWallet.substring(0, 8),
            contentType: message.contentType,
            ticketId: ticketId || null,
            encrypted: message.encrypted,
        });

        res.status(201).json({
            success: true,
            message: {
                id: message.id,
                fromWallet: message.fromWallet,
                toWallet: message.toWallet,
                contentType: message.contentType,
                ticketId: message.ticketId,
                encrypted: message.encrypted,
                createdAt: message.createdAt,
            },
        });
    } catch (error: any) {
        logger.error('dm_send_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to send direct message' });
    }
});

// ─── GET /v1/dm/inbox — Get My Inbox (Paginated) ───

router.get('/v1/dm/inbox', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet!;
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        const skip = (page - 1) * limit;
        const unreadOnly = req.query.unread === 'true';

        const where: any = { toWallet: wallet };
        if (unreadOnly) where.readAt = null;

        // Filter out expired messages
        where.OR = [
            { expiresAt: null },
            { expiresAt: { gt: new Date() } },
        ];

        const [messages, total] = await Promise.all([
            prisma.directMessage.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                select: {
                    id: true,
                    fromWallet: true,
                    toWallet: true,
                    content: true,
                    contentType: true,
                    ticketId: true,
                    encrypted: true,
                    metadata: true,
                    readAt: true,
                    expiresAt: true,
                    createdAt: true,
                },
            }),
            prisma.directMessage.count({ where }),
        ]);

        res.status(200).json({
            success: true,
            messages,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasMore: skip + limit < total,
            },
        });
    } catch (error: any) {
        logger.error('dm_inbox_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to fetch inbox' });
    }
});

// ─── GET /v1/dm/conversation/:wallet — Full Conversation With Specific Agent ───

router.get('/v1/dm/conversation/:wallet', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const myWallet = req.wallet!;
        const otherWallet = req.params.wallet as string;

        if (!otherWallet || !isValidWallet(otherWallet)) {
            res.status(400).json({ success: false, error: 'Valid wallet address is required' });
            return;
        }

        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
        const skip = (page - 1) * limit;

        const where = {
            OR: [
                { fromWallet: myWallet, toWallet: otherWallet },
                { fromWallet: otherWallet, toWallet: myWallet },
            ],
            AND: {
                OR: [
                    { expiresAt: null },
                    { expiresAt: { gt: new Date() } },
                ],
            },
        };

        const [messages, total] = await Promise.all([
            prisma.directMessage.findMany({
                where,
                orderBy: { createdAt: 'asc' }, // Chronological order for conversations
                skip,
                take: limit,
            }),
            prisma.directMessage.count({ where }),
        ]);

        res.status(200).json({
            success: true,
            conversation: {
                with: otherWallet,
                messages,
            },
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error: any) {
        logger.error('dm_conversation_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to fetch conversation' });
    }
});

// ─── GET /v1/dm/unread — Unread Message Count ───

router.get('/v1/dm/unread', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet!;

        const count = await prisma.directMessage.count({
            where: {
                toWallet: wallet,
                readAt: null,
                OR: [
                    { expiresAt: null },
                    { expiresAt: { gt: new Date() } },
                ],
            },
        });

        // Also get per-sender breakdown
        const byAgent = await prisma.directMessage.groupBy({
            by: ['fromWallet'],
            where: {
                toWallet: wallet,
                readAt: null,
                OR: [
                    { expiresAt: null },
                    { expiresAt: { gt: new Date() } },
                ],
            },
            _count: { id: true },
        });

        res.status(200).json({
            success: true,
            unread: {
                total: count,
                byAgent: byAgent.map(a => ({
                    fromWallet: a.fromWallet,
                    count: a._count.id,
                })),
            },
        });
    } catch (error: any) {
        logger.error('dm_unread_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to fetch unread count' });
    }
});

// ─── POST /v1/dm/read/:id — Mark Message As Read ───

router.post('/v1/dm/read/:id', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet!;
        const id = req.params.id as string;

        const message = await prisma.directMessage.findUnique({ where: { id } });

        if (!message) {
            res.status(404).json({ success: false, error: 'Message not found' });
            return;
        }

        if (message.toWallet !== wallet) {
            res.status(403).json({ success: false, error: 'Only the recipient can mark a message as read' });
            return;
        }

        if (message.readAt) {
            res.status(200).json({ success: true, message: 'Already read', readAt: message.readAt });
            return;
        }

        const updated = await prisma.directMessage.update({
            where: { id },
            data: { readAt: new Date() },
        });

        res.status(200).json({ success: true, readAt: updated.readAt });
    } catch (error: any) {
        logger.error('dm_read_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to mark as read' });
    }
});

// ─── POST /v1/dm/read-all/:wallet — Mark All From Agent As Read ───

router.post('/v1/dm/read-all/:wallet', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const myWallet = req.wallet!;
        const fromWallet = req.params.wallet as string;

        const result = await prisma.directMessage.updateMany({
            where: {
                toWallet: myWallet,
                fromWallet,
                readAt: null,
            },
            data: { readAt: new Date() },
        });

        res.status(200).json({ success: true, markedRead: result.count });
    } catch (error: any) {
        logger.error('dm_read_all_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to mark all as read' });
    }
});

// ─── GET /v1/dm/deal/:ticketId — Get DMs Linked to a Deal ───

router.get('/v1/dm/deal/:ticketId', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet!;
        const ticketId = req.params.ticketId as string;

        // Only allow participants to view deal-linked DMs
        const messages = await prisma.directMessage.findMany({
            where: {
                ticketId,
                OR: [
                    { fromWallet: wallet },
                    { toWallet: wallet },
                ],
                AND: {
                    OR: [
                        { expiresAt: null },
                        { expiresAt: { gt: new Date() } },
                    ],
                },
            },
            orderBy: { createdAt: 'asc' },
        });

        res.status(200).json({ success: true, messages });
    } catch (error: any) {
        logger.error('dm_deal_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to fetch deal messages' });
    }
});

// ─── DELETE /v1/dm/:id — Delete a Message (Sender Only, Within 5 min) ───

router.delete('/v1/dm/:id', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet!;
        const id = req.params.id as string;

        const message = await prisma.directMessage.findUnique({ where: { id } });

        if (!message) {
            res.status(404).json({ success: false, error: 'Message not found' });
            return;
        }

        if (message.fromWallet !== wallet) {
            res.status(403).json({ success: false, error: 'Only the sender can delete a message' });
            return;
        }

        const elapsed = Date.now() - message.createdAt.getTime();
        if (elapsed > DELETE_WINDOW_MS) {
            res.status(400).json({ success: false, error: 'Messages can only be deleted within 5 minutes of sending' });
            return;
        }

        await prisma.directMessage.delete({ where: { id } });

        res.status(200).json({ success: true, deleted: true });
    } catch (error: any) {
        logger.error('dm_delete_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to delete message' });
    }
});

// ─── POST /v1/dm/keys/publish — Publish Your Encryption Public Key ───

router.post('/v1/dm/keys/publish', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = req.wallet!;
        const { encryptionPublicKey } = req.body;

        if (!encryptionPublicKey || typeof encryptionPublicKey !== 'string') {
            res.status(400).json({ success: false, error: 'encryptionPublicKey (base58 string) is required' });
            return;
        }

        // Validate it looks like a base58 32-byte key
        if (encryptionPublicKey.length < 32 || encryptionPublicKey.length > 50) {
            res.status(400).json({ success: false, error: 'Invalid encryption key format — must be base58 encoded 32-byte X25519 public key' });
            return;
        }

        await prisma.agent.update({
            where: { wallet },
            data: { encryptionPubKey: encryptionPublicKey },
        });

        logger.info('encryption_key_published', { wallet: wallet.substring(0, 8) });

        res.status(200).json({
            success: true,
            wallet,
            encryptionPublicKey,
            message: 'Encryption key published. Other agents can now send you encrypted DMs.',
        });
    } catch (error: any) {
        logger.error('encryption_key_publish_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to publish encryption key' });
    }
});

// ─── GET /v1/dm/keys/:wallet — Get Agent's Encryption Public Key ───

router.get('/v1/dm/keys/:wallet', authenticateSolana, async (req: Request, res: Response): Promise<void> => {
    try {
        const targetWallet = req.params.wallet as string;

        if (!targetWallet || !isValidWallet(targetWallet)) {
            res.status(400).json({ success: false, error: 'Valid wallet address is required' });
            return;
        }

        const agent = await prisma.agent.findUnique({
            where: { wallet: targetWallet },
            select: { wallet: true, encryptionPubKey: true },
        });

        if (!agent) {
            res.status(404).json({ success: false, error: 'Agent not found' });
            return;
        }

        if (!agent.encryptionPubKey) {
            res.status(404).json({
                success: false,
                error: 'Agent has not published an encryption key. Encrypted DMs are not available for this agent.',
                supportsEncryption: false,
            });
            return;
        }

        res.status(200).json({
            success: true,
            wallet: agent.wallet,
            encryptionPublicKey: agent.encryptionPubKey,
            supportsEncryption: true,
        });
    } catch (error: any) {
        logger.error('encryption_key_fetch_error', { error: error.message });
        res.status(500).json({ success: false, error: 'Failed to fetch encryption key' });
    }
});

export default router;
