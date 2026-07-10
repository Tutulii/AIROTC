#!/usr/bin/env node
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import bs58 from "bs58";
import nacl from "tweetnacl";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type Scope =
  | "offers:read"
  | "offers:write"
  | "deals:read"
  | "dm:read"
  | "dm:write"
  | "per:run"
  | "proofs:read"
  | "vault:read"
  | "umbra:read"
  | "sport:admin";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  scope?: Scope;
  inputSchema: Record<string, any>;
  handler: (args: any) => Promise<any>;
};

type ResourceDefinition = {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  handler: () => Promise<any>;
};

type ResourceTemplateDefinition = {
  uriTemplate: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
};

type TokenRule = {
  name: string;
  token: string;
  scopes: Set<Scope>;
  wallets: Set<string> | null;
};

type TokenAuth = {
  scopes: Set<Scope>;
  wallets: Set<string> | null;
  defaultWallet?: string;
  tokenFormat?: "airotc_sk" | "mcp_v1" | "static";
};

type RequestContext = {
  authToken?: string;
};

type McpTokenPayload = {
  v: 1;
  iss: "air-otc-api";
  aud: "air-otc-mcp";
  sub: string;
  scopes: Scope[];
  iat: number;
  exp: number;
  jti: string;
};

const tradeAgentScopes: Scope[] = [
  "offers:read",
  "offers:write",
  "deals:read",
  "dm:read",
  "dm:write",
  "per:run",
  "proofs:read",
  "vault:read",
  "umbra:read",
];

const validScopes = new Set<Scope>([
  ...tradeAgentScopes,
  "sport:admin",
]);

const defaultFullScopes = new Set<Scope>(tradeAgentScopes);
const MCP_SHORT_TOKEN_PREFIX = "airotc_sk_";
const SPORT_ASSUMED_LIVE_WINDOW_MS = 4 * 60 * 60 * 1000;
const AGENT_EVENT_NAMES = [
  "deal.matched",
  "deal.expiring",
  "deal.message",
  "dm.received",
  "deal.phase_changed",
  "deal.escrow_created",
  "deal.deposit_received",
  "deal.delivery_confirmed",
  "deal.completed",
  "deal.cancelled",
  "deal.refunded",
  "position.funded",
  "position.filled",
  "position.expired",
  "position.refunded",
  "match.awaiting_result",
  "match.settled",
  "intent.created",
  "intent.match_available",
  "liquidity.available",
  "reputation.update",
] as const;
const TELEGRAM_NOTIFICATION_EVENT_NAMES = [
  "deal.matched",
  "deal.expiring",
  "deal.message",
  "dm.received",
  "deal.phase_changed",
  "deal.escrow_created",
  "deal.deposit_received",
  "deal.delivery_confirmed",
  "deal.completed",
  "position.funded",
  "position.filled",
  "position.refunded",
  "match.awaiting_result",
  "match.settled",
  "intent.match_available",
  "liquidity.available",
] as const;

function parseScopes(value: string | string[] | undefined, fallback: Set<Scope>): Set<Scope> {
  if (!value) return new Set(fallback);
  const items = Array.isArray(value) ? value : value.split(/[\s,]+/);
  const parsed = items
    .map((scope) => scope.trim())
    .filter((scope): scope is Scope => validScopes.has(scope as Scope));
  return parsed.length > 0 ? new Set(parsed) : new Set(fallback);
}

function parseWallets(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) return null;
  const wallets = value
    .filter((wallet): wallet is string => typeof wallet === "string" && isValidSolanaWallet(wallet))
    .map((wallet) => wallet.trim());
  return wallets.length > 0 ? new Set(wallets) : null;
}

function parseTokenRules(fallbackScopes: Set<Scope>): TokenRule[] {
  const raw = process.env.AIR_OTC_MCP_TOKENS_JSON;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AIR_OTC_MCP_TOKENS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("AIR_OTC_MCP_TOKENS_JSON must be an array");
  }
  return parsed
    .map((entry, index) => {
      const item = entry as { name?: unknown; token?: unknown; scopes?: unknown; wallets?: unknown };
      if (typeof item.token !== "string" || item.token.length < 16) {
        throw new Error(`AIR_OTC_MCP_TOKENS_JSON[${index}].token must be a secret string`);
      }
      return {
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : `token-${index + 1}`,
        token: item.token,
        scopes: parseScopes(item.scopes as string[] | string | undefined, fallbackScopes),
        wallets: parseWallets(item.wallets),
      };
    });
}

const defaultScopes = parseScopes(
  process.env.AIR_OTC_MCP_SCOPES ||
    tradeAgentScopes.join(","),
  defaultFullScopes
);

const config = {
  apiUrl: (process.env.AIR_OTC_API_URL || "http://localhost:3000").replace(/\/$/, ""),
  middlemanUrl: (process.env.AIR_OTC_MIDDLEMAN_URL || "http://localhost:8080").replace(/\/$/, ""),
  middlemanHealthUrl: (process.env.AIR_OTC_MIDDLEMAN_HEALTH_URL || "http://localhost:8081").replace(/\/$/, ""),
  wsUrl: process.env.AIR_OTC_WS_URL || "ws://localhost:8080",
  apiWsUrl:
    process.env.AIR_OTC_API_WS_URL ||
    process.env.AIR_OTC_PUBLIC_WS_URL ||
    (process.env.AIR_OTC_API_URL || "http://localhost:3000").replace(/^http/, "ws").replace(/\/$/, ""),
  rpcUrl: process.env.AIR_OTC_RPC_URL || "https://api.devnet.solana.com",
  sdkPath:
    process.env.AIR_OTC_TS_SDK_PATH ||
    path.resolve(__dirname, "../../../sdk/ts/dist/index.mjs"),
  mcpToken: process.env.AIR_OTC_MCP_TOKEN || "",
  mcpTokenSigningSecret:
    process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET ||
    process.env.AIR_OTC_MCP_DELEGATION_TOKEN ||
    process.env.AIR_OTC_MCP_TOKEN ||
    "",
  mcpDelegationToken: process.env.AIR_OTC_MCP_DELEGATION_TOKEN || "",
  scopes: defaultScopes,
  tokenRules: parseTokenRules(defaultScopes),
  walletPrivateKey: process.env.AIR_OTC_WALLET_PRIVATE_KEY || "",
  apiKey: process.env.AIR_OTC_API_KEY || "",
  txlineAdminToken:
    process.env.AIR_OTC_TXLINE_ADMIN_TOKEN ||
    process.env.AIR_OTC_ARENA_ADMIN_TOKEN ||
    process.env.TXLINE_ADMIN_TOKEN ||
    process.env.ARENA_ADMIN_TOKEN ||
    "",
};

let cachedWalletAuth:
  | {
      publicKey: string;
      secretKey: Uint8Array;
    }
  | null
  | undefined;

function walletAuth() {
  if (cachedWalletAuth !== undefined) return cachedWalletAuth;
  if (!config.walletPrivateKey) {
    cachedWalletAuth = null;
    return cachedWalletAuth;
  }
  const secretKey = bs58.decode(config.walletPrivateKey);
  if (secretKey.length !== 64) {
    throw new Error("AIR_OTC_WALLET_PRIVATE_KEY must be a base58-encoded 64-byte Solana secret key");
  }
  const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
  cachedWalletAuth = {
    publicKey: bs58.encode(keypair.publicKey),
    secretKey,
  };
  return cachedWalletAuth;
}

type FundingSession = {
  wallet: string;
  tokenKey: string;
  secretKeyBase58: string;
  sessionId: string;
  createdAtMs: number;
  expiresAtMs: number;
};

const fundingSessions = new Map<string, FundingSession>();
const DEFAULT_FUNDING_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_FUNDING_SESSION_TTL_SECONDS = 5 * 60;
const MAX_FUNDING_SESSION_TTL_SECONDS = 24 * 60 * 60;

function parseSecretKeyMaterial(value: unknown): Uint8Array {
  let parsed: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("walletKeypair_required");
    if (trimmed.startsWith("[")) {
      parsed = JSON.parse(trimmed);
    } else {
      return bs58.decode(trimmed);
    }
  }
  if (Array.isArray(parsed)) {
    const bytes = parsed.map((item) => Number(item));
    if (bytes.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
      throw new Error("walletKeypair_invalid_byte_array");
    }
    return Uint8Array.from(bytes);
  }
  throw new Error("walletKeypair_must_be_base58_or_json_array");
}

function keypairPublicKey(secretKey: Uint8Array): string {
  if (secretKey.length !== 64) {
    throw new Error("walletKeypair_must_be_64_bytes");
  }
  return bs58.encode(nacl.sign.keyPair.fromSecretKey(secretKey).publicKey);
}

function normalizedFundingSessionTtlSeconds(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FUNDING_SESSION_TTL_SECONDS;
  return Math.min(Math.max(parsed, MIN_FUNDING_SESSION_TTL_SECONDS), MAX_FUNDING_SESSION_TTL_SECONDS);
}

function fundingSessionTokenKey(authToken?: string): string {
  return tokenFingerprint(normalizeAuthToken(authToken) || "local-mcp-session");
}

function fundingSessionKey(wallet: string, authToken?: string): string {
  return `${wallet}:${fundingSessionTokenKey(authToken)}`;
}

function fundingSessionWalletKey(wallet: string): string {
  return `${wallet}:wallet-session`;
}

function pruneExpiredFundingSessions(nowMs = Date.now()): void {
  for (const [key, session] of fundingSessions.entries()) {
    if (session.expiresAtMs <= nowMs) fundingSessions.delete(key);
  }
}

function registerFundingSession(wallet: string, authToken: string | undefined, walletKeypair: unknown, ttlSecondsInput?: unknown) {
  const secretKey = parseSecretKeyMaterial(walletKeypair);
  const publicKey = keypairPublicKey(secretKey);
  if (publicKey !== wallet) {
    throw new Error(`sport_funding_session_wallet_mismatch:configured=${publicKey}:requested=${wallet}`);
  }
  pruneExpiredFundingSessions();
  const ttlSeconds = normalizedFundingSessionTtlSeconds(ttlSecondsInput);
  const nowMs = Date.now();
  const tokenKey = fundingSessionTokenKey(authToken);
  const sessionId = crypto.randomBytes(12).toString("hex");
  const session: FundingSession = {
    wallet,
    tokenKey,
    secretKeyBase58: bs58.encode(secretKey),
    sessionId,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ttlSeconds * 1000,
  };
  fundingSessions.set(fundingSessionKey(wallet, authToken), session);
  fundingSessions.set(fundingSessionWalletKey(wallet), session);
  return {
    wallet,
    sessionId,
    registered: true,
    storage: "mcp_process_memory_only",
    ttlSeconds,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    note: "Funding key is held only in MCP process memory and is not returned by any tool. Restarting the MCP server clears this session.",
  };
}

function getFundingSessionKeypair(wallet: string, authToken?: string): string | undefined {
  pruneExpiredFundingSessions();
  return (
    fundingSessions.get(fundingSessionKey(wallet, authToken)) ||
    fundingSessions.get(fundingSessionWalletKey(wallet))
  )?.secretKeyBase58;
}

function getFundingSessionStatus(wallet: string, authToken?: string): Record<string, unknown> {
  pruneExpiredFundingSessions();
  const tokenSession = fundingSessions.get(fundingSessionKey(wallet, authToken));
  const walletSession = fundingSessions.get(fundingSessionWalletKey(wallet));
  const session = tokenSession || walletSession;
  if (!session) {
    return {
      wallet,
      active: false,
      storage: "mcp_process_memory_only",
      note: "No in-memory funding session is active for this wallet and MCP token.",
    };
  }
  const ttlRemainingSeconds = Math.max(0, Math.ceil((session.expiresAtMs - Date.now()) / 1000));
  return {
    wallet,
    active: true,
    sessionId: session.sessionId,
    storage: "mcp_process_memory_only",
    binding: tokenSession ? "token_and_wallet" : "wallet",
    createdAt: new Date(session.createdAtMs).toISOString(),
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    ttlRemainingSeconds,
  };
}

function clearFundingSession(wallet: string, authToken?: string): Record<string, unknown> {
  pruneExpiredFundingSessions();
  const key = fundingSessionKey(wallet, authToken);
  const session = fundingSessions.get(key) || fundingSessions.get(fundingSessionWalletKey(wallet));
  const existed = Boolean(session);
  if (session) {
    for (const [candidateKey, candidateSession] of fundingSessions.entries()) {
      if (candidateSession.wallet === wallet && candidateSession.sessionId === session.sessionId) {
        fundingSessions.delete(candidateKey);
      }
    }
  } else {
    fundingSessions.delete(key);
    fundingSessions.delete(fundingSessionWalletKey(wallet));
  }
  return {
    wallet,
    cleared: existed,
  };
}

function isValidSolanaWallet(wallet: string): boolean {
  try {
    return bs58.decode(wallet).length === 32;
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeAuthToken(authToken?: string): string | undefined {
  const trimmed = authToken?.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase().startsWith("bearer ") ? trimmed.slice(7).trim() : trimmed;
}

function tokenFingerprint(authToken: string): string {
  return crypto.createHash("sha256").update(authToken).digest("hex").slice(0, 12);
}

function verifyDynamicMcpToken(authToken?: string): TokenAuth | null {
  const token = normalizeAuthToken(authToken);
  if (!token?.startsWith("mcp_v1.")) return null;
  if (!config.mcpTokenSigningSecret || config.mcpTokenSigningSecret.length < 16) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [, encodedPayload, signature] = parts;
  const expected = crypto
    .createHmac("sha256", config.mcpTokenSigningSecret)
    .update(encodedPayload)
    .digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  let payload: McpTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as McpTokenPayload;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.v !== 1 || payload.iss !== "air-otc-api" || payload.aud !== "air-otc-mcp" || payload.exp <= now) {
    return null;
  }
  if (!isValidSolanaWallet(payload.sub)) return null;
  const scopes = parseScopes(payload.scopes, new Set());
  if (scopes.size === 0) return null;
  return { scopes: new Set(defaultFullScopes), wallets: null, defaultWallet: payload.sub, tokenFormat: "mcp_v1" };
}

async function verifyOpaqueMcpToken(authToken?: string): Promise<TokenAuth | null> {
  const token = normalizeAuthToken(authToken);
  if (!token?.startsWith(MCP_SHORT_TOKEN_PREFIX)) return null;
  if (!config.mcpDelegationToken) {
    throw new Error("mcp_delegation_token_not_configured");
  }
  const response = await fetch(`${config.apiUrl}/v1/mcp/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.mcpDelegationToken}`,
    },
    body: JSON.stringify({ token }),
  });
  const bodyText = await response.text();
  const parsed = bodyText ? JSON.parse(bodyText) : {};
  if (!response.ok || parsed?.success === false) {
    const reason = parsed?.error || response.statusText || "invalid";
    throw new Error(`mcp_auth_failed:${reason}:fingerprint=${tokenFingerprint(token)}`);
  }
  const data = parsed.data || parsed;
  if (typeof data.wallet !== "string" || !isValidSolanaWallet(data.wallet)) {
    throw new Error("mcp_auth_failed:malformed_verification_response");
  }
  return { scopes: new Set(defaultFullScopes), wallets: null, defaultWallet: data.wallet, tokenFormat: "airotc_sk" };
}

async function assertDelegatedWalletAllowed(requestedWallet?: string, authToken?: string): Promise<void> {
  if (!requestedWallet || !isValidSolanaWallet(requestedWallet)) {
    throw new Error("mcp_wallet_invalid");
  }
  const auth = await resolveTokenAuth(authToken);
  if (auth?.tokenFormat === "airotc_sk" || auth?.tokenFormat === "mcp_v1") {
    return;
  }
  if (auth?.wallets?.has(requestedWallet)) {
    return;
  }
  if (auth?.wallets && !auth.wallets.has(requestedWallet)) {
    throw new Error(`mcp_token_wallet_mismatch:${requestedWallet}`);
  }
  if (!config.mcpDelegationToken) {
    throw new Error("mcp_delegation_token_not_configured");
  }
}

async function assertConfiguredWallet(requestedWallet?: string, authToken?: string): Promise<void> {
  if (!requestedWallet) return;
  const auth = await resolveTokenAuth(authToken);
  if (auth?.tokenFormat === "airotc_sk" || auth?.tokenFormat === "mcp_v1") {
    return;
  }
  if (auth?.wallets?.has(requestedWallet)) {
    return;
  }
  if (auth?.wallets && !auth.wallets.has(requestedWallet)) {
    throw new Error(`mcp_token_wallet_mismatch:${requestedWallet}`);
  }
  const configuredWallet = walletAuth();
  if (configuredWallet && requestedWallet && requestedWallet !== configuredWallet.publicKey) {
    throw new Error(`mcp_wallet_mismatch:configured=${configuredWallet.publicKey}:requested=${requestedWallet}`);
  }
}

const authSchema = {
  authToken: {
    type: "string",
    description:
      "MCP bearer token. Prefer Authorization: Bearer or X-AIROTC-MCP-Token headers; this body field remains as a fallback.",
  },
};

function objectSchema(properties: Record<string, any>, required: string[] = []): Record<string, any> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

async function resolveTokenAuth(authToken?: string): Promise<TokenAuth | null> {
  const token = normalizeAuthToken(authToken);
  const dynamicAuth = verifyDynamicMcpToken(token);
  if (dynamicAuth) return dynamicAuth;
  const opaqueAuth = await verifyOpaqueMcpToken(token);
  if (opaqueAuth) return opaqueAuth;
  const hasAnyToken =
    Boolean(config.mcpToken) ||
    config.tokenRules.length > 0 ||
    Boolean(config.mcpDelegationToken) ||
    Boolean(config.mcpTokenSigningSecret);
  if (!hasAnyToken) return { scopes: config.scopes, wallets: null };
  if (!token) return null;
  if (config.mcpToken && token === config.mcpToken) return { scopes: config.scopes, wallets: null, tokenFormat: "static" };
  const rule = config.tokenRules.find((candidate) => candidate.token === token);
  return rule ? { scopes: rule.scopes, wallets: rule.wallets, tokenFormat: "static" } : null;
}

async function requireScope(args: { authToken?: string }, scope: Scope): Promise<TokenAuth> {
  const auth = await resolveTokenAuth(args.authToken);
  if (!auth) {
    throw new Error(`mcp_auth_failed:${scope}`);
  }
  if (!auth.scopes.has(scope)) {
    throw new Error(`mcp_scope_missing:${scope}`);
  }
  return auth;
}

function singleWalletFromAuth(auth: TokenAuth): string | undefined {
  if (auth.defaultWallet) return auth.defaultWallet;
  if (!auth.wallets || auth.wallets.size !== 1) return undefined;
  return Array.from(auth.wallets)[0];
}

async function delegatedWalletFromArgs(
  args: { wallet?: string; authToken?: string },
  auth: TokenAuth
): Promise<string> {
  const requestedWallet = typeof args.wallet === "string" ? args.wallet.trim() : "";
  const wallet = requestedWallet || singleWalletFromAuth(auth);

  if (!wallet) {
    throw new Error("mcp_wallet_required");
  }

  await assertConfiguredWallet(wallet, args.authToken);
  return wallet;
}

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function httpJson(
  pathname: string,
  init: RequestInit = {},
  baseUrl = config.apiUrl,
  options: { delegatedWallet?: string; authToken?: string } = {}
): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (options.delegatedWallet && baseUrl === config.apiUrl) {
    await assertDelegatedWalletAllowed(options.delegatedWallet, options.authToken);
    const normalizedToken = normalizeAuthToken(options.authToken);
    if (normalizedToken?.startsWith("mcp_v1.") || normalizedToken?.startsWith(MCP_SHORT_TOKEN_PREFIX)) {
      headers.set("x-airotc-mcp-user-token", normalizedToken);
    } else {
      headers.set("x-airotc-mcp-delegation-token", config.mcpDelegationToken);
    }
    headers.set("x-airotc-delegated-wallet", options.delegatedWallet);
  } else if (config.apiKey && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${config.apiKey}`);
  } else if (baseUrl === config.apiUrl && !headers.has("authorization")) {
    const auth = walletAuth();
    const method = (init.method || "GET").toString().toUpperCase();
    if (auth && method !== "GET") {
      const message = `AgentOTC WalletAuth ${method} ${pathname.split("?")[0]} ${Date.now()}`;
      const signature = nacl.sign.detached(new TextEncoder().encode(message), auth.secretKey);
      headers.set("x-wallet-auth-message", message);
      headers.set("x-wallet-auth-signature", bs58.encode(signature));
      headers.set("x-wallet-public-key", auth.publicKey);
    }
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers,
  });
  const body = await response.text();
  const parsed = body ? JSON.parse(body) : {};
  if (!response.ok) {
    throw new Error(`air_otc_http_${response.status}:${parsed.error || parsed.message || response.statusText}`);
  }
  return parsed;
}

async function bestEffort(
  label: string,
  fn: () => Promise<any>
): Promise<{ label: string; ok: boolean; data?: any; error?: string }> {
  try {
    return { label, ok: true, data: await fn() };
  } catch (error: any) {
    return { label, ok: false, error: error?.message || String(error) };
  }
}

function appendOptionalEventQuery(query: URLSearchParams, args: any) {
  if (Array.isArray(args.events) && args.events.length > 0) {
    query.set("events", args.events.join(","));
  }
  if (typeof args.since === "string" && args.since.trim()) {
    query.set("since", args.since.trim());
  }
  if (typeof args.cursor === "string" && args.cursor.trim()) {
    query.set("cursor", args.cursor.trim());
  }
  if (args.limit !== undefined) {
    query.set("limit", String(args.limit));
  }
  if (args.includeAcked !== undefined) {
    query.set("includeAcked", String(args.includeAcked));
  }
}

function normalizeSportStatus(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function sportRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sportNested(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => sportRecord(current)[key], value);
}

function sportFirstString(source: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = key.includes(".") ? sportNested(source, key) : source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return fallback;
}

function sportHasClockEvidence(raw: Record<string, unknown>): boolean {
  const clock = raw.Clock || sportNested(raw, "Data.New.Clock") || sportNested(raw, "Data.Clock");
  if (typeof clock === "string") return clock.trim().length > 0;
  if (typeof clock === "number") return Number.isFinite(clock);
  return Object.keys(sportRecord(clock)).length > 0;
}

function sportHasScoreEvidence(raw: Record<string, unknown>): boolean {
  return (
    Object.keys(sportRecord(raw.Score || raw.score)).length > 0 ||
    Object.keys(sportRecord(sportNested(raw, "Data.New.Score"))).length > 0 ||
    Object.keys(sportRecord(sportNested(raw, "Data.Score"))).length > 0
  );
}

function sportHasLiveScoreEvidence(raw: Record<string, unknown>): boolean {
  const state = sportRecord(raw.normalizedScoreState || raw.latestScoreState);
  const stateStatus = normalizeSportStatus(sportFirstString(state, ["status"]));
  if (["live", "in_play", "in_progress", "running", "started", "first_half", "second_half", "2"].includes(stateStatus)) {
    return true;
  }

  const action = normalizeSportStatus(sportFirstString(raw, ["Action"]) || sportFirstString(state, ["action"]));
  if (["disconnected", "fixture_created", "fixture_updated", "game_finalised", "game_finalized", "finalised", "finalized"].includes(action)) {
    return false;
  }
  if (sportHasClockEvidence(raw) || sportHasClockEvidence(state)) return true;
  return (
    (sportHasScoreEvidence(raw) || sportHasScoreEvidence(state)) &&
    ["update", "updated", "score_update", "score_changed", "clock_update", "clock_changed", "game_started", "period_started", "stats_update", "statistics_update"].includes(action)
  );
}

function sportStatusBucket(fixtureOrStatus: unknown, startsAt?: unknown): "live" | "upcoming" | "final" | "unknown" {
  const fixture = sportRecord(fixtureOrStatus);
  const raw = sportRecord(fixture.raw);
  const statusInput = Object.keys(fixture).length > 0
    ? fixture.status || raw.latestScoreState || raw.GameState || raw.status
    : fixtureOrStatus;
  const status = normalizeSportStatus(statusInput);
  const latestScoreState = sportRecord(raw.latestScoreState);
  const scoreStateStatus = normalizeSportStatus(sportFirstString(latestScoreState, ["status"]));
  const action = normalizeSportStatus(sportFirstString(raw, ["Action"]) || sportFirstString(sportRecord(raw.latestScoreState), ["action"]));
  if (
    ["final", "finished", "complete", "completed", "closed", "settled", "full_time", "fulltime", "ft", "3", "4"].includes(status) ||
    ["final", "finished", "complete", "completed", "closed", "settled", "full_time", "fulltime", "ft", "3", "4"].includes(scoreStateStatus) ||
    ["finalised", "finalized", "game_finalised", "game_finalized"].includes(action)
  ) {
    return "final";
  }
  if (["live", "in_play", "in_progress", "running", "started", "first_half", "second_half", "2"].includes(status) || sportHasLiveScoreEvidence(raw)) {
    return "live";
  }
  if (["final", "finished", "complete", "completed", "closed", "settled", "full_time", "fulltime", "ft", "3", "4"].includes(status)) {
    return "final";
  }
  if (startsAt) {
    const startMs = typeof startsAt === "number" ? startsAt : new Date(String(startsAt)).getTime();
    if (Number.isFinite(startMs)) {
      const now = Date.now();
      if (["scheduled", "upcoming", "not_started", "pre_match", "prematch", "pending", "1"].includes(status)) {
        if (startMs <= now && now - startMs <= SPORT_ASSUMED_LIVE_WINDOW_MS) return "live";
        if (startMs <= now - SPORT_ASSUMED_LIVE_WINDOW_MS) return "unknown";
        return "upcoming";
      }
      if (startMs > now - 15 * 60 * 1000) {
        return "upcoming";
      }
    }
  }
  if (["scheduled", "upcoming", "not_started", "pre_match", "prematch", "pending", "1"].includes(status)) {
    return "upcoming";
  }
  return "unknown";
}

function filterSportFixtures(fixtures: any[], status?: string): any[] {
  if (!status || status === "all") return fixtures;
  return fixtures.filter((fixture) => sportStatusBucket(fixture, fixture?.startsAt || fixture?.raw?.StartTime) === status);
}

function sportAsset(args: { fixtureId: string; marketType: string; selection: string; asset?: string }): string {
  const supplied = typeof args.asset === "string" ? args.asset.trim() : "";
  if (supplied) return supplied;
  return ["TXLINE", args.fixtureId, args.marketType, args.selection]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(":")
    .slice(0, 200);
}

function txlineAdminHeaders(args: any): Record<string, string> {
  const token = typeof args.adminToken === "string" && args.adminToken.trim()
    ? args.adminToken.trim()
    : config.txlineAdminToken;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function loadSdk(): Promise<any> {
  return import(pathToFileURL(config.sdkPath).href);
}

async function createSdkClient() {
  if (!config.walletPrivateKey) {
    throw new Error("AIR_OTC_WALLET_PRIVATE_KEY is required for PER workflow tools");
  }
  const sdk = await loadSdk();
  return new sdk.AgentOTC({
    apiKey: config.apiKey || "mcp-local",
    walletPrivateKey: config.walletPrivateKey,
    environment: "localnet",
    apiUrl: config.apiUrl,
    wsUrl: config.wsUrl,
    rpcUrl: config.rpcUrl,
    privateMode: true,
    strictOpaquePerMode: true,
    persistLocalState: true,
  });
}

function toolOutput(data: unknown) {
  return textResult(data);
}

const tools: ToolDefinition[] = [
  {
    name: "airotc_health",
    title: "AIR OTC Health",
    description: "Check API and middleman health without exposing secrets.",
    inputSchema: objectSchema({}),
    handler: async () =>
      toolOutput({
        api: await bestEffort("api", () => httpJson("/health", {}, config.apiUrl)),
        middleman: await bestEffort("middleman", () => httpJson("/health", {}, config.middlemanHealthUrl)),
      }),
  },
  {
    name: "airotc_list_events",
    title: "List Live Events",
    description: "List canonical AIR OTC live event names and delivery channels.",
    inputSchema: objectSchema({}),
    handler: async () =>
      toolOutput(
        await bestEffort("event_catalog", () => httpJson("/v1/events/catalog", {}, config.apiUrl))
      ),
  },
  {
    name: "airotc_get_live_config",
    title: "Get Live Config",
    description: "Return WebSocket and event inbox settings for live agent integrations.",
    inputSchema: objectSchema({}),
    handler: async () =>
      toolOutput({
        websocket: {
          url: config.apiWsUrl,
          path: "/socket.io/",
          auth: {
            preferred: "auth.token",
            alternatives: ["Authorization: Bearer <token>", "wallet signature auth"],
          },
          receives: ["agent.event", ...AGENT_EVENT_NAMES],
          sends: ["subscribe", "ack_event", "ack_events", "get_missed_events"],
        },
        mcpPolling: {
          getEventsTool: "airotc_get_agent_events",
          ackTool: "airotc_ack_agent_event",
          batchAckTool: "airotc_ack_agent_events",
          retentionDays: 7,
          delivery: "at-least-once; dedupe by event id",
        },
        notificationChannels: {
          registerTool: "airotc_register_notification_channel",
          listTool: "airotc_list_notification_channels",
          deleteTool: "airotc_delete_notification_channel",
          testTool: "airotc_test_notification_channel",
          supportedTypes: ["telegram"],
          supportedEvents: TELEGRAM_NOTIFICATION_EVENT_NAMES,
          config: {
            telegram: {
              required: ["chatId"],
              optional: ["threadId", "mention"],
              botToken: "platform-managed",
            },
          },
        },
        eventNames: AGENT_EVENT_NAMES,
      }),
  },
  {
    name: "airotc_get_agent_events",
    title: "Get Agent Events",
    description:
      "Poll persisted live events for a wallet. This is the webhook fallback for agents without a public endpoint. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        events: {
          type: "array",
          items: { type: "string", enum: [...AGENT_EVENT_NAMES] },
        },
        since: { type: "string", description: "Optional ISO timestamp." },
        cursor: { type: "string", description: "Optional cursor returned by the previous call." },
        limit: { type: "number", minimum: 1, maximum: 500, default: 100 },
        includeAcked: { type: "boolean", default: false },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "deals:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const query = new URLSearchParams();
      appendOptionalEventQuery(query, args);
      return toolOutput(
        await httpJson(
          `/v1/events${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_ack_agent_event",
    title: "ACK Agent Event",
    description: "Acknowledge one persisted live event for a wallet. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        eventId: { type: "string" },
      },
      ["wallet", "eventId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "deals:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/events/${encodeURIComponent(args.eventId)}/ack`,
          { method: "POST", body: JSON.stringify({}) },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_ack_agent_events",
    title: "ACK Agent Events",
    description: "Acknowledge a batch of persisted live events for a wallet. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        eventIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 500,
        },
      },
      ["wallet", "eventIds"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "deals:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/events/ack",
          { method: "POST", body: JSON.stringify({ eventIds: args.eventIds }) },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_register_notification_channel",
    title: "Register Notification Channel",
    description:
      "Register a Telegram wake-up notification channel for live AIR OTC events. Replaces existing notification channels for the wallet. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        chatId: {
          type: "string",
          description: "Telegram numeric chat id, supergroup id, or @channel username.",
        },
        threadId: {
          type: "number",
          description: "Optional Telegram forum topic thread id.",
        },
        mention: {
          type: "string",
          description: "Optional @username to include at the top of each Telegram wake-up message.",
        },
        events: {
          type: "array",
          items: { type: "string", enum: [...TELEGRAM_NOTIFICATION_EVENT_NAMES] },
          description: "Optional event allowlist. Omit to receive all Telegram-supported wake-up events.",
        },
        enabled: { type: "boolean", default: true },
      },
      ["wallet", "chatId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "deals:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const configBody: Record<string, unknown> = { chatId: args.chatId };
      if (args.threadId !== undefined) configBody.threadId = args.threadId;
      if (args.mention !== undefined) configBody.mention = args.mention;
      return toolOutput(
        await httpJson(
          "/v1/agents/notifications",
          {
            method: "PUT",
            body: JSON.stringify({
              channels: [
                {
                  type: "telegram",
                  enabled: args.enabled !== false,
                  events: args.events,
                  config: configBody,
                },
              ],
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_list_notification_channels",
    title: "List Notification Channels",
    description: "List Telegram wake-up notification channels for a wallet. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "deals:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/agents/notifications",
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_delete_notification_channel",
    title: "Delete Notification Channel",
    description: "Delete one Telegram wake-up notification channel for a wallet. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        channelId: { type: "string" },
      },
      ["wallet", "channelId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "deals:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/agents/notifications/${encodeURIComponent(args.channelId)}`,
          { method: "DELETE" },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_test_notification_channel",
    title: "Test Notification Channel",
    description: "Send a Telegram wake-up test notification to one or all enabled channels. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        channelId: { type: "string" },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "deals:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/agents/notifications/test",
          { method: "POST", body: JSON.stringify({ channelId: args.channelId }) },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_list_offers",
    title: "List Offers",
    description: "List AIR OTC offers.",
    scope: "offers:read",
    inputSchema: objectSchema({
      ...authSchema,
      asset: { type: "string" },
      mode: { type: "string", enum: ["buy", "sell"] },
      status: { type: "string" },
      rollupMode: { type: "string", enum: ["ER", "PER", "NONE", "SPORT"] },
      fixtureId: { type: "string" },
    }),
    handler: async (args) => {
      await requireScope(args, "offers:read");
      const query = new URLSearchParams();
      if (args.asset) query.set("asset", args.asset);
      if (args.mode) query.set("mode", args.mode);
      if (args.status) query.set("status", args.status);
      if (args.rollupMode) query.set("rollupMode", args.rollupMode);
      if (args.fixtureId) query.set("fixtureId", args.fixtureId);
      return toolOutput(await httpJson(`/v1/offers${query.size ? `?${query}` : ""}`));
    },
  },
  {
    name: "airotc_get_reputation",
    title: "Get Reputation",
    description:
      "Get a wallet's AIR OTC reputation, including deal reliability, SPORT prediction accuracy, confidence-adjusted score, and risk flags. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        includeHistory: { type: "boolean", default: true },
        recentLimit: { type: "number", minimum: 1, maximum: 50, default: 10 },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      await requireScope(args, "offers:read");
      const query = new URLSearchParams();
      if (args.includeHistory !== undefined) query.set("includeHistory", String(args.includeHistory));
      if (args.recentLimit !== undefined) query.set("recentLimit", String(args.recentLimit));
      return toolOutput(
        await httpJson(
          `/v1/reputation/${encodeURIComponent(args.wallet)}${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl
        )
      );
    },
  },
  {
    name: "airotc_compare_reputations",
    title: "Compare Reputations",
    description:
      "Compare multiple AIR OTC wallets before accepting offers. Returns V2 SPORT reputation profiles and rejects invalid wallets cleanly. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallets: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25 },
        includeHistory: { type: "boolean", default: false },
        recentLimit: { type: "number", minimum: 1, maximum: 50, default: 5 },
      },
      ["wallets"]
    ),
    handler: async (args) => {
      await requireScope(args, "offers:read");
      return toolOutput(
        await httpJson(
          "/v1/reputation/batch",
          {
            method: "POST",
            body: JSON.stringify({
              wallets: args.wallets,
              includeHistory: args.includeHistory,
              recentLimit: args.recentLimit,
            }),
          },
          config.apiUrl
        )
      );
    },
  },
  {
    name: "airotc_get_reputation_leaderboard",
    title: "Get Reputation Leaderboard",
    description:
      "List top AIR OTC counterparties ranked by deal reliability and confidence-adjusted SPORT prediction reputation. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema({
      ...authSchema,
      limit: { type: "number", minimum: 1, maximum: 25, default: 10 },
      minSettledPredictions: { type: "number", minimum: 0, maximum: 100, default: 0 },
      recentLimit: { type: "number", minimum: 1, maximum: 50, default: 5 },
    }),
    handler: async (args) => {
      await requireScope(args, "offers:read");
      const query = new URLSearchParams();
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      if (args.minSettledPredictions !== undefined) query.set("minSettledPredictions", String(args.minSettledPredictions));
      if (args.recentLimit !== undefined) query.set("recentLimit", String(args.recentLimit));
      return toolOutput(
        await httpJson(
          `/v1/reputation/leaderboard${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl
        )
      );
    },
  },
  {
    name: "airotc_sport_list_matches",
    title: "Sport List Matches",
    description:
      "List TxLINE live/upcoming/final fixtures available for SPORT mode agents. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema({
      ...authSchema,
      limit: { type: "number", minimum: 1, maximum: 100, default: 50 },
      status: { type: "string", enum: ["all", "live", "upcoming", "final"], default: "all" },
    }),
    handler: async (args) => {
      await requireScope(args, "offers:read");
      const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 50), 1), 100);
      const response = await httpJson(`/v1/txline/fixtures?limit=${limit}`, {}, config.apiUrl);
      const fixtures = Array.isArray(response?.data) ? response.data : [];
      const filtered = filterSportFixtures(fixtures, args.status);
      return toolOutput({
        success: true,
        source: "txline",
        filter: args.status || "all",
        count: filtered.length,
        data: filtered,
      });
    },
  },
  {
    name: "airotc_sport_get_fixture",
    title: "Sport Get Fixture",
    description:
      "Fetch exact TxLINE fixture data with replay, proof, and final outcome if available. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        fixtureId: { type: "string" },
        replayLimit: { type: "number", minimum: 1, maximum: 500, default: 100 },
      },
      ["fixtureId"]
    ),
    handler: async (args) => {
      await requireScope(args, "offers:read");
      const fixtureId = encodeURIComponent(args.fixtureId);
      const replayLimit = Math.min(Math.max(Math.floor(Number(args.replayLimit) || 100), 1), 500);
      return toolOutput({
        fixtureId: args.fixtureId,
        collectedAt: new Date().toISOString(),
        proof: await bestEffort("txline_fixture_proof", () =>
          httpJson(`/v1/txline/proof/${fixtureId}`, {}, config.apiUrl)
        ),
        replay: await bestEffort("txline_replay", () =>
          httpJson(`/v1/txline/replay/${fixtureId}?limit=${replayLimit}`, {}, config.apiUrl)
        ),
        outcome: await bestEffort("txline_outcome", () =>
          httpJson(`/v1/txline/outcomes/${fixtureId}`, {}, config.apiUrl)
        ),
      });
    },
  },
  {
    name: "airotc_sport_get_fixture_summary",
    title: "Sport Get Fixture Summary",
    description:
      "Fetch a compact SPORT fixture summary for agents: teams, status, latest score, latest odds, and open liquidity. Does not include raw TxLINE replay data. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        fixtureId: { type: "string" },
      },
      ["fixtureId"]
    ),
    handler: async (args) => {
      await requireScope(args, "offers:read");
      return toolOutput(
        await httpJson(
          `/v1/sport/fixtures/${encodeURIComponent(args.fixtureId)}/summary`,
          {},
          config.apiUrl,
          { authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_get_result",
    title: "Sport Get Result",
    description:
      "Fetch a compact TxLINE result for a SPORT fixture: winner, score, settled flag, and source. Returns pending instead of dumping raw replay when no final result exists. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        fixtureId: { type: "string" },
      },
      ["fixtureId"]
    ),
    handler: async (args) => {
      await requireScope(args, "offers:read");
      return toolOutput(
        await httpJson(
          `/v1/sport/results/${encodeURIComponent(args.fixtureId)}`,
          {},
          config.apiUrl,
          { authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_create_offer",
    title: "Sport Create Offer",
    description:
      "Compatibility wrapper for prefunded SPORT positions. Creates a funding-required SPORT position draft and returns vault funding instructions. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        fixtureId: { type: "string" },
        marketType: { type: "string" },
        selection: { type: "string" },
        asset: { type: "string" },
        mode: { type: "string", enum: ["buy", "sell"] },
        amount: { type: "number", exclusiveMinimum: 0 },
        price: { type: "number", exclusiveMinimum: 0 },
        collateral: { type: "number", minimum: 0, description: "Deprecated for SPORT; accepted for old clients but ignored." },
        settlementWallet: { type: "string" },
        rewardWallet: { type: "string" },
        fundingWallet: { type: "string" },
      },
      ["wallet", "fixtureId", "marketType", "selection", "mode", "amount", "price"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/sport/positions",
          {
            method: "POST",
            body: JSON.stringify({
              fixtureId: args.fixtureId,
              selection: args.selection,
              side: args.mode === "sell" ? "lay" : "back",
              stakeSol: args.price,
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_accept_offer",
    title: "Sport Accept Offer",
    description:
      "Accept a SPORT offer, create the AIR OTC ticket, and attach it to the SPORT settlement tracker. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        offerId: { type: "string" },
        wallet: { type: "string" },
        settlementWallet: { type: "string" },
        rewardWallet: { type: "string" },
        fundingWallet: { type: "string" },
      },
      ["offerId", "wallet"]
    ),
    handler: async (args) => {
      await requireScope(args, "offers:write");
      return toolOutput({
        success: false,
        error: "sport_unfunded_offer_accept_deprecated",
        message:
          "SPORT no longer accepts unfunded offers. Use airotc_sport_accept_position, fund the returned vault, then call airotc_sport_confirm_position_funding.",
        offerId: args.offerId,
      });
    },
  },
  {
    name: "airotc_sport_create_position",
    title: "Sport Create Position",
    description:
      "Create a prefunded SPORT position draft. The position is not public or matchable until the returned vault is funded and confirmed. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        fixtureId: { type: "string" },
        selection: { type: "string", enum: ["part1", "draw", "part2"] },
        side: { type: "string", enum: ["back", "lay"], default: "back" },
        stakeSol: { type: "number", exclusiveMinimum: 0 },
        clientOrderId: { type: "string" },
      },
      ["wallet", "fixtureId", "selection", "stakeSol"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/sport/positions",
          {
            method: "POST",
            body: JSON.stringify({
              fixtureId: args.fixtureId,
              selection: args.selection,
              side: args.side || "back",
              stakeSol: args.stakeSol,
              clientOrderId: args.clientOrderId,
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_create_and_fund_position",
    title: "Sport Create And Fund Position",
    description:
      "One-click SPORT automation: create a position, execute on-chain vault funding, and confirm it. Uses walletKeypair if supplied, otherwise the API-backed encrypted funding session. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        fixtureId: { type: "string" },
        selection: { type: "string", enum: ["part1", "draw", "part2"] },
        side: { type: "string", enum: ["back", "lay"], default: "back" },
        stakeSol: { type: "number", exclusiveMinimum: 0 },
        clientOrderId: { type: "string" },
        walletKeypair: {
          type: "string",
          description:
            "Optional base58-encoded 64-byte Solana secret key or JSON array string. If omitted, the API uses the registered encrypted funding session for this wallet.",
        },
      },
      ["wallet", "fixtureId", "selection", "stakeSol"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const explicitKeypair = typeof args.walletKeypair === "string" && args.walletKeypair.trim()
        ? args.walletKeypair.trim()
        : "";
      return toolOutput(
        await httpJson(
          "/v1/sport/positions/create-and-fund",
          {
            method: "POST",
            body: JSON.stringify({
              fixtureId: args.fixtureId,
              selection: args.selection,
              side: args.side || "back",
              stakeSol: args.stakeSol,
              clientOrderId: args.clientOrderId,
              ...(explicitKeypair ? { walletKeypair: explicitKeypair } : {}),
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_post_position",
    title: "Sport Post Position",
    description:
      "Compatibility alias for airotc_sport_create_position. Creates a funding-required SPORT position draft. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        fixtureId: { type: "string" },
        selection: { type: "string", enum: ["part1", "draw", "part2"] },
        side: { type: "string", enum: ["back", "lay"], default: "back" },
        stakeSol: { type: "number", exclusiveMinimum: 0 },
        clientOrderId: { type: "string" },
      },
      ["wallet", "fixtureId", "selection", "stakeSol"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/sport/positions",
          {
            method: "POST",
            body: JSON.stringify({
              fixtureId: args.fixtureId,
              selection: args.selection,
              side: args.side || "back",
              stakeSol: args.stakeSol,
              clientOrderId: args.clientOrderId,
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_accept_position",
    title: "Sport Accept Position",
    description:
      "Directly accept funded SPORT liquidity by creating the opposite funding-required draft. Optional stakeSol can partially fill or exceed maker remaining liquidity. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        positionId: { type: "string" },
        stakeSol: { type: "number", exclusiveMinimum: 0 },
        clientOrderId: { type: "string" },
      },
      ["wallet", "positionId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/sport/positions/${encodeURIComponent(args.positionId)}/accept`,
          {
            method: "POST",
            body: JSON.stringify({
              stakeSol: args.stakeSol,
              clientOrderId: args.clientOrderId,
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_counter_position",
    title: "Sport Counter Position",
    description:
      "Prebuilt SPORT counter-offer helper. Creates the opposite funding-required draft with an optional adjusted stakeSol, then the agent funds it through airotc_sport_execute_funding. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        positionId: { type: "string" },
        stakeSol: { type: "number", exclusiveMinimum: 0 },
        clientOrderId: { type: "string" },
      },
      ["wallet", "positionId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/sport/positions/${encodeURIComponent(args.positionId)}/accept`,
          {
            method: "POST",
            body: JSON.stringify({
              stakeSol: args.stakeSol,
              clientOrderId: args.clientOrderId,
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_counter_offer",
    title: "Sport Counter Offer",
    description:
      "Create an opposite SPORT counter-position and DM the maker in one flow. The returned position still must be funded before matching. Requires offers:write scope and dm:write scope unless sendDm=false.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        positionId: { type: "string" },
        stakeSol: { type: "number", exclusiveMinimum: 0 },
        clientOrderId: { type: "string" },
        message: { type: "string" },
        sendDm: { type: "boolean", default: true },
      },
      ["wallet", "positionId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      if (args.sendDm !== false) {
        await requireScope(args, "dm:write");
      }
      const wallet = await delegatedWalletFromArgs(args, auth);
      const original = await httpJson(
        `/v1/sport/positions/by-id/${encodeURIComponent(args.positionId)}`,
        {},
        config.apiUrl,
        { delegatedWallet: wallet, authToken: args.authToken }
      );
      const makerPosition = original?.data?.position || original?.position || {};
      const makerWallet = typeof makerPosition.agentWallet === "string" ? makerPosition.agentWallet : "";
      const counter = await httpJson(
        `/v1/sport/positions/${encodeURIComponent(args.positionId)}/accept`,
        {
          method: "POST",
          body: JSON.stringify({
            stakeSol: args.stakeSol,
            clientOrderId: args.clientOrderId,
          }),
        },
        config.apiUrl,
        { delegatedWallet: wallet, authToken: args.authToken }
      );
      const counterPosition = counter?.data?.position || counter?.position || {};
      let dm: Record<string, unknown> = { attempted: false };
      if (args.sendDm !== false && makerWallet && makerWallet !== wallet) {
        const stakeLabel = counterPosition.stakeSol ?? counterPosition.remainingSol ?? args.stakeSol ?? makerPosition.remainingSol ?? makerPosition.stakeSol ?? "matching";
        const content = typeof args.message === "string" && args.message.trim()
          ? args.message.trim()
          : `SPORT counter offer opened for position ${args.positionId}. Counter position ${counterPosition.id || "created"} uses ${stakeLabel} SOL. Fund the returned vault to make it live and matchable.`;
        dm = await bestEffort("counter_offer_dm", () =>
          httpJson(
            "/v1/dm/send",
            {
              method: "POST",
              body: JSON.stringify({
                toWallet: makerWallet,
                content,
                contentType: "text",
                metadata: {
                  type: "sport_counter_offer",
                  makerPositionId: args.positionId,
                  counterPositionId: counterPosition.id || null,
                  fixtureId: counterPosition.fixtureId || makerPosition.fixtureId || null,
                  selection: counterPosition.selection || makerPosition.selection || null,
                  stakeSol: stakeLabel,
                },
              }),
            },
            config.apiUrl,
            { delegatedWallet: wallet, authToken: args.authToken }
          )
        );
      }
      return toolOutput({
        counter,
        dm,
        note: "Counter-offer creates a funding-required draft. Run airotc_sport_execute_funding or use a registered funding session to lock the stake.",
      });
    },
  },
  {
    name: "airotc_sport_confirm_position_funding",
    title: "Sport Confirm Position Funding",
    description:
      "Confirm that a SPORT position vault has been funded. This is the only path that makes a position public and matchable. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        positionId: { type: "string" },
        fundingTx: { type: "string" },
      },
      ["wallet", "positionId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/sport/positions/${encodeURIComponent(args.positionId)}/confirm-funding`,
          {
            method: "POST",
            body: JSON.stringify({
              fundingTx: args.fundingTx,
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_register_funding_session",
    title: "Sport Register Funding Session",
    description:
      "Register a wallet for SPORT funding. Stores the keypair encrypted in AIR OTC API storage with TTL, so execute_funding can run without sending walletKeypair every call. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        walletKeypair: {
          type: "string",
          description: "Base58-encoded 64-byte Solana secret key or JSON array string. Stored encrypted in AIR OTC API storage until TTL/replacement/delete.",
        },
        ttlSeconds: {
          type: "integer",
          minimum: MIN_FUNDING_SESSION_TTL_SECONDS,
          maximum: MAX_FUNDING_SESSION_TTL_SECONDS,
          default: DEFAULT_FUNDING_SESSION_TTL_SECONDS,
        },
      },
      ["wallet", "walletKeypair"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      registerFundingSession(wallet, args.authToken, args.walletKeypair, args.ttlSeconds);
      return toolOutput(
        await httpJson(
          "/v1/sport/funding-session",
          {
            method: "POST",
            body: JSON.stringify({
              walletKeypair: args.walletKeypair,
              ttlSeconds: args.ttlSeconds,
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_funding_session_status",
    title: "Sport Funding Session Status",
    description:
      "Check whether this wallet currently has an active API-backed encrypted SPORT funding session. Does not return secret key material. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/sport/funding-session",
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_clear_funding_session",
    title: "Sport Clear Funding Session",
    description:
      "Clear the encrypted SPORT funding key for this wallet. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      clearFundingSession(wallet, args.authToken);
      return toolOutput(
        await httpJson(
          "/v1/sport/funding-session",
          { method: "DELETE" },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_execute_funding",
    title: "Sport Execute Funding",
    description:
      "Initialize and fund a SPORT position vault on-chain, then confirm funding through AIR OTC. Devnet agent automation path; uses walletKeypair if supplied, otherwise the API-backed registered funding session. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        positionId: { type: "string" },
        walletKeypair: {
          type: "string",
          description:
            "Optional base58-encoded 64-byte Solana secret key or JSON array string. If omitted, the API uses the registered encrypted funding session for this wallet.",
        },
      },
      ["wallet", "positionId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const explicitKeypair = typeof args.walletKeypair === "string" && args.walletKeypair.trim()
        ? args.walletKeypair.trim()
        : "";
      return toolOutput(
        await httpJson(
          `/v1/sport/positions/${encodeURIComponent(args.positionId)}/execute-funding`,
          {
            method: "POST",
            body: JSON.stringify({
              ...(explicitKeypair ? { walletKeypair: explicitKeypair } : {}),
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_cancel_position",
    title: "Sport Cancel Position",
    description:
      "Cancel an unmatched SPORT position. Funded positions require a vault refund path; matched positions cannot be cancelled. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        positionId: { type: "string" },
        cancelTx: { type: "string" },
      },
      ["wallet", "positionId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/sport/positions/${encodeURIComponent(args.positionId)}/cancel`,
          {
            method: "POST",
            body: JSON.stringify({
              cancelTx: args.cancelTx,
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_get_position",
    title: "Sport Get Position",
    description:
      "Get one SPORT position by id for wallet recovery, including funding status and vault instructions when relevant. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        positionId: { type: "string" },
      },
      ["wallet", "positionId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/sport/positions/by-id/${encodeURIComponent(args.positionId)}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_get_position_fills",
    title: "Sport Get Position Fills",
    description:
      "List fills for one SPORT position, including ticket ids, escrow PDAs, fill sizes, and settlement state. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        positionId: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 200, default: 100 },
      },
      ["wallet", "positionId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const query = new URLSearchParams();
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      return toolOutput(
        await httpJson(
          `/v1/sport/positions/${encodeURIComponent(args.positionId)}/fills${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_list_positions",
    title: "Sport List Positions",
    description:
      "List public funded SPORT positions. Defaults to funded_open; old status=open is treated as funded_open. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema({
      ...authSchema,
      fixtureId: { type: "string" },
      status: {
        type: "string",
        enum: ["funded_open", "partially_filled", "matching", "matched", "filled", "expired", "cancelled", "all", "open"],
        default: "funded_open",
      },
      limit: { type: "number", minimum: 1, maximum: 100, default: 50 },
    }),
    handler: async (args) => {
      await requireScope(args, "offers:read");
      const query = new URLSearchParams();
      if (args.fixtureId) query.set("fixtureId", args.fixtureId);
      if (args.status) query.set("status", args.status);
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      return toolOutput(
        await httpJson(
          `/v1/sport/positions${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl
        )
      );
    },
  },
  {
    name: "airotc_sport_view_positions",
    title: "Sport View Positions",
    description:
      "View open or historical SPORT positions, usually filtered by TxLINE fixtureId. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema({
      ...authSchema,
      fixtureId: { type: "string" },
      status: {
        type: "string",
        enum: ["funded_open", "partially_filled", "matching", "matched", "filled", "expired", "cancelled", "all", "open"],
        default: "funded_open",
      },
      limit: { type: "number", minimum: 1, maximum: 100, default: 50 },
    }),
    handler: async (args) => {
      await requireScope(args, "offers:read");
      const query = new URLSearchParams();
      if (args.fixtureId) query.set("fixtureId", args.fixtureId);
      if (args.status) query.set("status", args.status);
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      return toolOutput(
        await httpJson(
          `/v1/sport/positions${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl
        )
      );
    },
  },
  {
    name: "airotc_sport_my_positions",
    title: "Sport My Positions",
    description:
      "List SPORT positions posted by the calling wallet, including open and matched rows for recovery. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        status: {
          type: "string",
          enum: ["funding_required", "funded_open", "partially_filled", "matching", "matched", "filled", "expired", "cancelled", "funding_failed", "all", "open"],
          default: "all",
        },
        limit: { type: "number", minimum: 1, maximum: 200, default: 100 },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const query = new URLSearchParams();
      if (args.status) query.set("status", args.status);
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      return toolOutput(
        await httpJson(
          `/v1/sport/me/positions${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_my_fills",
    title: "Sport My Fills",
    description:
      "List SPORT partial fills for the calling wallet across positions. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        status: {
          type: "string",
          enum: ["committing", "awaiting_result", "settled", "refunded", "failed", "all"],
          default: "all",
        },
        limit: { type: "number", minimum: 1, maximum: 200, default: 100 },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const query = new URLSearchParams();
      if (args.status) query.set("status", args.status);
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      return toolOutput(
        await httpJson(
          `/v1/sport/me/fills${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_my_tickets",
    title: "Sport My Tickets",
    description:
      "Recover matched SPORT arena tickets for the calling wallet after an agent restart. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 200, default: 100 },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "deals:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const query = new URLSearchParams();
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      return toolOutput(
        await httpJson(
          `/v1/sport/me/tickets${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_get_settlement_status",
    title: "Sport Settlement Status",
    description:
      "Get SPORT ticket funding, TxLINE outcome, and release/refund settlement status. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        ticketId: { type: "string" },
        includeMiddlemanStatus: { type: "boolean", default: true },
      },
      ["ticketId"]
    ),
    handler: async (args) => {
      await requireScope(args, "deals:read");
      const ticketId = encodeURIComponent(args.ticketId);
      const settlementStatus = await httpJson(
        `/v1/arena/tickets/${ticketId}/settlement-status`,
        {},
        config.apiUrl
      );
      const middlemanStatus = args.includeMiddlemanStatus === false
        ? undefined
        : await bestEffort("middleman_deal_status", () =>
          httpJson(`/v1/deals/${ticketId}/status`, {}, config.middlemanUrl)
        );
      return toolOutput({
        ...settlementStatus,
        ...(middlemanStatus ? { middlemanStatus } : {}),
      });
    },
  },
  {
    name: "airotc_sport_get_my_history",
    title: "Sport My Trades History",
    description:
      "Get the calling wallet's SPORT trade history, win/loss record, market performance, and estimated SOL PnL. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 200, default: 100 },
        includeLegacy: { type: "boolean", default: false },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "deals:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const query = new URLSearchParams();
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      if (args.includeLegacy !== undefined) query.set("includeLegacy", String(args.includeLegacy));
      return toolOutput(
        await httpJson(
          `/v1/sport/me/history${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_discover_agents",
    title: "Sport Discover Agents",
    description:
      "Discover active SPORT counterparties by active offers, reputation, markets, and fixture filters. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema({
      ...authSchema,
      limit: { type: "number", minimum: 1, maximum: 50, default: 25 },
      fixtureId: { type: "string" },
      marketType: { type: "string" },
      minSettledPredictions: { type: "number", minimum: 0, maximum: 100, default: 0 },
    }),
    handler: async (args) => {
      await requireScope(args, "offers:read");
      const query = new URLSearchParams();
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      if (args.fixtureId) query.set("fixtureId", args.fixtureId);
      if (args.marketType) query.set("marketType", args.marketType);
      if (args.minSettledPredictions !== undefined) {
        query.set("minSettledPredictions", String(args.minSettledPredictions));
      }
      return toolOutput(
        await httpJson(
          `/v1/sport/agents/discovery${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl
        )
      );
    },
  },
  {
    name: "airotc_sport_create_intent",
    title: "Sport Create Discovery Intent",
    description:
      "Broadcast a SPORT intent like 'I want to back part1 on this fixture' and receive push events when compatible funded liquidity appears. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        fixtureId: { type: "string" },
        selection: { type: "string", enum: ["part1", "draw", "part2"] },
        side: { type: "string", enum: ["back", "lay"], default: "back" },
        stakeSol: { type: "number", minimum: 0 },
        minStakeSol: { type: "number", minimum: 0 },
        maxStakeSol: { type: "number", minimum: 0 },
        expiresAt: { type: "string", description: "Optional ISO timestamp. Defaults to fixture kickoff when known." },
        note: { type: "string", maxLength: 280 },
        clientIntentId: { type: "string", description: "Optional idempotency key for this wallet." },
      },
      ["wallet", "fixtureId", "selection"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/sport/intents",
          {
            method: "POST",
            body: JSON.stringify({
              fixtureId: args.fixtureId,
              selection: args.selection,
              side: args.side || "back",
              stakeSol: args.stakeSol,
              minStakeSol: args.minStakeSol,
              maxStakeSol: args.maxStakeSol,
              expiresAt: args.expiresAt,
              note: args.note,
              clientIntentId: args.clientIntentId,
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_list_intents",
    title: "Sport List Public Intents",
    description:
      "List active public SPORT discovery intents broadcast by agents. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema({
      ...authSchema,
      fixtureId: { type: "string" },
      selection: { type: "string", enum: ["part1", "draw", "part2"] },
      side: { type: "string", enum: ["back", "lay"] },
      status: { type: "string", enum: ["active", "cancelled", "expired", "matched", "all"], default: "active" },
      limit: { type: "number", minimum: 1, maximum: 100, default: 50 },
    }),
    handler: async (args) => {
      await requireScope(args, "offers:read");
      const query = new URLSearchParams();
      if (args.fixtureId) query.set("fixtureId", args.fixtureId);
      if (args.selection) query.set("selection", args.selection);
      if (args.side) query.set("side", args.side);
      if (args.status) query.set("status", args.status);
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      return toolOutput(
        await httpJson(
          `/v1/sport/intents${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl
        )
      );
    },
  },
  {
    name: "airotc_sport_list_my_intents",
    title: "Sport List My Intents",
    description:
      "List SPORT discovery intents owned by the calling wallet, including cancelled or expired rows for recovery. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        status: { type: "string", enum: ["active", "cancelled", "expired", "matched", "all"], default: "all" },
        limit: { type: "number", minimum: 1, maximum: 100, default: 50 },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const query = new URLSearchParams();
      if (args.status) query.set("status", args.status);
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      return toolOutput(
        await httpJson(
          `/v1/sport/me/intents${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_cancel_intent",
    title: "Sport Cancel Intent",
    description:
      "Cancel one SPORT discovery intent owned by the calling wallet. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        intentId: { type: "string" },
      },
      ["wallet", "intentId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/sport/intents/${encodeURIComponent(args.intentId)}/cancel`,
          { method: "POST", body: "{}" },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_find_matching_liquidity",
    title: "Sport Find Matching Liquidity",
    description:
      "Find funded SPORT positions that can match a desired side/selection, including complement back-vs-back matches. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        fixtureId: { type: "string" },
        selection: { type: "string", enum: ["part1", "draw", "part2"] },
        side: { type: "string", enum: ["back", "lay"], default: "back" },
        stakeSol: { type: "number", minimum: 0 },
        limit: { type: "number", minimum: 1, maximum: 100, default: 25 },
      },
      ["wallet", "fixtureId", "selection"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const query = new URLSearchParams();
      query.set("fixtureId", args.fixtureId);
      query.set("selection", args.selection);
      if (args.side) query.set("side", args.side);
      if (args.stakeSol !== undefined) query.set("stakeSol", String(args.stakeSol));
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      return toolOutput(
        await httpJson(
          `/v1/sport/liquidity/matching?${query}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_get_event_guide",
    title: "Sport Event Guide",
    description:
      "Return the compact SPORT event, WebSocket, MCP polling, and discovery tool guide. No auth required.",
    inputSchema: objectSchema({ ...authSchema }),
    handler: async () => toolOutput(await httpJson("/v1/sport/events/guide", {}, config.apiUrl)),
  },
  {
    name: "airotc_sport_list_strategy_templates",
    title: "Sport List Strategy Templates",
    description:
      "List reusable SPORT offer templates for the calling wallet. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/sport/strategy-templates",
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_list_strategy_presets",
    title: "Sport List Strategy Presets",
    description:
      "List built-in SPORT strategy presets such as favorite_back, underdog_layer, and draw_hedge. Requires offers:read scope.",
    scope: "offers:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/sport/strategy-presets",
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_save_strategy_template",
    title: "Sport Save Strategy Template",
    description:
      "Create or replace a reusable SPORT offer template such as standard_sell. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        enabled: { type: "boolean", default: true },
        defaults: {
          type: "object",
          additionalProperties: true,
          description:
            "Template defaults: mode, amount, price, marketType, selection, optional deprecated collateral, asset/settlementWallet/rewardWallet/fundingWallet.",
        },
      },
      ["wallet", "name", "defaults"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/sport/strategy-templates/${encodeURIComponent(args.name)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              description: args.description,
              enabled: args.enabled !== false,
              defaults: args.defaults,
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_delete_strategy_template",
    title: "Sport Delete Strategy Template",
    description: "Delete one reusable SPORT offer template. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        name: { type: "string" },
      },
      ["wallet", "name"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/sport/strategy-templates/${encodeURIComponent(args.name)}`,
          { method: "DELETE" },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_create_offer_from_template",
    title: "Sport Create Offer From Template",
    description:
      "Create a SPORT offer from a saved strategy template, overriding fixtureId/market/selection/price when needed. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        name: { type: "string" },
        fixtureId: { type: "string" },
        overrides: {
          type: "object",
          additionalProperties: true,
          description: "Optional overrides for marketType, selection, mode, amount, price, deprecated collateral, asset, and wallets.",
        },
      },
      ["wallet", "name", "fixtureId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/sport/strategy-templates/${encodeURIComponent(args.name)}/offers`,
          {
            method: "POST",
            body: JSON.stringify({
              fixtureId: args.fixtureId,
              overrides: args.overrides || {},
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_create_position_from_preset",
    title: "Sport Create Position From Preset",
    description:
      "Create a prefunded SPORT position draft from a built-in preset. Returns vault funding instructions; fund it before matching. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        name: { type: "string", enum: ["favorite_back", "underdog_layer", "draw_hedge"] },
        fixtureId: { type: "string" },
        overrides: {
          type: "object",
          additionalProperties: true,
          description: "Optional overrides for selection, stakeSol, side, marketType, and clientOrderId.",
        },
      },
      ["wallet", "name", "fixtureId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/sport/strategy-presets/${encodeURIComponent(args.name)}/positions`,
          {
            method: "POST",
            body: JSON.stringify({
              fixtureId: args.fixtureId,
              overrides: args.overrides || {},
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_sport_settlement_automation_status",
    title: "Sport Settlement Automation Status",
    description:
      "Check whether SPORT settlement is running automatically and see the last sweep result. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema({ ...authSchema }),
    handler: async (args) => {
      await requireScope(args, "deals:read");
      return toolOutput(await httpJson("/v1/arena/settlement/automation", {}, config.apiUrl));
    },
  },
  {
    name: "airotc_sport_ingestion_status",
    title: "Sport Ingestion Status",
    description:
      "Get TxLINE live odds/scores ingestion status for SPORT mode. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema({ ...authSchema }),
    handler: async (args) => {
      await requireScope(args, "deals:read");
      return toolOutput(await httpJson("/v1/txline/ingestion/status", {}, config.apiUrl));
    },
  },
  {
    name: "airotc_sport_start_ingestion",
    title: "Sport Start Ingestion",
    description:
      "Start TxLINE live odds/scores ingestion for SPORT mode. Requires sport:admin scope and API admin authorization in production.",
    scope: "sport:admin",
    inputSchema: objectSchema({
      ...authSchema,
      adminToken: { type: "string" },
    }),
    handler: async (args) => {
      await requireScope(args, "sport:admin");
      return toolOutput(
        await httpJson(
          "/v1/txline/ingestion/start",
          { method: "POST", headers: txlineAdminHeaders(args), body: "{}" },
          config.apiUrl
        )
      );
    },
  },
  {
    name: "airotc_sport_stop_ingestion",
    title: "Sport Stop Ingestion",
    description:
      "Stop TxLINE live odds/scores ingestion for SPORT mode. Requires sport:admin scope and API admin authorization in production.",
    scope: "sport:admin",
    inputSchema: objectSchema({
      ...authSchema,
      adminToken: { type: "string" },
    }),
    handler: async (args) => {
      await requireScope(args, "sport:admin");
      return toolOutput(
        await httpJson(
          "/v1/txline/ingestion/stop",
          { method: "POST", headers: txlineAdminHeaders(args), body: "{}" },
          config.apiUrl
        )
      );
    },
  },
  {
    name: "airotc_sport_run_settlement_once",
    title: "Sport Run Settlement Once",
    description:
      "Run one SPORT settlement sweep now, refreshing TxLINE outcomes before escrow execution. Requires sport:admin scope and API admin authorization in production.",
    scope: "sport:admin",
    inputSchema: objectSchema({
      ...authSchema,
      adminToken: { type: "string" },
      matchId: { type: "string" },
      fixtureId: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100, default: 25 },
      refreshOutcomes: { type: "boolean", default: true },
      liveSync: { type: "boolean", default: true },
    }),
    handler: async (args) => {
      await requireScope(args, "sport:admin");
      const body: Record<string, unknown> = {
        refreshOutcomes: args.refreshOutcomes !== false,
        liveSync: args.liveSync !== false,
      };
      if (args.matchId) body.matchId = args.matchId;
      if (args.fixtureId) body.fixtureId = args.fixtureId;
      if (args.limit !== undefined) {
        body.limit = Math.min(Math.max(Math.floor(Number(args.limit) || 25), 1), 100);
      }
      return toolOutput(
        await httpJson(
          "/v1/arena/settlement/run",
          {
            method: "POST",
            headers: txlineAdminHeaders(args),
            body: JSON.stringify(body),
          },
          config.apiUrl
        )
      );
    },
  },
  {
    name: "airotc_create_offer",
    title: "Create Offer",
    description: "Create an AIR OTC offer. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        asset: { type: "string" },
        mode: { type: "string", enum: ["buy", "sell"] },
        amount: { type: "number", exclusiveMinimum: 0 },
        price: { type: "number", exclusiveMinimum: 0 },
        collateral: { type: "number", minimum: 0, description: "Required outside SPORT; SPORT ignores separate collateral and uses equal stake." },
        rollupMode: { type: "string", enum: ["ER", "PER", "NONE", "SPORT"], default: "NONE" },
        fixtureId: { type: "string" },
        marketType: { type: "string" },
        selection: { type: "string" },
        settlementWallet: { type: "string" },
        rewardWallet: { type: "string" },
        fundingWallet: { type: "string" },
      },
      ["wallet", "asset", "mode", "amount", "price"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson("/v1/offers", {
          method: "POST",
          body: JSON.stringify({
            publicKey: wallet,
            asset: args.asset,
            mode: args.mode,
            amount: args.amount,
            price: args.price,
            collateral: args.collateral ?? (args.rollupMode === "SPORT" ? 0 : undefined),
            rollupMode: args.rollupMode || "NONE",
            fixtureId: args.fixtureId,
            marketType: args.marketType,
            selection: args.selection,
            settlementWallet: args.settlementWallet,
            rewardWallet: args.rewardWallet,
            fundingWallet: args.fundingWallet,
          }),
        }, config.apiUrl, { delegatedWallet: wallet, authToken: args.authToken })
      );
    },
  },
  {
    name: "airotc_accept_offer",
    title: "Accept Offer",
    description: "Accept an offer. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        offerId: { type: "string" },
        wallet: { type: "string" },
        settlementWallet: { type: "string" },
        rewardWallet: { type: "string" },
        fundingWallet: { type: "string" },
      },
      ["offerId", "wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(`/v1/offers/${encodeURIComponent(args.offerId)}/accept`, {
          method: "POST",
          body: JSON.stringify({
            wallet,
            settlementWallet: args.settlementWallet,
            rewardWallet: args.rewardWallet,
            fundingWallet: args.fundingWallet,
          }),
        }, config.apiUrl, { delegatedWallet: wallet, authToken: args.authToken })
      );
    },
  },
  {
    name: "airotc_list_wallet_tickets",
    title: "List Wallet Tickets",
    description:
      "List recoverable AIR OTC tickets for a wallet, including active negotiations after agent restart. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        status: { type: "string" },
        activeOnly: { type: "boolean", default: true },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "deals:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const query = new URLSearchParams();
      if (args.status) query.set("status", args.status);
      if (args.activeOnly !== undefined) query.set("activeOnly", String(args.activeOnly));
      return toolOutput(
        await httpJson(
          `/v1/tickets${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_get_ticket_messages",
    title: "Get Ticket Messages",
    description: "Read the in-ticket negotiation chat for a buyer/seller ticket. Requires deals:read scope.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        ticketId: { type: "string" },
        wallet: { type: "string" },
      },
      ["ticketId", "wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "deals:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/tickets/${encodeURIComponent(args.ticketId)}/messages`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_send_ticket_message",
    title: "Send Ticket Message",
    description:
      "Send a raw English negotiation message inside an accepted ticket. Requires offers:write scope.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        ticketId: { type: "string" },
        wallet: { type: "string" },
        content: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
        },
      },
      ["ticketId", "wallet", "content"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "offers:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/tickets/${encodeURIComponent(args.ticketId)}/messages`,
          {
            method: "POST",
            body: JSON.stringify({ content: args.content }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_send_dm",
    title: "Send Direct Message",
    description:
      "Send a private agent-to-agent direct message outside ticket chat, optionally linked to a ticket for delivery context. Requires dm:write scope.",
    scope: "dm:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string", description: "Sender wallet." },
        toWallet: { type: "string", description: "Recipient wallet." },
        content: { type: "string", minLength: 1, maxLength: 10000 },
        contentType: {
          type: "string",
          enum: ["text", "api_key", "url", "file_link", "credentials"],
          default: "text",
        },
        ticketId: { type: "string" },
        encrypted: { type: "boolean", default: false },
        metadata: { type: "object", additionalProperties: true },
        expiresAt: { type: "string", description: "Optional ISO timestamp for expiring sensitive content." },
      },
      ["toWallet", "content"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "dm:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/dm/send",
          {
            method: "POST",
            body: JSON.stringify({
              toWallet: args.toWallet,
              content: args.content,
              contentType: args.contentType || "text",
              ticketId: args.ticketId,
              encrypted: args.encrypted === true,
              metadata: args.metadata,
              expiresAt: args.expiresAt,
            }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_list_dm_inbox",
    title: "List DM Inbox",
    description: "List direct messages received by a wallet. Requires dm:read scope.",
    scope: "dm:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        page: { type: "number", minimum: 1, default: 1 },
        limit: { type: "number", minimum: 1, maximum: 50, default: 20 },
        unread: { type: "boolean", default: false },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "dm:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const query = new URLSearchParams();
      if (args.page !== undefined) query.set("page", String(args.page));
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      if (args.unread !== undefined) query.set("unread", String(args.unread));
      return toolOutput(
        await httpJson(
          `/v1/dm/inbox${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_get_dm_conversation",
    title: "Get DM Conversation",
    description: "Read the full direct-message conversation between this wallet and another wallet. Requires dm:read scope.",
    scope: "dm:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        peerWallet: { type: "string" },
        page: { type: "number", minimum: 1, default: 1 },
        limit: { type: "number", minimum: 1, maximum: 100, default: 50 },
      },
      ["wallet", "peerWallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "dm:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      const query = new URLSearchParams();
      if (args.page !== undefined) query.set("page", String(args.page));
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      return toolOutput(
        await httpJson(
          `/v1/dm/conversation/${encodeURIComponent(args.peerWallet)}${query.size ? `?${query}` : ""}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_get_dm_unread",
    title: "Get DM Unread Count",
    description: "Get unread direct-message counts for a wallet. Requires dm:read scope.",
    scope: "dm:read",
    inputSchema: objectSchema({ ...authSchema, wallet: { type: "string" } }, ["wallet"]),
    handler: async (args) => {
      const auth = await requireScope(args, "dm:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/dm/unread",
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_get_deal_dms",
    title: "Get Deal Direct Messages",
    description: "Read DMs linked to a specific ticket/deal for the calling wallet. Requires dm:read scope.",
    scope: "dm:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        ticketId: { type: "string" },
      },
      ["wallet", "ticketId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "dm:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/dm/deal/${encodeURIComponent(args.ticketId)}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_mark_dm_read",
    title: "Mark DM Read",
    description: "Mark one direct message as read. Requires dm:write scope.",
    scope: "dm:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        messageId: { type: "string" },
      },
      ["wallet", "messageId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "dm:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/dm/read/${encodeURIComponent(args.messageId)}`,
          { method: "POST", body: JSON.stringify({}) },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_mark_dm_conversation_read",
    title: "Mark DM Conversation Read",
    description: "Mark all direct messages from one peer wallet as read. Requires dm:write scope.",
    scope: "dm:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        peerWallet: { type: "string" },
      },
      ["peerWallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "dm:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/dm/read-all/${encodeURIComponent(args.peerWallet)}`,
          { method: "POST", body: JSON.stringify({}) },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_delete_dm",
    title: "Delete DM",
    description: "Delete a direct message sent by the calling wallet within the API delete window. Requires dm:write scope.",
    scope: "dm:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        messageId: { type: "string" },
      },
      ["messageId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "dm:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/dm/${encodeURIComponent(args.messageId)}`,
          { method: "DELETE" },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_publish_dm_encryption_key",
    title: "Publish DM Encryption Key",
    description: "Publish the calling agent's X25519/base58 public key so peers can send encrypted DMs. Requires dm:write scope.",
    scope: "dm:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        encryptionPublicKey: { type: "string", minLength: 32, maxLength: 50 },
      },
      ["encryptionPublicKey"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "dm:write");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          "/v1/dm/keys/publish",
          {
            method: "POST",
            body: JSON.stringify({ encryptionPublicKey: args.encryptionPublicKey }),
          },
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_get_dm_encryption_key",
    title: "Get DM Encryption Key",
    description: "Fetch a peer agent's published encryption public key before sending encrypted DMs. Requires dm:read scope.",
    scope: "dm:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        targetWallet: { type: "string" },
      },
      ["targetWallet"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "dm:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/dm/keys/${encodeURIComponent(args.targetWallet)}`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_get_dm_file_info",
    title: "Get DM File Info",
    description: "Read metadata for a DM file attachment without downloading file contents. Requires dm:read scope.",
    scope: "dm:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        attachmentId: { type: "string" },
      },
      ["attachmentId"]
    ),
    handler: async (args) => {
      const auth = await requireScope(args, "dm:read");
      const wallet = await delegatedWalletFromArgs(args, auth);
      return toolOutput(
        await httpJson(
          `/v1/dm/files/${encodeURIComponent(args.attachmentId)}/info`,
          {},
          config.apiUrl,
          { delegatedWallet: wallet, authToken: args.authToken }
        )
      );
    },
  },
  {
    name: "airotc_get_deal_status",
    title: "Get Deal Status",
    description: "Read a deal/ticket status.",
    scope: "deals:read",
    inputSchema: objectSchema({ ...authSchema, ticketId: { type: "string" } }, ["ticketId"]),
    handler: async (args) => {
      await requireScope(args, "deals:read");
      return toolOutput(
        await bestEffort("middleman_status", () =>
          httpJson(`/v1/deals/${encodeURIComponent(args.ticketId)}/status`, {}, config.middlemanUrl)
        )
      );
    },
  },
  {
    name: "airotc_get_proof_bundle",
    title: "Get Proof Bundle",
    description: "Read an evidence bundle for a ticket from available local services.",
    scope: "proofs:read",
    inputSchema: objectSchema({ ...authSchema, ticketId: { type: "string" } }, ["ticketId"]),
    handler: async (args) => {
      await requireScope(args, "proofs:read");
      const ticketId = encodeURIComponent(args.ticketId);
      return toolOutput({
        ticketId: args.ticketId,
        collectedAt: new Date().toISOString(),
        entries: [
          await bestEffort("deal_status", () => httpJson(`/v1/deals/${ticketId}/status`, {}, config.middlemanUrl)),
          await bestEffort("audit", () => httpJson(`/api/audit/${ticketId}`, {}, config.middlemanHealthUrl)),
          await bestEffort("timeline", () => httpJson(`/api/deals/${ticketId}/timeline`, {}, config.middlemanHealthUrl)),
        ],
      });
    },
  },
  {
    name: "airotc_vault_status",
    title: "Vault Status",
    description: "Read configured confidential/vault status. Does not expose keys.",
    scope: "vault:read",
    inputSchema: objectSchema({ ...authSchema }),
    handler: async (args) => {
      await requireScope(args, "vault:read");
      return toolOutput({
        confidential: await bestEffort("confidential_status", () =>
          httpJson("/v1/confidential/status", {}, config.middlemanUrl)
        ),
        note: "MCP reports service/vault visibility only. On-chain reserve proof requires Solana RPC account inspection by the operator.",
      });
    },
  },
  {
    name: "airotc_umbra_lifecycle_status",
    title: "Umbra Lifecycle Status",
    description: "Read Umbra lifecycle evidence from the proof bundle/audit surface.",
    scope: "umbra:read",
    inputSchema: objectSchema({ ...authSchema, ticketId: { type: "string" } }, ["ticketId"]),
    handler: async (args) => {
      await requireScope(args, "umbra:read");
      const ticketId = encodeURIComponent(args.ticketId);
      return toolOutput({
        ticketId: args.ticketId,
        entries: [
          await bestEffort("audit", () => httpJson(`/api/audit/${ticketId}`, {}, config.middlemanHealthUrl)),
          await bestEffort("timeline", () => httpJson(`/api/deals/${ticketId}/timeline`, {}, config.middlemanHealthUrl)),
        ],
      });
    },
  },
  {
    name: "airotc_run_per_buyer_flow",
    title: "Run PER Buyer Flow",
    description: "Run the TypeScript SDK PER buyer workflow using env wallet credentials. Requires per:run scope.",
    scope: "per:run",
    inputSchema: objectSchema(
      {
        ...authSchema,
        offerId: { type: "string" },
        terms: { type: "object", additionalProperties: true },
        timeoutMs: { type: "integer", exclusiveMinimum: 0, default: 180000 },
      },
      ["offerId", "terms"]
    ),
    handler: async (args) => {
      await requireScope(args, "per:run");
      const client = await createSdkClient();
      try {
        return toolOutput(
          await client.workflows.quickBuyPer({
            offerId: args.offerId,
            terms: args.terms,
            timeoutMs: args.timeoutMs || 180000,
          })
        );
      } finally {
        await client.disconnect().catch(() => undefined);
      }
    },
  },
  {
    name: "airotc_run_per_seller_flow",
    title: "Run PER Seller Flow",
    description: "Run the TypeScript SDK PER seller workflow using env wallet credentials. Requires per:run scope.",
    scope: "per:run",
    inputSchema: objectSchema(
      {
        ...authSchema,
        offer: { type: "object", additionalProperties: true },
        terms: { type: "object", additionalProperties: true },
        deliveryContent: { type: "string" },
        timeoutMs: { type: "integer", exclusiveMinimum: 0, default: 180000 },
      },
      ["offer", "terms", "deliveryContent"]
    ),
    handler: async (args) => {
      await requireScope(args, "per:run");
      const client = await createSdkClient();
      try {
        return toolOutput(
          await client.workflows.quickSellPer({
            offer: args.offer,
            terms: args.terms,
            deliveryContent: args.deliveryContent,
            timeoutMs: args.timeoutMs || 180000,
          })
        );
      } finally {
        await client.disconnect().catch(() => undefined);
      }
    },
  },
];

const resourceTemplates: ResourceTemplateDefinition[] = [
  {
    uriTemplate: "airotc://deals/{ticketId}",
    name: "deal",
    title: "AIR OTC Deal",
    description: "Deal status resource",
    mimeType: "application/json",
  },
  {
    uriTemplate: "airotc://proofs/{ticketId}",
    name: "proof",
    title: "AIR OTC Proof Bundle",
    description: "Proof bundle resource",
    mimeType: "application/json",
  },
];

const staticResources: ResourceDefinition[] = [
  {
    uri: "airotc://vault/status",
    name: "vault-status",
    title: "AIR OTC Vault Status",
    description: "Vault status resource",
    mimeType: "application/json",
    handler: async () =>
      await bestEffort("confidential_status", () => httpJson("/v1/confidential/status", {}, config.middlemanUrl)),
  },
];

function listTools() {
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function mergeRequestAuth(args: Record<string, any>, context: RequestContext): Record<string, any> {
  if (!context.authToken) return args;
  return { ...args, authToken: context.authToken };
}

async function callTool(params: any, context: RequestContext = {}) {
  const parsed = z
    .object({
      name: z.string(),
      arguments: z.record(z.any()).optional(),
    })
    .parse(params || {});
  const tool = tools.find((candidate) => candidate.name === parsed.name);
  if (!tool) {
    throw new Error(`unknown_tool:${parsed.name}`);
  }
  return await tool.handler(mergeRequestAuth(parsed.arguments || {}, context));
}

async function readResource(params: any) {
  const uri = z.object({ uri: z.string() }).parse(params || {}).uri;
  const staticResource = staticResources.find((resource) => resource.uri === uri);
  if (staticResource) {
    return {
      contents: [
        {
          uri: staticResource.uri,
          mimeType: staticResource.mimeType,
          text: JSON.stringify(await staticResource.handler(), null, 2),
        },
      ],
    };
  }
  const dealMatch = /^airotc:\/\/deals\/(.+)$/.exec(uri);
  if (dealMatch) {
    const ticketId = decodeURIComponent(dealMatch[1]);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            await bestEffort("deal_status", () =>
              httpJson(`/v1/deals/${encodeURIComponent(ticketId)}/status`, {}, config.middlemanUrl)
            ),
            null,
            2
          ),
        },
      ],
    };
  }
  const proofMatch = /^airotc:\/\/proofs\/(.+)$/.exec(uri);
  if (proofMatch) {
    const ticketId = decodeURIComponent(proofMatch[1]);
    const encoded = encodeURIComponent(ticketId);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              ticketId,
              collectedAt: new Date().toISOString(),
              entries: [
                await bestEffort("deal_status", () => httpJson(`/v1/deals/${encoded}/status`, {}, config.middlemanUrl)),
                await bestEffort("audit", () => httpJson(`/api/audit/${encoded}`, {}, config.middlemanHealthUrl)),
              ],
            },
            null,
            2
          ),
        },
      ],
    };
  }
  throw new Error(`unknown_resource:${uri}`);
}

async function dispatch(method: string, params: any, context: RequestContext = {}): Promise<any> {
  const directTool = tools.find((candidate) => candidate.name === method);
  if (directTool) {
    return await directTool.handler(mergeRequestAuth(params || {}, context));
  }
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: {
          name: "air-otc-mcp",
          version: "0.1.0",
        },
      };
    case "ping":
      return {};
    case "tools/list":
      return listTools();
    case "tools/call":
      return await callTool(params, context);
    case "resources/list":
      return {
        resources: staticResources.map(({ uri, name, title, description, mimeType }) => ({
          uri,
          name,
          title,
          description,
          mimeType,
        })),
      };
    case "resources/templates/list":
      return {
        resourceTemplates,
      };
    case "resources/read":
      return await readResource(params);
    case "prompts/list":
      return { prompts: [] };
    default:
      throw new Error(`method_not_found:${method}`);
  }
}

async function handleJsonRpc(request: JsonRpcRequest, context: RequestContext = {}): Promise<any | null> {
  if (!request.id && request.id !== 0) {
    return null;
  }
  if (request.jsonrpc !== "2.0" || !request.method) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32600, message: "Invalid Request" },
    };
  }
  try {
    return {
      jsonrpc: "2.0",
      id: request.id,
        result: await dispatch(request.method, request.params, context),
    };
  } catch (error: any) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error?.message || String(error),
      },
    };
  }
}

async function startStdio(): Promise<void> {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      void (async () => {
        try {
          const response = await handleJsonRpc(JSON.parse(trimmed));
          if (response) {
            process.stdout.write(`${JSON.stringify(response)}\n`);
          }
        } catch (error: any) {
          process.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: error?.message || String(error) },
            })}\n`
          );
        }
      })();
    }
  });
}

function extractHttpAuthToken(req: express.Request): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return normalizeAuthToken(authorization);
  }
  const header = req.headers["x-airotc-mcp-token"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" ? normalizeAuthToken(value) : undefined;
}

async function startHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/mcp", async (req, res) => {
    const headerToken = extractHttpAuthToken(req);
    const context: RequestContext = headerToken ? { authToken: headerToken } : {};
    if (Array.isArray(req.body)) {
      const responses = (await Promise.all(req.body.map((entry) => handleJsonRpc(entry, context)))).filter(Boolean);
      if (responses.length === 0) {
        res.status(202).end();
        return;
      }
      res.json(responses);
      return;
    }
    const response = await handleJsonRpc(req.body, context);
    if (!response) {
      res.status(202).end();
      return;
    }
    res.json(response);
  });
  app.get("/mcp", (_req, res) => {
    res.json({
      name: "air-otc-mcp",
      version: "0.1.0",
      transports: ["stdio", "http"],
      delegatedWallets: {
        enabled: Boolean(config.mcpDelegationToken),
        mode: "token_delegated",
        maxActiveSeats: Number(process.env.AIR_OTC_MCP_MAX_ACTIVE_SEATS || 0) || null,
      },
      auth: {
        enabled: Boolean(config.mcpToken) || config.tokenRules.length > 0,
        tokenCount: (config.mcpToken ? 1 : 0) + config.tokenRules.length,
      },
      tools: tools.map((tool) => tool.name),
      resources: [
        ...staticResources.map((resource) => resource.uri),
        ...resourceTemplates.map((resource) => resource.uriTemplate),
      ],
    });
  });
  const port = Number(process.env.AIR_OTC_MCP_PORT || process.env.PORT || 8787);
  app.listen(port, () => {
    console.log(`AIR OTC MCP HTTP listening on http://localhost:${port}/mcp`);
  });
}

export const __test = {
  tools,
  staticResources,
  resourceTemplates,
  extractHttpAuthToken,
  mergeRequestAuth,
  parseScopes,
  delegatedWalletFromArgs,
  sportStatusBucket,
  registerFundingSession,
  getFundingSessionKeypair,
  getFundingSessionStatus,
  clearFundingSession,
};

if (process.env.AIR_OTC_MCP_NO_AUTOSTART !== "1") {
  if (process.argv.includes("--http")) {
    await startHttp();
  } else {
    await startStdio();
  }
}
