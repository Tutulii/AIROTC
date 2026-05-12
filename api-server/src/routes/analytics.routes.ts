/**
 * Analytics Routes — Powered by Dune SIM
 *
 * Exposes on-chain intelligence via REST API endpoints.
 * Backed by Dune SIM's SVM Balances and SVM Transactions APIs
 * to provide agent portfolio views, transaction histories,
 * and deal-level audit trails.
 *
 * Endpoints:
 *   GET /v1/analytics/agent/:wallet/portfolio
 *   GET /v1/analytics/agent/:wallet/history
 *   GET /v1/analytics/deal/:dealPda/audit
 *   GET /v1/analytics/deal/:dealPda/verify
 *   GET /v1/analytics/status
 */

import { Router, Request, Response } from "express";

const router = Router();

// ═══════════════════════════════════════════════════════
// DUNE SIM CONFIGURATION
// ═══════════════════════════════════════════════════════

const DUNE_SIM_API_KEY = process.env.DUNE_SIM_API_KEY || "";
const DUNE_SIM_BASE_URL = "https://api.sim.dune.com";

let requestCount = 0;
let errorCount = 0;

// Simple in-memory cache
const cache: Map<string, { data: any; expiresAt: number }> = new Map();
const CACHE_TTL = 15_000; // 15 seconds

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: any): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}

// ═══════════════════════════════════════════════════════
// DUNE SIM FETCH HELPER
// ═══════════════════════════════════════════════════════

async function fetchDuneSIM(path: string): Promise<any | null> {
  if (!DUNE_SIM_API_KEY) return null;

  requestCount++;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(`${DUNE_SIM_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        "X-Sim-Api-Key": DUNE_SIM_API_KEY,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      errorCount++;
      const body = await res.text().catch(() => "");
      console.error(`Dune SIM error: ${res.status} ${body.substring(0, 200)}`);
      return null;
    }

    return await res.json();
  } catch (err: any) {
    errorCount++;
    console.error(`Dune SIM fetch failed: ${err.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════

function isValidSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

// ═══════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════

/**
 * @swagger
 * /v1/analytics/agent/{wallet}/portfolio:
 *   get:
 *     summary: Get agent's on-chain portfolio
 *     description: Returns all token balances for an agent wallet, powered by Dune SIM
 *     tags: [Analytics]
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema:
 *           type: string
 *         description: Solana wallet address
 *     responses:
 *       200:
 *         description: Portfolio data
 */
router.get("/agent/:wallet/portfolio", async (req: Request, res: Response) => {
  const wallet = req.params.wallet as string;

  if (!isValidSolanaAddress(wallet)) {
    return res.status(400).json({
      success: false,
      error: "Invalid Solana wallet address",
    });
  }

  if (!DUNE_SIM_API_KEY) {
    return res.status(503).json({
      success: false,
      error: "Dune SIM not configured. Set DUNE_SIM_API_KEY environment variable.",
    });
  }

  // Check cache
  const cacheKey = `portfolio:${wallet}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json({ success: true, data: cached, cached: true, dataSource: "dune_sim" });
  }

  const balances = await fetchDuneSIM(`/beta/svm/balances/${wallet}`);

  if (!balances) {
    return res.status(502).json({
      success: false,
      error: "Failed to fetch portfolio data from Dune SIM",
    });
  }

  const portfolio = {
    wallet,
    balances: Array.isArray(balances) ? balances : balances?.balances || balances?.data || [],
    totalTokens: Array.isArray(balances) ? balances.length : 0,
    fetchedAt: new Date().toISOString(),
    dataSource: "dune_sim",
  };

  setCache(cacheKey, portfolio);

  return res.json({
    success: true,
    data: portfolio,
    cached: false,
    dataSource: "dune_sim",
  });
});

/**
 * @swagger
 * /v1/analytics/agent/{wallet}/history:
 *   get:
 *     summary: Get agent's transaction history
 *     description: Returns recent transactions for an agent wallet, powered by Dune SIM
 *     tags: [Analytics]
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Transaction history
 */
router.get("/agent/:wallet/history", async (req: Request, res: Response) => {
  const wallet = req.params.wallet as string;

  if (!isValidSolanaAddress(wallet)) {
    return res.status(400).json({
      success: false,
      error: "Invalid Solana wallet address",
    });
  }

  if (!DUNE_SIM_API_KEY) {
    return res.status(503).json({
      success: false,
      error: "Dune SIM not configured",
    });
  }

  const cacheKey = `history:${wallet}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json({ success: true, data: cached, cached: true, dataSource: "dune_sim" });
  }

  const transactions = await fetchDuneSIM(`/beta/svm/transactions/${wallet}`);

  if (!transactions) {
    return res.status(502).json({
      success: false,
      error: "Failed to fetch transaction history from Dune SIM",
    });
  }

  const history = {
    wallet,
    transactions: Array.isArray(transactions) ? transactions : transactions?.transactions || transactions?.data || [],
    total: Array.isArray(transactions) ? transactions.length : 0,
    fetchedAt: new Date().toISOString(),
    dataSource: "dune_sim",
  };

  setCache(cacheKey, history);

  return res.json({
    success: true,
    data: history,
    cached: false,
    dataSource: "dune_sim",
  });
});

/**
 * @swagger
 * /v1/analytics/deal/{dealPda}/audit:
 *   get:
 *     summary: Get deal's on-chain audit trail
 *     description: Returns all transactions that touched the deal's escrow PDA
 *     tags: [Analytics]
 *     parameters:
 *       - in: path
 *         name: dealPda
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Deal audit trail
 */
router.get("/deal/:dealPda/audit", async (req: Request, res: Response) => {
  const dealPda = req.params.dealPda as string;

  if (!isValidSolanaAddress(dealPda)) {
    return res.status(400).json({
      success: false,
      error: "Invalid deal PDA address",
    });
  }

  if (!DUNE_SIM_API_KEY) {
    return res.status(503).json({
      success: false,
      error: "Dune SIM not configured",
    });
  }

  // Fetch both balances and transactions for the escrow PDA
  const [balances, transactions] = await Promise.all([
    fetchDuneSIM(`/beta/svm/balances/${dealPda}`),
    fetchDuneSIM(`/beta/svm/transactions/${dealPda}`),
  ]);

  const txArray = Array.isArray(transactions) ? transactions : transactions?.transactions || transactions?.data || [];

  const audit = {
    dealPda,
    currentBalances: Array.isArray(balances) ? balances : balances?.balances || [],
    transactions: txArray,
    transactionCount: txArray.length,
    timeline: txArray.sort((a: any, b: any) => (a.block_time || a.blockTime || 0) - (b.block_time || b.blockTime || 0)),
    fetchedAt: new Date().toISOString(),
    dataSource: "dune_sim",
  };

  return res.json({
    success: true,
    data: audit,
    dataSource: "dune_sim",
  });
});

/**
 * @swagger
 * /v1/analytics/deal/{dealPda}/verify:
 *   get:
 *     summary: Verify deal deposits via Dune SIM
 *     description: Cross-validates deposit amounts using Dune SIM as secondary data source
 *     tags: [Analytics]
 *     parameters:
 *       - in: path
 *         name: dealPda
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: expectedLamports
 *         required: false
 *         schema:
 *           type: number
 *     responses:
 *       200:
 *         description: Deposit verification result
 */
router.get("/deal/:dealPda/verify", async (req: Request, res: Response) => {
  const dealPda = req.params.dealPda as string;
  const expectedLamports = parseInt(req.query.expectedLamports as string || "0", 10);

  if (!isValidSolanaAddress(dealPda)) {
    return res.status(400).json({
      success: false,
      error: "Invalid deal PDA address",
    });
  }

  if (!DUNE_SIM_API_KEY) {
    return res.status(503).json({
      success: false,
      error: "Dune SIM not configured",
    });
  }

  const balances = await fetchDuneSIM(`/beta/svm/balances/${dealPda}`);

  // Extract native SOL balance
  let currentLamports = 0;
  if (Array.isArray(balances)) {
    const solBalance = balances.find((b: any) =>
      b.symbol === "SOL" || b.native || b.token_address === "So11111111111111111111111111111111111111112"
    );
    currentLamports = solBalance ? parseFloat(solBalance.amount || solBalance.balance || "0") : 0;
  } else if (balances) {
    currentLamports = balances.lamports || balances.balance || 0;
  }

  const verified = expectedLamports > 0 ? currentLamports >= expectedLamports * 0.99 : currentLamports > 0;

  return res.json({
    success: true,
    data: {
      dealPda,
      verified,
      currentLamports,
      expectedLamports: expectedLamports || null,
      sufficientFunds: verified,
      verifiedAt: new Date().toISOString(),
      dataSource: "dune_sim",
    },
  });
});

/**
 * @swagger
 * /v1/analytics/status:
 *   get:
 *     summary: Dune SIM integration health status
 *     tags: [Analytics]
 *     responses:
 *       200:
 *         description: Service status
 */
router.get("/status", async (_req: Request, res: Response) => {
  const configured = !!DUNE_SIM_API_KEY;

  // Health check — try a simple ping
  let reachable = false;
  let latencyMs = 0;
  if (configured) {
    const start = Date.now();
    const testResult = await fetchDuneSIM("/beta/svm/balances/11111111111111111111111111111111");
    latencyMs = Date.now() - start;
    reachable = testResult !== null || latencyMs < 10_000;
  }

  return res.json({
    success: true,
    data: {
      provider: "dune_sim",
      configured,
      reachable,
      latencyMs,
      stats: {
        totalRequests: requestCount,
        totalErrors: errorCount,
        errorRate: requestCount > 0 ? (errorCount / requestCount * 100).toFixed(1) + "%" : "0%",
        cacheEntries: cache.size,
      },
      endpoints: {
        svmBalances: "/beta/svm/balances/{address}",
        svmTransactions: "/beta/svm/transactions/{address}",
      },
    },
  });
});

export default router;
