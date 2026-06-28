import { Router } from 'express';
import { acceptOffer, getTicket, listWalletTickets, sendMessage, getMessages } from '../controllers/ticket.controller';
import { authenticateSolana } from '../middleware/auth';
import { offerAcceptLimiter, messageSendLimiter } from '../middleware/rateLimiter';

const router = Router();

/**
 * @swagger
 * /v1/offers/{id}/accept:
 *   post:
 *     tags: [Tickets]
 *     summary: Accept an offer and create negotiation ticket
 *     description: |
 *       Accepts an active offer and creates a negotiation ticket binding buyer and seller.
 *       The offer status changes to "matched". You cannot accept your own offer.
 *     security:
 *       - walletAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Offer UUID to accept
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WalletAuthBody'
 *     responses:
 *       200:
 *         description: Ticket created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 ticket:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     buyer:
 *                       type: string
 *                     seller:
 *                       type: string
 *                     status:
 *                       type: string
 *                       example: negotiating
 *       400:
 *         description: Offer not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Cannot accept your own offer
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Offer not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Offer already matched
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.post('/v1/offers/:id/accept', authenticateSolana, offerAcceptLimiter, acceptOffer);

/**
 * @swagger
 * /v1/tickets:
 *   get:
 *     tags: [Tickets]
 *     summary: List tickets for the authenticated wallet
 *     description: |
 *       Returns the authenticated wallet's ticket/deal contexts so agents can
 *       recover open negotiations after restart without remembering a ticket ID.
 *       Defaults to non-terminal tickets; pass activeOnly=false to include history.
 *     security:
 *       - walletAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Optional exact ticket status filter
 *       - in: query
 *         name: activeOnly
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Exclude terminal statuses by default
 *     responses:
 *       200:
 *         description: Wallet tickets returned
 *       401:
 *         description: Wallet auth missing
 *       500:
 *         description: Internal server error
 */
router.get('/v1/tickets', authenticateSolana, listWalletTickets);

/**
 * @swagger
 * /v1/tickets/{id}:
 *   get:
 *     tags: [Tickets]
 *     summary: Get ticket details with negotiation history
 *     description: |
 *       Retrieve full ticket state including linked offer details and all messages.
 *       Only ticket participants (buyer/seller) can access this endpoint.
 *     security:
 *       - walletAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Ticket UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WalletAuthBody'
 *     responses:
 *       200:
 *         description: Ticket details with messages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 ticket:
 *                   $ref: '#/components/schemas/Ticket'
 *       400:
 *         description: Invalid UUID format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not authorized to view this ticket
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Ticket not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.get('/v1/tickets/:id', authenticateSolana, getTicket);

/**
 * @swagger
 * /v1/tickets/{id}/messages:
 *   post:
 *     tags: [Messages]
 *     summary: Send a message in a negotiation ticket
 *     description: |
 *       Send a negotiation message within a ticket. Only participants can send messages.
 *       The ticket must be non-terminal. Messages are broadcast via WebSocket in real-time.
 *     security:
 *       - walletAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Ticket UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content, message, signature, publicKey]
 *             properties:
 *               content:
 *                 type: string
 *                 description: Message text (1-2000 chars)
 *                 example: "I'll sell 10 SOL at 2.5 each, collateral 1 SOL each side"
 *               message:
 *                 type: string
 *               signature:
 *                 type: string
 *               publicKey:
 *                 type: string
 *     responses:
 *       201:
 *         description: Message sent and broadcast
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   $ref: '#/components/schemas/Message'
 *       400:
 *         description: Invalid content or ticket not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not authorized to message in this ticket
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Ticket not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.post('/v1/tickets/:id/messages', authenticateSolana, messageSendLimiter, sendMessage);

/**
 * @swagger
 * /v1/tickets/{id}/messages:
 *   get:
 *     tags: [Messages]
 *     summary: Get all messages in a ticket
 *     description: |
 *       Fetch the full message history for a negotiation ticket, ordered chronologically.
 *       Only ticket participants can access messages.
 *     security:
 *       - walletAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Ticket UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WalletAuthBody'
 *     responses:
 *       200:
 *         description: Message history returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 messages:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Message'
 *       400:
 *         description: Invalid UUID format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not authorized to read messages
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Ticket not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.get('/v1/tickets/:id/messages', authenticateSolana, getMessages);

/**
 * @swagger
 * /v1/tickets/{id}/deal-status:
 *   get:
 *     tags: [Tickets]
 *     summary: Get deal phase status from the Middleman
 *     description: |
 *       Proxies the deal's current phase, terms, escrow address, and deposit
 *       states from the Middleman agent. Only ticket participants can access.
 *     security:
 *       - walletAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Ticket UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WalletAuthBody'
 *     responses:
 *       200:
 *         description: Deal status returned
 *       404:
 *         description: Deal not found on Middleman
 *       500:
 *         description: Internal server error
 */
router.get('/v1/tickets/:id/deal-status', authenticateSolana, async (req, res) => {
    try {
        const { id } = req.params;
        const wallet = (req as any).wallet;

        if (!wallet) {
            res.status(401).json({ success: false, error: 'Unauthorized' });
            return;
        }

        // Verify the caller is a participant
        const { getTicketByIdService } = await import('../services/ticket.service');
        const ticket = await getTicketByIdService(id as string, wallet);

        // Proxy to middleman
        const { middlemanForwarder } = await import('../services/middlemanForwarder');
        const result = await middlemanForwarder.getDealStatus(id as string);

        if (!result.success) {
            res.status(404).json({ success: false, error: 'Deal not found on Middleman', detail: result.error });
            return;
        }

        res.status(200).json({
            success: true,
            deal: {
                ...result.deal,
                buyer: ticket.buyer,
                seller: ticket.seller,
            },
        });
    } catch (error: any) {
        if (error.message === 'UNAUTHORIZED_ACCESS') {
            res.status(403).json({ success: false, error: 'Forbidden' });
            return;
        }
        if (error.message === 'TICKET_NOT_FOUND') {
            res.status(404).json({ success: false, error: 'Ticket not found' });
            return;
        }
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

export default router;
