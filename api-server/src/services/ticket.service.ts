import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { isUUID, assertParticipant } from '../utils/validators';
import { getIO } from '../ws/socket';
import { webhookNewMessage } from './webhook.service';
import { TERMINAL_TICKET_STATUSES, isTerminalTicketStatus } from './ticketStatusPolicy';

function looksLikeSensitivePerTerms(content: string): boolean {
    const normalized = content.toLowerCase();
    return /\d/.test(normalized) && /(price|collateral|asset|lamport|sol|usdc|mint)/i.test(normalized);
}

function isStrictPerOpaqueMode(): boolean {
    const raw = process.env.PER_STRICT_OPAQUE_MODE;
    if (raw === undefined) return true;
    return raw !== 'false';
}

function toSafeNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
        return (value as { toNumber: () => number }).toNumber();
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error('Invalid numeric offer field');
    }
    return parsed;
}

function serializeTicketOffer(ticket: {
    rollupMode: string;
    offer: {
        id: string;
        mode: string;
        asset: string;
        price: unknown;
        collateral: unknown;
        status?: string;
        fixtureId?: string | null;
        marketType?: string | null;
        selection?: string | null;
    };
}, redactPrivateTerms: boolean) {
    const base = {
        id: ticket.offer.id,
        type: ticket.offer.mode,
        asset: ticket.offer.asset,
        status: ticket.offer.status,
        fixtureId: ticket.offer.fixtureId || null,
        marketType: ticket.offer.marketType || null,
        selection: ticket.offer.selection || null,
        privateTermsRedacted: redactPrivateTerms,
    };

    if (ticket.rollupMode === 'SPORT') {
        const stake = redactPrivateTerms ? null : toSafeNumber(ticket.offer.price);
        return {
            ...base,
            price: stake,
            stake,
            stakeModel: 'equal_stake',
        };
    }

    return {
        ...base,
        price: redactPrivateTerms ? null : toSafeNumber(ticket.offer.price),
        collateral: redactPrivateTerms ? null : toSafeNumber(ticket.offer.collateral),
    };
}

function summarizeTicket<T extends {
    rollupMode: string;
    offer: {
        id: string;
        mode: string;
        asset: string;
        price: unknown;
        collateral: unknown;
        status?: string;
        fixtureId?: string | null;
        marketType?: string | null;
        selection?: string | null;
    };
    messages?: Array<{
        id: string;
        sender: string;
        content: string;
        createdAt: Date;
    }>;
    _count?: { messages: number };
}>(ticket: T) {
    const redactPrivateTerms = ticket.rollupMode === 'PER' && isStrictPerOpaqueMode();
    const [lastMessage] = ticket.messages || [];

    return {
        ...ticket,
        messages: undefined,
        _count: undefined,
        messageCount: ticket._count?.messages ?? 0,
        lastMessage: lastMessage || null,
        privateTermsRedacted: redactPrivateTerms,
        offer: serializeTicketOffer(ticket, redactPrivateTerms),
    };
}

export const listTicketsForWalletService = async (
    wallet: string,
    options: { status?: string; activeOnly?: boolean } = {},
) => {
    const normalizedStatus =
        typeof options.status === 'string' && options.status.trim().length > 0
            ? options.status.trim()
            : undefined;
    const activeOnly = options.activeOnly !== false;

    const tickets = await prisma.ticket.findMany({
        where: {
            OR: [{ buyer: wallet }, { seller: wallet }],
            ...(normalizedStatus
                ? { status: normalizedStatus }
                : activeOnly
                    ? { status: { notIn: [...TERMINAL_TICKET_STATUSES] } }
                    : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
            id: true,
            status: true,
            rollupMode: true,
            buyer: true,
            seller: true,
            createdAt: true,
            offer: {
                select: {
                    id: true,
                    mode: true,
                    asset: true,
                    price: true,
                    collateral: true,
                    status: true,
                    fixtureId: true,
                    marketType: true,
                    selection: true,
                },
            },
            messages: {
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: 1,
                select: {
                    id: true,
                    sender: true,
                    content: true,
                    createdAt: true,
                },
            },
            _count: {
                select: {
                    messages: true,
                },
            },
        },
    });

    return tickets.map(summarizeTicket);
};

export const acceptOfferService = async (
    offerId: string,
    demanderWallet: string,
    demanderSettlementWallet?: string | null,
) => {
    return await prisma.$transaction(async (tx) => {
        const offer = await tx.offer.findUnique({
            where: { id: offerId },
            include: { creator: true, ticket: true }
        });

        if (!offer) {
            throw new Error('OFFER_NOT_FOUND');
        }

        if (offer.status === 'matched' || offer.ticket) {
            throw new Error('OFFER_ALREADY_MATCHED');
        }

        if (offer.status !== 'active') {
            throw new Error('OFFER_NOT_ACTIVE');
        }

        if (offer.creator.wallet === demanderWallet) {
            throw new Error('CANNOT_ACCEPT_OWN_OFFER');
        }

        let buyerWallet: string;
        let sellerWallet: string;

        if (offer.mode === 'buy') {
            buyerWallet = offer.creator.wallet;
            sellerWallet = demanderWallet;
        } else {
            buyerWallet = demanderWallet;
            sellerWallet = offer.creator.wallet;
        }

        const matched = await tx.offer.updateMany({
            where: { id: offer.id, status: 'active' },
            data: { status: 'matched' }
        });

        if (matched.count !== 1) {
            throw new Error('OFFER_ALREADY_MATCHED');
        }

        let ticket;
        try {
            ticket = await tx.ticket.create({
                data: {
                    offerId: offer.id,
                    buyer: buyerWallet,
                    seller: sellerWallet,
                    status: (offer as any).rollupMode === 'SPORT' ? 'awaiting_deposits' : 'negotiating',
                    rollupMode: (offer as any).rollupMode || 'ER',
                },
                select: {
                    id: true,
                    buyer: true,
                    seller: true,
                    status: true,
                    rollupMode: true,
                }
            });
        } catch (error: any) {
            if (error.code === 'P2002') {
                throw new Error('OFFER_ALREADY_MATCHED');
            }
            throw error;
        }

        return ticket;
    });
};

export const getTicketByIdService = async (ticketId: string, wallet: string) => {
    if (!isUUID(ticketId)) {
        throw new Error('INVALID_UUID');
    }

    const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: {
            id: true,
            status: true,
            rollupMode: true,
            buyer: true,
            seller: true,
            createdAt: true,
            offer: {
                select: {
                    id: true,
                    mode: true,
                    asset: true,
                    price: true,
                    collateral: true,
                    fixtureId: true,
                    marketType: true,
                    selection: true
                }
            },
            messages: {
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: {
                    id: true,
                    sender: true,
                    content: true,
                    createdAt: true
                }
            }
        }
    });

    if (!ticket) {
        throw new Error('TICKET_NOT_FOUND');
    }

    // 2. Access Control check
    assertParticipant(ticket, wallet);

    const redactPrivateTerms = ticket.rollupMode === 'PER' && isStrictPerOpaqueMode();

    // 3. Optional subset returning...o type to fulfill response pattern if needed, but db has mode
    return {
        ...ticket,
        privateTermsRedacted: redactPrivateTerms,
        offer: serializeTicketOffer(ticket, redactPrivateTerms),
    };
};

export const createMessageService = async (ticketId: string, wallet: string, content: string) => {
    if (!isUUID(ticketId)) {
        throw new Error('INVALID_UUID');
    }

    // 2. Validate content
    if (!content || typeof content !== 'string') {
        throw new Error('INVALID_CONTENT');
    }
    const trimmedContent = content.trim();
    if (trimmedContent.length === 0 || trimmedContent.length > 2000) {
        throw new Error('INVALID_CONTENT');
    }

    // 3. Fetch ticket for access control
    const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: {
            buyer: true,
            seller: true,
            status: true,
            rollupMode: true,
        }
    });

    if (!ticket) {
        throw new Error('TICKET_NOT_FOUND');
    }

    if (isTerminalTicketStatus(ticket.status)) {
        throw new Error('TICKET_NOT_ACTIVE');
    }

    if (ticket.rollupMode === 'PER' && looksLikeSensitivePerTerms(trimmedContent)) {
        throw new Error('PER_PLAINTEXT_TERMS_BLOCKED');
    }

    // 4. Access Control Check
    assertParticipant(ticket, wallet);

    // 5. Create the message
    const message = await prisma.message.create({
        data: {
            ticketId,
            sender: wallet,
            content: trimmedContent
        },
        select: {
            id: true,
            ticketId: true,
            sender: true,
            content: true,
            createdAt: true
        }
    });

    // 6. Real-time Broadcasting
    // TODO: emit typing indicators
    // TODO: emit read receipts
    // TODO: persist delivery status
    try {
        const payload = { ...message, ticketId };
        const io = getIO();
        io.to(`ticket:${ticketId}`).emit('new_message', payload);
        const recipient = message.sender === ticket.buyer ? ticket.seller : ticket.buyer;
        io.to(`agent:${recipient}`).emit('ticket_message_received', payload);
        io.to(`agent:${message.sender}`).emit('ticket_message_sent', payload);
        logger.info("ws_broadcast", { ticketId, sender: message.sender });
    } catch (wsError: any) {
        logger.warn("ws_emit_failed", { ticketId, err: wsError.message });
    }

    // 7. Webhook Push (fire-and-forget)
    webhookNewMessage({
        ticketId,
        messageId: message.id,
        sender: message.sender,
        content: message.content,
        buyerWallet: ticket.buyer,
        sellerWallet: ticket.seller,
    });

    return message;
};

export const getMessagesByTicketId = async (ticketId: string, wallet: string) => {
    if (!isUUID(ticketId)) {
        throw new Error('INVALID_UUID');
    }

    // 2. Fetch ticket minimally for access control
    const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: {
            buyer: true,
            seller: true
        }
    });

    if (!ticket) {
        throw new Error('TICKET_NOT_FOUND');
    }

    // 3. Access Control Check
    assertParticipant(ticket, wallet);

    // TODO: support pagination (cursor-based)

    // 4. Fetch messages cleanly
    const messages = await prisma.message.findMany({
        where: { ticketId },
        orderBy: [
            { createdAt: 'asc' },
            { id: 'asc' }
        ],
        select: {
            id: true,
            sender: true,
            content: true,
            createdAt: true
        }
    });

    return messages;
};
