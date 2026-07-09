import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import {
    acceptOfferService,
    getTicketByIdService,
    createMessageService,
    getMessagesByTicketId,
    listTicketsForWalletService,
} from '../services/ticket.service';
import { middlemanForwarder } from '../services/middlemanForwarder';
import { prisma } from '../lib/prisma';
import { webhooks } from '../services/webhookDelivery';
import { attachSportTicketByOffer } from '../services/arena/sportSettlementEngine';

function toNumber(value: unknown): number {
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

function asRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function sanitizeSportDepositInstructions(instructions: unknown): Record<string, unknown> | null {
    const raw = asRecord(instructions);
    if (!Object.keys(raw).length) return null;

    const buyer = asRecord(raw.buyer);
    const seller = asRecord(raw.seller);
    const protocolDustLamports = buyer.protocolDustLamports ?? raw.protocolDustLamports ?? 0;
    const buyerStake = buyer.stake ?? buyer.payment ?? buyer.total;
    const sellerStake = seller.stake ?? seller.total;

    return {
        escrowPda: raw.escrowPda || raw.escrow_pda || null,
        stakeModel: 'equal_stake',
        buyer: {
            wallet: buyer.wallet || null,
            stake: buyerStake ?? null,
            total: buyer.total ?? buyerStake ?? null,
            ...(Number(protocolDustLamports) > 0 ? { protocolDustLamports } : {}),
        },
        seller: {
            wallet: seller.wallet || null,
            stake: sellerStake ?? null,
            total: seller.total ?? sellerStake ?? null,
        },
    };
}

export const acceptOffer = async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        const wallet = (req as any).wallet; // Accommodate potential req.wallet augmented type safely

        if (!id) {
            res.status(400).json({ success: false, error: 'Offer ID is required' });
            return;
        }

        if (!wallet) {
            res.status(401).json({ success: false, error: 'Unauthorized: Wallet missing' });
            return;
        }

        const settlementWallet =
            typeof req.body?.settlementWallet === 'string' ? req.body.settlementWallet : null;
        const rewardWallet =
            typeof req.body?.rewardWallet === 'string' ? req.body.rewardWallet : null;
        const fundingWallet =
            typeof req.body?.fundingWallet === 'string' ? req.body.fundingWallet : null;

        if (settlementWallet) {
            try {
                new PublicKey(settlementWallet);
            } catch {
                res.status(400).json({ success: false, error: 'settlementWallet must be a valid base58 Solana address' });
                return;
            }
        }

        if (rewardWallet) {
            try {
                new PublicKey(rewardWallet);
            } catch {
                res.status(400).json({ success: false, error: 'rewardWallet must be a valid base58 Solana address' });
                return;
            }
        }

        if (fundingWallet) {
            try {
                new PublicKey(fundingWallet);
            } catch {
                res.status(400).json({ success: false, error: 'fundingWallet must be a valid base58 Solana address' });
                return;
            }
        }

        const offer = await prisma.offer.findUnique({ where: { id: id as string } });
        if (!offer) {
            res.status(404).json({ success: false, error: 'Offer not found' });
            return;
        }

        const previewBuyerRewardWallet =
            offer.mode === 'buy'
                ? (offer as any).creatorRewardWallet || null
                : rewardWallet;
        const previewSellerRewardWallet =
            offer.mode === 'buy'
                ? rewardWallet
                : (offer as any).creatorRewardWallet || null;
        const previewBuyerFundingWallet =
            offer.mode === 'buy'
                ? (offer as any).creatorFundingWallet || null
                : fundingWallet;
        const previewSellerFundingWallet =
            offer.mode === 'buy'
                ? fundingWallet
                : (offer as any).creatorFundingWallet || null;
        const hasPartialRewardWallets =
            [previewBuyerRewardWallet, previewSellerRewardWallet].some((value) => !!value) &&
            [previewBuyerRewardWallet, previewSellerRewardWallet].some((value) => !value);
        if (hasPartialRewardWallets) {
            res.status(400).json({
                success: false,
                error: 'Fresh per-deal reward wallets must be supplied by both counterparties together or omitted entirely.',
            });
            return;
        }
        const hasPartialFundingWallets =
            [previewBuyerFundingWallet, previewSellerFundingWallet].some((value) => !!value) &&
            [previewBuyerFundingWallet, previewSellerFundingWallet].some((value) => !value);
        if (hasPartialFundingWallets) {
            res.status(400).json({
                success: false,
                error: 'Fresh per-deal confidential funding wallets must be supplied by both counterparties together or omitted entirely.',
            });
            return;
        }

        const ticket = await acceptOfferService(id as string, wallet, settlementWallet);
        let sportArenaMatch: Record<string, unknown> | null = null;
        let sportEscrow: Record<string, unknown> | null = null;

        // Forward to Middleman before telling the agent the offer is accepted.
        // Sends BOTH buyer and seller wallets so they land in ONE ticket.
        if (offer) {
            const buyerSettlementWallet =
                offer.mode === 'buy'
                    ? (offer as any).creatorSettlementWallet || null
                    : settlementWallet;
            const sellerSettlementWallet =
                offer.mode === 'buy'
                    ? settlementWallet
                    : (offer as any).creatorSettlementWallet || null;
            const buyerRewardWallet =
                offer.mode === 'buy'
                    ? (offer as any).creatorRewardWallet || null
                    : rewardWallet;
            const sellerRewardWallet =
                offer.mode === 'buy'
                    ? rewardWallet
                    : (offer as any).creatorRewardWallet || null;
            const buyerFundingWallet =
                offer.mode === 'buy'
                    ? (offer as any).creatorFundingWallet || null
                    : fundingWallet;
            const sellerFundingWallet =
                offer.mode === 'buy'
                    ? fundingWallet
                    : (offer as any).creatorFundingWallet || null;

            const result = await middlemanForwarder.forwardOfferAccepted({
                ticketId: ticket.id,
                buyerWallet: ticket.buyer,
                sellerWallet: ticket.seller,
                asset: offer.asset,
                price: toNumber(offer.price),
                amount: toNumber(offer.amount),
                collateral: toNumber(offer.collateral),
                tokenMint: (offer as any).tokenMint || null,
                rollupMode: (offer as any).rollupMode || 'ER',
                buyerSettlementWallet,
                sellerSettlementWallet,
                buyerRewardWallet,
                sellerRewardWallet,
                buyerFundingWallet,
                sellerFundingWallet,
            });

            if (!result.success) {
                await prisma.$transaction([
                    prisma.ticket.delete({ where: { id: ticket.id } }),
                    prisma.offer.update({ where: { id: id as string }, data: { status: 'active' } }),
                ]);
                logger.error('[FORWARD] Matched deal was not created on middleman', {
                    apiTicketId: ticket.id,
                    reason: result.error || 'unknown',
                });
                res.status(502).json({ success: false, error: 'Middleman forward failed' });
                return;
            }

            logger.info('[FORWARD] Matched deal created on middleman:', {
                apiTicketId: ticket.id,
                middlemanTicketId: result.middlemanTicketId,
            });

            if ((offer as any).rollupMode === 'SPORT') {
                sportEscrow = {
                    mathOnly: true,
                    phase: result.phase || null,
                    dealPda: result.dealPda || null,
                    depositInstructions: sanitizeSportDepositInstructions(result.depositInstructions),
                    note: 'SPORT settlement is deterministic: each agent deposits the same stake, no delivery step is used, and TxLINE outcome plus market selection decides release/refund.',
                };
                try {
                    const attachResult = await attachSportTicketByOffer({
                        offerId: offer.id,
                        ticketId: ticket.id,
                        escrowPda: result.dealPda || null,
                    });
                    sportArenaMatch = (attachResult as any).match || attachResult;
                } catch (error: any) {
                    logger.warn('sport_ticket_attach_failed', {
                        offerId: offer.id,
                        ticketId: ticket.id,
                        error: error?.message,
                    });
                }
            }

            // Webhook: notify both parties
            webhooks.dealMatched(ticket.id, ticket.buyer, ticket.seller, offer)
                .catch((error: any) => {
                    logger.warn('deal_matched_webhook_failed', { ticketId: ticket.id, error: error?.message });
                });
        }

        res.status(200).json({
            success: true,
            ticket,
            ...(sportArenaMatch ? { arenaMatch: sportArenaMatch } : {}),
            ...(sportEscrow ? { sportEscrow } : {}),
        });
    } catch (error: any) {
        if (error.message === 'OFFER_NOT_FOUND') {
            res.status(404).json({ success: false, error: 'Offer not found' });
            return;
        }
        if (error.message === 'OFFER_NOT_ACTIVE') {
            res.status(400).json({ success: false, error: 'Offer not active' });
            return;
        }
        if (error.message === 'CANNOT_ACCEPT_OWN_OFFER') {
            res.status(403).json({ success: false, error: 'Cannot accept own offer' });
            return;
        }
        if (error.message === 'OFFER_ALREADY_MATCHED') {
            res.status(409).json({ success: false, error: 'Offer already matched' });
            return;
        }

        logger.error("accept_offer_failed", { error: error?.message });
        res.status(500).json({ success: false, error: 'Internal server error while accepting offer' });
    }
};

export const getTicket = async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        const wallet = (req as any).wallet; // Auth middleware sets this

        if (!wallet) {
            res.status(401).json({ success: false, error: 'Unauthorized: Wallet missing' });
            return;
        }

        const ticket = await getTicketByIdService(id as string, wallet);

        res.status(200).json({
            success: true,
            ticket
        });
    } catch (error: any) {
        if (error.message === 'INVALID_UUID') {
            res.status(400).json({ success: false, error: 'Invalid UUID format' });
            return;
        }
        if (error.message === 'TICKET_NOT_FOUND') {
            res.status(404).json({ success: false, error: 'Ticket not found' });
            return;
        }
        if (error.message === 'UNAUTHORIZED_ACCESS') {
            res.status(403).json({ success: false, error: 'Forbidden: You are not authorized to view this ticket' });
            return;
        }

        logger.error("error");
        res.status(500).json({ success: false, error: 'Internal server error while fetching ticket' });
    }
};

export const listWalletTickets = async (req: Request, res: Response): Promise<void> => {
    try {
        const wallet = (req as any).wallet;

        if (!wallet) {
            res.status(401).json({ success: false, error: 'Unauthorized: Wallet missing' });
            return;
        }

        const status =
            typeof req.query.status === 'string' && req.query.status.trim().length > 0
                ? req.query.status.trim()
                : undefined;
        const activeOnly = req.query.activeOnly === undefined
            ? true
            : String(req.query.activeOnly).toLowerCase() !== 'false';

        const tickets = await listTicketsForWalletService(wallet, { status, activeOnly });

        res.status(200).json({
            success: true,
            wallet,
            tickets,
        });
    } catch (error: any) {
        logger.error("list_wallet_tickets_failed", { error: error?.message });
        res.status(500).json({ success: false, error: 'Internal server error while listing tickets' });
    }
};

export const sendMessage = async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        const wallet = (req as any).wallet;
        const { content } = req.body;

        if (!wallet) {
            res.status(401).json({ success: false, error: 'Unauthorized: Wallet missing' });
            return;
        }

        if (content === undefined || content === null) {
            res.status(400).json({ success: false, error: 'Message content is required' });
            return;
        }

        // 1. Store message in API database
        const message = await createMessageService(id as string, wallet, content);

        const ticket = await prisma.ticket.findUnique({
            where: { id: id as string },
            select: { rollupMode: true },
        });
        const isSportTicket = ticket?.rollupMode === 'SPORT';

        // 2. Forward to Middleman brain — SYNCHRONOUS (await brain response).
        // SPORT chat is deliberately conversation-only: settlement is derived
        // from TxLINE outcome math, never from message interpretation.
        let brain: any = null;
        if (!isSportTicket) {
            try {
                const result = await middlemanForwarder.forwardMessage({
                    ticketId: id as string,
                    sender: wallet,
                    content,
                });
                if (result.success) {
                    brain = result.brain;
                } else {
                    logger.warn("warning");
                }
            } catch (fwdErr: any) {
                // Non-fatal — message is already stored in API DB
                logger.warn("warning");
            }
        }

        // 3. Return message + brain response to agent
        res.status(201).json({
            success: true,
            message,
            sportMathOnly: isSportTicket || undefined,
            brain: brain ? {
                action: brain.action,
                phase: brain.phase,
                response: brain.response,
                reasoning: brain.reasoning,
            } : null,
        });
    } catch (error: any) {
        if (error.message === 'INVALID_UUID') {
            res.status(400).json({ success: false, error: 'Invalid UUID format' });
            return;
        }
        if (error.message === 'INVALID_CONTENT') {
            res.status(400).json({ success: false, error: 'Invalid message content. Must be a non-empty string under 2000 characters.' });
            return;
        }
        if (error.message === 'TICKET_NOT_FOUND') {
            res.status(404).json({ success: false, error: 'Ticket not found' });
            return;
        }
        if (error.message === 'UNAUTHORIZED_ACCESS') {
            res.status(403).json({ success: false, error: 'Forbidden: You are not authorized to message in this ticket' });
            return;
        }
        if (error.message === 'TICKET_NOT_ACTIVE') {
            res.status(400).json({ success: false, error: 'Ticket is not active. Cannot send messages.' });
            return;
        }
        if (error.message === 'PER_PLAINTEXT_TERMS_BLOCKED') {
            res.status(400).json({
                success: false,
                error: 'Plaintext price/collateral terms are blocked in PER chat. Use the private rollup SDK term submission flow instead.'
            });
            return;
        }

        logger.error("error");
        res.status(500).json({ success: false, error: 'Internal server error while sending message' });
    }
};

export const getMessages = async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        const wallet = (req as any).wallet;

        if (!wallet) {
            res.status(401).json({ success: false, error: 'Unauthorized: Wallet missing' });
            return;
        }

        const messages = await getMessagesByTicketId(id as string, wallet);

        res.status(200).json({
            success: true,
            messages
        });
    } catch (error: any) {
        if (error.message === 'INVALID_UUID') {
            res.status(400).json({ success: false, error: 'Invalid UUID format' });
            return;
        }
        if (error.message === 'TICKET_NOT_FOUND') {
            res.status(404).json({ success: false, error: 'Ticket not found' });
            return;
        }
        if (error.message === 'UNAUTHORIZED_ACCESS') {
            res.status(403).json({ success: false, error: 'Forbidden: You are not authorized to read messages spanning this ticket' });
            return;
        }

        logger.error("error");
        res.status(500).json({ success: false, error: 'Internal server error while fetching messages' });
    }
};
