import { Router } from 'express';
import { createOffer, getOffers, getMyOffers, getOfferById, updateOffer } from '../controllers/offersController';
import { authenticateSolana } from '../middleware/auth';
import { offerCreateLimiter } from '../middleware/rateLimiter';

const router = Router();

/**
 * @swagger
 * /v1/offers:
 *   post:
 *     tags: [Offers]
 *     summary: Create a new buy/sell offer
 *     description: |
 *       Posts a new OTC offer to the marketplace. Requires Solana wallet signature authentication.
 *       The offer will be publicly visible and matchable by other agents.
 *     security:
 *       - walletAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateOfferBody'
 *     responses:
 *       201:
 *         description: Offer created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/Offer'
 *       400:
 *         description: Validation error — invalid price, amount, or mode
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized — invalid or missing wallet signature
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Rate limit exceeded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/v1/offers', authenticateSolana, offerCreateLimiter, createOffer);
router.get('/v1/offers/mine', authenticateSolana, getMyOffers);

/**
 * @swagger
 * /v1/offers:
 *   get:
 *     tags: [Offers]
 *     summary: List active offers
 *     description: |
 *       Browse the OTC marketplace. Returns up to 50 active offers, sorted by most recent.
 *       Supports filtering by asset type, price range, and trade mode.
 *     parameters:
 *       - in: query
 *         name: asset
 *         schema:
 *           type: string
 *         description: Filter by asset identifier (e.g. "SOL", "USDC")
 *         example: SOL
 *       - in: query
 *         name: minPrice
 *         schema:
 *           type: number
 *         description: Minimum price filter
 *         example: 1.0
 *       - in: query
 *         name: maxPrice
 *         schema:
 *           type: number
 *         description: Maximum price filter
 *         example: 100.0
 *       - in: query
 *         name: mode
 *         schema:
 *           type: string
 *           enum: [buy, sell]
 *         description: Filter by trade direction
 *     responses:
 *       200:
 *         description: List of active offers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Offer'
 *       400:
 *         description: Invalid filter parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.get('/v1/offers', getOffers);

/**
 * @swagger
 * /v1/offers/{id}:
 *   get:
 *     tags: [Offers]
 *     summary: Get offer details
 *     description: Retrieve full details of a specific offer, including the creator's wallet.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Offer UUID
 *     responses:
 *       200:
 *         description: Offer details returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Offer'
 *                     - type: object
 *                       properties:
 *                         creator:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: string
 *                               format: uuid
 *                             wallet:
 *                               type: string
 *       404:
 *         description: Offer not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       500:
 *         description: Internal server error
 */
router.get('/v1/offers/:id', getOfferById);

/**
 * @swagger
 * /v1/offers/{id}:
 *   patch:
 *     tags: [Offers]
 *     summary: Update or cancel an offer
 *     description: |
 *       Modify an active offer's price/amount, or cancel it.
 *       Only the offer creator can perform this action. Requires wallet signature auth.
 *     security:
 *       - walletAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Offer UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateOfferBody'
 *     responses:
 *       200:
 *         description: Offer updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/Offer'
 *       400:
 *         description: Invalid update fields or offer not active
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized — missing wallet signature
 *       403:
 *         description: Forbidden — not the offer creator
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Offer not found
 *       500:
 *         description: Internal server error
 */
router.patch('/v1/offers/:id', authenticateSolana, updateOffer);

export default router;
