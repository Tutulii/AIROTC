#!/usr/bin/env node
import crypto from "node:crypto";
import express from "express";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import bs58 from "bs58";
import nacl from "tweetnacl";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const requireFromMcp = createRequire(import.meta.url);

type Scope =
  | "offers:read"
  | "offers:write"
  | "deals:read"
  | "per:run"
  | "proofs:read"
  | "vault:read"
  | "umbra:read"
  | "policies:read"
  | "policies:write";

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
  source: "open" | "operator" | "rule" | "signed";
  accessToken?: string;
};

type WalletCredential = {
  name: string;
  wallet: string;
  privateKey: string;
};

type SdkClientOptions = {
  privateMode?: boolean;
  strictOpaquePerMode?: boolean;
  persistLocalState?: boolean;
};

type NormalModeOfferInput = {
  asset: string;
  mode: "sell";
  amount: number;
  amountRaw?: string;
  price: number;
  priceRaw?: string;
  collateral: number;
  collateralRaw?: string;
};

type NormalModeEvent = {
  at: string;
  agent: string;
  event: string;
  data: unknown;
};

type NormalSignerEntry = {
  wallet: string;
  source: "AIR_OTC_MCP_WALLETS_JSON" | "AIR_OTC_WALLET_PRIVATE_KEY";
  name?: string;
};

const NORMAL_MODE_PROFILE = Object.freeze({
  executionProfile: "NORMAL_SOL_ESCROW",
  privacyTier: "PUBLIC_SOL",
  settlementRail: "SOL_ESCROW",
  confidentialComputeProvider: "NONE",
  rollupMode: "NONE",
});

const validScopes = new Set<Scope>([
  "offers:read",
  "offers:write",
  "deals:read",
  "per:run",
  "proofs:read",
  "vault:read",
  "umbra:read",
  "policies:read",
  "policies:write",
]);

function parseScopes(value: string | string[] | undefined, fallback: Set<Scope>): Set<Scope> {
  if (!value) return new Set(fallback);
  const items = Array.isArray(value) ? value : value.split(",");
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

function derivePublicKeyFromPrivateKey(privateKey: string): string {
  const secretKey = bs58.decode(privateKey);
  if (secretKey.length !== 64) {
    throw new Error("wallet private keys must be base58-encoded 64-byte Solana secret keys");
  }
  return bs58.encode(nacl.sign.keyPair.fromSecretKey(secretKey).publicKey);
}

function parseWalletCredentials(): WalletCredential[] {
  const raw = process.env.AIR_OTC_MCP_WALLETS_JSON;
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AIR_OTC_MCP_WALLETS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("AIR_OTC_MCP_WALLETS_JSON must be an array");
  }

  return parsed.map((entry, index) => {
    const item = entry as { name?: unknown; wallet?: unknown; privateKey?: unknown };
    if (typeof item.privateKey !== "string" || item.privateKey.trim().length === 0) {
      throw new Error(`AIR_OTC_MCP_WALLETS_JSON[${index}].privateKey is required`);
    }
    const derivedWallet = derivePublicKeyFromPrivateKey(item.privateKey);
    if (typeof item.wallet === "string" && item.wallet.trim() && item.wallet.trim() !== derivedWallet) {
      throw new Error(`AIR_OTC_MCP_WALLETS_JSON[${index}].wallet does not match privateKey`);
    }
    return {
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : `wallet-${index + 1}`,
      wallet: derivedWallet,
      privateKey: item.privateKey,
    };
  });
}

const defaultScopes = parseScopes(
  process.env.AIR_OTC_MCP_SCOPES || "offers:read,deals:read,proofs:read,vault:read,umbra:read",
  new Set(validScopes)
);

const config = {
  apiUrl: (process.env.AIR_OTC_API_URL || "http://localhost:3000").replace(/\/$/, ""),
  middlemanUrl: (process.env.AIR_OTC_MIDDLEMAN_URL || "http://localhost:8080").replace(/\/$/, ""),
  middlemanHealthUrl: (process.env.AIR_OTC_MIDDLEMAN_HEALTH_URL || "http://localhost:8081").replace(/\/$/, ""),
  wsUrl: process.env.AIR_OTC_WS_URL || "ws://localhost:8080",
  rpcUrl: process.env.AIR_OTC_RPC_URL || "https://api.devnet.solana.com",
  environment: process.env.AIR_OTC_ENVIRONMENT || "devnet",
  sdkPath:
    process.env.AIR_OTC_TS_SDK_PATH ||
    path.resolve(__dirname, "../../../sdk/ts/dist/index.js"),
  mcpToken: process.env.AIR_OTC_MCP_TOKEN || "",
  mcpAccessTokenSecret:
    process.env.AIR_OTC_MCP_ACCESS_TOKEN_SECRET ||
    process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET ||
    process.env.AIR_OTC_MCP_DELEGATION_TOKEN ||
    "",
  mcpDelegationToken: process.env.AIR_OTC_MCP_DELEGATION_TOKEN || "",
  allowedWallets: new Set(
    (process.env.AIR_OTC_MCP_ALLOWED_WALLETS || "")
      .split(",")
      .map((wallet) => wallet.trim())
      .filter(Boolean)
  ),
  scopes: defaultScopes,
  tokenRules: parseTokenRules(defaultScopes),
  walletCredentials: parseWalletCredentials(),
  walletPrivateKey: process.env.AIR_OTC_WALLET_PRIVATE_KEY || "",
  apiKey: process.env.AIR_OTC_API_KEY || "",
  agentPolicyAdminToken: process.env.AIR_OTC_AGENT_POLICY_ADMIN_TOKEN || "",
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

function configuredNormalSigners(): NormalSignerEntry[] {
  const signers: NormalSignerEntry[] = config.walletCredentials.map((credential) => ({
    wallet: credential.wallet,
    name: credential.name,
    source: "AIR_OTC_MCP_WALLETS_JSON",
  }));

  const auth = walletAuth();
  if (auth && !signers.some((signer) => signer.wallet === auth.publicKey)) {
    signers.push({
      wallet: auth.publicKey,
      source: "AIR_OTC_WALLET_PRIVATE_KEY",
    });
  }

  return signers;
}

function isValidSolanaWallet(wallet: string): boolean {
  try {
    return bs58.decode(wallet).length === 32;
  } catch {
    return false;
  }
}

function usableApiKey(apiKey: string | undefined): string | undefined {
  const trimmed = apiKey?.trim();
  return trimmed?.startsWith("mk_") ? trimmed : undefined;
}

function assertDelegatedWalletAllowed(requestedWallet?: string): asserts requestedWallet is string {
  if (!requestedWallet || !isValidSolanaWallet(requestedWallet)) {
    throw new Error("mcp_wallet_invalid");
  }
  if (!config.allowedWallets.has(requestedWallet)) {
    throw new Error(`mcp_wallet_not_allowlisted:${requestedWallet}`);
  }
  if (!config.mcpDelegationToken) {
    throw new Error("mcp_delegation_token_not_configured");
  }
}

function assertConfiguredWallet(requestedWallet?: string, authToken?: string): void {
  if (!requestedWallet) return;
  const tokenAuth = resolveTokenAuth(authToken);
  if (tokenAuth?.wallets && !tokenAuth.wallets.has(requestedWallet)) {
    throw new Error(`mcp_token_wallet_mismatch:${requestedWallet}`);
  }
  if (config.mcpDelegationToken) {
    if (!isValidSolanaWallet(requestedWallet)) {
      throw new Error("mcp_wallet_invalid");
    }
    if (tokenAuth?.source !== "signed") {
      assertDelegatedWalletAllowed(requestedWallet);
    }
    return;
  }
  const auth = walletAuth();
  if (auth && requestedWallet && requestedWallet !== auth.publicKey) {
    throw new Error(`mcp_wallet_mismatch:configured=${auth.publicKey}:requested=${requestedWallet}`);
  }
}

function requireValidWalletField(value: unknown, field: string): string {
  if (typeof value !== "string" || !isValidSolanaWallet(value)) {
    throw new Error(`mcp_${field}_invalid`);
  }
  return value;
}

function requirePerMarketplaceWallets(args: Record<string, any>, action: "create" | "accept"): void {
  const prefix = action === "create" ? "maker" : "taker";
  requireValidWalletField(args.settlementWallet, `${prefix}_settlement_wallet`);
  requireValidWalletField(args.rewardWallet, `${prefix}_reward_wallet`);
  requireValidWalletField(args.fundingWallet, `${prefix}_funding_wallet`);
}

function requireDisplayOrRawAmount(args: Record<string, any>, field: "amount" | "price" | "collateral"): void {
  const rawField = `${field}Raw`;
  if (args[field] === undefined && args[rawField] === undefined) {
    throw new Error(`mcp_${field}_or_${rawField}_required`);
  }
  if (args[rawField] !== undefined && (typeof args[rawField] !== "string" || !/^\d+$/.test(args[rawField]))) {
    throw new Error(`mcp_${rawField}_invalid`);
  }
}

const authSchema = {
  authToken: {
    type: "string",
    description: "MCP bearer token. Required when AIR_OTC_MCP_TOKEN is set.",
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

const MCP_ACCESS_TOKEN_PREFIX = "mcp_v1";
const MCP_ACCESS_TOKEN_ISSUER = "air-otc-api";
const MCP_ACCESS_TOKEN_AUDIENCE = "air-otc-mcp";

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

function base64UrlEncode(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifySignedAccessToken(authToken?: string): TokenAuth | null {
  if (!authToken || !config.mcpAccessTokenSecret || config.mcpAccessTokenSecret.length < 16) return null;
  const parts = authToken.split(".");
  if (parts.length !== 3 || parts[0] !== MCP_ACCESS_TOKEN_PREFIX) return null;

  const [, encodedPayload, signature] = parts;
  const expected = base64UrlEncode(
    crypto.createHmac("sha256", config.mcpAccessTokenSecret).update(encodedPayload).digest()
  );
  if (!safeEqual(signature, expected)) return null;

  let payload: any;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    payload?.v !== 1 ||
    payload?.iss !== MCP_ACCESS_TOKEN_ISSUER ||
    payload?.aud !== MCP_ACCESS_TOKEN_AUDIENCE ||
    typeof payload?.sub !== "string" ||
    !isValidSolanaWallet(payload.sub) ||
    typeof payload?.exp !== "number" ||
    payload.exp <= now ||
    !Array.isArray(payload?.scopes)
  ) {
    return null;
  }

  const scopes = parseScopes(payload.scopes, new Set());
  if (scopes.size !== payload.scopes.length || scopes.size === 0) return null;

  return {
    scopes,
    wallets: new Set([payload.sub]),
    source: "signed",
    accessToken: authToken,
  };
}

function resolveTokenAuth(authToken?: string): TokenAuth | null {
  const hasAnyToken = Boolean(config.mcpToken) || config.tokenRules.length > 0 || Boolean(config.mcpAccessTokenSecret);
  if (!hasAnyToken) return { scopes: config.scopes, wallets: null, source: "open" };
  if (!authToken) return null;
  if (config.mcpToken && authToken === config.mcpToken) {
    return { scopes: config.scopes, wallets: null, source: "operator" };
  }
  const rule = config.tokenRules.find((candidate) => candidate.token === authToken);
  if (rule) return { scopes: rule.scopes, wallets: rule.wallets, source: "rule" };
  return verifySignedAccessToken(authToken);
}

function requireScope(args: { authToken?: string }, scope: Scope): void {
  const auth = resolveTokenAuth(args.authToken);
  if (!auth) {
    throw new Error(`mcp_auth_failed:${scope}`);
  }
  if (!auth.scopes.has(scope)) {
    throw new Error(`mcp_scope_missing:${scope}`);
  }
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
  options: { delegatedWallet?: string; accessToken?: string } = {}
): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (options.delegatedWallet && baseUrl === config.apiUrl) {
    const tokenAuth = verifySignedAccessToken(options.accessToken);
    if (!tokenAuth?.wallets?.has(options.delegatedWallet)) {
      assertDelegatedWalletAllowed(options.delegatedWallet);
    }
    if (!config.mcpDelegationToken) {
      throw new Error("mcp_delegation_token_not_configured");
    }
    headers.set("x-airotc-mcp-delegation-token", config.mcpDelegationToken);
    headers.set("x-airotc-delegated-wallet", options.delegatedWallet);
    if (tokenAuth?.accessToken) {
      headers.set("x-airotc-mcp-access-token", tokenAuth.accessToken);
    }
  } else if (usableApiKey(config.apiKey) && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${usableApiKey(config.apiKey)}`);
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
  let parsed: any = {};
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { message: response.statusText, raw: body.slice(0, 200) };
    }
  }
  if (!response.ok) {
    throw new Error(`air_otc_http_${response.status}:${parsed.error || parsed.message || response.statusText}`);
  }
  if (body && parsed?.raw) {
    throw new Error(`air_otc_invalid_json:${response.status}:${parsed.message || "non_json_response"}`);
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

async function loadSdk(): Promise<any> {
  if (config.sdkPath.endsWith(".js") || config.sdkPath.endsWith(".cjs")) {
    return requireFromMcp(config.sdkPath);
  }
  return import(pathToFileURL(config.sdkPath).href);
}

function inferSingleTokenWallet(authToken?: string): string | undefined {
  const auth = resolveTokenAuth(authToken);
  if (!auth?.wallets || auth.wallets.size !== 1) return undefined;
  return [...auth.wallets][0];
}

function missingHostedSignerMessage(wallet: string): string {
  return [
    `mcp_external_signer_required:${wallet}`,
    "hosted_mcp_cannot_sign_for_wallet_without_configured_signer",
    "run a local AIR OTC MCP/runtime with AIR_OTC_WALLET_PRIVATE_KEY for this same wallet",
    "or configure this wallet in AIR_OTC_MCP_WALLETS_JSON on the hosted MCP service",
  ].join(":");
}

function resolveSdkPrivateKey(requestedWallet?: string, authToken?: string): string {
  const targetWallet = requestedWallet || inferSingleTokenWallet(authToken);
  if (targetWallet) {
    assertConfiguredWallet(targetWallet, authToken);
    const credential = config.walletCredentials.find((item) => item.wallet === targetWallet);
    if (!credential) {
      const auth = walletAuth();
      if (auth?.publicKey === targetWallet && config.walletPrivateKey) {
        return config.walletPrivateKey;
      }
      throw new Error(missingHostedSignerMessage(targetWallet));
    }
    return credential.privateKey;
  }

  if (!config.walletPrivateKey) {
    throw new Error(
      "AIR_OTC_WALLET_PRIVATE_KEY or AIR_OTC_MCP_WALLETS_JSON is required for SDK workflow tools"
    );
  }
  return config.walletPrivateKey;
}

function canResolveHostedSdkSigner(requestedWallet?: string, authToken?: string): boolean {
  try {
    resolveSdkPrivateKey(requestedWallet, authToken);
    return true;
  } catch (error: any) {
    if (String(error?.message || error).startsWith("mcp_external_signer_required:")) {
      return false;
    }
    throw error;
  }
}

function normalSignerStatus(args: { wallet?: string; authToken?: string } = {}) {
  const auth = resolveTokenAuth(args.authToken);
  const inferredWallet = inferSingleTokenWallet(args.authToken);
  const requestedWallet = args.wallet || inferredWallet || null;
  if (requestedWallet) {
    requireValidWalletField(requestedWallet, "wallet");
    if (auth?.wallets && !auth.wallets.has(requestedWallet)) {
      throw new Error(`mcp_token_wallet_mismatch:${requestedWallet}`);
    }
  }

  const signers = configuredNormalSigners();
  const signer = requestedWallet ? signers.find((entry) => entry.wallet === requestedWallet) || null : null;
  const tokenWallets = auth?.wallets ? [...auth.wallets] : null;
  const signedWalletToken = auth?.source === "signed" && Boolean(requestedWallet && tokenWallets?.includes(requestedWallet));
  const allowlistedWallet = Boolean(requestedWallet && config.allowedWallets.has(requestedWallet));
  const canReadDeals = Boolean(auth?.scopes.has("deals:read"));
  const canWriteOffers = Boolean(auth?.scopes.has("offers:write"));
  const canReadProofs = Boolean(auth?.scopes.has("proofs:read"));
  const delegatedApiWritesAvailable = Boolean(
    requestedWallet &&
      config.mcpDelegationToken &&
      (signedWalletToken || allowlistedWallet || auth?.source === "operator" || auth?.source === "rule")
  );
  const delegatedOfferWritesReady = delegatedApiWritesAvailable && canWriteOffers;
  const delegatedTicketReadsReady = delegatedApiWritesAvailable && canReadDeals;
  const canSettleWithHostedSigner = Boolean(requestedWallet && signer);
  const hostedSettlementToolsReady = canSettleWithHostedSigner && canWriteOffers;
  const canPostOffer = delegatedOfferWritesReady || hostedSettlementToolsReady;
  const canAcceptOffer = delegatedOfferWritesReady || hostedSettlementToolsReady;
  const canSettleEscrow = hostedSettlementToolsReady;
  const canClaimRefund = hostedSettlementToolsReady;
  const settlementSignerConfigured = Boolean(signer);
  const next = (() => {
    if (!auth) {
      return "Provide a valid MCP token before checking or using this wallet.";
    }
    if (requestedWallet && !canWriteOffers) {
      return "This token can be inspected, but Normal Mode create/accept/settlement tools require offers:write scope.";
    }
    if (canSettleWithHostedSigner) {
      return "This wallet has a hosted signer. Full Normal Mode MCP settlement can run from the hosted service.";
    }
    if (requestedWallet) {
      return "This hosted MCP token can identify the wallet and may create/accept/list via delegated API, but full escrow settlement requires a local AIR OTC MCP/runtime configured with this wallet private key or a hosted AIR_OTC_MCP_WALLETS_JSON signer entry for this wallet.";
    }
    return "Pass wallet or use a wallet-bound MCP token to check a specific agent wallet.";
  })();

  return {
    environment: config.environment,
    requestedWallet,
    auth: auth
      ? {
          source: auth.source,
          scopes: [...auth.scopes].sort(),
          tokenWallets,
        }
      : null,
    hostedMcp: {
      walletAccessTokensEnabled: Boolean(config.mcpAccessTokenSecret),
      delegatedApiWritesEnabled: Boolean(config.mcpDelegationToken),
      configuredSignerCount: signers.length,
      configuredSignerWallets: signers.map(({ wallet, source, name }) => ({ wallet, source, name })),
    },
    normalMode: {
      profile: NORMAL_MODE_PROFILE,
      canPostOffer,
      canAcceptOffer,
      canSettleEscrow,
      canClaimRefund,
      canCreateOrAcceptWithHostedToken: canPostOffer && canAcceptOffer,
      canListOwnTickets: delegatedTicketReadsReady || (canSettleWithHostedSigner && canReadDeals),
      canSettleWithHostedSigner,
      settlementSignerConfigured,
      signerSource: signer?.source || null,
      signerName: signer?.name || null,
      browserTokenOnlyCanSettle: false,
      localRuntimeSignerSupported: true,
    },
    scopeReadiness: {
      offersWrite: canWriteOffers,
      dealsRead: canReadDeals,
      proofsRead: canReadProofs,
    },
    toolReadiness: {
      airotc_create_offer: canPostOffer,
      airotc_accept_offer: canAcceptOffer,
      airotc_create_normal_offer: canPostOffer,
      airotc_run_normal_seller_flow: canSettleEscrow,
      airotc_run_normal_buyer_flow: canSettleEscrow,
      airotc_claim_normal_timeout_refund: canClaimRefund,
      airotc_list_my_tickets: delegatedTicketReadsReady || (canSettleWithHostedSigner && canReadDeals),
      airotc_get_proof_bundle: canReadProofs,
    },
    next,
  };
}

function normalModeMcpCapabilitySummary() {
  const signers = configuredNormalSigners();
  return {
    profile: NORMAL_MODE_PROFILE,
    criticalPath: {
      escrowRoute: "STANDARD_ESCROW",
      payoutRoute: "DIRECT",
      advancedProvidersInvoked: false,
    },
    hostedSettlement: {
      configuredSignerCount: signers.length,
      configuredSignerWallets: signers.map(({ wallet, source, name }) => ({ wallet, source, name })),
      browserTokenOnlyCanSettle: false,
      localRuntimeSignerSupported: true,
    },
  };
}

async function createSdkClient(
  requestedWallet?: string,
  authToken?: string,
  options: SdkClientOptions = {}
) {
  const walletPrivateKey = resolveSdkPrivateKey(requestedWallet, authToken);
  const sdk = await loadSdk();
  return new sdk.AgentOTC({
    apiKey: usableApiKey(config.apiKey),
    walletPrivateKey,
    environment: config.environment,
    apiUrl: config.apiUrl,
    wsUrl: config.wsUrl,
    rpcUrl: config.rpcUrl,
    privateMode: options.privateMode ?? true,
    strictOpaquePerMode: options.strictOpaquePerMode ?? true,
    persistLocalState: options.persistLocalState ?? true,
  });
}

async function createNormalSdkClient(requestedWallet?: string, authToken?: string) {
  return await createSdkClient(requestedWallet, authToken, {
    privateMode: false,
    strictOpaquePerMode: false,
    persistLocalState: false,
  });
}

async function createNormalOfferViaDelegatedApi(args: Record<string, any>): Promise<any> {
  requireValidWalletField(args.wallet, "wallet");
  assertConfiguredWallet(args.wallet, args.authToken);
  const offerInput = normalModeOfferInput(args);
  const response = await httpJson(
    "/v1/offers",
    {
      method: "POST",
      body: JSON.stringify({
        publicKey: args.wallet,
        ...offerInput,
        ...NORMAL_MODE_PROFILE,
      }),
    },
    config.apiUrl,
    { delegatedWallet: args.wallet, accessToken: args.authToken }
  );
  const offer = response?.data || response;
  assertNormalModeOffer(offer);
  return offer;
}

function normalModeTimeoutMs(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("mcp_normal_timeout_invalid");
  }
  return Math.ceil(parsed);
}

function normalModeDelayMs(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("mcp_normal_delay_invalid");
  }
  return Math.ceil(parsed);
}

function decimalToRawAmount(value: number, decimals = 9): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("mcp_normal_decimal_invalid");
  }
  const [whole, fractional = ""] = String(value).split(".");
  if (fractional.length > decimals) {
    throw new Error(`mcp_normal_decimal_too_precise:${decimals}`);
  }
  const raw = `${whole}${fractional.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return raw || "0";
}

function numberFromDisplayOrRaw(args: Record<string, any>, field: "amount" | "price" | "collateral"): number {
  const display = args[field];
  if (display !== undefined) {
    const parsed = Number(display);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`mcp_normal_${field}_invalid`);
    }
    return parsed;
  }

  const raw = args[`${field}Raw`];
  if (typeof raw === "string" && /^\d+$/.test(raw) && BigInt(raw) > 0n) {
    return Number(raw) / 1_000_000_000;
  }

  throw new Error(`mcp_normal_${field}_or_${field}Raw_required`);
}

function normalModeOfferInput(args: Record<string, any>): NormalModeOfferInput {
  const asset = typeof args.asset === "string" && args.asset.trim() ? args.asset.trim().toUpperCase() : "SOL";
  const mode = args.mode || "sell";
  if (mode !== "sell") {
    throw new Error("mcp_normal_mode_only_supports_seller_posted_sell_offers");
  }

  const amount = numberFromDisplayOrRaw(args, "amount");
  const price = numberFromDisplayOrRaw(args, "price");
  const collateral = numberFromDisplayOrRaw(args, "collateral");
  const amountRaw = args.amountRaw ?? decimalToRawAmount(amount);
  const priceRaw = args.priceRaw ?? decimalToRawAmount(price);
  const collateralRaw = args.collateralRaw ?? decimalToRawAmount(collateral);

  for (const [field, value] of Object.entries({ amountRaw, priceRaw, collateralRaw })) {
    if (typeof value !== "string" || !/^\d+$/.test(value) || BigInt(value) <= 0n) {
      throw new Error(`mcp_normal_${field}_invalid`);
    }
  }

  return {
    asset,
    mode,
    amount,
    amountRaw,
    price,
    priceRaw,
    collateral,
    collateralRaw,
  };
}

function assertNormalModeOffer(offer: any): void {
  const actual = {
    executionProfile:
      offer?.executionProfile || (offer?.rollupMode === "NONE" ? NORMAL_MODE_PROFILE.executionProfile : null),
    privacyTier:
      offer?.privacyTier || (offer?.rollupMode === "NONE" ? NORMAL_MODE_PROFILE.privacyTier : null),
    settlementRail:
      offer?.settlementRail || (offer?.rollupMode === "NONE" ? NORMAL_MODE_PROFILE.settlementRail : null),
    confidentialComputeProvider:
      offer?.confidentialComputeProvider ||
      (offer?.rollupMode === "NONE" ? NORMAL_MODE_PROFILE.confidentialComputeProvider : null),
    rollupMode: offer?.rollupMode || null,
  };

  const mismatches = Object.entries(NORMAL_MODE_PROFILE)
    .filter(([key, expected]) => actual[key as keyof typeof actual] !== expected)
    .map(([key, expected]) => `${key}: expected ${expected}, got ${actual[key as keyof typeof actual]}`);

  if (mismatches.length > 0) {
    throw new Error(`mcp_offer_not_normal_mode:${mismatches.join("; ")}`);
  }
}

function recordNormalEvent(events: NormalModeEvent[], agent: string, event: string, data: unknown): void {
  events.push({
    at: new Date().toISOString(),
    agent,
    event,
    data,
  });
}

function normalizeNormalDealStatus(status: any): any {
  if (!status || typeof status !== "object") return status;
  const history = Array.isArray(status.history) ? status.history : [];
  const latestTransition = history[history.length - 1];
  const latestPhase = typeof latestTransition?.to === "string" ? latestTransition.to : null;
  if (!latestPhase || latestPhase === status.phase) return status;
  return {
    ...status,
    rawPhase: status.phase,
    phase: latestPhase,
  };
}

const NORMAL_PHASE_ORDER = [
  "created",
  "accepted",
  "negotiation",
  "escrow_created",
  "awaiting_deposits",
  "funded",
  "delivery",
  "awaiting_release",
  "completed",
  "settled",
  "refunded",
];

function normalPhaseRank(phase?: string | null): number {
  if (!phase) return -1;
  const normalized = String(phase).toLowerCase();
  const index = NORMAL_PHASE_ORDER.indexOf(normalized);
  return index >= 0 ? index : -1;
}

function normalPhaseAtOrAfter(phase: string | null | undefined, target: string): boolean {
  const currentRank = normalPhaseRank(phase);
  const targetRank = normalPhaseRank(target);
  return currentRank >= 0 && targetRank >= 0 && currentRank >= targetRank;
}

async function getAuthoritativeNormalDealStatus(ticketId?: string | null): Promise<any | null> {
  if (!ticketId) return null;
  const result = await bestEffort("middleman_status", () =>
    httpJson(`/v1/deals/${encodeURIComponent(ticketId)}/status`, {}, config.middlemanUrl)
  );
  return result.ok ? normalizeNormalDealStatus(result.data) : null;
}

function normalEscrowAddressFromStatus(status: any): string | null {
  return status?.escrowAddress || status?.escrow_pda || status?.deal?.escrow_pda || status?.data?.escrow_pda || null;
}

async function waitForNormalEscrowReady(
  deal: any,
  args: Record<string, any>,
  agent: string,
  events: NormalModeEvent[]
): Promise<any> {
  const timeoutMs = normalModeTimeoutMs(args.escrowReadyTimeoutMs ?? args.phaseTimeoutMs, 180_000);
  const pollIntervalMs = normalModeTimeoutMs(args.pollIntervalMs, 3_000);
  const deadline = Date.now() + timeoutMs;
  let lastStatus: any = null;
  let lastAuthoritative: any = null;

  recordNormalEvent(events, agent, "escrow_ready_wait_started", { ticketId: deal.id, timeoutMs });
  while (Date.now() < deadline) {
    lastStatus = await deal.refreshStatus().catch((error: any) => ({
      error: error?.message || String(error),
    }));
    const sdkEscrowAddress = normalEscrowAddressFromStatus(lastStatus);
    if (sdkEscrowAddress) {
      recordNormalEvent(events, agent, "escrow_ready", {
        ticketId: deal.id,
        escrowAddress: sdkEscrowAddress,
        source: "api_status",
      });
      return lastStatus;
    }

    lastAuthoritative = await getAuthoritativeNormalDealStatus(deal.id).catch((error: any) => ({
      error: error?.message || String(error),
    }));
    const authoritativeEscrowAddress = normalEscrowAddressFromStatus(lastAuthoritative);
    if (authoritativeEscrowAddress) {
      const refreshed = await deal.refreshStatus().catch(() => lastStatus);
      recordNormalEvent(events, agent, "escrow_ready", {
        ticketId: deal.id,
        escrowAddress: authoritativeEscrowAddress,
        source: "middleman_status",
      });
      return refreshed || lastAuthoritative;
    }

    const latestPhase = lastStatus?.phase || lastAuthoritative?.phase || null;
    if (["failed", "cancelled", "refunded"].includes(String(latestPhase || "").toLowerCase())) {
      throw new Error(`mcp_normal_escrow_not_ready_terminal_phase:${deal.id}:${latestPhase}`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `mcp_normal_escrow_pda_not_ready:${deal.id}:timeoutMs=${timeoutMs}:lastStatus=${JSON.stringify({
      phase: lastStatus?.phase || null,
      escrowAddress: normalEscrowAddressFromStatus(lastStatus),
      error: lastStatus?.error,
      authoritativePhase: lastAuthoritative?.phase || null,
      authoritativeEscrowAddress: normalEscrowAddressFromStatus(lastAuthoritative),
      authoritativeError: lastAuthoritative?.error,
    })}`
  );
}

function attachNormalEventLog(client: any, agent: string, events: NormalModeEvent[]): void {
  client.on("phase_changed", (update: any) => recordNormalEvent(events, agent, "phase_changed", update));
  client.on("deal_complete", (ticketId: string) => recordNormalEvent(events, agent, "deal_complete", { ticketId }));
  client.on("message", (message: any) => {
    const content = String(message?.content || "");
    recordNormalEvent(events, agent, "message", {
      ticketId: message?.ticketId || null,
      phase: message?.phase || null,
      content: content.length > 200 ? `${content.slice(0, 200)}...` : content,
    });
  });
}

async function safeRegisterNormalClient(client: any, agent: string, events: NormalModeEvent[]): Promise<void> {
  try {
    await client.register();
    recordNormalEvent(events, agent, "registered", { ok: true });
  } catch (error: any) {
    recordNormalEvent(events, agent, "registered", {
      ok: false,
      continuing: true,
      reason: error?.message || String(error),
    });
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function createNormalOfferWithClient(client: any, args: Record<string, any>): Promise<any> {
  const offer = await client.offers.normalSolEscrow(normalModeOfferInput(args));
  assertNormalModeOffer(offer);
  return offer;
}

function normalOfferFromTicket(ticket: any): any {
  const offer = ticket?.offer || {};
  const offerId = ticket?.offerId || offer.id;
  if (!offerId) {
    throw new Error("mcp_ticket_missing_offer_id");
  }

  const price = Number(offer.price);
  const collateral = Number(offer.collateral);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("mcp_ticket_missing_normal_price");
  }
  if (!Number.isFinite(collateral) || collateral <= 0) {
    throw new Error("mcp_ticket_missing_normal_collateral");
  }

  return {
    id: offerId,
    asset: offer.asset || "SOL",
    amount: offer.amount === null || offer.amount === undefined ? 0 : Number(offer.amount),
    amountRaw: offer.amountRaw || null,
    price,
    priceRaw: offer.priceRaw || null,
    collateral,
    collateralRaw: offer.collateralRaw || null,
    mode: offer.mode || offer.type || "sell",
    status: offer.status || "matched",
    privacyTier: offer.privacyTier || NORMAL_MODE_PROFILE.privacyTier,
    settlementRail: offer.settlementRail || NORMAL_MODE_PROFILE.settlementRail,
    confidentialComputeProvider: offer.confidentialComputeProvider || NORMAL_MODE_PROFILE.confidentialComputeProvider,
    executionProfile: offer.executionProfile || NORMAL_MODE_PROFILE.executionProfile,
    rollupMode: ticket.rollupMode || offer.rollupMode || NORMAL_MODE_PROFILE.rollupMode,
  };
}

async function runNormalSellerSettlement(
  seller: any,
  offer: any,
  args: Record<string, any>,
  events: NormalModeEvent[]
): Promise<any> {
  const phaseTimeoutMs = normalModeTimeoutMs(args.phaseTimeoutMs, 180_000);
  const matchTimeoutMs = normalModeTimeoutMs(args.matchTimeoutMs, phaseTimeoutMs);
  const pollIntervalMs = normalModeTimeoutMs(args.pollIntervalMs, 3_000);
  const settlementTimeoutMs = normalModeTimeoutMs(args.settlementTimeoutMs, phaseTimeoutMs);

  const deal = args.ticketId
    ? await seller.tickets.resume(args.ticketId)
    : await seller.offers.waitForMatch(offer.id, {
        timeoutMs: matchTimeoutMs,
        pollIntervalMs,
      });
  deal.on("phase_changed", (phase: string) => recordNormalEvent(events, "seller", "deal_phase_changed", { ticketId: deal.id, phase }));

  let status = await deal.refreshStatus().catch(() => null);
  let phase = status?.phase || null;
  recordNormalEvent(events, "seller", "resume_status", { ticketId: deal.id, phase });

  if (!normalPhaseAtOrAfter(phase, "escrow_created")) {
    await deal.sendMessage(
      args.sellerAgreementMessage ||
        `@middleman I agree to sell at ${offer.price} SOL. Collateral: ${offer.collateral} SOL each side.`
    );
    await deal.waitForPhase(["escrow_created", "awaiting_deposits"], {
      timeoutMs: phaseTimeoutMs,
      pollIntervalMs,
    });
    status = await deal.refreshStatus().catch(() => null);
    phase = status?.phase || phase;
  }

	  let sellerCollateralTx = "already-locked-or-not-required";
	  if (!normalPhaseAtOrAfter(phase, "funded")) {
	    status = await waitForNormalEscrowReady(deal, args, "seller", events);
	    phase = status?.phase || phase;
	    sellerCollateralTx = await deal.depositToEscrow(offer.collateral, "seller");
	    recordNormalEvent(events, "seller", "seller_collateral_locked", { ticketId: deal.id, tx: sellerCollateralTx });
	    status = await deal.refreshStatus().catch(() => null);
	    phase = status?.phase || phase;
  }

  if (!normalPhaseAtOrAfter(phase, "delivery")) {
    await deal.waitForPhase("delivery", { timeoutMs: phaseTimeoutMs, pollIntervalMs });
    status = await deal.refreshStatus().catch(() => null);
    phase = status?.phase || phase;
  }

  if (!normalPhaseAtOrAfter(phase, "awaiting_release")) {
    await deal.sendMessage(
      args.deliveryContent ||
        "@middleman Normal Mode seller delivery is complete. Buyer may release after verification."
    );
    status = await deal.refreshStatus().catch(() => null);
    phase = status?.phase || phase;
  }

  if (args.stopAfterDelivery) {
    const authoritativeStatus = await getAuthoritativeNormalDealStatus(deal.id);
    const mergedStatus = authoritativeStatus || status;
    return {
      success: true,
      ticketId: deal.id,
      sellerCollateralTx,
      finalPhase: mergedStatus?.phase || phase || "delivery",
      escrowAddress: mergedStatus?.escrow_pda || mergedStatus?.escrowAddress || null,
      stoppedBeforeRelease: true,
    };
  }

  if (!normalPhaseAtOrAfter(phase, "completed")) {
    await deal.waitForPhase(["completed", "settled"], {
      timeoutMs: settlementTimeoutMs,
      pollIntervalMs,
    });
  }

  const finalStatus = await deal.refreshStatus().catch(() => null);
  const authoritativeStatus = await getAuthoritativeNormalDealStatus(deal.id);
  const mergedStatus = authoritativeStatus || finalStatus;
  return {
    success: true,
    ticketId: deal.id,
    sellerCollateralTx,
    finalPhase: mergedStatus?.phase || "completed",
    escrowAddress: mergedStatus?.escrow_pda || mergedStatus?.escrowAddress || null,
  };
}

async function runNormalBuyerSettlement(
  buyer: any,
  offerId: string | undefined,
  args: Record<string, any>,
  events: NormalModeEvent[]
): Promise<any> {
  const phaseTimeoutMs = normalModeTimeoutMs(args.phaseTimeoutMs, 180_000);
  const pollIntervalMs = normalModeTimeoutMs(args.pollIntervalMs, 3_000);
  if (!args.ticketId && !offerId) {
    throw new Error("mcp_normal_offerId_or_ticketId_required");
  }
  const offer = args.ticketId
    ? normalOfferFromTicket(await assertNormalModeTicket(buyer, args.ticketId))
    : await buyer.offers.get(offerId as string);
  assertNormalModeOffer(offer);
  const maxPrice = args.maxPrice !== undefined ? Number(args.maxPrice) : Number(offer.price);
  const collateral = args.collateral !== undefined ? Number(args.collateral) : Number(offer.collateral);
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) throw new Error("mcp_normal_maxPrice_invalid");
  if (!Number.isFinite(collateral) || collateral <= 0) throw new Error("mcp_normal_collateral_invalid");

  const deal = args.ticketId
    ? await buyer.tickets.resume(args.ticketId)
    : await buyer.offers.accept(offer.id);
  recordNormalEvent(events, "buyer", "deal_created", { ticketId: deal.id, offerId: offer.id, resumed: !!args.ticketId });
  deal.on("phase_changed", (phase: string) => {
    recordNormalEvent(events, "buyer", "deal_phase_changed", { ticketId: deal.id, offerId: offer.id, phase });
  });

  let status = await deal.refreshStatus().catch(() => null);
  let phase = status?.phase || null;
  recordNormalEvent(events, "buyer", "resume_status", { ticketId: deal.id, phase });

  if (!normalPhaseAtOrAfter(phase, "escrow_created")) {
    await deal.sendMessage(
      `@middleman I agree to buy at ${maxPrice} SOL. Collateral: ${collateral} SOL each side.`
    );
    await deal.waitForPhase(["escrow_created", "awaiting_deposits"], {
      timeoutMs: phaseTimeoutMs,
      pollIntervalMs,
    });
    status = await deal.refreshStatus().catch(() => null);
    phase = status?.phase || phase;
    if (status?.escrowAddress) {
      recordNormalEvent(events, "buyer", "escrow_ready", { escrowAddress: status.escrowAddress });
    }
  }

	  let buyerCollateralTx = "already-locked-or-not-required";
	  if (!normalPhaseAtOrAfter(phase, "funded")) {
	    status = await waitForNormalEscrowReady(deal, args, "buyer", events);
	    phase = status?.phase || phase;
	    buyerCollateralTx = await deal.depositToEscrow(collateral, "buyer");
	    recordNormalEvent(events, "buyer", "buyer_collateral_locked", { ticketId: deal.id, tx: buyerCollateralTx });
	    status = await deal.refreshStatus().catch(() => null);
	    phase = status?.phase || phase;
  }

  if (!normalPhaseAtOrAfter(phase, "delivery")) {
    await deal.waitForPhase("delivery", { timeoutMs: phaseTimeoutMs, pollIntervalMs });
    status = await deal.refreshStatus().catch(() => null);
    phase = status?.phase || phase;
  }

  let buyerPaymentTx = "already-locked-or-not-required";
  if (!normalPhaseAtOrAfter(phase, "awaiting_release")) {
    buyerPaymentTx = await deal.depositToEscrow(maxPrice, "buyer");
    recordNormalEvent(events, "buyer", "buyer_payment_locked", { ticketId: deal.id, tx: buyerPaymentTx });
    status = await deal.refreshStatus().catch(() => null);
    phase = status?.phase || phase;
  }

  if (args.stopBeforeRelease) {
    const authoritativeStatus = await getAuthoritativeNormalDealStatus(deal.id);
    const mergedStatus = authoritativeStatus || status;
    return {
      success: true,
      offerId: offer.id,
      ticketId: deal.id,
      buyerCollateralTx,
      buyerPaymentTx,
      finalPhase: mergedStatus?.phase || phase || "awaiting_release",
      escrowAddress: mergedStatus?.escrow_pda || mergedStatus?.escrowAddress || null,
      stoppedBeforeRelease: true,
    };
  }

  if (!normalPhaseAtOrAfter(phase, "completed")) {
    await deal.confirmDelivery();
    await deal.waitForPhase(["completed", "settled"], {
      timeoutMs: phaseTimeoutMs,
      pollIntervalMs,
    });
  }

  const finalStatus = await deal.refreshStatus().catch(() => null);
  const authoritativeStatus = await getAuthoritativeNormalDealStatus(deal.id);
  const mergedStatus = authoritativeStatus || finalStatus;
  return {
    success: true,
    offerId: offer.id,
    ticketId: deal.id,
    buyerCollateralTx,
    buyerPaymentTx,
    finalPhase: mergedStatus?.phase || "completed",
    escrowAddress: mergedStatus?.escrow_pda || mergedStatus?.escrowAddress || null,
  };
}

async function assertNormalModeTicket(client: any, ticketId: string): Promise<any> {
  const ticket = await client.api.getTicket(ticketId);
  const rollupMode = ticket?.rollupMode ?? ticket?.rollup_mode;
  if (rollupMode !== "NONE") {
    throw new Error(`mcp_ticket_not_normal_mode:${rollupMode || "unknown"}`);
  }
  return ticket;
}

async function runNormalTimeoutRefund(
  client: any,
  args: Record<string, any>,
  events: NormalModeEvent[]
): Promise<any> {
  await assertNormalModeTicket(client, args.ticketId);
  const deal = client.getDeal(args.ticketId);
  const before = await deal.refreshStatus();
  if (before?.rollupMode && before.rollupMode !== "NONE") {
    throw new Error(`mcp_deal_not_normal_mode:${before.rollupMode}`);
  }
  recordNormalEvent(events, "refund", "refund_status_before", before);

  const refundTx = await deal.claimTimeoutRefund();
  recordNormalEvent(events, "refund", "timeout_refund_claimed", { ticketId: args.ticketId, tx: refundTx });

  const after = await deal.refreshStatus().catch(() => null);
  return {
    success: true,
    ticketId: args.ticketId,
    refundTx,
    finalPhase: after?.phase || "refunded",
    escrowAddress: after?.escrowAddress || before?.escrowAddress || null,
  };
}

function toolOutput(data: unknown) {
  return textResult(data);
}

function policyAdminHeaders(): Record<string, string> {
  if (!config.agentPolicyAdminToken) {
    throw new Error("AIR_OTC_AGENT_POLICY_ADMIN_TOKEN is required for policy administration tools");
  }
  return {
    "x-air-otc-admin-token": config.agentPolicyAdminToken,
    "x-air-otc-admin-actor": "mcp",
  };
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
    name: "airotc_normal_signer_status",
    title: "Normal Mode Signer Status",
    description:
      "Explain whether a wallet-bound MCP token can create/accept/list Normal Mode tickets and whether hosted MCP can actually sign escrow settlement transactions for that wallet.",
    scope: "deals:read",
    inputSchema: objectSchema({
      ...authSchema,
      wallet: { type: "string" },
    }),
    handler: async (args) => {
      requireScope(args, "deals:read");
      return toolOutput(normalSignerStatus(args));
    },
  },
  {
    name: "airotc_list_agent_policies",
    title: "List Agent Policies",
    description: "List stored AIR OTC agent policy versions. Requires policies:read scope.",
    scope: "policies:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      requireScope(args, "policies:read");
      requireValidWalletField(args.wallet, "wallet");
      return toolOutput(
        await httpJson(`/v1/agent-policies/${encodeURIComponent(args.wallet)}`, {
          headers: policyAdminHeaders(),
        })
      );
    },
  },
  {
    name: "airotc_create_agent_policy",
    title: "Create Agent Policy",
    description: "Create a new active AIR OTC agent policy. Requires policies:write scope.",
    scope: "policies:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        maxDealValueRaw: { type: "string" },
        allowedAssets: { type: "array", items: { type: "string" } },
        allowedCounterparties: { type: "array", items: { type: "string" } },
        allowedSettlementRails: {
          type: "array",
          items: { type: "string", enum: ["SOL_ESCROW", "UMBRA_WSOL", "CROSS_CHAIN_DWALLET"] },
        },
        approvedEscrowProgramIds: { type: "array", items: { type: "string" } },
        allowedActions: {
          type: "array",
          items: {
            type: "string",
            enum: ["OFFER_CREATE", "OFFER_ACCEPT", "FUNDING_SUBMIT", "RELEASE_APPROVAL", "DISPUTE_OPEN"],
          },
        },
        expiresAt: { type: "string", description: "Future ISO-8601 timestamp." },
        ikaDWalletPolicyPda: { type: "string" },
      },
      ["wallet", "expiresAt"]
    ),
    handler: async (args) => {
      requireScope(args, "policies:write");
      requireValidWalletField(args.wallet, "wallet");
      if (args.maxDealValueRaw !== undefined && !/^\d+$/.test(String(args.maxDealValueRaw))) {
        throw new Error("mcp_maxDealValueRaw_invalid");
      }
      return toolOutput(
        await httpJson(`/v1/agent-policies/${encodeURIComponent(args.wallet)}`, {
          method: "POST",
          headers: policyAdminHeaders(),
          body: JSON.stringify({
            maxDealValueRaw: args.maxDealValueRaw,
            allowedAssets: args.allowedAssets,
            allowedCounterparties: args.allowedCounterparties,
            allowedSettlementRails: args.allowedSettlementRails,
            approvedEscrowProgramIds: args.approvedEscrowProgramIds,
            allowedActions: args.allowedActions,
            expiresAt: args.expiresAt,
            ikaDWalletPolicyPda: args.ikaDWalletPolicyPda,
          }),
        })
      );
    },
  },
  {
    name: "airotc_revoke_agent_policy",
    title: "Revoke Agent Policy",
    description: "Revoke a stored AIR OTC agent policy version. Requires policies:write scope.",
    scope: "policies:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        policyId: { type: "string" },
        reason: { type: "string" },
      },
      ["wallet", "policyId"]
    ),
    handler: async (args) => {
      requireScope(args, "policies:write");
      requireValidWalletField(args.wallet, "wallet");
      return toolOutput(
        await httpJson(
          `/v1/agent-policies/${encodeURIComponent(args.wallet)}/${encodeURIComponent(args.policyId)}/revoke`,
          {
            method: "POST",
            headers: policyAdminHeaders(),
            body: JSON.stringify({ reason: args.reason }),
          }
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
    }),
    handler: async (args) => {
      requireScope(args, "offers:read");
      const query = new URLSearchParams();
      if (args.asset) query.set("asset", args.asset);
      if (args.mode) query.set("mode", args.mode);
      if (args.status) query.set("status", args.status);
      return toolOutput(await httpJson(`/v1/offers${query.size ? `?${query}` : ""}`));
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
        amountRaw: { type: "string" },
        price: { type: "number", exclusiveMinimum: 0 },
        priceRaw: { type: "string" },
        collateral: { type: "number", minimum: 0 },
        collateralRaw: { type: "string" },
        privacyTier: {
          type: "string",
          enum: ["PUBLIC_SOL", "SHIELDED_CREDIT", "UMBRA_WSOL", "UMBRA_WSOL_COMPLIANCE"],
          default: "SHIELDED_CREDIT",
        },
        settlementRail: {
          type: "string",
          enum: ["SOL_ESCROW", "UMBRA_WSOL", "CROSS_CHAIN_DWALLET"],
          default: "SOL_ESCROW",
        },
        confidentialComputeProvider: {
          type: "string",
          enum: ["NONE", "ARCIUM", "ENCRYPT"],
          default: "NONE",
        },
        executionProfile: { type: "string", enum: ["NORMAL_SOL_ESCROW"] },
        rollupMode: { type: "string", enum: ["ER", "PER", "NONE"], default: "PER" },
        settlementWallet: { type: "string" },
        rewardWallet: { type: "string" },
        fundingWallet: { type: "string" },
      },
      ["wallet", "asset", "mode"]
    ),
    handler: async (args) => {
      requireScope(args, "offers:write");
      assertConfiguredWallet(args.wallet, args.authToken);
      requireDisplayOrRawAmount(args, "amount");
      requireDisplayOrRawAmount(args, "price");
      requireDisplayOrRawAmount(args, "collateral");
      const normalMode = args.executionProfile === "NORMAL_SOL_ESCROW";
      const rollupMode = normalMode ? "NONE" : args.rollupMode || "PER";
      if (rollupMode === "PER") {
        requirePerMarketplaceWallets(args, "create");
      }
      return toolOutput(
        await httpJson("/v1/offers", {
          method: "POST",
          body: JSON.stringify({
            publicKey: args.wallet,
            asset: args.asset,
            mode: args.mode,
            amount: args.amount,
            amountRaw: args.amountRaw,
            price: args.price,
            priceRaw: args.priceRaw,
            collateral: args.collateral,
            collateralRaw: args.collateralRaw,
            privacyTier: normalMode ? "PUBLIC_SOL" : args.privacyTier,
            settlementRail: normalMode ? "SOL_ESCROW" : args.settlementRail,
            confidentialComputeProvider: normalMode ? "NONE" : args.confidentialComputeProvider,
            executionProfile: args.executionProfile,
            rollupMode,
            settlementWallet: args.settlementWallet,
            rewardWallet: args.rewardWallet,
            fundingWallet: args.fundingWallet,
          }),
        }, config.apiUrl, { delegatedWallet: args.wallet, accessToken: args.authToken })
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
      requireScope(args, "offers:write");
      assertConfiguredWallet(args.wallet, args.authToken);
      const offerResponse = await httpJson(`/v1/offers/${encodeURIComponent(args.offerId)}`);
      const offer = offerResponse?.data || offerResponse;
      if (offer?.rollupMode === "PER") {
        requirePerMarketplaceWallets(args, "accept");
        const privacy = offer?.privacy;
        if (privacy && privacy.perReady === false) {
          throw new Error(
            "mcp_offer_not_per_ready: maker must recreate this PER offer with settlementWallet, rewardWallet, and fundingWallet"
          );
        }
      }
      return toolOutput(
        await httpJson(`/v1/offers/${encodeURIComponent(args.offerId)}/accept`, {
          method: "POST",
          body: JSON.stringify({
            wallet: args.wallet,
            settlementWallet: args.settlementWallet,
            rewardWallet: args.rewardWallet,
            fundingWallet: args.fundingWallet,
          }),
        }, config.apiUrl, { delegatedWallet: args.wallet, accessToken: args.authToken })
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
      requireScope(args, "deals:read");
      const status = await bestEffort("middleman_status", () =>
        httpJson(`/v1/deals/${encodeURIComponent(args.ticketId)}/status`, {}, config.middlemanUrl)
      );
      if (status.ok) {
        status.data = normalizeNormalDealStatus(status.data);
      }
      return toolOutput(
        status
      );
    },
  },
  {
    name: "airotc_list_my_tickets",
    title: "List My Tickets",
    description:
      "List tickets where the authenticated wallet is buyer or seller. Use after reconnect/offline periods to resume accepted offers.",
    scope: "deals:read",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        status: { type: "string", default: "negotiating" },
        role: { type: "string", enum: ["buyer", "seller", "both"], default: "both" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      requireScope(args, "deals:read");
      requireValidWalletField(args.wallet, "wallet");
      assertConfiguredWallet(args.wallet, args.authToken);
      const query = new URLSearchParams();
      query.set("status", args.status || "negotiating");
      query.set("role", args.role || "both");
      query.set("limit", String(args.limit || 50));
      const response = await httpJson(
        `/v1/tickets/mine?${query}`,
        {},
        config.apiUrl,
        { delegatedWallet: args.wallet, accessToken: args.authToken }
      );
      return toolOutput({
        ...response,
        next: "For Normal Mode recovery, resume with airotc_run_normal_seller_flow or airotc_run_normal_buyer_flow using the listed ticketId. The offerId is still included for older offer-based flows.",
      });
    },
  },
  {
    name: "airotc_get_proof_bundle",
    title: "Get Proof Bundle",
    description: "Read an evidence bundle for a ticket from available local services.",
    scope: "proofs:read",
    inputSchema: objectSchema({ ...authSchema, ticketId: { type: "string" } }, ["ticketId"]),
    handler: async (args) => {
      requireScope(args, "proofs:read");
      const ticketId = encodeURIComponent(args.ticketId);
      return toolOutput({
        ticketId: args.ticketId,
        collectedAt: new Date().toISOString(),
        entries: [
          await bestEffort("deal_status", () => httpJson(`/v1/deals/${ticketId}/status`, {}, config.middlemanUrl)),
          await bestEffort("audit", () => httpJson(`/api/audit/${ticketId}`, {}, config.middlemanHealthUrl)),
          await bestEffort("timeline", () => httpJson(`/api/deals/${ticketId}/timeline`, {}, config.middlemanHealthUrl)),
          await bestEffort("authority_governance", () => httpJson("/api/governance/authority", {}, config.middlemanUrl)),
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
      requireScope(args, "vault:read");
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
      requireScope(args, "umbra:read");
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
    name: "airotc_create_normal_offer",
    title: "Create Normal Mode Offer",
    description:
      "Create a Normal Mode SOL escrow offer. Uses hosted signer when configured, otherwise uses wallet-bound delegated API for offer posting only. Forces PUBLIC_SOL + SOL_ESCROW + NONE + rollup NONE.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        asset: { type: "string", default: "SOL" },
        mode: { type: "string", enum: ["sell"], default: "sell" },
        amount: { type: "number", exclusiveMinimum: 0 },
        amountRaw: { type: "string" },
        price: { type: "number", exclusiveMinimum: 0 },
        priceRaw: { type: "string" },
        collateral: { type: "number", exclusiveMinimum: 0 },
        collateralRaw: { type: "string" },
      },
      ["wallet", "amount", "price", "collateral"]
    ),
    handler: async (args) => {
      requireScope(args, "offers:write");
      if (!canResolveHostedSdkSigner(args.wallet, args.authToken)) {
        const offer = await createNormalOfferViaDelegatedApi(args);
        return toolOutput({
          success: true,
          mode: "NORMAL_SOL_ESCROW",
          signerMode: "delegated_api_offer_only",
          offer,
          criticalPath: {
            escrowRoute: "STANDARD_ESCROW",
            payoutRoute: "DIRECT",
            advancedProvidersInvoked: false,
          },
          signerStatus: normalSignerStatus(args),
          next: "Offer is posted. Full settlement still requires the same wallet signer in a local AIR OTC MCP/runtime, or this wallet must be configured in hosted AIR_OTC_MCP_WALLETS_JSON.",
        });
      }
      const client = await createNormalSdkClient(args.wallet, args.authToken);
      const events: NormalModeEvent[] = [];
      attachNormalEventLog(client, "seller", events);
      try {
        await safeRegisterNormalClient(client, "seller", events);
        await client.connect();
        const offer = await createNormalOfferWithClient(client, args);
        return toolOutput({
          success: true,
          mode: "NORMAL_SOL_ESCROW",
          offer,
          criticalPath: {
            escrowRoute: "STANDARD_ESCROW",
            payoutRoute: "DIRECT",
            advancedProvidersInvoked: false,
          },
          next: "Run a seller flow for this offer and a buyer flow from the counterparty, or use airotc_run_normal_flow with two configured wallets.",
          events,
        });
      } finally {
        client.disconnect();
      }
    },
  },
  {
    name: "airotc_run_normal_seller_flow",
    title: "Run Normal Mode Seller Flow",
    description:
      "Create or resume a Normal Mode seller flow. Waits for a buyer, agrees, funds seller collateral, sends delivery, and waits for completion unless stopAfterDelivery is set for timeout/refund proofs.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        offerId: { type: "string" },
        ticketId: { type: "string" },
        postOnly: { type: "boolean", default: false },
        asset: { type: "string", default: "SOL" },
        mode: { type: "string", enum: ["sell"], default: "sell" },
        amount: { type: "number", exclusiveMinimum: 0 },
        amountRaw: { type: "string" },
        price: { type: "number", exclusiveMinimum: 0 },
        priceRaw: { type: "string" },
        collateral: { type: "number", exclusiveMinimum: 0 },
        collateralRaw: { type: "string" },
        sellerAgreementMessage: { type: "string" },
        deliveryContent: { type: "string" },
        stopAfterDelivery: { type: "boolean", default: false },
        matchTimeoutMs: { type: "integer", exclusiveMinimum: 0, default: 180000 },
        phaseTimeoutMs: { type: "integer", exclusiveMinimum: 0, default: 180000 },
        settlementTimeoutMs: { type: "integer", exclusiveMinimum: 0, default: 180000 },
        pollIntervalMs: { type: "integer", exclusiveMinimum: 0, default: 3000 },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      requireScope(args, "offers:write");
      if (args.postOnly && !canResolveHostedSdkSigner(args.wallet, args.authToken)) {
        const fetchedOffer = args.offerId
          ? await httpJson(`/v1/offers/${encodeURIComponent(args.offerId)}`)
          : null;
        const offer = args.offerId ? fetchedOffer?.data || fetchedOffer : await createNormalOfferViaDelegatedApi(args);
        assertNormalModeOffer(offer);
        return toolOutput({
          success: true,
          mode: "NORMAL_SOL_ESCROW",
          signerMode: "delegated_api_offer_only",
          offer,
          postOnly: true,
          criticalPath: {
            escrowRoute: "STANDARD_ESCROW",
            payoutRoute: "DIRECT",
            advancedProvidersInvoked: false,
          },
          signerStatus: normalSignerStatus(args),
          next: "Seller offer is available. To continue escrow settlement later, resume with a local signer runtime or configure this wallet as a hosted MCP signer.",
        });
      }
      const client = await createNormalSdkClient(args.wallet, args.authToken);
      const events: NormalModeEvent[] = [];
      attachNormalEventLog(client, "seller", events);
      try {
        await safeRegisterNormalClient(client, "seller", events);
        await client.connect();
        const offer = args.ticketId
          ? normalOfferFromTicket(await assertNormalModeTicket(client, args.ticketId))
          : args.offerId
            ? await client.offers.get(args.offerId)
            : await createNormalOfferWithClient(client, args);
        assertNormalModeOffer(offer);

        if (args.postOnly) {
          return toolOutput({
            success: true,
            mode: "NORMAL_SOL_ESCROW",
            offer,
            postOnly: true,
            criticalPath: {
              escrowRoute: "STANDARD_ESCROW",
              payoutRoute: "DIRECT",
              advancedProvidersInvoked: false,
            },
            events,
          });
        }

        const seller = await runNormalSellerSettlement(client, offer, args, events);
        return toolOutput({
          success: true,
          mode: "NORMAL_SOL_ESCROW",
          offerId: offer.id,
          ticketId: args.ticketId || undefined,
          seller,
          criticalPath: {
            escrowRoute: "STANDARD_ESCROW",
            payoutRoute: "DIRECT",
            advancedProvidersInvoked: false,
          },
          events,
        });
      } finally {
        client.disconnect();
      }
    },
  },
  {
    name: "airotc_run_normal_buyer_flow",
    title: "Run Normal Mode Buyer Flow",
    description:
      "Accept an existing Normal Mode offer and drive the buyer side through escrow, collateral, payment, release confirmation, and completion unless stopBeforeRelease is set for timeout/refund proofs.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        offerId: { type: "string" },
        ticketId: { type: "string" },
        maxPrice: { type: "number", exclusiveMinimum: 0 },
        collateral: { type: "number", exclusiveMinimum: 0 },
        stopBeforeRelease: { type: "boolean", default: false },
        phaseTimeoutMs: { type: "integer", exclusiveMinimum: 0, default: 180000 },
        pollIntervalMs: { type: "integer", exclusiveMinimum: 0, default: 3000 },
      },
      ["wallet"]
    ),
    handler: async (args) => {
      requireScope(args, "offers:write");
      const client = await createNormalSdkClient(args.wallet, args.authToken);
      const events: NormalModeEvent[] = [];
      attachNormalEventLog(client, "buyer", events);
      try {
        await safeRegisterNormalClient(client, "buyer", events);
        await client.connect();
        const buyer = await runNormalBuyerSettlement(client, args.offerId, args, events);
        return toolOutput({
          success: true,
          mode: "NORMAL_SOL_ESCROW",
          offerId: buyer.offerId,
          ticketId: buyer.ticketId,
          buyer,
          criticalPath: {
            escrowRoute: "STANDARD_ESCROW",
            payoutRoute: "DIRECT",
            advancedProvidersInvoked: false,
          },
          events,
        });
      } finally {
        client.disconnect();
      }
    },
  },
  {
    name: "airotc_run_normal_flow",
    title: "Run Full Normal Mode Flow",
    description:
      "Run a complete two-agent Normal Mode SOL escrow flow from MCP: seller creates offer, buyer accepts, both fund escrow, seller delivers, buyer releases.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        sellerWallet: { type: "string" },
        buyerWallet: { type: "string" },
        asset: { type: "string", default: "SOL" },
        mode: { type: "string", enum: ["sell"], default: "sell" },
        amount: { type: "number", exclusiveMinimum: 0 },
        amountRaw: { type: "string" },
        price: { type: "number", exclusiveMinimum: 0 },
        priceRaw: { type: "string" },
        collateral: { type: "number", exclusiveMinimum: 0 },
        collateralRaw: { type: "string" },
        sellerAgreementMessage: { type: "string" },
        deliveryContent: { type: "string" },
        joinDelayMs: { type: "integer", minimum: 0, default: 1500 },
        matchTimeoutMs: { type: "integer", exclusiveMinimum: 0, default: 180000 },
        phaseTimeoutMs: { type: "integer", exclusiveMinimum: 0, default: 180000 },
        settlementTimeoutMs: { type: "integer", exclusiveMinimum: 0, default: 180000 },
        pollIntervalMs: { type: "integer", exclusiveMinimum: 0, default: 3000 },
      },
      ["sellerWallet", "buyerWallet", "amount", "price", "collateral"]
    ),
    handler: async (args) => {
      requireScope(args, "offers:write");
      const sellerClient = await createNormalSdkClient(args.sellerWallet, args.authToken);
      const buyerClient = await createNormalSdkClient(args.buyerWallet, args.authToken);
      const events: NormalModeEvent[] = [];
      attachNormalEventLog(sellerClient, "seller", events);
      attachNormalEventLog(buyerClient, "buyer", events);

      let offer: any;
      try {
        await Promise.all([
          safeRegisterNormalClient(sellerClient, "seller", events),
          safeRegisterNormalClient(buyerClient, "buyer", events),
        ]);
        await Promise.all([sellerClient.connect(), buyerClient.connect()]);

        offer = await createNormalOfferWithClient(sellerClient, args);
        recordNormalEvent(events, "seller", "normal_offer_created", { offerId: offer.id });

        const sellerFlow = runNormalSellerSettlement(sellerClient, offer, args, events);
        const buyerFlow = (async () => {
          await sleep(normalModeDelayMs(args.joinDelayMs, 1_500));
          return await runNormalBuyerSettlement(buyerClient, offer.id, args, events);
        })();

        const [seller, buyer] = await Promise.all([sellerFlow, buyerFlow]);
        const ticketId = buyer.ticketId || seller.ticketId || null;
        const authoritativeStatus = await getAuthoritativeNormalDealStatus(ticketId);
        const finalPhase = authoritativeStatus?.phase || buyer.finalPhase || seller.finalPhase || null;
        const escrowAddress =
          authoritativeStatus?.escrow_pda ||
          buyer.escrowAddress ||
          seller.escrowAddress ||
          null;

        if (finalPhase) {
          seller.finalPhase = finalPhase;
          buyer.finalPhase = finalPhase;
        }
        if (escrowAddress) {
          seller.escrowAddress = escrowAddress;
          buyer.escrowAddress = escrowAddress;
        }

        return toolOutput({
          success: true,
          mode: "NORMAL_SOL_ESCROW",
          offerId: offer.id,
          ticketId,
          finalPhase,
          authoritativeStatus,
          seller,
          buyer,
          criticalPath: {
            escrowRoute: "STANDARD_ESCROW",
            payoutRoute: "DIRECT",
            advancedProvidersInvoked: false,
          },
          events,
        });
      } finally {
        buyerClient.disconnect();
        sellerClient.disconnect();
      }
    },
  },
  {
    name: "airotc_claim_normal_timeout_refund",
    title: "Claim Normal Mode Timeout Refund",
    description:
      "Claim a timeout refund for a Normal Mode SOL escrow deal using a configured MCP signing wallet. Fails closed for PER or non-Normal tickets.",
    scope: "offers:write",
    inputSchema: objectSchema(
      {
        ...authSchema,
        wallet: { type: "string" },
        ticketId: { type: "string" },
      },
      ["wallet", "ticketId"]
    ),
    handler: async (args) => {
      requireScope(args, "offers:write");
      const client = await createNormalSdkClient(args.wallet, args.authToken);
      const events: NormalModeEvent[] = [];
      attachNormalEventLog(client, "refund", events);
      try {
        await client.connect();
        const refund = await runNormalTimeoutRefund(client, args, events);
        return toolOutput({
          success: true,
          mode: "NORMAL_SOL_ESCROW",
          refund,
          criticalPath: {
            escrowRoute: "STANDARD_ESCROW",
            payoutRoute: "DIRECT",
            advancedProvidersInvoked: false,
          },
          events,
        });
      } finally {
        client.disconnect();
      }
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
        wallet: { type: "string" },
        offerId: { type: "string" },
        terms: { type: "object", additionalProperties: true },
        timeoutMs: { type: "integer", exclusiveMinimum: 0, default: 180000 },
      },
      ["offerId", "terms"]
    ),
    handler: async (args) => {
      requireScope(args, "per:run");
      const client = await createSdkClient(args.wallet, args.authToken);
      try {
        return toolOutput(
          await client.workflows.quickBuyPer({
            offerId: args.offerId,
            terms: args.terms,
            timeoutMs: args.timeoutMs || 180000,
          })
        );
      } finally {
        client.disconnect();
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
        wallet: { type: "string" },
        offer: { type: "object", additionalProperties: true },
        terms: { type: "object", additionalProperties: true },
        deliveryContent: { type: "string" },
        timeoutMs: { type: "integer", exclusiveMinimum: 0, default: 180000 },
      },
      ["offer", "terms", "deliveryContent"]
    ),
    handler: async (args) => {
      requireScope(args, "per:run");
      const client = await createSdkClient(args.wallet, args.authToken);
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
        client.disconnect();
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

async function callTool(params: any) {
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
  return await tool.handler(parsed.arguments || {});
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

async function dispatch(method: string, params: any): Promise<any> {
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
      return await callTool(params);
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

async function handleJsonRpc(request: JsonRpcRequest): Promise<any | null> {
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
      result: await dispatch(request.method, request.params),
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

async function startHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/mcp", async (req, res) => {
    if (Array.isArray(req.body)) {
      const responses = (await Promise.all(req.body.map((entry) => handleJsonRpc(entry)))).filter(Boolean);
      if (responses.length === 0) {
        res.status(202).end();
        return;
      }
      res.json(responses);
      return;
    }
    const response = await handleJsonRpc(req.body);
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
        allowlisted: config.allowedWallets.size,
        maxActiveSeats: Number(process.env.AIR_OTC_MCP_MAX_ACTIVE_SEATS || 0) || null,
      },
      auth: {
        enabled: Boolean(config.mcpToken) || config.tokenRules.length > 0 || Boolean(config.mcpAccessTokenSecret),
        tokenCount: (config.mcpToken ? 1 : 0) + config.tokenRules.length,
        walletAccessTokens: Boolean(config.mcpAccessTokenSecret),
      },
      normalMode: normalModeMcpCapabilitySummary(),
      tools: tools.map((tool) => tool.name),
      resources: [
        ...staticResources.map((resource) => resource.uri),
        ...resourceTemplates.map((resource) => resource.uriTemplate),
      ],
    });
  });
  const port = Number(process.env.AIR_OTC_MCP_PORT || process.env.PORT || 8787);
  app.listen(port, () => {
    console.error(`AIR OTC MCP HTTP listening on http://localhost:${port}/mcp`);
  });
}

if (process.argv.includes("--http")) {
  await startHttp();
} else {
  await startStdio();
}
