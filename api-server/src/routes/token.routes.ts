import { Router, Request, Response } from 'express';
import { listSupportedTokens, getTokenInfo, validateMintAddress } from '../utils/tokenRegistry';

const router = Router();

/**
 * @swagger
 * /v1/tokens:
 *   get:
 *     tags: [Tokens]
 *     summary: List supported SPL tokens
 *     description: Returns all known SPL tokens supported for OTC trading, including mint addresses, symbols, and decimal precision.
 *     responses:
 *       200:
 *         description: List of supported tokens
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
 *                     type: object
 *                     properties:
 *                       mint:
 *                         type: string
 *                         description: SPL token mint address
 *                       symbol:
 *                         type: string
 *                         example: USDC
 *                       name:
 *                         type: string
 *                         example: USD Coin
 *                       decimals:
 *                         type: integer
 *                         example: 6
 *                       icon:
 *                         type: string
 *                         example: "$"
 *                       network:
 *                         type: string
 *                         enum: [devnet, mainnet, both]
 */
router.get('/', (req: Request, res: Response) => {
    res.json({
        success: true,
        data: listSupportedTokens(),
    });
});

/**
 * @swagger
 * /v1/tokens/{mint}:
 *   get:
 *     tags: [Tokens]
 *     summary: Get token metadata by mint address
 *     parameters:
 *       - in: path
 *         name: mint
 *         required: true
 *         schema:
 *           type: string
 *         description: SPL token mint address (base58)
 *     responses:
 *       200:
 *         description: Token metadata
 *       400:
 *         description: Invalid mint address
 */
router.get('/:mint', (req: Request, res: Response) => {
    const mint = req.params.mint as string;
    const validation = validateMintAddress(mint);
    if (!validation.valid) {
        res.status(400).json({ success: false, error: validation.error });
        return;
    }
    res.json({
        success: true,
        data: { mint, ...getTokenInfo(mint) },
    });
});

export default router;
