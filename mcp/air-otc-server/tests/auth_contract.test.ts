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
  ["airotc_mark_dm_conversation_read", "dm:write"],
  ["airotc_delete_dm", "dm:write"],
  ["airotc_publish_dm_encryption_key", "dm:write"],
  ["airotc_get_dm_encryption_key", "dm:read"],
  ["airotc_get_dm_file_info", "dm:read"],
  ["airotc_run_per_buyer_flow", "per:run"],
  ["airotc_run_per_seller_flow", "per:run"],
  ["airotc_list_events", undefined],
  ["airotc_get_live_config", undefined],
  ["airotc_get_agent_events", "deals:read"],
  ["airotc_ack_agent_event", "deals:read"],
  ["airotc_ack_agent_events", "deals:read"],
]);

assert.equal(__test.tools.length, 29, "MCP must expose exactly 29 tools");
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
  "hosted MCP tokens must be able to infer the default sender wallet for send_dm"
);

assert.equal(
  await __test.delegatedWalletFromArgs(
    {},
    {
      scopes: new Set(["dm:write"]),
      wallets: null,
      defaultWallet: "EdUWKpttdUtWWiUpWzDasouXPvZzpuMpjytteHEzuk9Y",
      tokenFormat: "airotc_sk",
    }
  ),
  "EdUWKpttdUtWWiUpWzDasouXPvZzpuMpjytteHEzuk9Y",
  "hosted tokens should infer their issuer wallet only when wallet arg is omitted"
);

assert.equal(
  await __test.delegatedWalletFromArgs(
    { wallet: "9nqd6aAWQ7DK3fj9fDpk6saaZS5yfXwJ86jgnz7Nbv9F" },
    {
      scopes: new Set(["offers:write"]),
      wallets: null,
      defaultWallet: "EdUWKpttdUtWWiUpWzDasouXPvZzpuMpjytteHEzuk9Y",
      tokenFormat: "airotc_sk",
    }
  ),
  "9nqd6aAWQ7DK3fj9fDpk6saaZS5yfXwJ86jgnz7Nbv9F",
  "hosted tokens must allow an explicit delegated wallet different from the issuer wallet"
);

const fullScopes = __test.parseScopes(
  "offers:read,offers:write,deals:read,dm:read,dm:write,per:run,proofs:read,vault:read,umbra:read",
  new Set()
);
assert.equal(fullScopes.size, 9, "full trade-agent scope set must include all 9 scopes");

const liveConfigTool = __test.tools.find((candidate: any) => candidate.name === "airotc_get_live_config");
const liveConfig = JSON.parse((await liveConfigTool.handler({})).content[0].text);
assert.equal(liveConfig.websocket.path, "/socket.io/", "live config must point agents at API Socket.IO");
assert.ok(liveConfig.eventNames.includes("dm.received"), "live config must expose canonical dot event names");
