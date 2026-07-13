import express, { Application, Request, Response } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { corsMiddleware } from './middleware/cors';
import { apiRateLimiter } from './middleware/rateLimiter';
import { requestIdMiddleware, httpLogger } from './middleware/requestId';
import { errorHandler } from './middleware/errorHandler';
import { sanitizeMessageMiddleware } from './middleware/sanitizer';
import { swaggerSpec } from './docs/swagger';

import healthRoutes from './routes/health.route';
import testDbRoutes from './routes/testDb.route';
import secureRoutes from './routes/secure.route';
import offersRoutes from './routes/offers';
import ticketRoutes from './routes/ticket.routes';
import dealRoutes from './routes/deal.routes';
import agentRoutes from './routes/agent.routes';
import statsRoutes from './routes/stats.routes';
import bridgeRoutes from './routes/bridge.routes';
import tokenRoutes from './routes/token.routes';
import metricsRoutes from './routes/metrics.routes';
import priceRoutes from './routes/price.routes';
import simulateRoutes from './routes/simulate.routes';
import dmRoutes from './routes/dm.routes';
import fileRoutes from './routes/file.routes';
import feeRoutes from './routes/fee.routes';
import analyticsRoutes from './routes/analytics.routes';
import encryptRoutes from './routes/encrypt.routes';
import mcpRoutes from './routes/mcp.routes';
import eventsRoutes from './routes/events.routes';
import txlineRoutes from './routes/txline.routes';
import arenaRoutes from './routes/arena.routes';
import reputationRoutes from './routes/reputation.routes';
import sportRoutes from './routes/sport.routes';

const app: Application = express();
const simulationRoutesEnabled = process.env.ENABLE_SIMULATION_ROUTES === 'true';

// Railway terminates TLS/proxying before requests reach Express.
// Trust one proxy hop so express-rate-limit reads the client IP correctly.
app.set('trust proxy', 1);

// 1. Core Security & Parsing Middleware (STRICT ORDER)
app.use(helmet({
    contentSecurityPolicy: false, // Allow Swagger UI to load inline scripts/styles
}));
app.use(corsMiddleware);
app.use(apiRateLimiter);
app.use(express.json());
app.use(requestIdMiddleware);
app.use(sanitizeMessageMiddleware);
app.use(httpLogger);

// 2. Raw spec endpoint first (before swagger UI intercepts the path)
app.get('/docs/spec.json', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
});

// 3. API Documentation (Swagger UI)
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    explorer: true,
    customSiteTitle: 'AgentOTC API Docs',
    customCss: `
        .swagger-ui .topbar { display: none; }
        .swagger-ui .info .title { font-size: 2em; }
        .swagger-ui .scheme-container { background: #1a1a2e; padding: 12px; border-radius: 8px; }
    `,
    swaggerOptions: {
        docExpansion: 'list',
        defaultModelsExpandDepth: 1,
        filter: true,
        tryItOutEnabled: true,
    },
}));

// 4. Routes
app.use('/', healthRoutes);
if (process.env.ENABLE_DB_DIAGNOSTICS_ROUTE === 'true') {
    app.use('/', testDbRoutes);
}
app.use('/', secureRoutes);
app.use('/', offersRoutes);
app.use('/', ticketRoutes);
app.use('/v1/deals', dealRoutes);
app.use('/v1/agents', agentRoutes);
app.use('/v1/stats', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
}, statsRoutes);
app.use('/v1/bridge', bridgeRoutes);
app.use('/v1/tokens', tokenRoutes);
app.use('/v1/metrics', metricsRoutes);
app.use('/v1/prices', priceRoutes);
if (simulationRoutesEnabled) {
    app.use('/v1/simulate', simulateRoutes);
}
app.use('/', dmRoutes);
app.use('/', fileRoutes);
app.use('/', feeRoutes);
app.use('/v1/analytics', analyticsRoutes);
app.use('/v1/encrypt', encryptRoutes);
app.use('/v1/mcp', mcpRoutes);
app.use('/', eventsRoutes);
app.use('/', txlineRoutes);
app.use('/', arenaRoutes);
app.use('/', reputationRoutes);
app.use('/v1/sport', sportRoutes);

// Stats overview alias (maps /v1/stats/overview → /v1/stats)
app.get('/v1/stats/overview', (req: Request, res: Response, next) => {
    req.url = '/v1/stats/';
    statsRoutes(req, res, next);
});

// 5. Fallback 404 Handler
app.use((req: Request, res: Response) => {
    res.status(404).json({ success: false, error: "Route not found" });
});

// 6. Global Error Handling Middleware (Must be last)
app.use(errorHandler);

export default app;
