import assert from "node:assert/strict";

process.env.AIR_OTC_MCP_NO_AUTOSTART = "1";

const { __test } = await import("../src/index.ts");

const expectedScopes = new Map<string, string | undefined>([
  ["airotc_create_offer", "offers:write"],
  ["airotc_accept_offer", "offers:write"],
  ["airotc_list_offers", "offers:read"],
  ["airotc_sport_list_matches", "offers:read"],
  ["airotc_sport_get_fixture", "offers:read"],
  ["airotc_sport_create_offer", "offers:write"],
  ["airotc_sport_accept_offer", "offers:write"],
  ["airotc_sport_get_settlement_status", "deals:read"],
  ["airotc_sport_ingestion_status", "deals:read"],
  ["airotc_sport_start_ingestion", "offers:write"],
  ["airotc_sport_stop_ingestion", "offers:write"],
  ["airotc_sport_run_settlement_once", "offers:write"],
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
  ["airotc_register_notification_channel", "deals:read"],
  ["airotc_list_notification_channels", "deals:read"],
  ["airotc_delete_notification_channel", "deals:read"],
  ["airotc_test_notification_channel", "deals:read"],
]);

assert.equal(__test.tools.length, 42, "MCP must expose exactly 42 tools");
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

const createOfferTool = __test.tools.find((candidate: any) => candidate.name === "airotc_create_offer");
assert.ok(
  createOfferTool.inputSchema.properties.rollupMode.enum.includes("SPORT"),
  "create_offer must expose SPORT rollup mode"
);
assert.ok(
  createOfferTool.inputSchema.properties.fixtureId,
  "create_offer must accept fixtureId for SPORT offers"
);
assert.ok(
  createOfferTool.inputSchema.properties.selection,
  "create_offer must accept selection for SPORT offers"
);

const sportListTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_list_matches");
assert.deepEqual(
  sportListTool.inputSchema.properties.status.enum,
  ["all", "live", "upcoming", "final"],
  "sport_list_matches must expose match status filters"
);

const sportFixtureTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_get_fixture");
assert.deepEqual(
  sportFixtureTool.inputSchema.required,
  ["fixtureId"],
  "sport_get_fixture must require fixtureId"
);

const sportCreateTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_create_offer");
assert.deepEqual(
  sportCreateTool.inputSchema.required,
  ["wallet", "fixtureId", "marketType", "selection", "mode", "amount", "price", "collateral"],
  "sport_create_offer must require SPORT fixture and market terms"
);

const sportSettlementTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_get_settlement_status");
assert.deepEqual(
  sportSettlementTool.inputSchema.required,
  ["ticketId"],
  "sport_get_settlement_status must be ticket based"
);

const sportIngestionStatusTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_ingestion_status");
assert.ok(
  sportIngestionStatusTool.inputSchema.properties.authToken,
  "sport_ingestion_status must accept normal MCP auth"
);

const sportRunSettlementTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_run_settlement_once");
assert.equal(
  sportRunSettlementTool.inputSchema.properties.refreshOutcomes.default,
  true,
  "sport_run_settlement_once must refresh outcomes by default"
);
assert.equal(
  sportRunSettlementTool.inputSchema.properties.liveSync.default,
  true,
  "sport_run_settlement_once must allow live sync by default"
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
assert.equal(
  liveConfig.notificationChannels.registerTool,
  "airotc_register_notification_channel",
  "live config must expose notification registration tool"
);
assert.ok(
  liveConfig.notificationChannels.supportedEvents.includes("deal.expiring"),
  "live config must expose Telegram wake-up event names"
);
