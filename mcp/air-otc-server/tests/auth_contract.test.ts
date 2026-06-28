import assert from "node:assert/strict";

process.env.AIR_OTC_MCP_NO_AUTOSTART = "1";

const { __test } = await import("../src/index.ts");

const expectedScopes = new Map<string, string | undefined>([
  ["airotc_create_offer", "offers:write"],
  ["airotc_accept_offer", "offers:write"],
  ["airotc_list_offers", "offers:read"],
  ["airotc_list_wallet_tickets", "deals:read"],
  ["airotc_get_ticket_messages", "deals:read"],
  ["airotc_send_ticket_message", "offers:write"],
  ["airotc_get_deal_status", "deals:read"],
  ["airotc_get_proof_bundle", "proofs:read"],
  ["airotc_umbra_lifecycle_status", "umbra:read"],
  ["airotc_vault_status", "vault:read"],
  ["airotc_health", undefined],
  ["airotc_send_dm", "dm:write"],
  ["airotc_list_dm_inbox", "dm:read"],
  ["airotc_get_dm_conversation", "dm:read"],
  ["airotc_get_dm_unread", "dm:read"],
  ["airotc_get_deal_dms", "dm:read"],
  ["airotc_mark_dm_read", "dm:write"],
  ["airotc_run_per_buyer_flow", "per:run"],
  ["airotc_run_per_seller_flow", "per:run"],
]);

assert.equal(__test.tools.length, 19, "MCP must expose exactly 19 tools");
for (const [name, scope] of expectedScopes) {
  const tool = __test.tools.find((candidate: any) => candidate.name === name);
  assert.ok(tool, `missing MCP tool ${name}`);
  assert.equal(tool.scope, scope, `${name} scope mismatch`);
}

assert.ok(
  __test.staticResources.some((resource: any) => resource.uri === "airotc://vault/status"),
  "vault status resource must be exposed"
);

assert.equal(
  __test.extractHttpAuthToken({
    headers: {
      authorization: "Bearer header-token",
      "x-airotc-mcp-token": "body-token",
    },
  } as any),
  "header-token",
  "Authorization header must win over fallback headers"
);

assert.equal(
  __test.mergeRequestAuth({ authToken: "truncated-body-token" }, { authToken: "header-token" }).authToken,
  "header-token",
  "HTTP header token must override truncated body authToken"
);

const sendDmTool = __test.tools.find((candidate: any) => candidate.name === "airotc_send_dm");
assert.deepEqual(
  sendDmTool.inputSchema.required,
  ["toWallet", "content"],
  "wallet-bound MCP tokens must be able to infer the sender wallet for send_dm"
);

assert.equal(
  await __test.delegatedWalletFromArgs(
    {},
    {
      scopes: new Set(["dm:write"]),
      wallets: new Set(["EdUWKpttdUtWWiUpWzDasouXPvZzpuMpjytteHEzuk9Y"]),
      tokenFormat: "airotc_sk",
    }
  ),
  "EdUWKpttdUtWWiUpWzDasouXPvZzpuMpjytteHEzuk9Y",
  "wallet-bound tokens should infer the delegated wallet when wallet arg is omitted"
);

const fullScopes = __test.parseScopes(
  "offers:read,offers:write,deals:read,dm:read,dm:write,per:run,proofs:read,vault:read,umbra:read",
  new Set()
);
assert.equal(fullScopes.size, 9, "full trade-agent scope set must include all 9 scopes");
