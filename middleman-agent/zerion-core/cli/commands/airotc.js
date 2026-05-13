/**
 * AIR OTC extension commands for the Zerion Superteam track.
 *
 * These commands make Zerion a visible pre-trade and execution gate:
 * - policy-check: deterministic scoped policy proof for an autonomous agent
 * - verify-seller / verify-buyer: wallet readiness snapshot through Zerion API
 * - execute-demo-tx: real transaction handoff gate for demo evidence
 */

import { createHash } from "node:crypto";
import * as api from "../lib/api/client.js";
import { getApiKey } from "../lib/config.js";
import { isX402Enabled } from "../lib/api/x402.js";
import { print, printError } from "../lib/util/output.js";
import { validateChain } from "../lib/util/validate.js";
import swap from "./trading/swap.js";

const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/;
const EVM_TX_HASH = /^0x[a-fA-F0-9]{64}$/;

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function fail(code, message, details = {}) {
  printError(code, message, details);
  process.exit(1);
}

function asString(value, fallback = undefined) {
  if (value === undefined || value === null || value === true || value === false) {
    return fallback;
  }
  return String(value);
}

function parsePositiveNumber(value, label, fallback = undefined) {
  if (value === undefined || value === null || value === false) return fallback;
  if (value === true) {
    fail("missing_numeric_value", `${label} requires a numeric value`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail("invalid_numeric_value", `${label} must be a positive number`);
  }
  return parsed;
}

function parseActions(value) {
  const raw = asString(value, "verify,swap");
  const actions = raw.split(",").map((item) => item.trim()).filter(Boolean);
  const allowed = new Set(["verify", "swap", "send", "bridge"]);
  for (const action of actions) {
    if (!allowed.has(action)) {
      fail("unsupported_action", `Unsupported AIR OTC Zerion action '${action}'`, {
        supportedActions: Array.from(allowed).sort(),
      });
    }
  }
  return actions;
}

function requireAddress(flags) {
  const address = asString(flags.wallet) || asString(flags.address) || asString(flags.owner);
  if (!address) {
    fail("missing_wallet", "Pass --wallet <address> or --address <address>");
  }
  return address;
}

function assertChain(chain) {
  const err = validateChain(chain);
  if (err) {
    fail(err.code, err.message, { supportedChains: err.supportedChains });
  }
}

function requireZerionAccess(flags) {
  const useX402 = flags.x402 === true || isX402Enabled();
  if (flags["allow-offline"] === true) {
    return { useX402: false, offline: true };
  }
  if (!useX402 && !getApiKey()) {
    fail("missing_zerion_access", "Zerion API access is required for AIR OTC verification", {
      suggestion:
        "Set ZERION_API_KEY, use --x402 with WALLET_PRIVATE_KEY, or pass --allow-offline only in tests.",
    });
  }
  return { useX402, offline: false };
}

function normalizePosition(position) {
  const attrs = position.attributes || {};
  const fungible = attrs.fungible_info || {};
  const relationships = position.relationships || {};
  const chain = relationships.chain?.data?.id || null;
  return {
    id: position.id || null,
    name: fungible.name || attrs.name || null,
    symbol: fungible.symbol || null,
    chain,
    quantity: attrs.quantity?.float ?? null,
    valueUsd: attrs.value ?? 0,
    priceUsd: attrs.price ?? null,
    raw: position,
  };
}

function positionMatchesAsset(position, asset) {
  if (!asset) return true;
  const expected = String(asset).toLowerCase();
  const haystack = [
    position.id,
    position.name,
    position.symbol,
    JSON.stringify(position.raw),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(expected);
}

async function policyCheck(_args, flags) {
  const chain = asString(flags.chain, "solana");
  assertChain(chain);
  const wallet = requireAddress(flags);
  const role = asString(flags.role, "agent");
  const maxSpendUsd = parsePositiveNumber(flags["max-spend-usd"], "--max-spend-usd", 1);
  const actions = parseActions(flags.actions || flags.action);
  const expiresAt =
    asString(flags["expires-at"]) ||
    new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    fail("invalid_expiry", "--expires-at must be an ISO date in the future");
  }

  const policy = {
    version: "air-otc-zerion-policy-v1",
    role,
    wallet,
    chain,
    actions,
    maxSpendUsd,
    expiresAt,
    requireRealTx: flags["require-real-tx"] !== false,
  };

  print({
    airotc: {
      type: "ZERION_POLICY_CHECK",
      status: "approved",
      policy,
      policyHash: sha256Json(policy),
      checkedAt: new Date().toISOString(),
    },
  });
}

async function verifyWallet(kind, flags) {
  const chain = asString(flags.chain, "solana");
  assertChain(chain);
  const address = requireAddress(flags);
  const { useX402, offline } = requireZerionAccess(flags);
  const asset = asString(flags.asset, kind === "seller" ? "SOL" : undefined);
  const minAmount = parsePositiveNumber(flags["min-amount"], "--min-amount", undefined);
  const minValueUsd = parsePositiveNumber(flags["min-value-usd"], "--min-value-usd", undefined);

  if (offline) {
    const offlineSnapshot = {
      address,
      chain,
      asset,
      minAmount,
      minValueUsd,
      mode: "offline-test-only",
    };
    print({
      airotc: {
        type: kind === "seller" ? "ZERION_SELLER_VERIFY" : "ZERION_BUYER_VERIFY",
        status: "offline_allowed_for_tests",
        verified: false,
        snapshotHash: sha256Json(offlineSnapshot),
        snapshot: offlineSnapshot,
        checkedAt: new Date().toISOString(),
      },
    });
    return;
  }

  const [portfolioRes, positionsRes] = await Promise.all([
    api.getPortfolio(address, { useX402 }),
    api.getPositions(address, {
      chainId: chain,
      positionFilter: "no_filter",
      useX402,
    }),
  ]);

  const positions = (positionsRes.data || [])
    .map(normalizePosition)
    .filter((position) => !chain || position.chain === chain);
  const matching = positions.filter((position) => positionMatchesAsset(position, asset));
  const totalUsd = portfolioRes.data?.attributes?.total?.positions ?? 0;

  let verified = true;
  const failures = [];

  if (kind === "seller") {
    if (matching.length === 0) {
      verified = false;
      failures.push(`no ${asset || "requested asset"} position found on ${chain}`);
    }
    if (minAmount !== undefined) {
      const quantity = matching.reduce((sum, position) => {
        return sum + (Number(position.quantity) || 0);
      }, 0);
      if (quantity < minAmount) {
        verified = false;
        failures.push(`asset quantity ${quantity} is below required ${minAmount}`);
      }
    }
  }

  if (minValueUsd !== undefined && totalUsd < minValueUsd) {
    verified = false;
    failures.push(`portfolio value ${totalUsd} USD is below required ${minValueUsd} USD`);
  }

  const snapshot = {
    address,
    chain,
    asset,
    minAmount,
    minValueUsd,
    portfolioValueUsd: totalUsd,
    positionCount: positions.length,
    matchingPositions: matching.slice(0, 10).map((position) => ({
      id: position.id,
      name: position.name,
      symbol: position.symbol,
      chain: position.chain,
      quantity: position.quantity,
      valueUsd: position.valueUsd,
      priceUsd: position.priceUsd,
    })),
  };

  if (!verified) {
    fail(kind === "seller" ? "seller_verification_failed" : "buyer_verification_failed", "Zerion verification failed", {
      failures,
      snapshotHash: sha256Json(snapshot),
      snapshot,
    });
  }

  print({
    airotc: {
      type: kind === "seller" ? "ZERION_SELLER_VERIFY" : "ZERION_BUYER_VERIFY",
      status: "verified",
      verified: true,
      snapshotHash: sha256Json(snapshot),
      snapshot,
      checkedAt: new Date().toISOString(),
    },
  });
}

async function onlineCheck(_args, flags) {
  const chain = asString(flags.chain, "solana");
  assertChain(chain);
  const address = requireAddress(flags);
  const { useX402, offline } = requireZerionAccess(flags);
  const positionFilter = asString(flags.positions, "no_filter");
  const mode = flags.light === true ? "light" : asString(flags.mode, "wallet");
  if (!["light", "wallet"].includes(mode)) {
    fail("invalid_online_check_mode", "--mode must be light or wallet");
  }

  if (offline) {
    const offlineSnapshot = {
      address,
      chain,
      mode,
      positionFilter,
      source: "offline-test-only",
    };
    print({
      airotc: {
        type: "ZERION_ONLINE_CHECK",
        status: "offline_allowed_for_tests",
        online: false,
        snapshotHash: sha256Json(offlineSnapshot),
        snapshot: offlineSnapshot,
        checkedAt: new Date().toISOString(),
      },
    });
    return;
  }

  if (mode === "light") {
    const chainsRes = await api.getChains({ useX402 });
    const chains = Array.isArray(chainsRes.data) ? chainsRes.data : [];
    const chainIds = chains.map((item) => item?.id).filter(Boolean);
    const snapshot = {
      address,
      chain,
      mode,
      chainCount: chains.length,
      requestedChainSupported: chainIds.includes(chain),
      sampleChains: chainIds.slice(0, 20),
    };
    print({
      airotc: {
        type: "ZERION_ONLINE_CHECK",
        status: "online",
        online: true,
        snapshotHash: sha256Json(snapshot),
        snapshot,
        checkedAt: new Date().toISOString(),
      },
    });
    return;
  }

  const [portfolioRes, positionsRes] = await Promise.all([
    api.getPortfolio(address, { useX402 }),
    api.getPositions(address, {
      chainId: chain,
      positionFilter,
      useX402,
    }),
  ]);

  const positions = (positionsRes.data || [])
    .map(normalizePosition)
    .filter((position) => !chain || position.chain === chain);
  const totalUsd = portfolioRes.data?.attributes?.total?.positions ?? 0;
  const snapshot = {
    address,
    chain,
    positionFilter,
    portfolioValueUsd: totalUsd,
    positionCount: positions.length,
    samplePositions: positions.slice(0, 5).map((position) => ({
      id: position.id,
      name: position.name,
      symbol: position.symbol,
      chain: position.chain,
      quantity: position.quantity,
      valueUsd: position.valueUsd,
      priceUsd: position.priceUsd,
    })),
  };

  print({
    airotc: {
      type: "ZERION_ONLINE_CHECK",
      status: "online",
      online: true,
      snapshotHash: sha256Json(snapshot),
      snapshot,
      checkedAt: new Date().toISOString(),
    },
  });
}

async function executeDemoTx(args, flags) {
  const externalTx = asString(flags["external-tx"]) || asString(flags.tx) || asString(flags.signature);
  if (externalTx) {
    if (!BASE58_SIGNATURE.test(externalTx) && !EVM_TX_HASH.test(externalTx)) {
      fail("invalid_tx_hash", "--external-tx must be a Solana signature or EVM tx hash");
    }
    print({
      airotc: {
        type: "ZERION_REAL_TX_EVIDENCE",
        status: "accepted",
        executed: true,
        txHash: externalTx,
        source: "external_zerion_cli_or_agent_token_execution",
        checkedAt: new Date().toISOString(),
      },
    });
    return;
  }

  if (flags.execute !== true) {
    fail("real_tx_required", "AIR OTC Zerion demo evidence requires a real transaction", {
      suggestion:
        "Run `zerion airotc execute-demo-tx --execute <from> <to> <amount> --wallet <name> --chain solana` or pass --external-tx after a Zerion-executed transaction.",
    });
  }

  return swap(args, flags);
}

async function proofBundle(_args, flags) {
  const ticketId = asString(flags.ticket) || asString(flags["ticket-id"]);
  if (!ticketId) {
    fail("missing_ticket", "Pass --ticket <ticketId>");
  }
  const bundle = {
    version: "air-otc-zerion-proof-v1",
    ticketId,
    policyHash: asString(flags["policy-hash"]) || null,
    sellerSnapshotHash: asString(flags["seller-snapshot-hash"]) || null,
    buyerSnapshotHash: asString(flags["buyer-snapshot-hash"]) || null,
    zerionTxHash: asString(flags["zerion-tx"]) || null,
    generatedAt: new Date().toISOString(),
  };
  print({
    airotc: {
      type: "ZERION_PROOF_BUNDLE",
      bundle,
      bundleHash: sha256Json(bundle),
    },
  });
}

export default async function airotc(args, flags) {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === "help") {
    print({
      usage: "zerion airotc <policy-check|online-check|verify-seller|verify-buyer|execute-demo-tx|proof-bundle> [options]",
      commands: {
        "policy-check --wallet <address> --role <seller|buyer> --chain solana": "Create a deterministic scoped policy proof",
        "online-check --wallet <address> --chain solana --mode light": "Prove live Zerion API access through the CLI without asserting a devnet wallet balance",
        "verify-seller --wallet <address> --asset SOL --min-amount <n>": "Verify seller asset readiness through Zerion",
        "verify-buyer --wallet <address> --min-value-usd <n>": "Verify buyer purchasing power through Zerion",
        "execute-demo-tx --execute SOL USDC 0.001 --wallet <name> --chain solana": "Execute a real Zerion transaction using the agent token",
        "execute-demo-tx --external-tx <signature>": "Attach an already executed Zerion transaction hash",
        "proof-bundle --ticket <id>": "Create an AIR OTC Zerion proof bundle hash",
      },
    });
    return;
  }

  if (subcommand === "policy-check") return policyCheck(rest, flags);
  if (subcommand === "online-check") return onlineCheck(rest, flags);
  if (subcommand === "verify-seller") return verifyWallet("seller", flags);
  if (subcommand === "verify-buyer") return verifyWallet("buyer", flags);
  if (subcommand === "execute-demo-tx") return executeDemoTx(rest, flags);
  if (subcommand === "proof-bundle") return proofBundle(rest, flags);

  fail("unknown_airotc_command", `Unknown AIR OTC Zerion command: ${subcommand}`);
}
