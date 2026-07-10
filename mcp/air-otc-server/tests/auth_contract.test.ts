import assert from "node:assert/strict";
import bs58 from "bs58";
import nacl from "tweetnacl";

process.env.AIR_OTC_MCP_NO_AUTOSTART = "1";

const { __test } = await import("../src/index.ts");

const expectedScopes = new Map<string, string | undefined>([
  ["airotc_create_offer", "offers:write"],
  ["airotc_accept_offer", "offers:write"],
  ["airotc_list_offers", "offers:read"],
  ["airotc_get_reputation", "offers:read"],
  ["airotc_compare_reputations", "offers:read"],
  ["airotc_get_reputation_leaderboard", "offers:read"],
  ["airotc_sport_list_matches", "offers:read"],
  ["airotc_sport_get_fixture", "offers:read"],
  ["airotc_sport_get_fixture_summary", "offers:read"],
  ["airotc_sport_get_result", "offers:read"],
  ["airotc_sport_create_offer", "offers:write"],
  ["airotc_sport_accept_offer", "offers:write"],
  ["airotc_sport_create_position", "offers:write"],
  ["airotc_sport_create_and_fund_position", "offers:write"],
  ["airotc_sport_post_position", "offers:write"],
  ["airotc_sport_accept_position", "offers:write"],
  ["airotc_sport_counter_position", "offers:write"],
  ["airotc_sport_counter_offer", "offers:write"],
  ["airotc_sport_confirm_position_funding", "offers:write"],
  ["airotc_sport_register_funding_session", "offers:write"],
  ["airotc_sport_funding_session_status", "offers:write"],
  ["airotc_sport_clear_funding_session", "offers:write"],
  ["airotc_sport_execute_funding", "offers:write"],
  ["airotc_sport_cancel_position", "offers:write"],
  ["airotc_sport_get_position", "offers:read"],
  ["airotc_sport_get_position_fills", "offers:read"],
  ["airotc_sport_list_positions", "offers:read"],
  ["airotc_sport_view_positions", "offers:read"],
  ["airotc_sport_my_positions", "offers:read"],
  ["airotc_sport_my_fills", "offers:read"],
  ["airotc_sport_my_tickets", "deals:read"],
  ["airotc_sport_get_settlement_status", "deals:read"],
  ["airotc_sport_get_my_history", "deals:read"],
  ["airotc_sport_discover_agents", "offers:read"],
  ["airotc_sport_create_intent", "offers:write"],
  ["airotc_sport_list_intents", "offers:read"],
  ["airotc_sport_list_my_intents", "offers:read"],
  ["airotc_sport_cancel_intent", "offers:write"],
  ["airotc_sport_find_matching_liquidity", "offers:read"],
  ["airotc_sport_get_event_guide", undefined],
  ["airotc_sport_list_strategy_templates", "offers:read"],
  ["airotc_sport_list_strategy_presets", "offers:read"],
  ["airotc_sport_save_strategy_template", "offers:write"],
  ["airotc_sport_delete_strategy_template", "offers:write"],
  ["airotc_sport_create_offer_from_template", "offers:write"],
  ["airotc_sport_create_position_from_preset", "offers:write"],
  ["airotc_sport_settlement_automation_status", "deals:read"],
  ["airotc_sport_ingestion_status", "deals:read"],
  ["airotc_sport_start_ingestion", "sport:admin"],
  ["airotc_sport_stop_ingestion", "sport:admin"],
  ["airotc_sport_run_settlement_once", "sport:admin"],
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

assert.equal(__test.tools.length, expectedScopes.size, "MCP must expose exactly the expected tool set");
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
assert.equal(
  __test.sportStatusBucket({
    status: "upcoming",
    startsAt: "2026-07-04T17:00:00.000Z",
    raw: {
      GameState: 1,
      latestScoreState: {
        status: "live",
        action: "update",
        clock: { Running: true, Seconds: 3420 },
        homeScore: 1,
        awayScore: 0,
      },
    },
  }),
  "live",
  "sport_list_matches must classify stale GameState 1 fixtures as live when score evidence is live"
);
assert.equal(
  __test.sportStatusBucket({
    status: "upcoming",
    raw: {
      GameState: "scheduled",
      latestScoreState: {
        status: "final",
        action: "game_finalised",
        homeScore: 0,
        awayScore: 3,
      },
    },
  }),
  "final",
  "sport_list_matches must classify stale scheduled fixtures as final when score evidence is final"
);

const reputationTool = __test.tools.find((candidate: any) => candidate.name === "airotc_get_reputation");
assert.deepEqual(
  reputationTool.inputSchema.required,
  ["wallet"],
  "get_reputation must require a target wallet"
);
assert.equal(
  reputationTool.inputSchema.properties.includeHistory.default,
  true,
  "get_reputation should include reputation history by default"
);

const compareReputationTool = __test.tools.find((candidate: any) => candidate.name === "airotc_compare_reputations");
assert.deepEqual(
  compareReputationTool.inputSchema.required,
  ["wallets"],
  "compare_reputations must require wallet array"
);
assert.equal(
  compareReputationTool.inputSchema.properties.wallets.maxItems,
  25,
  "compare_reputations must cap batch size"
);

const reputationLeaderboardTool = __test.tools.find((candidate: any) => candidate.name === "airotc_get_reputation_leaderboard");
assert.equal(
  reputationLeaderboardTool.inputSchema.properties.limit.maximum,
  25,
  "reputation leaderboard must cap page size"
);

const sportFixtureTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_get_fixture");
assert.deepEqual(
  sportFixtureTool.inputSchema.required,
  ["fixtureId"],
  "sport_get_fixture must require fixtureId"
);

const sportFixtureSummaryTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_get_fixture_summary");
assert.deepEqual(
  sportFixtureSummaryTool.inputSchema.required,
  ["fixtureId"],
  "sport_get_fixture_summary must require fixtureId"
);

const sportResultTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_get_result");
assert.deepEqual(
  sportResultTool.inputSchema.required,
  ["fixtureId"],
  "sport_get_result must require fixtureId"
);

const sportCreateTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_create_offer");
assert.deepEqual(
  sportCreateTool.inputSchema.required,
  ["wallet", "fixtureId", "marketType", "selection", "mode", "amount", "price"],
  "sport_create_offer must require SPORT fixture, market terms, and stake but no separate collateral"
);

const sportPostPositionTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_post_position");
assert.deepEqual(
  sportPostPositionTool.inputSchema.required,
  ["wallet", "fixtureId", "selection", "stakeSol"],
  "sport_post_position must expose the simplified position input"
);
assert.deepEqual(
  sportPostPositionTool.inputSchema.properties.side.enum,
  ["back", "lay"],
  "sport_post_position must expose back/lay sides"
);

const sportCreatePositionTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_create_position");
assert.deepEqual(
  sportCreatePositionTool.inputSchema.required,
  ["wallet", "fixtureId", "selection", "stakeSol"],
  "sport_create_position must expose the prefunded position input"
);

const sportCreateAndFundPositionTool = __test.tools.find(
  (candidate: any) => candidate.name === "airotc_sport_create_and_fund_position"
);
assert.deepEqual(
  sportCreateAndFundPositionTool.inputSchema.required,
  ["wallet", "fixtureId", "selection", "stakeSol"],
  "sport_create_and_fund_position must expose one-click SPORT input"
);
assert.ok(
  sportCreateAndFundPositionTool.inputSchema.properties.walletKeypair.description.includes("registered encrypted funding session"),
  "sport_create_and_fund_position should document session-backed funding"
);

const sportAcceptPositionTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_accept_position");
assert.deepEqual(
  sportAcceptPositionTool.inputSchema.required,
  ["wallet", "positionId"],
  "sport_accept_position must require a wallet and position id"
);
assert.equal(
  sportAcceptPositionTool.inputSchema.properties.stakeSol.exclusiveMinimum,
  0,
  "sport_accept_position must allow optional partial/larger stake"
);

const sportCounterPositionTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_counter_position");
assert.deepEqual(
  sportCounterPositionTool.inputSchema.required,
  ["wallet", "positionId"],
  "sport_counter_position must require a wallet and position id"
);
assert.equal(
  sportCounterPositionTool.inputSchema.properties.stakeSol.exclusiveMinimum,
  0,
  "sport_counter_position must allow optional adjusted stake"
);

const sportCounterOfferTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_counter_offer");
assert.deepEqual(
  sportCounterOfferTool.inputSchema.required,
  ["wallet", "positionId"],
  "sport_counter_offer must require a wallet and position id"
);
assert.equal(
  sportCounterOfferTool.inputSchema.properties.sendDm.default,
  true,
  "sport_counter_offer must DM the maker by default"
);

const sportConfirmFundingTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_confirm_position_funding");
assert.deepEqual(
  sportConfirmFundingTool.inputSchema.required,
  ["wallet", "positionId"],
  "sport_confirm_position_funding must require wallet and position id"
);

const sportRegisterFundingSessionTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_register_funding_session");
assert.deepEqual(
  sportRegisterFundingSessionTool.inputSchema.required,
  ["wallet", "walletKeypair"],
  "sport_register_funding_session must require wallet and keypair"
);
assert.equal(
  sportRegisterFundingSessionTool.inputSchema.properties.ttlSeconds.maximum,
  86400,
  "sport_register_funding_session must cap session TTL"
);

const sportClearFundingSessionTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_clear_funding_session");
assert.deepEqual(
  sportClearFundingSessionTool.inputSchema.required,
  ["wallet"],
  "sport_clear_funding_session must require wallet"
);

const sportFundingSessionStatusTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_funding_session_status");
assert.deepEqual(
  sportFundingSessionStatusTool.inputSchema.required,
  ["wallet"],
  "sport_funding_session_status must require wallet"
);

const generatedFundingKeypair = nacl.sign.keyPair();
const generatedFundingWallet = bs58.encode(generatedFundingKeypair.publicKey);
const generatedFundingSecret = bs58.encode(generatedFundingKeypair.secretKey);
const fundingSession = __test.registerFundingSession(
  generatedFundingWallet,
  "session-body-token",
  generatedFundingSecret,
  600
);
assert.equal(fundingSession.registered, true, "funding session registration must succeed for a matching wallet keypair");
assert.equal(
  __test.getFundingSessionKeypair(generatedFundingWallet, "session-body-token"),
  generatedFundingSecret,
  "funding session must resolve with the original token binding"
);
assert.equal(
  __test.getFundingSessionKeypair(generatedFundingWallet, "session-header-token"),
  generatedFundingSecret,
  "funding session must resolve by wallet fallback when token transport changes"
);
assert.equal(
  __test.getFundingSessionStatus(generatedFundingWallet, "session-header-token").active,
  true,
  "funding session status must report active through wallet fallback"
);
assert.equal(
  __test.clearFundingSession(generatedFundingWallet, "session-header-token").cleared,
  true,
  "clearing by fallback token must clear the wallet session"
);
assert.equal(
  __test.getFundingSessionStatus(generatedFundingWallet, "session-body-token").active,
  false,
  "clearing a wallet session must remove all aliases for that session"
);

const sportExecuteFundingTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_execute_funding");
assert.deepEqual(
  sportExecuteFundingTool.inputSchema.required,
  ["wallet", "positionId"],
  "sport_execute_funding must require wallet and position id"
);
assert.ok(
  sportExecuteFundingTool.inputSchema.properties.walletKeypair,
  "sport_execute_funding must expose optional walletKeypair"
);

const sportCancelPositionTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_cancel_position");
assert.deepEqual(
  sportCancelPositionTool.inputSchema.required,
  ["wallet", "positionId"],
  "sport_cancel_position must require wallet and position id"
);

const sportGetPositionTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_get_position");
assert.deepEqual(
  sportGetPositionTool.inputSchema.required,
  ["wallet", "positionId"],
  "sport_get_position must require wallet and position id"
);

const sportGetPositionFillsTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_get_position_fills");
assert.deepEqual(
  sportGetPositionFillsTool.inputSchema.required,
  ["wallet", "positionId"],
  "sport_get_position_fills must require wallet and position id"
);

const sportListPositionsTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_list_positions");
assert.equal(
  sportListPositionsTool.inputSchema.properties.status.default,
  "funded_open",
  "sport_list_positions must default to funded open positions only"
);

const sportViewPositionsTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_view_positions");
assert.equal(
  sportViewPositionsTool.inputSchema.properties.limit.maximum,
  100,
  "sport_view_positions must cap public book page size"
);

const sportMyPositionsTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_my_positions");
assert.deepEqual(
  sportMyPositionsTool.inputSchema.required,
  ["wallet"],
  "sport_my_positions must require wallet"
);

const sportMyFillsTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_my_fills");
assert.deepEqual(
  sportMyFillsTool.inputSchema.required,
  ["wallet"],
  "sport_my_fills must require wallet"
);

const sportMyTicketsTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_my_tickets");
assert.deepEqual(
  sportMyTicketsTool.inputSchema.required,
  ["wallet"],
  "sport_my_tickets must require wallet"
);

const sportSettlementTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_get_settlement_status");
assert.deepEqual(
  sportSettlementTool.inputSchema.required,
  ["ticketId"],
  "sport_get_settlement_status must be ticket based"
);

const sportHistoryTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_get_my_history");
assert.deepEqual(
  sportHistoryTool.inputSchema.required,
  ["wallet"],
  "sport_get_my_history must require wallet"
);
assert.equal(
  sportHistoryTool.inputSchema.properties.limit.maximum,
  200,
  "sport_get_my_history must cap page size"
);

const sportDiscoveryTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_discover_agents");
assert.equal(
  sportDiscoveryTool.inputSchema.properties.limit.maximum,
  50,
  "sport_discover_agents must cap directory page size"
);

const sportCreateIntentTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_create_intent");
assert.deepEqual(
  sportCreateIntentTool.inputSchema.required,
  ["wallet", "fixtureId", "selection"],
  "sport_create_intent must require wallet, fixture, and selection"
);
assert.ok(
  sportCreateIntentTool.inputSchema.properties.side.enum.includes("back"),
  "sport_create_intent must expose back/lay side"
);

const sportListIntentTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_list_intents");
assert.equal(
  sportListIntentTool.inputSchema.properties.limit.maximum,
  100,
  "sport_list_intents must cap page size"
);

const sportListMyIntentsTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_list_my_intents");
assert.deepEqual(
  sportListMyIntentsTool.inputSchema.required,
  ["wallet"],
  "sport_list_my_intents must require wallet"
);

const sportCancelIntentTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_cancel_intent");
assert.deepEqual(
  sportCancelIntentTool.inputSchema.required,
  ["wallet", "intentId"],
  "sport_cancel_intent must require wallet and intent id"
);

const sportFindLiquidityTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_find_matching_liquidity");
assert.deepEqual(
  sportFindLiquidityTool.inputSchema.required,
  ["wallet", "fixtureId", "selection"],
  "sport_find_matching_liquidity must require wallet, fixture, and selection"
);
assert.equal(
  sportFindLiquidityTool.inputSchema.properties.limit.maximum,
  100,
  "sport_find_matching_liquidity must cap page size"
);

const sportEventGuideTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_get_event_guide");
assert.ok(
  sportEventGuideTool.inputSchema.properties.authToken,
  "sport_get_event_guide may accept authToken but must not require it"
);

const sportTemplateListTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_list_strategy_templates");
assert.deepEqual(
  sportTemplateListTool.inputSchema.required,
  ["wallet"],
  "sport_list_strategy_templates must require wallet"
);

const sportPresetListTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_list_strategy_presets");
assert.deepEqual(
  sportPresetListTool.inputSchema.required,
  ["wallet"],
  "sport_list_strategy_presets must require wallet"
);

const sportTemplateSaveTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_save_strategy_template");
assert.deepEqual(
  sportTemplateSaveTool.inputSchema.required,
  ["wallet", "name", "defaults"],
  "sport_save_strategy_template must require wallet, template name, and defaults"
);

const sportTemplateOfferTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_create_offer_from_template");
assert.deepEqual(
  sportTemplateOfferTool.inputSchema.required,
  ["wallet", "name", "fixtureId"],
  "sport_create_offer_from_template must require wallet, template name, and fixture"
);

const sportPresetPositionTool = __test.tools.find((candidate: any) => candidate.name === "airotc_sport_create_position_from_preset");
assert.deepEqual(
  sportPresetPositionTool.inputSchema.required,
  ["wallet", "name", "fixtureId"],
  "sport_create_position_from_preset must require wallet, preset name, and fixture"
);

const sportAutomationTool = __test.tools.find(
  (candidate: any) => candidate.name === "airotc_sport_settlement_automation_status"
);
assert.ok(
  sportAutomationTool.inputSchema.properties.authToken,
  "sport_settlement_automation_status must accept normal MCP auth"
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
assert.equal(fullScopes.has("sport:admin"), false, "trade-agent scope set must not include SPORT admin");

const sportAdminScopes = __test.parseScopes("sport:admin", new Set());
assert.deepEqual(
  Array.from(sportAdminScopes),
  ["sport:admin"],
  "static operator tokens must be able to opt into SPORT admin scope"
);

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
