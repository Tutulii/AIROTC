/**
 * API Configuration
 * Backend runs on port 3000 — we proxy through Next.js API routes
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export type RollupMode = "ER" | "PER" | "NONE" | "SPORT";

/** Generic fetch wrapper with error handling */
async function apiFetch<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || `API Error: ${res.status}`);
  }

  return res.json();
}

// ─── Health ──────────────────────────────────────────
export interface HealthStatus {
  status: string;
  timestamp: string;
}

export async function fetchHealth(options?: RequestInit): Promise<HealthStatus> {
  return apiFetch<HealthStatus>("/health", options);
}

// ─── Agents ──────────────────────────────────────────
export interface AgentProfile {
  wallet: string;
  score: number;
  tier: string;
  trustSummary: string;
  totalDeals: number;
  successfulDeals: number;
  failedDeals: number;
  totalVolumeSol: number;
  avgSettlementTime: number | null;
  successRate: string;
  disputeRate: string;
  createdAt: string;
}

export async function fetchAgentProfile(
  wallet: string
): Promise<AgentProfile> {
  return apiFetch<AgentProfile>(`/v1/agents/${wallet}`);
}

// ─── Offers ──────────────────────────────────────────
export interface Offer {
  id: string;
  asset: string;
  price: number;
  priceRaw?: string | null;
  amount: number;
  amountRaw?: string | null;
  mode: "buy" | "sell";
  rollupMode?: RollupMode;
  fixtureId?: string | null;
  marketType?: string | null;
  selection?: string | null;
  collateral: number;
  collateralRaw?: string | null;
  status: string;
  createdAt: string;
  creator?: { id: string; wallet: string };
  tokenMint?: string;
  tokenDecimals?: number;
}

export interface WalletAuthPayload {
  message: string;
  signature: string;
  publicKey: string;
}

export interface McpTokenMessageResponse {
  message: string;
  scopes: string[];
  expiresInSeconds: number;
  timestamp: number;
}

export interface McpTokenIssueResponse {
  token: string;
  mcpUrl: string;
  wallet: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  tokenFormat: "airotc_sk" | "mcp_v1";
}

export interface OffersResponse {
  success: boolean;
  data: Offer[];
}

function parseDecimal(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return fallback;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function normalizeOffer(offer: Offer): Offer {
  return {
    ...offer,
    price: parseDecimal(offer.price),
    amount: parseDecimal(offer.amount),
    collateral: parseDecimal(offer.collateral),
    tokenDecimals: Number.isInteger(offer.tokenDecimals) ? offer.tokenDecimals : 9,
  };
}

export async function fetchOffers(params?: {
  asset?: string;
  minPrice?: number;
  maxPrice?: number;
  mode?: "buy" | "sell";
  tokenMint?: string;
  fixtureId?: string;
  rollupMode?: RollupMode;
}): Promise<Offer[]> {
  const searchParams = new URLSearchParams();
  if (params?.asset) searchParams.set("asset", params.asset);
  if (params?.minPrice) searchParams.set("minPrice", String(params.minPrice));
  if (params?.maxPrice) searchParams.set("maxPrice", String(params.maxPrice));
  if (params?.mode) searchParams.set("mode", params.mode);
  if (params?.tokenMint) searchParams.set("tokenMint", params.tokenMint);
  if (params?.fixtureId) searchParams.set("fixtureId", params.fixtureId);
  if (params?.rollupMode) searchParams.set("rollupMode", params.rollupMode);

  const query = searchParams.toString();
  const res = await apiFetch<OffersResponse>(
    `/v1/offers${query ? `?${query}` : ""}`
  );
  return res.data.map(normalizeOffer);
}

export async function fetchOfferById(id: string): Promise<Offer> {
  const res = await apiFetch<{ success: boolean; data: Offer }>(
    `/v1/offers/${id}`
  );
  return normalizeOffer(res.data);
}

export async function requestMcpTokenMessage(params: {
  publicKey: string;
  scopes: string[];
  expiresInSeconds: number;
}): Promise<McpTokenMessageResponse> {
  const res = await apiFetch<{ success: boolean; data: McpTokenMessageResponse }>(
    "/v1/mcp/message",
    {
      method: "POST",
      body: JSON.stringify(params),
    }
  );
  return res.data;
}

export async function issueMcpToken(params: {
  publicKey: string;
  message: string;
  signature: string;
  scopes: string[];
  expiresInSeconds: number;
}): Promise<McpTokenIssueResponse> {
  const res = await apiFetch<{ success: boolean; data: McpTokenIssueResponse }>(
    "/v1/mcp/token",
    {
      method: "POST",
      body: JSON.stringify(params),
    }
  );
  return res.data;
}

export interface TicketView {
  id: string;
  buyer: string;
  seller: string;
  status: string;
  rollupMode?: RollupMode;
  privateTermsRedacted?: boolean;
  offer: {
    id: string;
    type: "buy" | "sell";
    asset: string;
    fixtureId?: string | null;
    marketType?: string | null;
    selection?: string | null;
    price: number | null;
    collateral: number | null;
    privateTermsRedacted?: boolean;
  };
  messages: Array<{
    id: string;
    sender: string;
    content: string;
    createdAt: string;
  }>;
}

export async function acceptOffer(
  offerId: string,
  auth: WalletAuthPayload
): Promise<{
  id: string;
  buyer: string;
  seller: string;
  status: string;
  rollupMode?: RollupMode;
}> {
  const res = await apiFetch<{
    success: boolean;
    ticket: {
      id: string;
      buyer: string;
      seller: string;
      status: string;
      rollupMode?: RollupMode;
    };
  }>(`/v1/offers/${offerId}/accept`, {
    method: "POST",
    body: JSON.stringify(auth),
  });
  return res.ticket;
}

// ─── Deals ───────────────────────────────────────────
export interface DealState {
  dealId: string;
  buyer: string;
  seller: string;
  middleman: string;
  amountLamports: string;
  status: string;
  buyerFunded: boolean;
  sellerFunded: boolean;
  explorerUrl: string;
}

export interface TransactionEvent {
  signature: string;
  blockTime: number;
  event: string;
  status: string;
  explorerUrl: string;
}

export async function fetchDeal(id: string): Promise<DealState> {
  return apiFetch<DealState>(`/v1/deals/${id}`);
}

export async function fetchDealTransactions(
  id: string
): Promise<TransactionEvent[]> {
  const res = await apiFetch<{
    success: boolean;
    dealId: string;
    transactions: TransactionEvent[];
  }>(`/v1/deals/${id}/transactions`);
  return res.transactions;
}

// ─── Stats ───────────────────────────────────────────
export interface PlatformStats {
  activeDeals: number;
  volume24h: string;
  settlementRate: string;
  registeredAgents: number;
}

export async function fetchStats(): Promise<PlatformStats> {
  const res = await apiFetch<{ success: boolean; data: PlatformStats }>("/v1/stats");
  return res.data;
}

// ─── Agent List ──────────────────────────────────────
export interface AgentListItem {
  id: string;
  wallet: string;
  createdAt: string;
  totalDeals: number;
  successfulDeals: number;
  cancelledDeals: number;
  disputedDeals: number;
  totalVolume: string;
  avgSettlementTime: number;
  reputationScore: number;
}

export async function fetchAgentsList(params?: {
  page?: number;
  limit?: number;
  sort?: string;
}): Promise<{ data: AgentListItem[]; pagination: { total: number; totalPages: number } }> {
  const sp = new URLSearchParams();
  if (params?.page) sp.set("page", String(params.page));
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.sort) sp.set("sort", params.sort);
  const query = sp.toString();
  return apiFetch(`/v1/stats/agents${query ? `?${query}` : ""}`);
}

// ─── Recent Deals ────────────────────────────────────
export interface RecentDeal {
  id: string;
  offerId: string;
  buyer: string;
  seller: string;
  status: string;
  createdAt: string;
  rollupMode?: RollupMode;
  privateTermsRedacted?: boolean;
  offer?: {
    asset: string;
    fixtureId?: string | null;
    marketType?: string | null;
    selection?: string | null;
    price: number | null;
    amount: number;
    mode: string;
    collateral?: number | null;
    tokenMint?: string;
    tokenDecimals?: number;
    privateTermsRedacted?: boolean;
  };
  tokenMint?: string;
  tokenDecimals?: number;
}

export async function fetchRecentDeals(limit?: number): Promise<RecentDeal[]> {
  const res = await apiFetch<{ success: boolean; data: RecentDeal[] }>(
    `/v1/stats/deals${limit ? `?limit=${limit}` : ""}`
  );
  return res.data;
}

// ─── Telemetry Metrics ───────────────────────────────
export interface TelemetryMetrics {
  timestamp: number;
  activeDeals: number;
  staleDeals: number;
  totalDeals: number;
  completedDeals: number;
  cancelledDeals: number;
  settlementRate: number;
  registeredAgents: number;
  offersActive: number;
  offersTotal: number;
  messagesTotal: number;
  uptime: number;
  memoryMB: number;
  alerts: Array<{ severity: string; message: string; timestamp: number }>;
}

export async function fetchMetrics(): Promise<TelemetryMetrics> {
  const res = await apiFetch<{ success: boolean; data: TelemetryMetrics }>("/v1/metrics");
  return res.data;
}

// ─── RPC Health ──────────────────────────────────────
export interface RpcHealth {
  overall: {
    totalCalls: number;
    totalErrors: number;
    errorRate: number;
    avgLatencyMs: number;
  };
  methods: Record<string, {
    calls: number;
    errors: number;
    errorRate: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
  }>;
}

export async function fetchRpcHealth(): Promise<RpcHealth> {
  return apiFetch<RpcHealth>("/v1/health/rpc");
}

// ─── Log Stream URL ──────────────────────────────────
export function getLogStreamUrl(level?: string): string {
  const base = `${API_BASE}/v1/metrics/logs/stream`;
  return level ? `${base}?level=${level}` : base;
}

// ─── Prices (Pyth + CoinGecko) ──────────────────────

export interface PriceEntry {
  price: number;
  change24h: number;
  source: string;
  updatedAt: number;
}

export async function fetchPrices(): Promise<Record<string, PriceEntry>> {
  const res = await apiFetch<{ success: boolean; data: Record<string, PriceEntry> }>("/v1/prices");
  return res.data;
}

export async function fetchPrice(symbol: string): Promise<PriceEntry> {
  const res = await apiFetch<{ success: boolean; data: PriceEntry }>(`/v1/prices/${symbol}`);
  return res.data;
}

// ─── TxLINE Arena ───────────────────────────────────
export interface TxlineConfig {
  day: number;
  txlineBaseUrl: string;
  txlineNetwork: string;
  txlineConfigured: boolean;
  txlineGuestJwtMode?: boolean;
  requiredSnapshots: string[];
  streamEndpoints: string[];
  replayEndpoints: string[];
  strategyEndpoints: string[];
  outcomeEndpoints: string[];
  backtestEndpoints: string[];
  demoReplayEndpoints: string[];
  proofModes: string[];
  publicEndpoints: Record<string, string>;
  adminEndpoints: Record<string, string>;
}

export interface TxlineFixture {
  id?: string;
  fixtureId: string;
  sport?: string | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
  startsAt?: string | null;
  status?: string | null;
  raw?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface TxlineReplayEvent {
  id: string;
  sequence: number;
  fixtureId: string;
  type: "odds" | "score" | string;
  teams?: {
    home?: string;
    away?: string;
  };
  marketType?: string;
  selection?: string;
  oddsValue?: number;
  scoreState?: Record<string, unknown>;
  txlineTimestamp: string;
  sourceEndpoint: string;
  sourceUpdateId?: string;
  raw?: Record<string, unknown>;
}

export interface TxlineReplay {
  fixtureId: string;
  deterministic: boolean;
  rebuilt: boolean;
  count: number;
  order: string[];
  events: TxlineReplayEvent[];
}

export interface TxlineSnapshotProof {
  day: number;
  fixtureId: string;
  fixture?: TxlineFixture | null;
  latestOdds: Record<string, unknown>[];
  latestScores: Record<string, unknown>[];
  replayEvents: TxlineReplayEvent[];
  acceptance: {
    hasFixture: boolean;
    oddsSnapshots: number;
    scoreSnapshots: number;
    replayEvents: number;
  };
}

export interface TxlineStrategyConfig {
  day: number;
  strategy: string;
  signalType: string;
  description: string;
  thresholds: {
    minOddsChangePct: number;
    minImpliedProbabilityDelta: number;
    maxStakeSol: number;
  };
  endpoints: string[];
  outputMode: "signal_only" | string;
}

export interface TxlineStrategySignal {
  id: string;
  fixtureId: string;
  strategy: string;
  signalType: string;
  marketType?: string;
  selection?: string;
  direction: string;
  confidence?: number;
  oddsBefore?: number;
  oddsAfter?: number;
  oddsChangePct?: number;
  impliedBefore?: number;
  impliedAfter?: number;
  impliedDelta?: number;
  scoreContext?: Record<string, unknown>;
  tradeIntent?: Record<string, unknown>;
  reason?: string;
  sourceEventIds?: string[];
  signalTimestamp: string;
  dedupeKey?: string;
  createdAt?: string;
}

export interface TxlineStrategySignalsResponse {
  fixtureId: string;
  strategy: string;
  count: number;
  signals: TxlineStrategySignal[];
}

export interface TxlineBacktestEvaluation {
  signalId: string;
  fixtureId: string;
  marketType?: string;
  selection?: string;
  direction: string;
  oddsAfter?: number;
  signalTimestamp: string;
  outcome?: {
    winner: string;
    homeScore: number;
    awayScore: number;
    settledAt: string;
  };
  correct: boolean | null;
  oneUnitPnl: number | null;
  skippedReason?: string;
}

export interface TxlineBacktest {
  day: number;
  fixtureId: string | null;
  fixtureIds?: string[];
  generatedAt: string;
  totalSignals: number;
  storedOutcomes: number;
  evaluableSignals: number;
  correctSignals: number;
  accuracy: number | null;
  oneUnitPnl: number | null;
  minSampleSize: number;
  sampleSizeWarning: string | null;
  verdict: string;
  skippedCounts: Record<string, number>;
  evaluations: TxlineBacktestEvaluation[];
}

export interface TxlineDemoReplayProof {
  mode: string;
  source: string;
  generatedAt: string;
  fixtureIds: string[];
  seeded: {
    fixtures: number;
    oddsUpdates: number;
    scoreUpdates: number;
    signals: number;
    outcomes: number;
    ready: boolean;
  };
  backtest: TxlineBacktest;
  judgeNote: string;
}

export interface TxlineIngestionStatus {
  running?: boolean;
  startedAt?: string | null;
  odds?: Record<string, unknown>;
  scores?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function fetchTxlineConfig(): Promise<TxlineConfig> {
  const res = await apiFetch<{ success: boolean; data: TxlineConfig }>("/v1/txline/config");
  return res.data;
}

export async function fetchTxlineFixtures(limit = 50): Promise<TxlineFixture[]> {
  const res = await apiFetch<{ success: boolean; data: TxlineFixture[] }>(
    `/v1/txline/fixtures?limit=${limit}`
  );
  return res.data;
}

export async function fetchTxlineIngestionStatus(): Promise<TxlineIngestionStatus> {
  const res = await apiFetch<{ success: boolean; data: TxlineIngestionStatus }>(
    "/v1/txline/ingestion/status"
  );
  return res.data;
}

export async function fetchTxlineReplay(
  fixtureId: string,
  limit = 500
): Promise<TxlineReplay> {
  const res = await apiFetch<{ success: boolean; data: TxlineReplay }>(
    `/v1/txline/replay/${encodeURIComponent(fixtureId)}?limit=${limit}`
  );
  return res.data;
}

export function getTxlineReplayStreamUrl(fixtureId: string, intervalMs = 250): string {
  return `${API_BASE}/v1/txline/replay/${encodeURIComponent(
    fixtureId
  )}/stream?intervalMs=${intervalMs}`;
}

export async function fetchTxlineSnapshotProof(
  fixtureId: string
): Promise<TxlineSnapshotProof> {
  const res = await apiFetch<{ success: boolean; data: TxlineSnapshotProof }>(
    `/v1/txline/proof/${encodeURIComponent(fixtureId)}`
  );
  return res.data;
}

export async function fetchTxlineStrategyConfig(): Promise<TxlineStrategyConfig> {
  const res = await apiFetch<{ success: boolean; data: TxlineStrategyConfig }>(
    "/v1/txline/strategy/config"
  );
  return res.data;
}

export async function fetchTxlineStrategySignals(
  fixtureId: string,
  limit = 50
): Promise<TxlineStrategySignalsResponse> {
  const res = await apiFetch<{ success: boolean; data: TxlineStrategySignalsResponse }>(
    `/v1/txline/strategy/signals/${encodeURIComponent(fixtureId)}?limit=${limit}`
  );
  return res.data;
}

export async function fetchTxlineBacktest(params?: {
  fixtureId?: string;
  minSampleSize?: number;
  limit?: number;
}): Promise<TxlineBacktest> {
  const searchParams = new URLSearchParams();
  if (params?.fixtureId) searchParams.set("fixtureId", params.fixtureId);
  if (params?.minSampleSize) searchParams.set("minSampleSize", String(params.minSampleSize));
  if (params?.limit) searchParams.set("limit", String(params.limit));
  const query = searchParams.toString();
  const res = await apiFetch<{ success: boolean; data: TxlineBacktest }>(
    `/v1/txline/backtest${query ? `?${query}` : ""}`
  );
  return res.data;
}

export async function fetchTxlineDemoReplayProof(
  minSampleSize = 12
): Promise<TxlineDemoReplayProof> {
  const res = await apiFetch<{ success: boolean; data: TxlineDemoReplayProof }>(
    `/v1/txline/demo-replay/proof?minSampleSize=${minSampleSize}`
  );
  return res.data;
}
