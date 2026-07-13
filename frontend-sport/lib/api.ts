/**
 * AIR SPORT API client — talks to api-server :3000
 * Independent from the bound main frontend.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export function getApiBase(): string {
  return API_BASE;
}

async function apiFetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    cache: options?.cache ?? "no-store",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof error.error === "string"
          ? error.error
          : `API Error: ${res.status}`;
    throw new Error(message);
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

// ─── TxLINE ──────────────────────────────────────────

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
  teams?: { home?: string; away?: string };
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

export interface TxlineIngestionStatus {
  running?: boolean;
  mode?: string;
  lastOddsAt?: string | null;
  lastScoresAt?: string | null;
  serviceLevelId?: number;
  network?: string;
  [key: string]: unknown;
}

export async function fetchTxlineFixtures(limit = 50): Promise<TxlineFixture[]> {
  const res = await apiFetch<{ success: boolean; data: TxlineFixture[] }>(
    `/v1/txline/fixtures?limit=${limit}`
  );
  return res.data || [];
}

export async function fetchTxlineReplay(
  fixtureId: string,
  limit = 220,
  opts?: { latest?: boolean }
): Promise<TxlineReplay> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (opts?.latest) query.set("latest", "true");
  const res = await apiFetch<{ success: boolean; data: TxlineReplay }>(
    `/v1/txline/replay/${encodeURIComponent(fixtureId)}?${query.toString()}`
  );
  return res.data;
}

export function txlineReplayStreamUrl(
  fixtureId: string,
  opts?: { limit?: number; latest?: boolean; follow?: boolean; intervalMs?: number }
): string {
  const query = new URLSearchParams({
    limit: String(opts?.limit ?? 220),
    intervalMs: String(opts?.intervalMs ?? 250),
  });
  if (opts?.latest !== false) query.set("latest", "true");
  if (opts?.follow !== false) query.set("follow", "true");
  return `${API_BASE}/v1/txline/replay/${encodeURIComponent(
    fixtureId
  )}/stream?${query.toString()}`;
}

export async function fetchTxlineIngestionStatus(): Promise<TxlineIngestionStatus | null> {
  try {
    const res = await apiFetch<{ success: boolean; data: TxlineIngestionStatus }>(
      "/v1/txline/ingestion/status"
    );
    return res.data;
  } catch {
    return null;
  }
}

// ─── Sport ───────────────────────────────────────────

export interface SportFixtureSummary {
  fixtureId: string;
  sport?: string;
  status?: string;
  startsAt?: string | null;
  teams?: {
    home?: string | null;
    away?: string | null;
    part1?: string | null;
    part2?: string | null;
  };
  marketType?: string | null;
  latestScore?: {
    homeScore?: number | null;
    awayScore?: number | null;
    label?: string | null;
    status?: string | null;
    timestamp?: string | null;
    source?: string | null;
  } | null;
  result?: {
    settled?: boolean;
    winner?: string | null;
    score?: string | null;
  } | null;
  latestOdds?: Array<Record<string, unknown>>;
  oddsRefresh?: Record<string, unknown> | null;
  openLiquidity?: Record<string, unknown> | null;
  feed?: {
    boardMarket?: string | null;
    boardTimestamp?: string | null;
    lastAnyOddsAt?: string | null;
    lastAnyOddsMarket?: string | null;
    boardStale?: boolean;
    checkedAt?: string | null;
  } | null;
  source?: string;
  rawIncluded?: boolean;
}

export type SportPositionSide = "back" | "lay";

export interface SportPosition {
  id: string;
  fixtureId: string;
  selection: string;
  side: SportPositionSide;
  stakeLamports?: string | null;
  stakeSol?: number | null;
  filledLamports?: string | null;
  filledSol?: number | null;
  remainingLamports?: string | null;
  remainingSol?: number | null;
  agentWallet: string;
  status: string;
  vaultPda?: string | null;
  fundingTx?: string | null;
  matchId?: string | null;
  offerId?: string | null;
  ticketId?: string | null;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt?: string | null;
}

export interface SportPositionFill {
  id: string;
  fixtureId: string;
  selection: string;
  backPositionId: string;
  layPositionId: string;
  backWallet: string;
  layWallet: string;
  fillLamports: string;
  fillSol: number;
  ticketId?: string | null;
  escrowPda?: string | null;
  commitTx?: string | null;
  status: string;
  winnerWallet?: string | null;
  releaseTx?: string | null;
  refundTx?: string | null;
  createdAt: string;
  settledAt?: string | null;
}

export interface SportArenaMatch {
  id: string;
  fixtureId: string;
  selection?: string | null;
  makerWallet: string;
  takerWallet?: string | null;
  stakeSol?: number | null;
  status: string;
  outcomeWinner?: string | null;
  winnerWallet?: string | null;
  settlementAction?: string | null;
  settlementStatus?: string | null;
  releaseTx?: string | null;
  refundTx?: string | null;
  settledAt?: string | null;
  createdAt: string;
}

export interface SportMarketActivity {
  positions: SportPosition[];
  fills: SportPositionFill[];
  matches: SportArenaMatch[];
  fixtures?: TxlineFixture[];
}

export async function fetchSportFixtureSummary(
  fixtureId: string
): Promise<SportFixtureSummary> {
  const res = await apiFetch<{ success: boolean; data: SportFixtureSummary }>(
    `/v1/sport/fixtures/${encodeURIComponent(fixtureId)}/summary`
  );
  return res.data;
}

export async function fetchSportPositions(params?: {
  fixtureId?: string;
  status?: string;
  limit?: number;
}): Promise<SportPosition[]> {
  const searchParams = new URLSearchParams();
  if (params?.fixtureId) searchParams.set("fixtureId", params.fixtureId);
  if (params?.status) searchParams.set("status", params.status);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  const query = searchParams.toString();
  const res = await apiFetch<{
    success: boolean;
    data: { count: number; positions: SportPosition[] };
  }>(`/v1/sport/positions${query ? `?${query}` : ""}`);
  return res.data.positions || [];
}

export async function fetchSportMarketActivity(params?: {
  fixtureId?: string;
  limit?: number;
}): Promise<SportMarketActivity> {
  const searchParams = new URLSearchParams();
  if (params?.fixtureId) searchParams.set("fixtureId", params.fixtureId);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  const query = searchParams.toString();
  const res = await apiFetch<{ success: boolean; data: SportMarketActivity }>(
    `/v1/sport/activity${query ? `?${query}` : ""}`
  );
  return {
    positions: res.data.positions || [],
    fills: res.data.fills || [],
    matches: res.data.matches || [],
    fixtures: res.data.fixtures || [],
  };
}

// ─── Agents & reputation ─────────────────────────────

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

export interface AgentProfile {
  wallet: string;
  reputationScore?: number;
  score?: number;
  tier: string;
  trustSummary: string;
  stats?: {
    totalDeals: number;
    successfulDeals: number;
    cancelledDeals: number;
    disputedDeals: number;
    totalVolume: string;
    avgSettlementTime: number;
    avgSettlementTimeFormatted?: string;
  };
  metrics?: {
    successRate: number;
    disputeRate: number;
  };
  totalDeals?: number;
  successfulDeals?: number;
  failedDeals?: number;
  totalVolumeSol?: number;
  avgSettlementTime?: number | null;
  successRate?: string;
  disputeRate?: string;
  createdAt?: string;
}

export interface ReputationPredictionTrade {
  matchId?: string;
  fixtureId?: string;
  ticketId?: string | null;
  offerId?: string | null;
  role?: string;
  counterpartyWallet?: string | null;
  marketType?: string | null;
  selection?: string | null;
  direction?: string | null;
  outcomeWinner?: string | null;
  correct?: boolean;
  status?: string;
  settlementAction?: string | null;
  winnerWallet?: string | null;
  notional?: number;
  settledAt?: string | null;
  createdAt?: string | null;
}

export interface ReputationProfile {
  wallet: string;
  registered?: boolean;
  score: number;
  tier: string;
  riskLevel?: string;
  recommendedCounterpartyAction?: string;
  trustSummary: string;
  scoreBreakdown?: Record<string, number | null>;
  riskFlags?: Array<{ code: string; severity: string; message: string }>;
  dealReputation?: {
    score: number;
    totalDeals: number;
    successfulDeals: number;
    cancelledDeals: number;
    disputedDeals: number;
    totalVolume: string;
    avgSettlementTime: number;
    successRate: number;
    cancellationRate: number;
    disputeRate: number;
  };
  predictionReputation?: {
    totalMatches: number;
    evaluableSettledPredictions: number;
    correctPredictions: number;
    wrongPredictions: number;
    accuracy: number | null;
    accuracyPct: number | null;
    pendingMatches: number;
    cancelledMatches: number;
    failedMatches: number;
    notional: number;
    currentStreak: number | null;
    roles?: { maker: number; taker: number };
    recent?: ReputationPredictionTrade[];
  };
  history?: Array<Record<string, unknown>>;
  generatedAt?: string;
}

export interface RecentDeal {
  id: string;
  offerId: string;
  buyer: string;
  seller: string;
  status: string;
  createdAt: string;
  rollupMode?: string;
  offer?: {
    asset: string;
    price: number;
    amount: number;
    mode: string;
    collateral: number;
    fixtureId?: string | null;
    marketType?: string | null;
    selection?: string | null;
  };
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

export async function fetchAgentProfile(wallet: string): Promise<AgentProfile> {
  return apiFetch<AgentProfile>(`/v1/agents/${encodeURIComponent(wallet)}`);
}

export async function fetchReputationProfile(
  wallet: string,
  opts?: { includeHistory?: boolean; recentLimit?: number }
): Promise<ReputationProfile> {
  const sp = new URLSearchParams();
  sp.set("includeHistory", String(opts?.includeHistory ?? true));
  if (opts?.recentLimit) sp.set("recentLimit", String(opts.recentLimit));
  const res = await apiFetch<{ success: boolean; data: ReputationProfile }>(
    `/v1/reputation/${encodeURIComponent(wallet)}?${sp.toString()}`
  );
  return res.data;
}

export async function fetchRecentDeals(limit = 50): Promise<RecentDeal[]> {
  const res = await apiFetch<{ success: boolean; data: RecentDeal[] }>(
    `/v1/stats/deals?limit=${limit}`
  );
  return res.data || [];
}

// ─── MCP token ───────────────────────────────────────

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
  tokenFormat: "airotc_sk" | "mcp_v1" | string;
}

export interface McpConfig {
  tokenFormat: string;
  mcpUrl: string;
  defaultExpiresInSeconds: number;
  scopePresets?: Record<string, string[]>;
  tokenIssuerReady?: boolean;
}

export async function fetchMcpConfig(): Promise<McpConfig | null> {
  try {
    const res = await apiFetch<{ success: boolean; data: McpConfig }>("/v1/mcp/config");
    return res.data;
  } catch {
    return null;
  }
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
