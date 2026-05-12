import { Router } from 'express';
import { getDeal, getDealTransactions } from '../controllers/deal.controller';

const router = Router();

/**
 * @swagger
 * /v1/deals/{id}/transactions:
 *   get:
 *     tags: [Deals]
 *     summary: Get deal transaction timeline
 *     description: |
 *       Retrieves the full on-chain transaction history for a deal PDA.
 *       Each event is decoded from Anchor program logs and includes Solana Explorer links.
 *       Events: `deal_created`, `buyer_deposit`, `seller_deposit`, `funded`, `released`, `cancelled`.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Deal PDA public key (base58)
 *         example: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 1000
 *         description: Maximum number of signatures to fetch
 *       - in: query
 *         name: before
 *         schema:
 *           type: string
 *         description: Fetch transactions before this signature (pagination)
 *     responses:
 *       200:
 *         description: Transaction timeline returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 dealId:
 *                   type: string
 *                 transactions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/TransactionEvent'
 *       400:
 *         description: Invalid public key format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.get('/:id/transactions', getDealTransactions);

/**
 * @swagger
 * /v1/deals/{id}:
 *   get:
 *     tags: [Deals]
 *     summary: Get on-chain deal state
 *     description: |
 *       Reads the live deal state directly from Solana. Decodes the Anchor account data
 *       and returns participants, financials, funding status, and Solana Explorer links.
 *       This is a real-time on-chain read — not cached.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Deal PDA public key (base58)
 *         example: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
 *     responses:
 *       200:
 *         description: On-chain deal state returned
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DealState'
 *       400:
 *         description: Invalid public key or program owner mismatch
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Deal account not found on-chain
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.get('/:id', getDeal);

export default router;
