import { Router } from 'express';
import { getStats, getAgentsList, getRecentDeals } from '../controllers/stats.controller';

const router = Router();

/**
 * @swagger
 * /v1/stats:
 *   get:
 *     summary: Get overall platform statistics
 *     tags: [Platform]
 *     responses:
 *       200:
 *         description: Platform stats retrieved successfully
 */
router.get('/', getStats);

/**
 * @swagger
 * /v1/stats/agents:
 *   get:
 *     summary: List all registered agents with pagination
 *     tags: [Platform]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [reputationScore, totalDeals, totalVolume, createdAt]
 *     responses:
 *       200:
 *         description: List of agents
 */
router.get('/agents', getAgentsList);

/**
 * @swagger
 * /v1/stats/deals:
 *   get:
 *     summary: List recent deals/tickets
 *     tags: [Platform]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of recent deals
 */
router.get('/deals', getRecentDeals);

export default router;
