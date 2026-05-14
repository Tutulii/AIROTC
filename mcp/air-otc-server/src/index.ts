#!/usr/bin/env node
import express from "express";
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
  | "per:run"
  | "proofs:read"
  | "vault:read"
  | "umbra:read";

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
};

const validScopes = new Set<Scope>([
  "offers:read",
  "offers:write",
  "deals:read",
  "per:run",
  "proofs:read",
  "vault:read",
  "umbra:read",
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
  sdkPath:
    process.env.AIR_OTC_TS_SDK_PATH ||
    path.resolve(__dirname, "../../../sdk/ts/dist/index.mjs"),
  mcpToken: process.env.AIR_OTC_MCP_TOKEN || "",
  mcpDelegationToken: process.env.AIR_OTC_MCP_DELEGATION_TOKEN || "",
  allowedWallets: new Set(
    (process.env.AIR_OTC_MCP_ALLOWED_WALLETS || "")
      .split(",")
      .map((wallet) => wallet.trim())
      .filter(Boolean)
  ),
  scopes: defaultScopes,
  tokenRules: parseTokenRules(defaultScopes),
  walletPrivateKey: process.env.AIR_OTC_WALLET_PRIVATE_KEY || "",
  apiKey: process.env.AIR_OTC_API_KEY || "",
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

function isValidSolanaWallet(wallet: string): boolean {
  try {
    return bs58.decode(wallet).length === 32;
  } catch {
    return false;
  }
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
  if (config.allowedWallets.size > 0) {
    assertDelegatedWalletAllowed(requestedWallet);
    const auth = resolveTokenAuth(authToken);
    if (auth?.wallets && !auth.wallets.has(requestedWallet)) {
      throw new Error(`mcp_token_wallet_mismatch:${requestedWallet}`);
    }
    return;
  }
  const auth = walletAuth();
  if (auth && requestedWallet && requestedWallet !== auth.publicKey) {
    throw new Error(`mcp_wallet_mismatch:configured=${auth.publicKey}:requested=${requestedWallet}`);
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

function resolveTokenAuth(authToken?: string): TokenAuth | null {
  const hasAnyToken = Boolean(config.mcpToken) || config.tokenRules.length > 0;
  if (!hasAnyToken) return { scopes: config.scopes, wallets: null };
  if (!authToken) return null;
  if (config.mcpToken && authToken === config.mcpToken) return { scopes: config.scopes, wallets: null };
  const rule = config.tokenRules.find((candidate) => candidate.token === authToken);
  return rule ? { scopes: rule.scopes, wallets: rule.wallets } : null;
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
  options: { delegatedWallet?: string } = {}
): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (options.delegatedWallet && baseUrl === config.apiUrl) {
    assertDelegatedWalletAllowed(options.delegatedWallet);
    headers.set("x-airotc-mcp-delegation-token", config.mcpDelegationToken);
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
        price: { type: "number", exclusiveMinimum: 0 },
        collateral: { type: "number", minimum: 0 },
        rollupMode: { type: "string", enum: ["ER", "PER", "NONE"], default: "PER" },
        settlementWallet: { type: "string" },
        rewardWallet: { type: "string" },
        fundingWallet: { type: "string" },
      },
      ["wallet", "asset", "mode", "amount", "price", "collateral"]
    ),
    handler: async (args) => {
      requireScope(args, "offers:write");
      assertConfiguredWallet(args.wallet, args.authToken);
      return toolOutput(
        await httpJson("/v1/offers", {
          method: "POST",
          body: JSON.stringify({
            publicKey: args.wallet,
            asset: args.asset,
            mode: args.mode,
            amount: args.amount,
            price: args.price,
            collateral: args.collateral,
            rollupMode: args.rollupMode || "PER",
            settlementWallet: args.settlementWallet,
            rewardWallet: args.rewardWallet,
            fundingWallet: args.fundingWallet,
          }),
        }, config.apiUrl, { delegatedWallet: args.wallet })
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
      return toolOutput(
        await httpJson(`/v1/offers/${encodeURIComponent(args.offerId)}/accept`, {
          method: "POST",
          body: JSON.stringify({
            wallet: args.wallet,
            settlementWallet: args.settlementWallet,
            rewardWallet: args.rewardWallet,
            fundingWallet: args.fundingWallet,
          }),
        }, config.apiUrl, { delegatedWallet: args.wallet })
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
      requireScope(args, "proofs:read");
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
      requireScope(args, "per:run");
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
      requireScope(args, "per:run");
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
    console.error(`AIR OTC MCP HTTP listening on http://localhost:${port}/mcp`);
  });
}

if (process.argv.includes("--http")) {
  await startHttp();
} else {
  await startStdio();
}
