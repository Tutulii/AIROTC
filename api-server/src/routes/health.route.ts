import { Router, Request, Response } from 'express';

const router = Router();

/**
 * @swagger
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: System health check
 *     description: Returns server liveness status and current timestamp. Use this to verify the API is reachable.
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
router.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
        status: 'ok',
        apiVersion: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

export default router;
