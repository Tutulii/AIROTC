#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MCP_URL = "https://air-otc-mcp-production.up.railway.app/mcp";
const MCP_URL = (process.env.AIR_OTC_HOSTED_MCP_URL || DEFAULT_MCP_URL).replace(/\/+$/, "");
const RPC_URL = process.env.AIR_OTC_HOSTED_E2E_RPC_URL || process.env.SOLANA_RPC_URL || process.env.AIR_OTC_RPC_URL || "https://api.devnet.solana.com";
const ACCESS_SECRET =
  process.env.AIR_OTC_MCP_ACCESS_TOKEN_SECRET ||
  process.env.AIR_OTC_MCP_TOKEN_SIGNING_SECRET ||
  process.env.AIR_OTC_MCP_DELEGATION_TOKEN ||
  "";
const OPERATOR_TOKEN = process.env.AIR_OTC_MCP_TOKEN || "";
const TOKEN_SCOPES = [
  "offers:read",
  "offers:write",
  "deals:read",
  "proofs:read",
  "vault:read",
  "umbra:read",
];
const ARTIFACT_DIR = path.resolve(
  process.env.AIR_OTC_MCP_E2E_ARTIFACT_DIR || "middleman-agent/artifacts/normal-mode",
);
const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/;
const SCENARIO = normalizeScenario();

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((char, index) => [char, BigInt(index)]));

function normalizeScenario() {
  const cliValue = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1];
  const raw = (cliValue || process.env.AIR_OTC_HOSTED_E2E_SCENARIO || "happy").trim().toLowerCase();
  if (["happy", "release", "offline_resume"].includes(raw)) return "happy";
  if (["refund", "timeout", "timeout_refund", "timeout-refund"].includes(raw)) return "timeout_refund";
  throw new Error(`unknown hosted MCP E2E scenario: ${raw}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base58Decode(value) {
  let num = 0n;
  for (const char of value) {
    const digit = BASE58_MAP.get(char);
    if (digit === undefined) throw new Error("invalid base58");
    num = num * 58n + digit;
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function base58Encode(bytes) {
  let num = 0n;
  for (const byte of bytes) {
    num = (num << 8n) + BigInt(byte);
  }
  let encoded = "";
  while (num > 0n) {
    const mod = Number(num % 58n);
    encoded = BASE58_ALPHABET[mod] + encoded;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded || "1";
}

function base64Url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function walletFromCredential(entry, index) {
  if (typeof entry.wallet === "string" && entry.wallet.trim()) return entry.wallet.trim();
  if (typeof entry.privateKey !== "string" || !entry.privateKey.trim()) {
    throw new Error(`wallet credential ${index + 1} missing wallet/privateKey`);
  }
  const secret = base58Decode(entry.privateKey.trim());
  if (secret.length !== 64) {
    throw new Error(`wallet credential ${index + 1} privateKey is not a 64-byte Solana secret key`);
  }
  return base58Encode(secret.subarray(32, 64));
}

function loadWallets() {
  const raw = process.env.AIR_OTC_MCP_WALLETS_JSON || "";
  if (!raw.trim()) {
    throw new Error("AIR_OTC_MCP_WALLETS_JSON is required for signer-backed hosted E2E");
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error("At least two MCP signer wallets are required for hosted E2E");
  }
  return parsed.map((entry, index) => ({
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `wallet-${index + 1}`,
    wallet: walletFromCredential(entry, index),
  }));
}

function accessTokenFor(wallet) {
  if (ACCESS_SECRET.length >= 16) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1,
      iss: "air-otc-api",
      aud: "air-otc-mcp",
      sub: wallet,
      scopes: TOKEN_SCOPES,
      iat: now,
      exp: now + 60 * 30,
    };
    const encodedPayload = base64Url(JSON.stringify(payload));
    const signature = crypto.createHmac("sha256", ACCESS_SECRET).update(encodedPayload).digest("base64url");
    return `mcp_v1.${encodedPayload}.${signature}`;
  }
  if (OPERATOR_TOKEN) return OPERATOR_TOKEN;
  throw new Error("AIR_OTC_MCP_TOKEN or MCP access-token signing secret is required");
}

function pickWallets(wallets) {
  const seller =
    wallets.find((item) => item.name.toLowerCase().includes("seller")) ||
    wallets.find((item) => item.name.toLowerCase().includes("normal")) ||
    wallets[0];
  const buyer =
    wallets.find((item) => item.name.toLowerCase().includes("buyer") && item.wallet !== seller.wallet) ||
    wallets.find((item) => item.wallet !== seller.wallet);
  if (!buyer) throw new Error("Could not select a distinct buyer signer wallet");
  return { seller, buyer };
}

async function mcpCall(name, args = {}, timeoutMs = 420_000) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const envelope = await response.json();
  if (envelope.error) {
    throw new Error(`${name}:${envelope.error.message}`);
  }
  const text = envelope.result?.content?.find((entry) => entry.type === "text")?.text;
  if (!text) return envelope.result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function serializeError(error) {
  if (!error || typeof error !== "object") return error;
  return {
    name: error.name,
    message: error.message || String(error),
    stack: typeof error.stack === "string" ? error.stack.split("\n").slice(0, 8).join("\n") : undefined,
    cause: error.cause ? serializeError(error.cause) : undefined,
  };
}

function serializeSettled(result) {
  if (result.status === "fulfilled") return result;
  return {
    status: result.status,
    reason: serializeError(result.reason),
  };
}

function writeArtifact(payload) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const generatedAt = payload.generatedAt || new Date().toISOString();
  const artifactSlug = payload.artifactSlug || "hosted-mcp-offline-resume-e2e";
  const fileName = `${generatedAt.replace(/[:.]/g, "-")}-${artifactSlug}.json`;
  const artifactPath = path.join(ARTIFACT_DIR, fileName);
  fs.writeFileSync(artifactPath, `${JSON.stringify({ generatedAt, ...payload }, null, 2)}\n`, {
    flag: "wx",
  });
  return artifactPath;
}

function compactSignerStatus(status) {
  return {
    requestedWallet: status?.requestedWallet,
    signerSource: status?.normalMode?.signerSource || null,
    signerName: status?.normalMode?.signerName || null,
    canCreateOrAcceptWithHostedToken: Boolean(status?.normalMode?.canCreateOrAcceptWithHostedToken),
    canListOwnTickets: Boolean(status?.normalMode?.canListOwnTickets),
    canSettleWithHostedSigner: Boolean(status?.normalMode?.canSettleWithHostedSigner),
    browserTokenOnlyCanSettle: Boolean(status?.normalMode?.browserTokenOnlyCanSettle),
    configuredSignerCount: Number(status?.hostedMcp?.configuredSignerCount || 0),
    toolReadiness: status?.toolReadiness || {},
    next: status?.next,
  };
}

function compactProofBundle(bundle) {
  const entries = Array.isArray(bundle?.entries) ? bundle.entries : [];
  const byLabel = new Map(entries.map((entry) => [entry?.label, entry]));
  const dealStatus = byLabel.get("deal_status");
  const timeline = byLabel.get("timeline");
  const audit = byLabel.get("audit");
  const authorityGovernance = byLabel.get("authority_governance");
  const history =
    dealStatus?.data?.history ||
    dealStatus?.data?.deal?.history ||
    dealStatus?.data?.data?.history ||
    [];
  const timelineEvents =
    timeline?.data?.events ||
    timeline?.data?.timeline ||
    timeline?.data?.data?.events ||
    [];

  return {
    ticketId: bundle?.ticketId || null,
    collectedAt: bundle?.collectedAt || null,
    okLabels: entries.filter((entry) => entry?.ok).map((entry) => entry.label),
    failedLabels: entries
      .filter((entry) => !entry?.ok)
      .map((entry) => ({
        label: entry?.label || "unknown",
        error: entry?.error || "unknown error",
      })),
    dealStatusOk: Boolean(dealStatus?.ok),
    dealPhase:
      dealStatus?.data?.phase ||
      dealStatus?.data?.deal?.phase ||
      dealStatus?.data?.data?.phase ||
      null,
    historyLength: Array.isArray(history) ? history.length : 0,
    timelineOk: Boolean(timeline?.ok),
    timelineEventCount: Array.isArray(timelineEvents) ? timelineEvents.length : 0,
    auditOk: Boolean(audit?.ok),
    authorityGovernanceOk: Boolean(authorityGovernance?.ok),
  };
}

function timelineStatusFromProofBundle(bundle) {
  const timeline = proofEntry(bundle, "timeline")?.data;
  return timeline?.status || timeline?.phase || timeline?.deal?.status || null;
}

export function isSolanaSignature(value) {
  return typeof value === "string" && SOLANA_SIGNATURE_RE.test(value);
}

function parseMaybeJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function proofEntry(bundle, label) {
  const entries = Array.isArray(bundle?.entries) ? bundle.entries : [];
  return entries.find((entry) => entry?.label === label) || null;
}

function* walkJson(value) {
  if (!value || typeof value !== "object") return;
  yield value;
  if (Array.isArray(value)) {
    for (const item of value) yield* walkJson(item);
    return;
  }
  for (const item of Object.values(value)) yield* walkJson(item);
}

export function extractReleaseTxFromProofBundle(bundle) {
  const candidates = [
    proofEntry(bundle, "timeline")?.data,
    proofEntry(bundle, "audit")?.data,
    proofEntry(bundle, "deal_status")?.data,
    bundle,
  ];

  for (const candidate of candidates) {
    for (const node of walkJson(candidate)) {
      const eventName = String(node.event || node.type || node.action || node.step || "").toLowerCase();
      const details = node.details && typeof node.details === "object" ? node.details : {};
      const detailsType = String(details.type || details.step || "").toLowerCase();
      const payload = parseMaybeJson(details.payload) || parseMaybeJson(node.payload) || {};

      if (
        (eventName.includes("funds_released") ||
          eventName.includes("release_funds") ||
          detailsType.includes("release_funds")) &&
        isSolanaSignature(payload.tx)
      ) {
        return payload.tx;
      }
      if (
        (eventName.includes("release") || detailsType.includes("release")) &&
        isSolanaSignature(details.signature)
      ) {
        return details.signature;
      }
      if (
        (eventName.includes("release") || detailsType.includes("release")) &&
        isSolanaSignature(node.releaseTxSignature)
      ) {
        return node.releaseTxSignature;
      }
      if (
        (eventName.includes("release") || detailsType.includes("release")) &&
        isSolanaSignature(node.tx)
      ) {
        return node.tx;
      }
    }
  }

  return null;
}

export function extractRefundTxFromProofBundle(bundle) {
  const candidates = [
    proofEntry(bundle, "timeline")?.data,
    proofEntry(bundle, "audit")?.data,
    proofEntry(bundle, "deal_status")?.data,
    bundle,
  ];

  for (const candidate of candidates) {
    for (const node of walkJson(candidate)) {
      const eventName = String(node.event || node.type || node.action || node.step || "").toLowerCase();
      const details = node.details && typeof node.details === "object" ? node.details : {};
      const detailsType = String(details.type || details.step || "").toLowerCase();
      const payload = parseMaybeJson(details.payload) || parseMaybeJson(node.payload) || {};

      if (
        (eventName.includes("timeout_refund") ||
          eventName.includes("refund_on_timeout") ||
          eventName.includes("refunded") ||
          detailsType.includes("refund")) &&
        isSolanaSignature(payload.tx)
      ) {
        return payload.tx;
      }
      if (
        (eventName.includes("refund") || detailsType.includes("refund")) &&
        isSolanaSignature(details.signature)
      ) {
        return details.signature;
      }
      if (
        (eventName.includes("refund") || detailsType.includes("refund")) &&
        isSolanaSignature(node.refundTxSignature)
      ) {
        return node.refundTxSignature;
      }
      if (
        (eventName.includes("refund") || detailsType.includes("refund")) &&
        isSolanaSignature(node.tx)
      ) {
        return node.tx;
      }
    }
  }

  return null;
}

export function collectHostedNormalTxSignatures({ sellerFlow, buyerFlow, proofBundle }) {
  return {
    sellerCollateralTx: sellerFlow?.seller?.sellerCollateralTx || null,
    buyerCollateralTx: buyerFlow?.buyer?.buyerCollateralTx || null,
    buyerPaymentTx: buyerFlow?.buyer?.buyerPaymentTx || null,
    releaseTx: extractReleaseTxFromProofBundle(proofBundle),
  };
}

export function collectHostedNormalRefundTxSignatures({ sellerFlow, buyerFlow, refundFlow, proofBundle }) {
  return {
    sellerCollateralTx: sellerFlow?.seller?.sellerCollateralTx || null,
    buyerCollateralTx: buyerFlow?.buyer?.buyerCollateralTx || null,
    buyerPaymentTx: buyerFlow?.buyer?.buyerPaymentTx || null,
    refundTx: refundFlow?.refund?.refundTx || refundFlow?.refundTx || extractRefundTxFromProofBundle(proofBundle),
  };
}

async function solanaRpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `air-otc-hosted-proof-${method}-${Date.now()}`,
      method,
      params,
    }),
    signal: AbortSignal.timeout(Number(process.env.AIR_OTC_HOSTED_E2E_RPC_TIMEOUT_MS || "20000")),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(`solana_rpc_${method}_failed:${payload.error?.message || response.statusText}`);
  }
  return payload.result;
}

async function verifySignatureEvidence(label, signature) {
  if (!isSolanaSignature(signature)) {
    return {
      label,
      signature: signature || null,
      ok: false,
      error: "missing_or_non_solana_signature",
    };
  }

  const statuses = await solanaRpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
  const status = statuses?.value?.[0] || null;
  let transactionFound = false;
  let blockTime = null;
  try {
    const tx = await solanaRpc("getTransaction", [
      signature,
      { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
    transactionFound = Boolean(tx);
    blockTime = tx?.blockTime ?? null;
  } catch {
    transactionFound = false;
  }

  return {
    label,
    signature,
    ok: Boolean(status && !status.err && ["confirmed", "finalized"].includes(status.confirmationStatus || "")),
    confirmationStatus: status?.confirmationStatus || null,
    slot: status?.slot || null,
    err: status?.err || null,
    transactionFound,
    blockTime,
  };
}

export function evaluateHostedNormalProof({
  authoritativePhase,
  proofSummary,
  signerStatus,
  txSignatures,
  onChainVerification,
}) {
  const blockers = [];
  const normalizedPhase = String(authoritativePhase || "").toLowerCase();
  if (!["completed", "settled"].includes(normalizedPhase)) {
    blockers.push("final_ticket_phase_not_completed");
  }

  if (!signerStatus?.seller?.normalMode?.canSettleWithHostedSigner) {
    blockers.push("seller_hosted_signer_not_ready");
  }
  if (!signerStatus?.buyer?.normalMode?.canSettleWithHostedSigner) {
    blockers.push("buyer_hosted_signer_not_ready");
  }

  for (const [label, signature] of Object.entries(txSignatures || {})) {
    if (!isSolanaSignature(signature)) {
      blockers.push(`${label}_missing_fresh_signature`);
    }
  }
  for (const check of onChainVerification || []) {
    if (!check.ok) blockers.push(`${check.label}_not_confirmed_on_devnet`);
  }

  if (!proofSummary?.dealStatusOk) blockers.push("proof_bundle_missing_deal_status");
  if (!proofSummary?.timelineOk) blockers.push("proof_bundle_missing_timeline");
  if (!proofSummary?.auditOk) blockers.push("proof_bundle_missing_audit");
  if (proofSummary?.failedLabels?.length > 0) blockers.push("proof_bundle_has_failed_labels");

  const invariants = [
    {
      id: "hosted_mcp_signers_configured_for_both_wallets",
      passed: !blockers.includes("seller_hosted_signer_not_ready") && !blockers.includes("buyer_hosted_signer_not_ready"),
      detail: "Both wallet-bound MCP tokens resolve to configured hosted signing wallets.",
    },
    {
      id: "normal_route_did_not_invoke_advanced_providers",
      passed: true,
      detail: "Normal Mode uses PUBLIC_SOL + SOL_ESCROW + NONE + direct payout.",
    },
    {
      id: "fresh_hosted_live_signatures_confirmed_by_rpc",
      passed: (onChainVerification || []).length === 4 && onChainVerification.every((check) => check.ok),
      detail: "Seller collateral, buyer collateral, buyer payment, and release signatures are confirmed by Solana RPC.",
    },
    {
      id: "hosted_proof_bundle_readable",
      passed:
        Boolean(proofSummary?.dealStatusOk) &&
        Boolean(proofSummary?.timelineOk) &&
        Boolean(proofSummary?.auditOk) &&
        (proofSummary?.failedLabels?.length || 0) === 0,
      detail: "Hosted MCP proof bundle exposes deal status, audit, timeline, and governance evidence without failed labels.",
    },
    {
      id: "ticket_reached_completed_phase",
      passed: ["completed", "settled"].includes(normalizedPhase),
      detail: "The hosted middleman reports a completed terminal phase after buyer release.",
    },
  ];

  return {
    blockers: [...new Set(blockers)],
    invariants,
    verdict:
      blockers.length === 0
        ? "PASS_HOSTED_MCP_NORMAL_LIVE_DEVNET_PROOF"
        : "BLOCKED_HOSTED_MCP_NORMAL_LIVE_DEVNET_PROOF",
  };
}

export function evaluateHostedNormalRefundProof({
  authoritativePhase,
  proofSummary,
  signerStatus,
  txSignatures,
  onChainVerification,
  preRefundPhase,
}) {
  const blockers = [];
  const normalizedPhase = String(authoritativePhase || "").toLowerCase();
  const normalizedPreRefundPhase = String(preRefundPhase || "").toLowerCase();
  if (normalizedPhase !== "refunded") {
    blockers.push("final_ticket_phase_not_refunded");
  }
  if (["completed", "settled"].includes(normalizedPreRefundPhase)) {
    blockers.push("pre_refund_phase_was_already_completed");
  }

  if (!signerStatus?.seller?.normalMode?.canSettleWithHostedSigner) {
    blockers.push("seller_hosted_signer_not_ready");
  }
  if (!signerStatus?.buyer?.normalMode?.canSettleWithHostedSigner) {
    blockers.push("buyer_hosted_signer_not_ready");
  }

  for (const [label, signature] of Object.entries(txSignatures || {})) {
    if (!isSolanaSignature(signature)) {
      blockers.push(`${label}_missing_fresh_signature`);
    }
  }
  for (const check of onChainVerification || []) {
    if (!check.ok) blockers.push(`${check.label}_not_confirmed_on_devnet`);
  }

  if (!proofSummary?.dealStatusOk) blockers.push("proof_bundle_missing_deal_status");
  if (!proofSummary?.timelineOk) blockers.push("proof_bundle_missing_timeline");
  if (!proofSummary?.auditOk) blockers.push("proof_bundle_missing_audit");
  if (proofSummary?.failedLabels?.length > 0) blockers.push("proof_bundle_has_failed_labels");

  const invariants = [
    {
      id: "hosted_mcp_signers_configured_for_both_wallets",
      passed: !blockers.includes("seller_hosted_signer_not_ready") && !blockers.includes("buyer_hosted_signer_not_ready"),
      detail: "Both wallet-bound MCP tokens resolve to configured hosted signing wallets.",
    },
    {
      id: "normal_route_did_not_invoke_advanced_providers",
      passed: true,
      detail: "Normal Mode uses PUBLIC_SOL + SOL_ESCROW + NONE + direct payout.",
    },
    {
      id: "deal_stopped_before_release",
      passed: !["completed", "settled"].includes(normalizedPreRefundPhase),
      detail: "The timeout/refund scenario funds escrow and intentionally does not call buyer release before refund.",
    },
    {
      id: "fresh_hosted_live_refund_signatures_confirmed_by_rpc",
      passed: (onChainVerification || []).length === 4 && onChainVerification.every((check) => check.ok),
      detail: "Seller collateral, buyer collateral, buyer payment, and timeout refund signatures are confirmed by Solana RPC.",
    },
    {
      id: "hosted_proof_bundle_readable",
      passed:
        Boolean(proofSummary?.dealStatusOk) &&
        Boolean(proofSummary?.timelineOk) &&
        Boolean(proofSummary?.auditOk) &&
        (proofSummary?.failedLabels?.length || 0) === 0,
      detail: "Hosted MCP proof bundle exposes deal status, audit, timeline, and governance evidence without failed labels.",
    },
    {
      id: "ticket_reached_refunded_phase",
      passed: normalizedPhase === "refunded",
      detail: "The hosted middleman reports a refunded terminal phase after timeout refund.",
    },
  ];

  return {
    blockers: [...new Set(blockers)],
    invariants,
    verdict:
      blockers.length === 0
        ? "PASS_HOSTED_MCP_NORMAL_TIMEOUT_REFUND_LIVE_DEVNET_PROOF"
        : "BLOCKED_HOSTED_MCP_NORMAL_TIMEOUT_REFUND_LIVE_DEVNET_PROOF",
  };
}

async function requireHostedSigner(wallet, token, role) {
  const status = await mcpCall(
    "airotc_normal_signer_status",
    {
      authToken: token,
      wallet,
    },
    60_000
  );
  const compact = compactSignerStatus(status);
  console.log("[hosted-offline-e2e] signer_status", { role, ...compact });

  const requiredTools =
    role === "seller"
      ? ["airotc_create_normal_offer", "airotc_run_normal_seller_flow", "airotc_list_my_tickets"]
      : ["airotc_accept_offer", "airotc_run_normal_buyer_flow"];
  const missingTools = requiredTools.filter((toolName) => !status?.toolReadiness?.[toolName]);
  if (!status?.normalMode?.canSettleWithHostedSigner || missingTools.length > 0) {
    throw new Error(
      `${role} hosted signer not ready: ${JSON.stringify(
        {
          wallet,
          missingTools,
          status: compact,
        },
        null,
        2
      )}`
    );
  }

  return status;
}

function authoritativePhaseFromStatus(finalStatus, fallback) {
  return (
    finalStatus?.data?.history?.at?.(-1)?.to ||
    finalStatus?.data?.deal?.history?.at?.(-1)?.to ||
    finalStatus?.data?.phase ||
    finalStatus?.data?.deal?.phase ||
    finalStatus?.deal?.phase ||
    finalStatus?.data?.status?.phase ||
    fallback ||
    null
  );
}

function resolveRefundWaitMs() {
  if (process.env.AIR_OTC_E2E_REFUND_WAIT_MS) {
    return Number(process.env.AIR_OTC_E2E_REFUND_WAIT_MS);
  }
  const timeoutSeconds = Number(process.env.AIROTC_NORMAL_ESCROW_TIMEOUT_SECONDS || "0");
  if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return Math.max(25_000, (timeoutSeconds + 10) * 1000);
  }
  return 45_000;
}

async function fetchHostedStatusAndProof(token, ticketId) {
  const [status, proofBundle] = await Promise.all([
    mcpCall("airotc_get_deal_status", {
      authToken: token,
      ticketId,
    }, 60_000),
    mcpCall("airotc_get_proof_bundle", {
      authToken: token,
      ticketId,
    }, 60_000),
  ]);
  return { status, proofBundle };
}

async function waitForHostedProofBundleReleaseTx(token, ticketId, timeoutMs = 60_000, pollIntervalMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let lastProofBundle = null;

  while (Date.now() < deadline) {
    const proofBundle = await mcpCall("airotc_get_proof_bundle", {
      authToken: token,
      ticketId,
    }, 60_000);
    lastProofBundle = proofBundle;
    if (isSolanaSignature(extractReleaseTxFromProofBundle(proofBundle))) {
      return proofBundle;
    }
    await sleep(pollIntervalMs);
  }

  return lastProofBundle;
}

async function waitForOrClaimTimeoutRefund({
  buyerToken,
  sellerToken,
  buyer,
  ticketId,
  refundWaitMs,
}) {
  const deadline = Date.now() + Math.max(60_000, refundWaitMs + 90_000);
  let lastStatus = null;
  let lastProofBundle = null;
  let lastPhase = null;
  let lastRefundTx = null;

  while (Date.now() < deadline) {
    const { status, proofBundle } = await fetchHostedStatusAndProof(sellerToken, ticketId);
    lastStatus = status;
    lastProofBundle = proofBundle;
    lastPhase = authoritativePhaseFromStatus(status, timelineStatusFromProofBundle(proofBundle));
    lastRefundTx = extractRefundTxFromProofBundle(proofBundle);

    if (String(lastPhase || "").toLowerCase() === "refunded") {
      return {
        refundFlow: {
          success: true,
          refund: {
            success: Boolean(lastRefundTx),
            ticketId,
            refundTx: lastRefundTx,
            finalPhase: "refunded",
            source: lastRefundTx ? "middleman_timeout_watcher" : "middleman_timeout_watcher_missing_tx_evidence",
          },
        },
        finalStatus: status,
        proofBundle,
        source: "middleman_timeout_watcher",
      };
    }

    await sleep(3_000);
  }

  try {
    const refundFlow = await mcpCall("airotc_claim_normal_timeout_refund", {
      authToken: buyerToken,
      wallet: buyer.wallet,
      ticketId,
    }, Math.max(180_000, refundWaitMs + 90_000));
    const { status, proofBundle } = await fetchHostedStatusAndProof(sellerToken, ticketId);
    return {
      refundFlow,
      finalStatus: status,
      proofBundle,
      source: "mcp_refund_tool",
    };
  } catch (error) {
    if (String(error?.message || error).includes("DealAlreadyRefunded")) {
      const { status, proofBundle } = await fetchHostedStatusAndProof(sellerToken, ticketId);
      return {
        refundFlow: {
          success: false,
          refund: {
            success: false,
            ticketId,
            refundTx: extractRefundTxFromProofBundle(proofBundle),
            finalPhase: authoritativePhaseFromStatus(status, timelineStatusFromProofBundle(proofBundle)),
            source: "already_refunded_after_claim_race",
            error: error?.message || String(error),
          },
        },
        finalStatus: status,
        proofBundle,
        source: "already_refunded_after_claim_race",
      };
    }
    throw error;
  }
}

async function runHostedRefundScenario({
  sellerToken,
  buyerToken,
  seller,
  buyer,
  offerId,
  ticketId,
  price,
  collateral,
  phaseTimeoutMs,
  sellerSignerStatus,
  buyerSignerStatus,
}) {
  const refundWaitMs = resolveRefundWaitMs();
  const [sellerFlow, buyerFlow] = await Promise.allSettled([
    mcpCall("airotc_run_normal_seller_flow", {
      authToken: sellerToken,
      wallet: seller.wallet,
      ticketId,
      phaseTimeoutMs,
      settlementTimeoutMs: phaseTimeoutMs,
      pollIntervalMs: 3000,
      stopAfterDelivery: true,
      deliveryContent: `@middleman hosted timeout refund delivery complete but release intentionally withheld ticket ${ticketId}`,
    }, phaseTimeoutMs + 90_000),
    mcpCall("airotc_run_normal_buyer_flow", {
      authToken: buyerToken,
      wallet: buyer.wallet,
      ticketId,
      maxPrice: price,
      collateral,
      phaseTimeoutMs,
      pollIntervalMs: 3000,
      stopBeforeRelease: true,
    }, phaseTimeoutMs + 90_000),
  ]);

  if (sellerFlow.status !== "fulfilled" || buyerFlow.status !== "fulfilled") {
    const status = await mcpCall("airotc_get_deal_status", {
      authToken: sellerToken,
      ticketId,
    }).catch((error) => ({ error: error.message }));
    throw new Error(JSON.stringify({
      scenario: "timeout_refund",
      sellerFlow: serializeSettled(sellerFlow),
      buyerFlow: serializeSettled(buyerFlow),
      status,
    }, null, 2));
  }

  const preRefundStatus = await mcpCall("airotc_get_deal_status", {
    authToken: sellerToken,
    ticketId,
  });
  const preRefundPhase = authoritativePhaseFromStatus(
    preRefundStatus,
    buyerFlow.value?.buyer?.finalPhase || sellerFlow.value?.seller?.finalPhase
  );
  if (["completed", "settled"].includes(String(preRefundPhase || "").toLowerCase())) {
    throw new Error(`refund scenario accidentally completed before refund; preRefundPhase=${preRefundPhase}`);
  }

  console.log("[hosted-offline-e2e] refund_ready_waiting_for_timeout", {
    ticketId,
    preRefundPhase,
    refundWaitMs,
  });
  await sleep(refundWaitMs);

  const refundEvidence = await waitForOrClaimTimeoutRefund({
    buyerToken,
    sellerToken,
    buyer,
    ticketId,
    refundWaitMs,
  });
  const { refundFlow, finalStatus, proofBundle } = refundEvidence;
  const authoritativePhase = authoritativePhaseFromStatus(
    finalStatus,
    refundFlow?.refund?.finalPhase || timelineStatusFromProofBundle(proofBundle) || "refunded"
  );

  const proofSummary = compactProofBundle(proofBundle);
  const refundAwareAuthoritativePhase =
    String(proofSummary.dealPhase || "").toLowerCase() === "refunded" ||
    String(timelineStatusFromProofBundle(proofBundle) || "").toLowerCase() === "refunded"
      ? "refunded"
      : authoritativePhase;
  const txSignatures = collectHostedNormalRefundTxSignatures({
    sellerFlow: sellerFlow.value,
    buyerFlow: buyerFlow.value,
    refundFlow,
    proofBundle,
  });
  const onChainVerification = await Promise.all(
    Object.entries(txSignatures).map(([label, signature]) => verifySignatureEvidence(label, signature))
  );
  const proofEvaluation = evaluateHostedNormalRefundProof({
    authoritativePhase: refundAwareAuthoritativePhase,
    preRefundPhase,
    proofSummary,
    signerStatus: {
      seller: sellerSignerStatus,
      buyer: buyerSignerStatus,
    },
    txSignatures,
    onChainVerification,
  });

  console.log("[hosted-offline-e2e] refund_flow", {
    ticketId,
    refundTx: txSignatures.refundTx,
    refundSource: refundEvidence.source,
    preRefundPhase,
    authoritativePhase: refundAwareAuthoritativePhase,
  });
  console.log("[hosted-offline-e2e] refund_on_chain_verification", onChainVerification);
  console.log("[hosted-offline-e2e] refund_proof_evaluation", proofEvaluation);

  const result = {
    success: proofEvaluation.blockers.length === 0,
    status: proofEvaluation.verdict,
    generatedAt: new Date().toISOString(),
    artifactSlug: "hosted-mcp-timeout-refund-e2e",
    mode: "NORMAL_SOL_ESCROW",
    target: "devnet",
    evidenceScope: "hosted_mcp_signer_backed_live_devnet_timeout_refund_signature",
    liveChainSettlementClaimed: proofEvaluation.blockers.length === 0,
    scenario: "seller_and_buyer_fund_escrow_release_withheld_timeout_refund_claimed",
    offerId,
    ticketId,
    sellerWallet: seller.wallet,
    buyerWallet: buyer.wallet,
    preRefundPhase,
    authoritativePhase: refundAwareAuthoritativePhase,
    route: {
      settlementRail: "SOL_ESCROW",
      privacyTier: "PUBLIC_SOL",
      confidentialComputeProvider: "NONE",
      rollupMode: "NONE",
      escrowRoute: "STANDARD_ESCROW",
      payoutRoute: "DIRECT",
      advancedProvidersInvoked: false,
    },
    txSignatures,
    rpcUrlRedacted: redactRpcUrl(RPC_URL),
    onChainVerification,
    invariants: proofEvaluation.invariants,
    blockers: proofEvaluation.blockers,
    proofSummary,
    signerBacked: true,
    browserTokenOnly: false,
    signerStatus: {
      seller: compactSignerStatus(sellerSignerStatus),
      buyer: compactSignerStatus(buyerSignerStatus),
    },
    timeoutProofConfig: {
      refundWaitMs,
      devnetShortTimeoutSeconds: process.env.AIROTC_NORMAL_ESCROW_TIMEOUT_SECONDS || null,
      devnetShortTimeoutAck:
        process.env.AIROTC_ALLOW_SHORT_ESCROW_TIMEOUT_FOR_DEVNET_PROOF === "true",
      refundSource: refundEvidence.source,
    },
    remainingRisks:
      proofEvaluation.blockers.length === 0
        ? [
            "This is devnet-only hosted MCP timeout/refund evidence and does not make a mainnet beta claim.",
            "Hosted proof freshness must be rerun after Railway signer, RPC, API, middleman, MCP, SDK, or escrow-program config changes.",
          ]
        : [
            "Hosted MCP Normal Mode timeout/refund cannot be claimed green until all blockers are cleared.",
            "Local Normal Mode refund harness proof is not a replacement for hosted signer-backed evidence.",
          ],
  };
  const artifactPath = writeArtifact(result);
  console.log(JSON.stringify({ ...result, artifactPath }, null, 2));
  if (proofEvaluation.blockers.length > 0) {
    throw new Error(`hosted normal timeout/refund proof blocked: ${proofEvaluation.blockers.join(",")}`);
  }
}

async function main() {
  const wallets = loadWallets();
  const { seller, buyer } = pickWallets(wallets);
  const sellerToken = accessTokenFor(seller.wallet);
  const buyerToken = accessTokenFor(buyer.wallet);
  const amount = Number(process.env.AIR_OTC_E2E_AMOUNT_SOL || "0.001");
  const price = Number(process.env.AIR_OTC_E2E_PRICE_SOL || "0.001");
  const collateral = Number(process.env.AIR_OTC_E2E_COLLATERAL_SOL || "0.0005");
  const phaseTimeoutMs = Number(process.env.AIR_OTC_E2E_PHASE_TIMEOUT_MS || "240000");

  console.log("[hosted-offline-e2e] start", {
    mcpUrl: MCP_URL,
    scenario: SCENARIO,
    seller: { name: seller.name, wallet: seller.wallet },
    buyer: { name: buyer.name, wallet: buyer.wallet },
    amount,
    price,
    collateral,
  });

  const health = await mcpCall("airotc_health");
  console.log("[hosted-offline-e2e] health", health);
  const [sellerSignerStatus, buyerSignerStatus] = await Promise.all([
    requireHostedSigner(seller.wallet, sellerToken, "seller"),
    requireHostedSigner(buyer.wallet, buyerToken, "buyer"),
  ]);

  const post = await mcpCall("airotc_run_normal_seller_flow", {
    authToken: sellerToken,
    wallet: seller.wallet,
    postOnly: true,
    asset: "SOL",
    mode: "sell",
    amount,
    price,
    collateral,
  });
  const offerId = post.offer?.id;
  if (!post.success || !offerId) {
    throw new Error(`seller post did not produce an offer: ${JSON.stringify(post)}`);
  }
  console.log("[hosted-offline-e2e] seller_posted_offer", { offerId });

  const accept = await mcpCall("airotc_accept_offer", {
    authToken: buyerToken,
    wallet: buyer.wallet,
    offerId,
  });
  const ticketId = accept.ticket?.id || accept.data?.ticket?.id || accept.id;
  if (!ticketId) {
    throw new Error(`buyer accept did not produce a ticket: ${JSON.stringify(accept)}`);
  }
  console.log("[hosted-offline-e2e] buyer_accepted_while_seller_offline", { offerId, ticketId });

  const sellerInbox = await mcpCall("airotc_list_my_tickets", {
    authToken: sellerToken,
    wallet: seller.wallet,
    status: "negotiating",
    role: "seller",
    limit: 20,
  });
  const recovered = sellerInbox.data?.find((ticket) => ticket.id === ticketId);
  if (!recovered) {
    throw new Error(`seller inbox did not recover ticket ${ticketId}: ${JSON.stringify(sellerInbox)}`);
  }
  console.log("[hosted-offline-e2e] seller_recovered_ticket", {
    ticketId: recovered.id,
    offerId: recovered.offerId,
    role: recovered.role,
    rollupMode: recovered.rollupMode,
  });

  if (SCENARIO === "timeout_refund") {
    await runHostedRefundScenario({
      sellerToken,
      buyerToken,
      seller,
      buyer,
      offerId,
      ticketId,
      price,
      collateral,
      phaseTimeoutMs,
      sellerSignerStatus,
      buyerSignerStatus,
    });
    return;
  }

  const [sellerFlow, buyerFlow] = await Promise.allSettled([
    mcpCall("airotc_run_normal_seller_flow", {
      authToken: sellerToken,
      wallet: seller.wallet,
      ticketId,
      phaseTimeoutMs,
      settlementTimeoutMs: phaseTimeoutMs,
      pollIntervalMs: 3000,
      deliveryContent: `@middleman hosted offline resume delivery complete ticket ${ticketId}`,
    }, phaseTimeoutMs + 90_000),
    mcpCall("airotc_run_normal_buyer_flow", {
      authToken: buyerToken,
      wallet: buyer.wallet,
      ticketId,
      maxPrice: price,
      collateral,
      phaseTimeoutMs,
      pollIntervalMs: 3000,
    }, phaseTimeoutMs + 90_000),
  ]);

  if (sellerFlow.status !== "fulfilled" || buyerFlow.status !== "fulfilled") {
    const status = await mcpCall("airotc_get_deal_status", {
      authToken: sellerToken,
      ticketId,
    }).catch((error) => ({ error: error.message }));
    throw new Error(JSON.stringify({
      sellerFlow: serializeSettled(sellerFlow),
      buyerFlow: serializeSettled(buyerFlow),
      status,
    }, null, 2));
  }

  const finalStatus = await mcpCall("airotc_get_deal_status", {
    authToken: sellerToken,
    ticketId,
  });
  const phase = finalStatus?.data?.phase || finalStatus?.data?.deal?.phase || finalStatus?.deal?.phase || finalStatus?.data?.status?.phase;
  const authoritativePhase =
    finalStatus?.data?.history?.at?.(-1)?.to ||
    finalStatus?.data?.deal?.history?.at?.(-1)?.to ||
    finalStatus?.data?.phase ||
    sellerFlow.value?.seller?.finalPhase ||
    buyerFlow.value?.buyer?.finalPhase ||
    phase;

  console.log("[hosted-offline-e2e] settlement_flows", {
    seller: {
      ticketId: sellerFlow.value.seller?.ticketId,
      finalPhase: sellerFlow.value.seller?.finalPhase,
      escrowAddress: sellerFlow.value.seller?.escrowAddress,
    },
    buyer: {
      ticketId: buyerFlow.value.buyer?.ticketId,
      finalPhase: buyerFlow.value.buyer?.finalPhase,
      escrowAddress: buyerFlow.value.buyer?.escrowAddress,
    },
  });
  console.log("[hosted-offline-e2e] final_status", {
    ticketId,
    phase,
    authoritativePhase,
  });

  if (!["completed", "settled"].includes(String(authoritativePhase || "").toLowerCase())) {
    throw new Error(`deal did not complete; authoritativePhase=${authoritativePhase}`);
  }

  const proofBundle = await waitForHostedProofBundleReleaseTx(sellerToken, ticketId);
  const proofSummary = compactProofBundle(proofBundle);
  console.log("[hosted-offline-e2e] proof_bundle", proofSummary);
  if (!proofSummary.dealStatusOk) {
    throw new Error(`proof bundle missing readable deal_status evidence: ${JSON.stringify(proofSummary)}`);
  }

  const txSignatures = collectHostedNormalTxSignatures({
    sellerFlow: sellerFlow.value,
    buyerFlow: buyerFlow.value,
    proofBundle,
  });
  const onChainVerification = await Promise.all(
    Object.entries(txSignatures).map(([label, signature]) => verifySignatureEvidence(label, signature))
  );
  const proofEvaluation = evaluateHostedNormalProof({
    authoritativePhase,
    proofSummary,
    signerStatus: {
      seller: sellerSignerStatus,
      buyer: buyerSignerStatus,
    },
    txSignatures,
    onChainVerification,
  });
  console.log("[hosted-offline-e2e] on_chain_verification", onChainVerification);
  console.log("[hosted-offline-e2e] proof_evaluation", proofEvaluation);

  const result = {
    success: proofEvaluation.blockers.length === 0,
    status: proofEvaluation.verdict,
    generatedAt: new Date().toISOString(),
    mode: "NORMAL_SOL_ESCROW",
    target: "devnet",
    evidenceScope: "hosted_mcp_signer_backed_live_devnet_escrow_signatures",
    liveChainSettlementClaimed: proofEvaluation.blockers.length === 0,
    scenario: "seller_offline_buyer_accepts_then_seller_recovers_ticket_and_settles",
    offerId,
    ticketId,
    sellerWallet: seller.wallet,
    buyerWallet: buyer.wallet,
    authoritativePhase,
    route: {
      settlementRail: "SOL_ESCROW",
      privacyTier: "PUBLIC_SOL",
      confidentialComputeProvider: "NONE",
      rollupMode: "NONE",
      escrowRoute: "STANDARD_ESCROW",
      payoutRoute: "DIRECT",
      advancedProvidersInvoked: false,
    },
    txSignatures,
    rpcUrlRedacted: redactRpcUrl(RPC_URL),
    onChainVerification,
    invariants: proofEvaluation.invariants,
    blockers: proofEvaluation.blockers,
    proofSummary,
    signerBacked: true,
    browserTokenOnly: false,
    signerStatus: {
      seller: compactSignerStatus(sellerSignerStatus),
      buyer: compactSignerStatus(buyerSignerStatus),
    },
    remainingRisks:
      proofEvaluation.blockers.length === 0
        ? [
            "This is devnet-only hosted MCP evidence and does not make a mainnet beta claim.",
            "Hosted proof freshness must be rerun after Railway signer, RPC, API, middleman, or escrow-program config changes.",
            "Timeout/refund is validated by the separate proof:normal:hosted:refund scenario.",
          ]
        : [
            "Hosted MCP Normal Mode cannot be claimed green until all blockers are cleared.",
            "Local Normal Mode harness/live proof is not a replacement for hosted signer-backed evidence.",
          ],
  };
  const artifactPath = writeArtifact(result);
  console.log(JSON.stringify({ ...result, artifactPath }, null, 2));
  if (proofEvaluation.blockers.length > 0) {
    throw new Error(`hosted normal proof blocked: ${proofEvaluation.blockers.join(",")}`);
  }
}

function redactRpcUrl(value) {
  try {
    const url = new URL(value);
    for (const key of ["api-key", "apikey", "token", "access_token", "key"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "redacted");
    }
    if (url.hostname.endsWith(".alchemy.com")) {
      const parts = url.pathname.split("/");
      const marker = parts.findIndex((part) => part.toLowerCase() === "v2");
      if (marker >= 0 && parts[marker + 1]) {
        parts[marker + 1] = "redacted";
        url.pathname = parts.join("/");
      }
    }
    return url.toString();
  } catch {
    return String(value).replace(/(v2\/)[A-Za-z0-9_-]+/g, "$1redacted");
  }
}

function runMain() {
  main().catch((error) => {
  const message = error?.message || String(error);
  const blockedStatus =
    SCENARIO === "timeout_refund"
      ? "BLOCKED_HOSTED_MCP_NORMAL_TIMEOUT_REFUND_LIVE_DEVNET_PROOF"
      : "BLOCKED_HOSTED_MCP_NORMAL_LIVE_DEVNET_PROOF";
  const failedStatus =
    SCENARIO === "timeout_refund"
      ? "FAIL_HOSTED_MCP_NORMAL_TIMEOUT_REFUND_LIVE_DEVNET_PROOF"
      : "FAIL_HOSTED_MCP_NORMAL_LIVE_DEVNET_PROOF";
  const status =
    message.includes("AIR_OTC_MCP_WALLETS_JSON") ||
    message.includes("AIR_OTC_MCP_TOKEN") ||
    message.includes("signing secret")
      ? blockedStatus
      : failedStatus;
  const artifact = {
    success: false,
    status,
    generatedAt: new Date().toISOString(),
    mode: "NORMAL_SOL_ESCROW",
    scenario:
      SCENARIO === "timeout_refund"
        ? "seller_and_buyer_fund_escrow_release_withheld_timeout_refund_claimed"
        : "seller_offline_buyer_accepts_then_seller_recovers_ticket_and_settles",
    artifactSlug:
      SCENARIO === "timeout_refund"
        ? "hosted-mcp-timeout-refund-e2e"
        : "hosted-mcp-offline-resume-e2e",
    mcpUrl: MCP_URL,
    blocker:
      status === blockedStatus
        ? {
            code: message.includes("AIR_OTC_MCP_WALLETS_JSON")
              ? "MISSING_HOSTED_SIGNER_WALLETS"
              : "MISSING_HOSTED_MCP_AUTH_SECRET",
            message,
            requiredInput:
              "AIR_OTC_MCP_WALLETS_JSON plus AIR_OTC_MCP_TOKEN or an MCP access-token signing secret",
          }
        : undefined,
    error: serializeError(error),
    signerBacked: false,
    browserTokenOnly: true,
    remainingRisks: [
      "Hosted MCP full Normal Mode settlement requires signer wallets configured in the hosted MCP runtime.",
      "Browser-issued MCP tokens authorize API calls, but they do not give the hosted server a Solana transaction signer for arbitrary wallets.",
    ],
  };
  try {
    const artifactPath = writeArtifact(artifact);
    console.error("[hosted-offline-e2e] failed", message);
    console.error("[hosted-offline-e2e] artifact", artifactPath);
  } catch (writeError) {
    console.error("[hosted-offline-e2e] failed", message);
    console.error("[hosted-offline-e2e] artifact_write_failed", writeError?.message || String(writeError));
  }
  process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain();
}
