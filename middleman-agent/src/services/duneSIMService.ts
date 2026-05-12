/**
 * Dune SIM Service — On-Chain Intelligence Layer
 *
 * Integrates Dune SIM's SVM APIs for deep on-chain analytics.
 * Provides real-time balance monitoring, transaction history,
 * and deposit verification as a secondary data source alongside
 * the primary WebSocket-based deposit watcher.
 *
 * Capabilities:
 * - Wallet balance queries (all SVM tokens) via SVM Balances API
 * - Transaction history lookup via SVM Transactions API
 * - Deposit verification (cross-validates WebSocket detections)
 * - Caching layer with TTL-based invalidation
 * - Rate limiting to stay within API quotas
 * - Structured logging for observability
 *
 * API Reference:
 *   GET /beta/svm/balances/{address}
 *   GET /beta/svm/transactions/{address}
 *   Header: X-Sim-Api-Key
 */

import { logger } from "../utils/logger";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface DuneSIMConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  cacheTtlMs: number;
  rateLimitPerMinute: number;
}

export interface TokenBalance {
  address: string;
  amount: string;
  decimals: number;
  symbol?: string;
  name?: string;
  usdValue?: number;
  logoUrl?: string;
}

export interface WalletBalances {
  address: string;
  totalUsdValue: number;
  nativeBalance: TokenBalance | null;
  tokens: TokenBalance[];
  timestamp: number;
}

export interface TransactionRecord {
  signature: string;
  blockTime: number;
  slot: number;
  fee: number;
  status: "success" | "failed";
  type?: string;
  from?: string;
  to?: string;
  amount?: number;
  tokenMint?: string;
}

export interface TransactionHistory {
  address: string;
  transactions: TransactionRecord[];
  total: number;
  timestamp: number;
}

export interface DepositVerification {
  verified: boolean;
  currentBalance: number;
  recentDeposits: TransactionRecord[];
  dataSource: "dune_sim";
  verifiedAt: number;
}

// ═══════════════════════════════════════════════════════
// CACHE
// ═══════════════════════════════════════════════════════

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class SimpleCache<T> {
  private store: Map<string, CacheEntry<T>> = new Map();

  set(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// ═══════════════════════════════════════════════════════
// RATE LIMITER
// ═══════════════════════════════════════════════════════

class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(maxPerMinute: number) {
    this.maxTokens = maxPerMinute;
    this.tokens = maxPerMinute;
    this.lastRefill = Date.now();
    this.refillRate = maxPerMinute / 60_000;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
      logger.debug("dune_sim_rate_limit_wait", { wait_ms: waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// ═══════════════════════════════════════════════════════
// DUNE SIM CLIENT
// ═══════════════════════════════════════════════════════

const DEFAULT_CONFIG: DuneSIMConfig = {
  apiKey: process.env.DUNE_SIM_API_KEY || "",
  baseUrl: "https://api.sim.dune.com",
  timeoutMs: 10_000,
  maxRetries: 3,
  cacheTtlMs: 15_000, // 15s cache for balance queries
  rateLimitPerMinute: 30, // Conservative default
};

class DuneSIMClient {
  private config: DuneSIMConfig;
  private balanceCache: SimpleCache<WalletBalances>;
  private txCache: SimpleCache<TransactionHistory>;
  private rateLimiter: TokenBucketRateLimiter;
  private requestCount = 0;
  private errorCount = 0;
  private initialized = false;

  constructor(config?: Partial<DuneSIMConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.balanceCache = new SimpleCache<WalletBalances>();
    this.txCache = new SimpleCache<TransactionHistory>();
    this.rateLimiter = new TokenBucketRateLimiter(this.config.rateLimitPerMinute);
  }

  // ── Initialization ──

  initialize(apiKey?: string): void {
    if (apiKey) this.config.apiKey = apiKey;
    if (!this.config.apiKey) {
      logger.warn("dune_sim_no_api_key", {
        message: "Dune SIM API key not configured. Service will operate in degraded mode.",
      });
      return;
    }
    this.initialized = true;
    logger.info("dune_sim_initialized", {
      base_url: this.config.baseUrl,
      cache_ttl_ms: this.config.cacheTtlMs,
      rate_limit: this.config.rateLimitPerMinute,
    });
  }

  get isAvailable(): boolean {
    return this.initialized && !!this.config.apiKey;
  }

  // ── Core API Methods ──

  /**
   * Fetch all SVM token balances for a wallet address.
   * Returns cached data if available and fresh.
   */
  async getWalletBalances(address: string, skipCache = false): Promise<WalletBalances | null> {
    if (!this.isAvailable) return null;

    // Check cache
    if (!skipCache) {
      const cached = this.balanceCache.get(address);
      if (cached) {
        logger.debug("dune_sim_balance_cache_hit", { address: this.abbreviate(address) });
        return cached;
      }
    }

    const data = await this.fetchAPI<any>(`/beta/svm/balances/${address}`);
    if (!data) return null;

    const balances = this.parseBalancesResponse(address, data);
    this.balanceCache.set(address, balances, this.config.cacheTtlMs);

    logger.info("dune_sim_balances_fetched", {
      address: this.abbreviate(address),
      token_count: balances.tokens.length,
      native_balance: balances.nativeBalance?.amount || "0",
      total_usd: balances.totalUsdValue,
    });

    return balances;
  }

  /**
   * Fetch SVM transaction history for a wallet address.
   * Returns cached data if available and fresh.
   */
  async getTransactionHistory(address: string, skipCache = false): Promise<TransactionHistory | null> {
    if (!this.isAvailable) return null;

    if (!skipCache) {
      const cached = this.txCache.get(address);
      if (cached) {
        logger.debug("dune_sim_tx_cache_hit", { address: this.abbreviate(address) });
        return cached;
      }
    }

    const data = await this.fetchAPI<any>(`/beta/svm/transactions/${address}`);
    if (!data) return null;

    const history = this.parseTransactionsResponse(address, data);
    this.txCache.set(address, history, this.config.cacheTtlMs);

    logger.info("dune_sim_transactions_fetched", {
      address: this.abbreviate(address),
      tx_count: history.transactions.length,
    });

    return history;
  }

  // ── Deposit Verification ──

  /**
   * Verify a deposit by checking balance and recent transactions via Dune SIM.
   * Used as a secondary verification layer alongside WebSocket-based detection.
   */
  async verifyDeposit(
    dealPda: string,
    expectedAmountLamports: number,
    depositorAddress?: string,
  ): Promise<DepositVerification> {
    const result: DepositVerification = {
      verified: false,
      currentBalance: 0,
      recentDeposits: [],
      dataSource: "dune_sim",
      verifiedAt: Date.now(),
    };

    if (!this.isAvailable) {
      logger.debug("dune_sim_verification_skipped", { reason: "not_available" });
      return result;
    }

    try {
      // Step 1: Fetch current balance via Dune SIM
      const balances = await this.getWalletBalances(dealPda, true); // Skip cache for verification
      if (balances && balances.nativeBalance) {
        result.currentBalance = parseFloat(balances.nativeBalance.amount);
      }

      // Step 2: Fetch recent transactions to find the deposit
      const history = await this.getTransactionHistory(dealPda, true);
      if (history) {
        // Filter for recent incoming transfers
        const recentDeposits = history.transactions.filter((tx) => {
          const isRecent = tx.blockTime > Date.now() / 1000 - 300; // Last 5 minutes
          const isSuccess = tx.status === "success";
          const isFromDepositor = !depositorAddress || tx.from === depositorAddress;
          return isRecent && isSuccess && isFromDepositor;
        });
        result.recentDeposits = recentDeposits;
      }

      // Step 3: Verify the deposit
      const lamportsThreshold = expectedAmountLamports * 0.99; // 1% tolerance
      if (result.currentBalance >= lamportsThreshold) {
        result.verified = true;
        logger.info("dune_sim_deposit_verified", {
          deal_pda: this.abbreviate(dealPda),
          current_balance: result.currentBalance,
          expected: expectedAmountLamports,
          recent_deposits: result.recentDeposits.length,
        });
      } else {
        logger.debug("dune_sim_deposit_insufficient", {
          deal_pda: this.abbreviate(dealPda),
          current_balance: result.currentBalance,
          expected: expectedAmountLamports,
        });
      }

      return result;
    } catch (err: any) {
      logger.warn("dune_sim_verification_error", { deal_pda: this.abbreviate(dealPda), error: err.message });
      return result;
    }
  }

  // ── Agent Portfolio Analytics ──

  /**
   * Get a comprehensive portfolio view for an agent wallet.
   * Combines balance data with transaction history for analytics.
   */
  async getAgentPortfolio(agentWallet: string): Promise<{
    wallet: string;
    balances: WalletBalances | null;
    recentActivity: TransactionHistory | null;
    stats: {
      totalTokens: number;
      totalUsdValue: number;
      recentTxCount: number;
      lastActiveAt: number | null;
    };
  }> {
    const [balances, activity] = await Promise.all([
      this.getWalletBalances(agentWallet),
      this.getTransactionHistory(agentWallet),
    ]);

    const lastTx = activity?.transactions[0];

    return {
      wallet: agentWallet,
      balances,
      recentActivity: activity,
      stats: {
        totalTokens: balances?.tokens.length || 0,
        totalUsdValue: balances?.totalUsdValue || 0,
        recentTxCount: activity?.transactions.length || 0,
        lastActiveAt: lastTx ? lastTx.blockTime * 1000 : null,
      },
    };
  }

  /**
   * Get full on-chain audit trail for a deal PDA.
   * Returns all transactions that touched the escrow address.
   */
  async getDealAuditTrail(dealPda: string): Promise<{
    dealPda: string;
    deposits: TransactionRecord[];
    withdrawals: TransactionRecord[];
    totalDeposited: number;
    totalWithdrawn: number;
    netBalance: number;
    timeline: TransactionRecord[];
    dataSource: "dune_sim";
  }> {
    const history = await this.getTransactionHistory(dealPda, true);
    const transactions = history?.transactions || [];

    const deposits = transactions.filter((tx) => tx.to === dealPda && tx.status === "success");
    const withdrawals = transactions.filter((tx) => tx.from === dealPda && tx.status === "success");

    const totalDeposited = deposits.reduce((sum, tx) => sum + (tx.amount || 0), 0);
    const totalWithdrawn = withdrawals.reduce((sum, tx) => sum + (tx.amount || 0), 0);

    return {
      dealPda,
      deposits,
      withdrawals,
      totalDeposited,
      totalWithdrawn,
      netBalance: totalDeposited - totalWithdrawn,
      timeline: transactions.sort((a, b) => a.blockTime - b.blockTime),
      dataSource: "dune_sim",
    };
  }

  // ── Telemetry ──

  getServiceStats(): {
    available: boolean;
    requestCount: number;
    errorCount: number;
    cacheSize: number;
    errorRate: number;
  } {
    return {
      available: this.isAvailable,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      cacheSize: this.balanceCache.size + this.txCache.size,
      errorRate: this.requestCount > 0 ? this.errorCount / this.requestCount : 0,
    };
  }

  // ── Internal Helpers ──

  private async fetchAPI<T>(path: string): Promise<T | null> {
    await this.rateLimiter.acquire();
    this.requestCount++;

    const url = `${this.config.baseUrl}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

        const response = await fetch(url, {
          method: "GET",
          headers: {
            "X-Sim-Api-Key": this.config.apiKey,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "no body");

          if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get("Retry-After") || "5", 10);
            logger.warn("dune_sim_rate_limited", { retry_after: retryAfter, attempt });
            await new Promise((r) => setTimeout(r, retryAfter * 1000));
            continue;
          }

          throw new Error(`HTTP ${response.status}: ${errorBody.substring(0, 200)}`);
        }

        const data = (await response.json()) as T;
        return data;
      } catch (err: any) {
        lastError = err;
        if (err.name === "AbortError") {
          logger.warn("dune_sim_timeout", { path, attempt, timeout_ms: this.config.timeoutMs });
        } else {
          logger.warn("dune_sim_request_failed", {
            path,
            attempt,
            error: err.message,
          });
        }

        if (attempt < this.config.maxRetries) {
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    this.errorCount++;
    logger.error("dune_sim_request_exhausted", {
      path,
      retries: this.config.maxRetries,
      error: lastError?.message,
    });
    return null;
  }

  private parseBalancesResponse(address: string, raw: any): WalletBalances {
    // Dune SIM response format — adapt based on actual response shape
    const tokens: TokenBalance[] = [];
    let nativeBalance: TokenBalance | null = null;
    let totalUsdValue = 0;

    if (Array.isArray(raw)) {
      for (const item of raw) {
        const balance: TokenBalance = {
          address: item.token_address || item.mint || "",
          amount: String(item.amount || item.balance || "0"),
          decimals: item.decimals || 9,
          symbol: item.symbol || item.token_symbol,
          name: item.name || item.token_name,
          usdValue: item.usd_value || item.value_usd || 0,
          logoUrl: item.logo_url || item.logo,
        };
        totalUsdValue += balance.usdValue || 0;

        // SOL native balance
        if (
          item.symbol === "SOL" ||
          item.token_address === "So11111111111111111111111111111111111111112" ||
          item.native
        ) {
          nativeBalance = balance;
        } else {
          tokens.push(balance);
        }
      }
    } else if (raw && typeof raw === "object") {
      // Handle object response with balances array
      const balancesArray = raw.balances || raw.tokens || raw.data || [];
      if (Array.isArray(balancesArray)) {
        return this.parseBalancesResponse(address, balancesArray);
      }
      // Single balance object
      nativeBalance = {
        address: "native",
        amount: String(raw.lamports || raw.balance || raw.amount || "0"),
        decimals: 9,
        symbol: "SOL",
        name: "Solana",
        usdValue: raw.usd_value || 0,
      };
      totalUsdValue = nativeBalance.usdValue || 0;
    }

    return {
      address,
      totalUsdValue,
      nativeBalance,
      tokens,
      timestamp: Date.now(),
    };
  }

  private parseTransactionsResponse(address: string, raw: any): TransactionHistory {
    const transactions: TransactionRecord[] = [];

    const txArray = Array.isArray(raw) ? raw : raw?.transactions || raw?.data || [];

    for (const item of txArray) {
      transactions.push({
        signature: item.signature || item.tx_hash || item.hash || "",
        blockTime: item.block_time || item.blockTime || item.timestamp || 0,
        slot: item.slot || 0,
        fee: item.fee || 0,
        status: item.err || item.error ? "failed" : "success",
        type: item.type || item.tx_type,
        from: item.from || item.source || item.sender,
        to: item.to || item.destination || item.recipient,
        amount: item.amount || item.value,
        tokenMint: item.token_mint || item.mint || item.token_address,
      });
    }

    return {
      address,
      transactions,
      total: transactions.length,
      timestamp: Date.now(),
    };
  }

  private abbreviate(addr: string): string {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
  }
}

// ═══════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════

export const duneSIM = new DuneSIMClient();

// Auto-initialize if env var is set
if (process.env.DUNE_SIM_API_KEY) {
  duneSIM.initialize(process.env.DUNE_SIM_API_KEY);
}
