#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SDK_DIST_ENTRY = path.join(ROOT, "sdk", "ts", "dist", "index.js");
const DEFAULT_API_URL = "http://localhost:3000";
const DEFAULT_WS_URL = "ws://localhost:8080";
const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const NORMAL_MODE_PROFILE = Object.freeze({
  executionProfile: "NORMAL_SOL_ESCROW",
  privacyTier: "PUBLIC_SOL",
  settlementRail: "SOL_ESCROW",
  confidentialComputeProvider: "NONE",
  rollupMode: "NONE",
});

function loadSdk() {
  if (!fs.existsSync(SDK_DIST_ENTRY)) {
    throw new Error(
      `Built SDK not found at ${SDK_DIST_ENTRY}. Run \`npm --prefix sdk/ts run build\` before using this agent script.`
    );
  }
  return require(SDK_DIST_ENTRY);
}

function readEnv(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;

  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

function walletPrivateKey(role) {
  if (process.env.AGENT_WALLET_PRIVATE_KEY) {
    return process.env.AGENT_WALLET_PRIVATE_KEY;
  }

  const env = readEnv(path.join(ROOT, "middleman-agent", ".env"));
  const roleToKey = {
    buyer: "BUYER_PRIVATE_KEY",
    seller: "SELLER_PRIVATE_KEY",
    operator: "PRIVATE_KEY",
  };
  const envKey = roleToKey[role] || roleToKey.buyer;
  const value = env[envKey];
  if (!value) {
    throw new Error(
      `No wallet private key found. Set AGENT_WALLET_PRIVATE_KEY or add ${envKey} in middleman-agent/.env.`
    );
  }
  return value;
}

function makeClient(role, options = {}) {
  const { AgentOTC } = loadSdk();
  const normalMode = options.normalMode === true;
  return new AgentOTC({
    walletPrivateKey: walletPrivateKey(role),
    apiUrl: process.env.AIROTC_API_URL || DEFAULT_API_URL,
    wsUrl: process.env.AIROTC_WS_URL || DEFAULT_WS_URL,
    rpcUrl: process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL,
    environment: "devnet",
    privateMode: normalMode ? false : true,
    strictOpaquePerMode: normalMode ? false : true,
    persistLocalState: false,
  });
}

function parsePositiveDecimal(name, fallback) {
  const value = String(process.env[name] || fallback).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a non-negative decimal string.`);
  }
  if (Number(value) <= 0) {
    throw new Error(`${name} must be greater than zero.`);
  }
  return value;
}

function decimalToRawAmount(value, decimals = 9) {
  const [whole, fractional = ""] = String(value).trim().split(".");
  if (fractional.length > decimals) {
    throw new Error(`Value ${value} has more than ${decimals} decimals.`);
  }
  const raw = `${whole}${fractional.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return raw || "0";
}

function toNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return parsed;
}

function normalModeOfferParams() {
  const amount = parsePositiveDecimal("AIROTC_NORMAL_AMOUNT", process.env.AIROTC_AMOUNT || "1");
  const price = parsePositiveDecimal("AIROTC_NORMAL_PRICE_SOL", process.env.AIROTC_PRICE_SOL || "0.001");
  const collateral = parsePositiveDecimal(
    "AIROTC_NORMAL_COLLATERAL_SOL",
    process.env.AIROTC_COLLATERAL_SOL || "0.001"
  );
  const mode = process.env.AIROTC_NORMAL_MODE || "sell";
  if (mode !== "sell") {
    throw new Error("This Normal Mode agent script currently supports seller-posted sell offers only.");
  }

  return {
    asset: process.env.AIROTC_NORMAL_ASSET || process.env.AIROTC_ASSET || "SOL",
    mode,
    amount: toNumber(amount, "AIROTC_NORMAL_AMOUNT"),
    amountRaw: process.env.AIROTC_NORMAL_AMOUNT_RAW || decimalToRawAmount(amount, 9),
    price: toNumber(price, "AIROTC_NORMAL_PRICE_SOL"),
    priceRaw: process.env.AIROTC_NORMAL_PRICE_RAW || decimalToRawAmount(price, 9),
    collateral: toNumber(collateral, "AIROTC_NORMAL_COLLATERAL_SOL"),
    collateralRaw: process.env.AIROTC_NORMAL_COLLATERAL_RAW || decimalToRawAmount(collateral, 9),
  };
}

function normalTimeoutMs(name, fallback) {
  const parsed = Number(process.env[name] || fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive timeout in milliseconds.`);
  }
  return parsed;
}

function assertNormalModeOffer(offer) {
  const actual = {
    executionProfile: offer.executionProfile || null,
    privacyTier: offer.privacyTier || null,
    settlementRail: offer.settlementRail || null,
    confidentialComputeProvider: offer.confidentialComputeProvider || null,
    rollupMode: offer.rollupMode || null,
  };
  const mismatches = Object.entries(NORMAL_MODE_PROFILE)
    .filter(([key, expected]) => actual[key] !== expected)
    .map(([key, expected]) => `${key}: expected ${expected}, got ${actual[key]}`);

  if (mismatches.length > 0) {
    throw new Error(`Offer is not Normal Mode safe. ${mismatches.join("; ")}`);
  }
}

function attachAgentLogs(client, label) {
  client.on("phase_changed", (update) => {
    console.log(JSON.stringify({ agent: label, event: "phase_changed", update }));
  });
  client.on("deal_complete", (ticketId) => {
    console.log(JSON.stringify({ agent: label, event: "deal_complete", ticketId }));
  });
  client.on("message", (message) => {
    const content = String(message?.content || "");
    console.log(
      JSON.stringify({
        agent: label,
        event: "message",
        ticketId: message?.ticketId || null,
        phase: message?.phase || null,
        content: content.length > 180 ? `${content.slice(0, 180)}...` : content,
      })
    );
  });
}

async function safeRegister(client, label) {
  try {
    await client.register();
    console.log(JSON.stringify({ agent: label, registered: true }));
  } catch (error) {
    console.log(
      JSON.stringify({
        agent: label,
        registered: false,
        continuing: true,
        reason: error?.message || String(error),
      })
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function health() {
  const [api, middleman] = await Promise.all([
    fetch(`${process.env.AIROTC_API_URL || DEFAULT_API_URL}/health`).then((r) => r.json()),
    fetch((process.env.AIROTC_WS_URL || DEFAULT_WS_URL).replace(/^ws/, "http") + "/health").then((r) => r.json()),
  ]);
  console.log(JSON.stringify({ api, middleman }, null, 2));
}

async function listOffers() {
  const client = makeClient(process.env.AIROTC_SDK_WALLET || "buyer");
  const offers = await client.offers.list({ status: "active" });
  console.log(JSON.stringify(offers, null, 2));
}

async function normalDryRun() {
  const offerParams = normalModeOfferParams();
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "normal-dry-run",
        mode: "NORMAL_SOL_ESCROW",
        offer: {
          ...offerParams,
          ...NORMAL_MODE_PROFILE,
        },
        criticalPath: {
          escrowRoute: "STANDARD_ESCROW",
          payoutRoute: "DIRECT",
          advancedProvidersInvoked: false,
        },
      },
      null,
      2
    )
  );
}

async function probeJson(name, url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.AIROTC_NORMAL_PREFLIGHT_TIMEOUT_MS || "5000")
  );
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return {
      name,
      ok: response.ok,
      status: response.status,
      url,
      body,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      url,
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function normalPreflight() {
  const apiUrl = process.env.AIROTC_API_URL || DEFAULT_API_URL;
  const wsUrl = process.env.AIROTC_WS_URL || DEFAULT_WS_URL;
  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
  const walletChecks = ["seller", "buyer"].map((role) => {
    try {
      walletPrivateKey(role);
      return { role, ok: true };
    } catch (error) {
      return { role, ok: false, error: error?.message || String(error) };
    }
  });

  const probes = await Promise.all([
    probeJson("api", `${apiUrl.replace(/\/+$/, "")}/health`),
    probeJson("middleman", `${wsUrl.replace(/^ws/, "http").replace(/\/+$/, "")}/health`),
    probeJson("rpc", rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "air-otc-normal-preflight", method: "getHealth" }),
    }),
  ]);

  const ok = walletChecks.every((check) => check.ok) && probes.every((probe) => probe.ok);
  const result = {
    ok,
    command: "normal-preflight",
    mode: "NORMAL_SOL_ESCROW",
    endpoints: {
      apiUrl,
      wsUrl,
      rpcUrl,
    },
    wallets: walletChecks,
    probes,
    advancedProvidersRequired: false,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!ok) {
    process.exitCode = 1;
  }
}

async function normalPost({ waitForSettlement = true } = {}) {
  const seller = makeClient(process.env.AIROTC_NORMAL_SELLER_ROLE || "seller", { normalMode: true });
  const offerParams = normalModeOfferParams();
  const phaseTimeoutMs = normalTimeoutMs("AIROTC_NORMAL_PHASE_TIMEOUT_MS", "180000");
  const matchTimeoutMs = normalTimeoutMs("AIROTC_NORMAL_MATCH_TIMEOUT_MS", String(phaseTimeoutMs));

  attachAgentLogs(seller, "seller");
  await safeRegister(seller, "seller");
  await seller.connect();

  try {
    const offer = await seller.offers.normalSolEscrow(offerParams);
    assertNormalModeOffer(offer);
    console.log(
      JSON.stringify(
        {
          created: true,
          mode: "NORMAL_SOL_ESCROW",
          offer,
          advancedProvidersInvoked: false,
          next: waitForSettlement
            ? "Seller agent is waiting for a buyer, then will fund seller collateral and wait for completion."
            : "Offer posted only. Start normal-join <offerId> from a funded buyer agent.",
        },
        null,
        2
      )
    );

    if (!waitForSettlement) {
      return { offer };
    }

    const sellerResult = await runNormalSellerSettlement(seller, offer, {
      phaseTimeoutMs,
      matchTimeoutMs,
      collateral: offerParams.collateral,
    });
    return { offer, seller: sellerResult };
  } finally {
    seller.disconnect();
  }
}

async function runNormalSellerSettlement(seller, offer, options) {
  const deal = await seller.offers.waitForMatch(offer.id, {
    timeoutMs: options.matchTimeoutMs,
    pollIntervalMs: Number(process.env.AIROTC_NORMAL_POLL_INTERVAL_MS || "3000"),
  });
  deal.on("phase_changed", (phase) => {
    console.log(JSON.stringify({ agent: "seller", ticketId: deal.id, phase }));
  });

  await deal.waitForPhase(["escrow_created", "awaiting_deposits"], {
    timeoutMs: options.phaseTimeoutMs,
  });
  const sellerCollateralTx = await deal.depositToEscrow(options.collateral, "seller");
  console.log(JSON.stringify({ agent: "seller", ticketId: deal.id, sellerCollateralTx }));

  await deal.waitForPhase("delivery", { timeoutMs: options.phaseTimeoutMs });
  await deal.sendMessage(
    process.env.AIROTC_NORMAL_DELIVERY_MESSAGE ||
      "@middleman Normal Mode seller delivery is complete. Buyer may release after verification."
  );
  await deal.waitForPhase(["completed", "settled"], {
    timeoutMs: normalTimeoutMs("AIROTC_NORMAL_SETTLEMENT_TIMEOUT_MS", String(options.phaseTimeoutMs)),
  });

  const finalStatus = await deal.refreshStatus().catch(() => null);
  return {
    success: true,
    ticketId: deal.id,
    sellerCollateralTx,
    finalPhase: finalStatus?.phase || "completed",
    escrowAddress: finalStatus?.escrowAddress || null,
  };
}

async function normalJoin(offerId) {
  if (!offerId) throw new Error("Usage: normal-join <offerId>");

  const buyer = makeClient(process.env.AIROTC_NORMAL_BUYER_ROLE || "buyer", { normalMode: true });
  const offerParams = normalModeOfferParams();
  const phaseTimeoutMs = normalTimeoutMs("AIROTC_NORMAL_PHASE_TIMEOUT_MS", "180000");

  attachAgentLogs(buyer, "buyer");
  await safeRegister(buyer, "buyer");
  await buyer.connect();

  try {
    const offer = await buyer.offers.get(offerId);
    assertNormalModeOffer(offer);

    const result = await buyer.quickBuy({
      offerId,
      maxPrice: offer.price || offerParams.price,
      collateral: offer.collateral || offerParams.collateral,
      phaseTimeoutMs,
      onDealCreated: (deal) => {
        console.log(JSON.stringify({ agent: "buyer", event: "deal_created", ticketId: deal.id, offerId }));
      },
      onEscrowReady: (escrowAddress) => {
        console.log(JSON.stringify({ agent: "buyer", event: "escrow_ready", escrowAddress }));
      },
      onPhaseChange: (phase) => {
        console.log(JSON.stringify({ agent: "buyer", offerId, phase }));
      },
    });

    if (!result.success) {
      throw new Error(result.error || "Normal Mode buyer settlement failed.");
    }

    console.log(
      JSON.stringify(
        {
          success: true,
          mode: "NORMAL_SOL_ESCROW",
          offerId,
          ticketId: result.deal?.id || null,
          buyerCollateralTx: result.collateralTx,
          buyerPaymentTx: result.paymentTx,
          advancedProvidersInvoked: false,
        },
        null,
        2
      )
    );
    return result;
  } finally {
    buyer.disconnect();
  }
}

async function normalTwoAgent() {
  const seller = makeClient(process.env.AIROTC_NORMAL_SELLER_ROLE || "seller", { normalMode: true });
  const buyer = makeClient(process.env.AIROTC_NORMAL_BUYER_ROLE || "buyer", { normalMode: true });
  const offerParams = normalModeOfferParams();
  const phaseTimeoutMs = normalTimeoutMs("AIROTC_NORMAL_PHASE_TIMEOUT_MS", "180000");
  const matchTimeoutMs = normalTimeoutMs("AIROTC_NORMAL_MATCH_TIMEOUT_MS", String(phaseTimeoutMs));

  attachAgentLogs(seller, "seller");
  attachAgentLogs(buyer, "buyer");
  await Promise.all([safeRegister(seller, "seller"), safeRegister(buyer, "buyer")]);
  await Promise.all([seller.connect(), buyer.connect()]);

  let sellerResult;
  let buyerResult;
  let offer;

  try {
    offer = await seller.offers.normalSolEscrow(offerParams);
    assertNormalModeOffer(offer);
    console.log(
      JSON.stringify(
        {
          created: true,
          mode: "NORMAL_SOL_ESCROW",
          offer,
          advancedProvidersInvoked: false,
        },
        null,
        2
      )
    );

    const sellerFlow = runNormalSellerSettlement(seller, offer, {
      phaseTimeoutMs,
      matchTimeoutMs,
      collateral: offerParams.collateral,
    });

    const buyerFlow = (async () => {
      await sleep(Number(process.env.AIROTC_NORMAL_JOIN_DELAY_MS || "1500"));
      const result = await buyer.quickBuy({
        offerId: offer.id,
        maxPrice: offerParams.price,
        collateral: offerParams.collateral,
        phaseTimeoutMs,
        onDealCreated: (deal) => {
          console.log(JSON.stringify({ agent: "buyer", event: "deal_created", ticketId: deal.id, offerId: offer.id }));
        },
        onEscrowReady: (escrowAddress) => {
          console.log(JSON.stringify({ agent: "buyer", event: "escrow_ready", escrowAddress }));
        },
        onPhaseChange: (phase) => {
          console.log(JSON.stringify({ agent: "buyer", offerId: offer.id, phase }));
        },
      });
      if (!result.success) {
        throw new Error(result.error || "Normal Mode buyer settlement failed.");
      }
      return {
        success: true,
        ticketId: result.deal?.id || null,
        buyerCollateralTx: result.collateralTx,
        buyerPaymentTx: result.paymentTx,
      };
    })();

    [sellerResult, buyerResult] = await Promise.all([sellerFlow, buyerFlow]);
  } finally {
    buyer.disconnect();
    seller.disconnect();
  }

  console.log(
    JSON.stringify(
      {
        success: true,
        mode: "NORMAL_SOL_ESCROW",
        offerId: offer?.id || null,
        seller: sellerResult,
        buyer: buyerResult,
        criticalPath: {
          escrowRoute: "STANDARD_ESCROW",
          payoutRoute: "DIRECT",
          advancedProvidersInvoked: false,
        },
      },
      null,
      2
    )
  );
}

async function createPerOffer() {
  const client = makeClient(process.env.AIROTC_SDK_WALLET || "seller");
  await client.register();
  await client.connect();

  const offer = await client.offers.create({
    asset: process.env.AIROTC_ASSET || "SOL",
    mode: "sell",
    amount: Number(process.env.AIROTC_AMOUNT || "1"),
    price: Number(process.env.AIROTC_PRICE_SOL || "0.001"),
    collateral: Number(process.env.AIROTC_COLLATERAL_SOL || "0.001"),
    rollupMode: "PER",
  });

  console.log(JSON.stringify({ created: true, offer }, null, 2));
  console.log("Seller SDK agent is staying online. Keep this terminal open while another agent accepts.");
  await new Promise(() => {});
}

async function acceptPerOffer(offerId) {
  if (!offerId) throw new Error("Usage: accept-per-offer <offerId>");

  const client = makeClient(process.env.AIROTC_SDK_WALLET || "buyer");
  await client.register();
  await client.connect();

  const offer = await client.offers.get(offerId);
  console.log(JSON.stringify({ offerId, rollupMode: offer.rollupMode, privacy: offer.privacy }, null, 2));

  const deal = await client.offers.accept(offerId);
  console.log(JSON.stringify({ accepted: true, ticketId: deal.id, offerId }, null, 2));

  const session = await deal.waitForRollupSessionReady(
    Number(process.env.AIROTC_ROLLUP_WAIT_MS || "180000")
  );
  console.log(JSON.stringify({ rollupSessionReady: true, session }, null, 2));
}

async function main() {
  const [command, offerId] = process.argv.slice(2);

  if (command === "health") return health();
  if (command === "list-offers") return listOffers();
  if (command === "normal-preflight") return normalPreflight();
  if (command === "normal-dry-run") return normalDryRun();
  if (command === "normal-post") {
    return normalPost({ waitForSettlement: process.env.AIROTC_NORMAL_POST_WAIT !== "false" });
  }
  if (command === "normal-join") return normalJoin(offerId);
  if (command === "normal-two-agent") return normalTwoAgent();
  if (command === "create-per-offer") return createPerOffer();
  if (command === "accept-per-offer") return acceptPerOffer(offerId);

  console.log(`Usage:
  node scripts/manus-local-sdk-agent.cjs health
  node scripts/manus-local-sdk-agent.cjs list-offers
  node scripts/manus-local-sdk-agent.cjs normal-preflight
  node scripts/manus-local-sdk-agent.cjs normal-dry-run
  node scripts/manus-local-sdk-agent.cjs normal-two-agent
  AIROTC_NORMAL_POST_WAIT=false node scripts/manus-local-sdk-agent.cjs normal-post
  node scripts/manus-local-sdk-agent.cjs normal-join <offerId>
  AIROTC_SDK_WALLET=seller node scripts/manus-local-sdk-agent.cjs create-per-offer
  AIROTC_SDK_WALLET=buyer node scripts/manus-local-sdk-agent.cjs accept-per-offer <offerId>

Optional env:
  AGENT_WALLET_PRIVATE_KEY=<base58 private key>
  SELLER_PRIVATE_KEY=<base58 private key> or middleman-agent/.env SELLER_PRIVATE_KEY
  BUYER_PRIVATE_KEY=<base58 private key> or middleman-agent/.env BUYER_PRIVATE_KEY
  AIROTC_API_URL=http://localhost:3000
  AIROTC_WS_URL=ws://localhost:8080
  SOLANA_RPC_URL=https://api.devnet.solana.com
  AIROTC_NORMAL_AMOUNT=1
  AIROTC_NORMAL_PRICE_SOL=0.001
  AIROTC_NORMAL_COLLATERAL_SOL=0.001
  AIROTC_NORMAL_PHASE_TIMEOUT_MS=180000
`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
