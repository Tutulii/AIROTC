import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectHostedNormalRefundTxSignatures,
  collectHostedNormalTxSignatures,
  evaluateHostedNormalProof,
  evaluateHostedNormalRefundProof,
  extractRefundTxFromProofBundle,
  extractReleaseTxFromProofBundle,
  isSolanaSignature,
} from "./hosted-mcp-offline-resume-e2e.mjs";

const SIG_A = "5rDcZ6AZVZ8r1QjQ1cW7eV6xnF1Ah8wcguv1fc69m1fAK9F4oJZZz7P3YRta5YHwy5E7kTn6aXVvS2vjW6Kf9b8";
const SIG_B = "4jZ7uD3JPWnvbfyQk3SUQYh3N7F9uSyHLJGSkrt5ABxv1bmR7kBBpyrLUegf9XjM8y8Fdk6HNrKcAVdHngYM9aYo";
const SIG_C = "3tzSXWgJFH9buEcbX3F6KZYuvJXoALFRYxMqVTSMtE63sS2b1tD8HLCrLw98k9KZ3NpqCZ6xusENv4zjeA8pH2rS";
const SIG_D = "2ziJ1eRcfmtNTTrjnTwwieCLsucSz8eckcZPpF4STg1RVbNCh7bB6k1bRDiAfmBYvD7Fb5N6brVbdggfhUoGcxV";

function signerStatus() {
  return {
    normalMode: {
      canSettleWithHostedSigner: true,
    },
  };
}

function proofSummary(overrides = {}) {
  return {
    dealStatusOk: true,
    timelineOk: true,
    auditOk: true,
    failedLabels: [],
    ...overrides,
  };
}

function confirmedChecks() {
  return [
    { label: "sellerCollateralTx", ok: true },
    { label: "buyerCollateralTx", ok: true },
    { label: "buyerPaymentTx", ok: true },
    { label: "releaseTx", ok: true },
  ];
}

test("hosted MCP proof helpers extract release tx from timeline payloads", () => {
  const bundle = {
    entries: [
      {
        label: "timeline",
        ok: true,
        data: {
          timeline: [
            {
              type: "audit",
              event: "funds_released",
              details: {
                payload: JSON.stringify({ tx: SIG_D }),
              },
            },
          ],
        },
      },
    ],
  };

  assert.equal(extractReleaseTxFromProofBundle(bundle), SIG_D);
});

test("hosted MCP proof helpers collect all required Normal Mode tx signatures", () => {
  const signatures = collectHostedNormalTxSignatures({
    sellerFlow: { seller: { sellerCollateralTx: SIG_A } },
    buyerFlow: { buyer: { buyerCollateralTx: SIG_B, buyerPaymentTx: SIG_C } },
    proofBundle: {
      entries: [
        {
          label: "audit",
          ok: true,
          data: [{ event: "release_funds", tx: SIG_D }],
        },
      ],
    },
  });

  assert.deepEqual(signatures, {
    sellerCollateralTx: SIG_A,
    buyerCollateralTx: SIG_B,
    buyerPaymentTx: SIG_C,
    releaseTx: SIG_D,
  });
  assert.equal(Object.values(signatures).every(isSolanaSignature), true);
});

test("hosted MCP refund proof helpers extract refund tx from audit payloads", () => {
  const bundle = {
    entries: [
      {
        label: "audit",
        ok: true,
        data: [
          {
            event: "timeout_refund_claimed",
            details: {
              payload: JSON.stringify({ tx: SIG_D }),
            },
          },
        ],
      },
    ],
  };

  assert.equal(extractRefundTxFromProofBundle(bundle), SIG_D);
});

test("hosted MCP refund proof helpers collect all required refund tx signatures", () => {
  const signatures = collectHostedNormalRefundTxSignatures({
    sellerFlow: { seller: { sellerCollateralTx: SIG_A } },
    buyerFlow: { buyer: { buyerCollateralTx: SIG_B, buyerPaymentTx: SIG_C } },
    refundFlow: { refund: { refundTx: SIG_D } },
    proofBundle: {},
  });

  assert.deepEqual(signatures, {
    sellerCollateralTx: SIG_A,
    buyerCollateralTx: SIG_B,
    buyerPaymentTx: SIG_C,
    refundTx: SIG_D,
  });
  assert.equal(Object.values(signatures).every(isSolanaSignature), true);
});

test("hosted MCP proof evaluation passes only with hosted signers, readable proof, completed phase, and confirmed signatures", () => {
  const result = evaluateHostedNormalProof({
    authoritativePhase: "completed",
    proofSummary: proofSummary(),
    signerStatus: {
      seller: signerStatus(),
      buyer: signerStatus(),
    },
    txSignatures: {
      sellerCollateralTx: SIG_A,
      buyerCollateralTx: SIG_B,
      buyerPaymentTx: SIG_C,
      releaseTx: SIG_D,
    },
    onChainVerification: confirmedChecks(),
  });

  assert.equal(result.verdict, "PASS_HOSTED_MCP_NORMAL_LIVE_DEVNET_PROOF");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.invariants.every((entry) => entry.passed), true);
});

test("hosted MCP proof evaluation fails closed for browser-token-only and missing release evidence", () => {
  const result = evaluateHostedNormalProof({
    authoritativePhase: "completed",
    proofSummary: proofSummary({ failedLabels: [{ label: "authority_governance", error: "404" }] }),
    signerStatus: {
      seller: { normalMode: { canSettleWithHostedSigner: false } },
      buyer: signerStatus(),
    },
    txSignatures: {
      sellerCollateralTx: SIG_A,
      buyerCollateralTx: SIG_B,
      buyerPaymentTx: SIG_C,
      releaseTx: null,
    },
    onChainVerification: [
      { label: "sellerCollateralTx", ok: true },
      { label: "buyerCollateralTx", ok: true },
      { label: "buyerPaymentTx", ok: true },
      { label: "releaseTx", ok: false },
    ],
  });

  assert.equal(result.verdict, "BLOCKED_HOSTED_MCP_NORMAL_LIVE_DEVNET_PROOF");
  assert(result.blockers.includes("seller_hosted_signer_not_ready"));
  assert(result.blockers.includes("releaseTx_missing_fresh_signature"));
  assert(result.blockers.includes("releaseTx_not_confirmed_on_devnet"));
  assert(result.blockers.includes("proof_bundle_has_failed_labels"));
});

test("hosted MCP timeout/refund evaluation passes only with funded non-released deal and confirmed refund", () => {
  const result = evaluateHostedNormalRefundProof({
    authoritativePhase: "refunded",
    preRefundPhase: "awaiting_release",
    proofSummary: proofSummary(),
    signerStatus: {
      seller: signerStatus(),
      buyer: signerStatus(),
    },
    txSignatures: {
      sellerCollateralTx: SIG_A,
      buyerCollateralTx: SIG_B,
      buyerPaymentTx: SIG_C,
      refundTx: SIG_D,
    },
    onChainVerification: [
      { label: "sellerCollateralTx", ok: true },
      { label: "buyerCollateralTx", ok: true },
      { label: "buyerPaymentTx", ok: true },
      { label: "refundTx", ok: true },
    ],
  });

  assert.equal(result.verdict, "PASS_HOSTED_MCP_NORMAL_TIMEOUT_REFUND_LIVE_DEVNET_PROOF");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.invariants.every((entry) => entry.passed), true);
});

test("hosted MCP timeout/refund evaluation fails closed if deal already completed or refund tx is missing", () => {
  const result = evaluateHostedNormalRefundProof({
    authoritativePhase: "completed",
    preRefundPhase: "completed",
    proofSummary: proofSummary(),
    signerStatus: {
      seller: signerStatus(),
      buyer: signerStatus(),
    },
    txSignatures: {
      sellerCollateralTx: SIG_A,
      buyerCollateralTx: SIG_B,
      buyerPaymentTx: SIG_C,
      refundTx: null,
    },
    onChainVerification: [
      { label: "sellerCollateralTx", ok: true },
      { label: "buyerCollateralTx", ok: true },
      { label: "buyerPaymentTx", ok: true },
      { label: "refundTx", ok: false },
    ],
  });

  assert.equal(result.verdict, "BLOCKED_HOSTED_MCP_NORMAL_TIMEOUT_REFUND_LIVE_DEVNET_PROOF");
  assert(result.blockers.includes("final_ticket_phase_not_refunded"));
  assert(result.blockers.includes("pre_refund_phase_was_already_completed"));
  assert(result.blockers.includes("refundTx_missing_fresh_signature"));
  assert(result.blockers.includes("refundTx_not_confirmed_on_devnet"));
});
