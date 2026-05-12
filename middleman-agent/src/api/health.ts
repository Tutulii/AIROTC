import express from "express";
import { Server } from "http";
import { prisma } from "../lib/prisma";
import { rpcManager } from "../utils/rpcManager";
import { circuitBreaker } from "../utils/circuitBreaker";
import { shutdownManager } from "../utils/shutdownManager";
import { logger } from "../utils/logger";
import { verifyAuditChain } from "../services/auditTrail";
import { dependencyHealthService } from "../services/dependencyHealthService";
import dealTimelineRouter from "./dealTimeline";

const app = express();
app.use(express.json());
app.use("/api", dealTimelineRouter);
let server: Server | null = null;
const API_VERSION = "2.0";

// ── LEVEL 5: Emergency Kill Switch ──
export let SYSTEM_PAUSED = false;

// Absolute safe boundary execution evaluating latency or yielding explicitly
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallbackConfig: any): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<any>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(fallbackConfig);
    }, timeoutMs);
  });

  return Promise.race([
    promise.then(result => {
      clearTimeout(timeoutId);
      return result;
    }).catch(err => {
      clearTimeout(timeoutId);
      throw err;
    }),
    timeoutPromise
  ]);
}

app.get("/health", async (req, res) => {
  const start = Date.now();

  logger.info("health_check_requested");

  // 1. Postgres Liveness
  const checkDb = async () => {
    const dbStart = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      const latency_ms = Date.now() - dbStart;
      return { status: latency_ms > 1000 ? "degraded" : "ok", latency_ms };
    } catch (err) {
      return { status: "down", latency_ms: Date.now() - dbStart };
    }
  };

  // 2. Solana RPC Check
  const checkRpc = async () => {
    const rpcStart = Date.now();
    try {
      const conn = rpcManager.getConnection();
      const slot = await conn.getSlot("confirmed");
      const latency_ms = Date.now() - rpcStart;
      return { status: latency_ms > 1000 ? "degraded" : "ok", latency_ms, slot };
    } catch (err) {
      return { status: "down", latency_ms: Date.now() - rpcStart, slot: null };
    }
  };

  const [dbResult, rpcResult] = await Promise.all([
    withTimeout(checkDb(), 1500, { status: "down", latency_ms: 1500 }),
    withTimeout(checkRpc(), 1500, { status: "down", latency_ms: 1500, slot: null })
  ]);
  const dependencySnapshot = await withTimeout(
    dependencyHealthService.getSnapshot(),
    2500,
    {
      checkedAt: new Date().toISOString(),
      overallStatus: "degraded",
      probes: {},
    }
  );

  const cbState = circuitBreaker.getStatus().state;

  let globalStatus = "ok";
  if (SYSTEM_PAUSED) {
    globalStatus = "paused";
  } else if (dbResult.status === "down" || rpcResult.status === "down") {
    globalStatus = "down";
  } else if (dbResult.status === "degraded" || rpcResult.status === "degraded" || cbState !== "CLOSED") {
    globalStatus = "degraded";
  }

  const payload = {
    status: globalStatus,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    system_paused: SYSTEM_PAUSED,
    checks: {
      database: dbResult,
      solana_rpc: rpcResult,
      external_dependencies: dependencySnapshot,
      active_deals: shutdownManager.getActiveExecutions(),
      circuit_breaker: cbState
    },
    version: API_VERSION
  };

  const statusCode = globalStatus === "down" ? 503 : 200;

  logger.info("health_check_result", { status: globalStatus, latency: Date.now() - start });

  res.status(statusCode).json(payload);
});

// ── Emergency Kill Switch Endpoints ──

app.post("/api/emergency/pause", (req, res) => {
  SYSTEM_PAUSED = true;
  logger.warn("emergency_kill_switch_activated", { by: req.ip });
  res.json({ status: "paused", message: "System paused. Active deals continue, new deals blocked." });
});

app.post("/api/emergency/resume", (req, res) => {
  SYSTEM_PAUSED = false;
  logger.info("emergency_kill_switch_deactivated", { by: req.ip });
  res.json({ status: "resumed", message: "System resumed. New deals accepted." });
});

// ── SLA Metrics ──

app.get("/metrics", async (req, res) => {
  try {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [totalDeals, completedDeals, timedOutDeals, disputedDeals, activePhaseStates] = await Promise.all([
      prisma.deal.count({ where: { createdAt: { gte: dayAgo } } }),
      prisma.deal.count({ where: { status: "completed", createdAt: { gte: dayAgo } } }),
      prisma.deal.count({ where: { status: { in: ["expired", "timeout_failed"] }, createdAt: { gte: dayAgo } } }),
      prisma.deal.count({ where: { status: "disputed", createdAt: { gte: dayAgo } } }),
      prisma.dealPhaseState.count({ where: { phase: { notIn: ["completed", "cancelled", "refunded"] } } }),
    ]);

    const timeoutRate = totalDeals > 0 ? timedOutDeals / totalDeals : 0;
    const disputeRate = totalDeals > 0 ? disputedDeals / totalDeals : 0;

    const textMetrics = [
      `# HELP agentotc_deals_total Total deals in last 24h`,
      `# TYPE agentotc_deals_total gauge`,
      `agentotc_deals_total ${totalDeals}`,
      `# HELP agentotc_deals_completed Completed deals in last 24h`,
      `# TYPE agentotc_deals_completed gauge`,
      `agentotc_deals_completed ${completedDeals}`,
      `# HELP agentotc_timeout_rate Timeout rate (0-1) in last 24h`,
      `# TYPE agentotc_timeout_rate gauge`,
      `agentotc_timeout_rate ${timeoutRate.toFixed(4)}`,
      `# HELP agentotc_dispute_rate Dispute rate (0-1) in last 24h`,
      `# TYPE agentotc_dispute_rate gauge`,
      `agentotc_dispute_rate ${disputeRate.toFixed(4)}`,
      `# HELP agentotc_active_deals Currently active deals`,
      `# TYPE agentotc_active_deals gauge`,
      `agentotc_active_deals ${activePhaseStates}`,
      `# HELP agentotc_system_paused Whether system is paused (1=yes)`,
      `# TYPE agentotc_system_paused gauge`,
      `agentotc_system_paused ${SYSTEM_PAUSED ? 1 : 0}`,
      `# HELP agentotc_circuit_breaker_state Circuit breaker state`,
      `# TYPE agentotc_circuit_breaker_state gauge`,
      `agentotc_circuit_breaker_state{state="${circuitBreaker.getStatus().state}"} 1`,
    ].join("\n");

    res.set("Content-Type", "text/plain");
    res.send(textMetrics);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Audit Chain Verification ──

app.get("/api/audit/:ticketId", async (req, res) => {
  const result = await verifyAuditChain(req.params.ticketId);
  const logs = await prisma.auditLog.findMany({
    where: { ticketId: req.params.ticketId },
    orderBy: { createdAt: "asc" },
    select: { event: true, createdAt: true, hash: true },
  });
  res.json({ ...result, events: logs });
});

export function startHealthServer(port: number = parseInt(process.env.HEALTH_PORT || "8080")): void {
  if (server) return;
  server = app.listen(port, () => {
    logger.info("health_server_started", { port });
  });
}

export function stopHealthServer(): void {
  if (server) {
    server.close(() => {
      logger.info("health_server_stopped");
    });
    server = null;
  }
}
