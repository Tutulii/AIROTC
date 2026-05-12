import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { AttestedEscrowIntent } from "../src/types/dealPipeline";
import {
  revealPrivateMetadata,
  type SealedPrivateMetadataEnvelope,
} from "../src/services/privateMetadataSeal";

const mocks = vi.hoisted(() => ({
  appendAuditLog: vi.fn(),
}));

vi.mock("../src/services/auditTrail", () => ({
  appendAuditLog: mocks.appendAuditLog,
  appendAuditLogStrict: mocks.appendAuditLog,
}));

const ORIGINAL_KEY = process.env.PRIVATE_EXECUTION_TERMS_KEY;
const TEST_KEY = Buffer.alloc(32, 11).toString("base64");

function buildIntent(): AttestedEscrowIntent {
  return {
    intentId: "intent-1",
    ticketId: "ticket-1",
    rollupMode: "PER",
    negotiationSource: "PER",
    buyer: Keypair.generate().publicKey.toBase58(),
    seller: Keypair.generate().publicKey.toBase58(),
    sessionPda: Keypair.generate().publicKey.toBase58(),
    assetMint: "So11111111111111111111111111111111111111112",
    executionTerms: {
      agreedPriceLamports: "5000000000",
      agreedAsset: "SOL",
      buyerCollateralLamports: "2000000000",
      sellerCollateralLamports: "2000000000",
      observedStatus: "confidentialHandoff",
    },
    termsHash: "a".repeat(64),
    fundingCommitments: {
      buyerPaymentHash: "b".repeat(64),
      buyerCollateralHash: "c".repeat(64),
      sellerCollateralHash: "d".repeat(64),
    },
    encryptedTerms: {
      buyerCollateral: {
        identifierHex: "01",
        account: Keypair.generate().publicKey.toBase58(),
        fheType: 1,
      },
      sellerCollateral: {
        identifierHex: "02",
        account: Keypair.generate().publicKey.toBase58(),
        fheType: 1,
      },
      paymentAmount: {
        identifierHex: "03",
        account: Keypair.generate().publicKey.toBase58(),
        fheType: 1,
      },
      settlementResult: {
        identifierHex: "04",
        account: Keypair.generate().publicKey.toBase58(),
        fheType: 1,
      },
      networkEncryptionKeyPda: Keypair.generate().publicKey.toBase58(),
    },
    evidence: {
      kind: "magicblock_per_live_state",
      teeRpcUrl: "https://tee.example",
      sessionPda: Keypair.generate().publicKey.toBase58(),
      observedAt: new Date().toISOString(),
      verifierWallet: Keypair.generate().publicKey.toBase58(),
      integrityVerified: true,
      sourceEvent: "ROLLUP_CONSENSUS_REACHED",
      termsHash: "a".repeat(64),
      remoteAttestation: {
        verificationApi: "fast-quote",
        verifiedAt: new Date().toISOString(),
        challengeBase64: "challenge",
        quoteBase64: "quote",
        quoteSha256: "e".repeat(64),
      },
    },
    status: "consensus_confirmed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("PER plaintext persistence guard", () => {
  beforeEach(() => {
    mocks.appendAuditLog.mockReset();
    process.env.PRIVATE_EXECUTION_TERMS_KEY = TEST_KEY;
  });

  afterEach(() => {
    process.env.PRIVATE_EXECUTION_TERMS_KEY = ORIGINAL_KEY;
  });

  it("stores sealed intent snapshots without persisting plaintext execution terms", async () => {
    const { privateEscrowIntentStore } = await import("../src/state/privateEscrowIntentStore");

    await privateEscrowIntentStore.save(buildIntent());

    expect(mocks.appendAuditLog).toHaveBeenCalledOnce();
    const [, event, persisted] = mocks.appendAuditLog.mock.calls[0] as [
      string,
      string,
      SealedPrivateMetadataEnvelope,
    ];

    expect(event).toBe("per_attested_escrow_intent_snapshot");
    expect(persisted.kind).toBe("per_attested_escrow_intent_snapshot");
    expect(persisted.sealed).toBeDefined();

    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain("5000000000");
    expect(serialized).not.toContain("2000000000");
    expect(serialized).not.toContain("agreedPriceLamports");
    expect(serialized).not.toContain("buyerCollateralLamports");
    expect(serialized).not.toContain("sellerCollateralLamports");

    const revealed = revealPrivateMetadata<AttestedEscrowIntent>(persisted);
    expect(revealed.executionTerms).toBeUndefined();
    expect(revealed.sealedExecutionTerms).toBeDefined();
  });
});
