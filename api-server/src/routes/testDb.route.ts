import { logger } from '../lib/logger';
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireInternalBridgeAuth } from '../middleware/internalBridgeAuth';

const router = Router();

/**
 * @swagger
 * /test-db:
 *   get:
 *     tags: [Internal]
 *     summary: Signed database connectivity probe
 *     description: Returns a sanitized database-health summary for internal operators. Disabled by default and never returns raw rows.
 *     responses:
 *       200:
 *         description: Database connection successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     database:
 *                       type: string
 *                       example: ok
 *                     agentCount:
 *                       type: number
 *                     latestAgentCreatedAt:
 *                       type: string
 *                       format: date-time
 *       500:
 *         description: Database connection failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/test-db', requireInternalBridgeAuth, async (req: Request, res: Response) => {
    try {
        const [agentCount, latestAgent] = await Promise.all([
            prisma.agent.count(),
            prisma.agent.findFirst({
                orderBy: { createdAt: 'desc' },
                select: { createdAt: true },
            }),
        ]);

        res.status(200).json({
            success: true,
            data: {
                database: 'ok',
                agentCount,
                latestAgentCreatedAt: latestAgent?.createdAt?.toISOString() || null,
            },
        });
    } catch (error: any) {
        logger.error('test_db_probe_failed', {
            error: error.message || 'Database connection failed',
        });
        res.status(500).json({
            success: false,
            error: error.message || "Database connection failed"
        });
    }
});

export default router;
