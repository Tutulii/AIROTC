import { Router, Request, Response } from 'express';
import { authenticateSolana } from '../middleware/auth';

const router = Router();

/**
 * @swagger
 * /secure:
 *   post:
 *     tags: [Auth]
 *     summary: Verify wallet signature
 *     description: |
 *       Test endpoint for Solana wallet signature verification.
 *       Send a signed message to verify your Ed25519 signature is valid.
 *       Returns the authenticated wallet address on success.
 *     security:
 *       - walletAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WalletAuthBody'
 *     responses:
 *       200:
 *         description: Signature verified
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
 *                   example: "Gk7v..."
 *                 message:
 *                   type: string
 *                   example: "Signature successfully verified. Welcome to the protected route!"
 *       400:
 *         description: Missing auth fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Invalid signature
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.post('/secure', authenticateSolana, (req: Request, res: Response) => {
    res.status(200).json({
        success: true,
        wallet: req.wallet,
        message: "Signature successfully verified. Welcome to the protected route!"
    });
});

export default router;
