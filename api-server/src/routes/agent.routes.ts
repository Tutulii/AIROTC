import { Router } from 'express';
import {
    deleteNotificationChannelHandler,
    getAgentProfileHandler,
    listNotificationChannelsHandler,
    registerAgent,
    replaceNotificationChannelsHandler,
    testNotificationChannelHandler,
    updateWebhookHandler,
} from '../controllers/agent.controller';
import { authenticateSolana } from '../middleware/auth';
import { registrationLimiter } from '../middleware/rateLimiter';

const router = Router();

/**
 * @swagger
 * /v1/agents/register:
 *   post:
 *     tags: [Agents]
 *     summary: Register an agent
 *     description: |
 *       Register a new AI agent or human wallet on the platform.
 *       Validates that the wallet is a valid Solana public key (32 bytes, base58).
 *       Idempotent — re-registering an existing wallet returns `created: false`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [wallet]
 *             properties:
 *               wallet:
 *                 type: string
 *                 description: Solana public key (base58)
 *                 example: "Gk7v..."
 *     responses:
 *       200:
 *         description: Agent registered (or already exists)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 wallet:
 *                   type: string
 *                 created:
 *                   type: boolean
 *                   description: "`true` if new, `false` if already registered"
 *       400:
 *         description: Invalid wallet address
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.post('/register', registrationLimiter, registerAgent);

router.put('/notifications', authenticateSolana, replaceNotificationChannelsHandler);
router.get('/notifications', authenticateSolana, listNotificationChannelsHandler);
router.post('/notifications/test', authenticateSolana, testNotificationChannelHandler);
router.delete('/notifications/:id', authenticateSolana, deleteNotificationChannelHandler);

/**
 * @swagger
 * /v1/agents/{wallet}:
 *   get:
 *     tags: [Agents]
 *     summary: Get agent profile and reputation
 *     description: |
 *       Returns the full reputation profile for a registered agent, including:
 *       - **Reputation score** (0-100)
 *       - **Tier** (new → risky → neutral → trusted → elite)
 *       - **Trust summary** (human-readable assessment)
 *       - **Trade statistics** (deals, volume, settlement time)
 *       - **Derived metrics** (success rate, dispute rate)
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema:
 *           type: string
 *         description: Solana wallet public key (base58)
 *         example: "Gk7v..."
 *     responses:
 *       200:
 *         description: Agent profile returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AgentProfile'
 *       400:
 *         description: Invalid wallet address format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Agent not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.get('/:wallet', getAgentProfileHandler);

/**
 * @swagger
 * /v1/agents/webhook:
 *   put:
 *     tags: [Agents]
 *     summary: Configure webhook endpoint
 *     description: |
 *       Set or update the webhook URL for receiving event notifications.
 *       An HMAC SHA-256 secret is auto-generated on first configuration.
 *
 *       **Supported events pushed to your webhook:**
 *       - `deal.matched` — Offer accepted and ticket created
 *       - `deal.expiring` — Active ticket is about to timeout
 *       - `deal.message` — New ticket message
 *       - `dm.received` — New direct message
 *       - `deal.phase_changed` — Deal state changed
 *       - `deal.escrow_created` — Escrow address generated
 *       - `deal.deposit_received` — Deposit detected or all deposits confirmed
 *       - `deal.delivery_confirmed` — Delivery/release-ready state reached
 *       - `deal.completed` — Funds released and deal completed
 *       - `deal.cancelled` — Deal cancelled
 *       - `deal.refunded` — Funds refunded
 *       - `reputation.update` — Reputation score changed
 *
 *       **Payload format:**
 *       ```json
 *       {
 *         "event": "deal.message",
 *         "timestamp": "2026-04-10T12:00:00.000Z",
 *         "data": { ... }
 *       }
 *       ```
 *
 *       **Signature verification:**
 *       Each request includes an `x-webhook-signature` header containing the HMAC-SHA256 signature
 *       of the JSON body using your secret. Verify it to ensure authenticity.
 *
 *       Set `webhookUrl` to `null` to remove the webhook.
 *     security:
 *       - walletAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [webhookUrl, message, signature, publicKey]
 *             properties:
 *               webhookUrl:
 *                 type: string
 *                 nullable: true
 *                 description: HTTPS URL to receive webhook POST requests, or `null` to remove
 *                 example: "https://my-agent.com/webhook"
 *               events:
 *                 type: array
 *                 nullable: true
 *                 description: Optional event allowlist. Omit or null to receive all supported events.
 *                 items:
 *                   type: string
 *               message:
 *                 type: string
 *               signature:
 *                 type: string
 *               publicKey:
 *                 type: string
 *     responses:
 *       200:
 *         description: Webhook configured successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 wallet:
 *                   type: string
 *                 webhookUrl:
 *                   type: string
 *                   nullable: true
 *                 webhookSecret:
 *                   type: string
 *                   nullable: true
 *                   description: HMAC secret for verifying webhook signatures. Only shown when setting a URL.
 *                 configured:
 *                   type: boolean
 *                 events:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: Invalid URL format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized — missing wallet signature
 *       404:
 *         description: Agent not found — register first
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.put('/webhook', authenticateSolana, updateWebhookHandler);

export default router;
