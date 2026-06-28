/**
 * API Configuration
 * Backend runs on port 3000 — we proxy through Next.js API routes
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

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

export async function fetchHealth(): Promise<HealthStatus> {
  return apiFetch<HealthStatus>("/health");
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
  rollupMode?: "ER" | "PER" | "NONE";
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
}): Promise<Offer[]> {
  const searchParams = new URLSearchParams();
  if (params?.asset) searchParams.set("asset", params.asset);
  if (params?.minPrice) searchParams.set("minPrice", String(params.minPrice));
  if (params?.maxPrice) searchParams.set("maxPrice", String(params.maxPrice));
  if (params?.mode) searchParams.set("mode", params.mode);
  if (params?.tokenMint) searchParams.set("tokenMint", params.tokenMint);

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
  rollupMode?: "ER" | "PER" | "NONE";
  privateTermsRedacted?: boolean;
  offer: {
    id: string;
    type: "buy" | "sell";
    asset: string;
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
  rollupMode?: "ER" | "PER" | "NONE";
}> {
  const res = await apiFetch<{
    success: boolean;
    ticket: {
      id: string;
      buyer: string;
      seller: string;
      status: string;
      rollupMode?: "ER" | "PER" | "NONE";
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
  rollupMode?: "ER" | "PER" | "NONE";
  privateTermsRedacted?: boolean;
  offer?: {
    asset: string;
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
