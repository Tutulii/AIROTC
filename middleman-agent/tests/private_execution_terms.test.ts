import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { sealPrivateExecutionTerms, revealPrivateExecutionTerms } from "../src/services/privateExecutionTerms";
import { createDealPipeline } from "../src/services/dealPipeline";
import type { AttestedEscrowIntent, PrivateExecutionTermsSnapshot } from "../src/types/dealPipeline";
import { computeFundingCommitmentHash } from "../src/protocol/privateHandoffProtocol";

const testKey = Buffer.alloc(32, 7);
const testKeyBase64 = testKey.toString("base64");

function buildTermsHash(input: {
  sessionPda: string;
  agreedAsset: string;
  agreedPriceLamports: string;
  buyerCollateralLamports: string;
  sellerCollateralLamports: string;
  observedStatus: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      [
        input.sessionPda,
        input.agreedAsset,
        input.agreedPriceLamports,
        input.buyerCollateralLamports,
        input.sellerCollateralLamports,
        input.observedStatus,
      ].join(":")
    )
    .digest("hex");
}

describe("privateExecutionTerms", () => {
  it("seals PER execution terms so plaintext is absent from the durable snapshot", () => {
    const originalKey = process.env.PRIVATE_EXECUTION_TERMS_KEY;
    process.env.PRIVATE_EXECUTION_TERMS_KEY = testKeyBase64;
    const executionTerms: PrivateExecutionTermsSnapshot = {
      agreedPriceLamports: "3000000",
      agreedAsset: "SOL",
      buyerCollateralLamports: "1000000",
      sellerCollateralLamports: "2000000",
      observedStatus: "consensusReached",
    };
    const termsHash = buildTermsHash({
      sessionPda: "session-1",
      ...executionTerms,
    });

    const sealed = sealPrivateExecutionTerms(
      {
        ticketId: "ticket-1",
        intentId: "intent-1",
        sessionPda: "session-1",
        termsHash,
        executionTerms,
      }
    );

    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain("3000000");
    expect(serialized).not.toContain("1000000");
    expect(serialized).not.toContain("2000000");
    expect(serialized).not.toContain("buyerCollateralLamports");

    const revealed = revealPrivateExecutionTerms(
      {
        ticketId: "ticket-1",
        intentId: "intent-1",
        sessionPda: "session-1",
        termsHash,
        sealedExecutionTerms: sealed,
      }
    );

    expect(revealed).toEqual(executionTerms);
    process.env.PRIVATE_EXECUTION_TERMS_KEY = originalKey;
  });

  it("lets the pipeline rebuild a PER outcome from sealed terms without re-reading live plaintext", async () => {
    const originalKey = process.env.PRIVATE_EXECUTION_TERMS_KEY;
    process.env.PRIVATE_EXECUTION_TERMS_KEY = testKeyBase64;
    const buyer = Keypair.generate().publicKey.toBase58();
    const seller = Keypair.generate().publicKey.toBase58();
    const buyerCt = Keypair.generate().publicKey.toBase58();
    const sellerCt = Keypair.generate().publicKey.toBase58();
    const paymentCt = Keypair.generate().publicKey.toBase58();
    const resultCt = Keypair.generate().publicKey.toBase58();
    const networkEncryptionKeyPda = Keypair.generate().publicKey.toBase58();
    const executionTerms: PrivateExecutionTermsSnapshot = {
      agreedPriceLamports: "3000000",
      agreedAsset: "SOL",
      buyerCollateralLamports: "1000000",
      sellerCollateralLamports: "2000000",
      observedStatus: "confidentialHandoff",
    };
    const sessionPda = Keypair.generate().publicKey.toBase58();
    const termsHash = buildTermsHash({
      sessionPda,
      ...executionTerms,
    });

    const intent: AttestedEscrowIntent = {
      intentId: "intent-1",
      ticketId: "ticket-1",
      rollupMode: "PER",
      negotiationSource: "PER",
      buyer,
      seller,
      sessionPda,
      assetMint: "So11111111111111111111111111111111111111112",
      sealedExecutionTerms: sealPrivateExecutionTerms(
        {
          ticketId: "ticket-1",
          intentId: "intent-1",
          sessionPda,
          termsHash,
          executionTerms,
        }
      ),
      termsHash,
      fundingCommitments: {
        buyerPaymentHash: computeFundingCommitmentHash({
          sessionPda,
          role: "buyer_payment",
          termsHash,
          amountLamports: executionTerms.agreedPriceLamports,
        }),
        buyerCollateralHash: computeFundingCommitmentHash({
          sessionPda,
          role: "buyer_collateral",
          termsHash,
          amountLamports: executionTerms.buyerCollateralLamports,
        }),
        sellerCollateralHash: computeFundingCommitmentHash({
          sessionPda,
          role: "seller_collateral",
          termsHash,
          amountLamports: executionTerms.sellerCollateralLamports,
        }),
      },
      encryptedTerms: {
        buyerCollateral: {
          identifierHex: "01",
          account: buyerCt,
          fheType: 1,
        },
        sellerCollateral: {
          identifierHex: "02",
          account: sellerCt,
          fheType: 1,
        },
        paymentAmount: {
          identifierHex: "03",
          account: paymentCt,
          fheType: 1,
        },
        settlementResult: {
          identifierHex: "04",
          account: resultCt,
          fheType: 1,
        },
        networkEncryptionKeyPda,
      },
      evidence: {
        kind: "magicblock_per_live_state",
        teeRpcUrl: "https://tee.example",
        sessionPda,
        observedAt: new Date().toISOString(),
        verifierWallet: buyer,
        integrityVerified: true,
        sourceEvent: "ROLLUP_CONSENSUS_REACHED",
        termsHash,
        remoteAttestation: {
          verificationApi: "fast-quote",
          verifiedAt: new Date().toISOString(),
          challengeBase64: "challenge",
          quoteBase64: "quote",
          quoteSha256: "sha",
        },
      },
      status: "consensus_confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const pipeline = createDealPipeline({
      loadConfig: () => ({ enableConfidentialEscrow: true } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue({
          ticket_id: "ticket-1",
          offer_id: "offer-1",
          buyer,
          seller,
          status: "active",
          rollup_mode: "PER",
          tokenMint: "So11111111111111111111111111111111111111112",
          decimals: 9,
          created_at: new Date().toISOString(),
        }),
        recordNegotiatedTerms: vi.fn(),
      },
      privateEscrowIntentStore: { updateStatus: vi.fn() },
      dealTracker: {
        initDeal: vi.fn(),
        storeOnChainId: vi.fn(),
        updateStatus: vi.fn(),
      },
      getPrivacyStatus: vi.fn(),
      pipelineStateStore: {
        markStage: vi.fn(),
        markRouteSelected: vi.fn(),
        getLatestStage: vi.fn(),
      },
      eventBus: { publish: vi.fn() },
      appendAuditLog: vi.fn(),
      executeCreateDealPhase: vi.fn(),
      isConfidentialEscrowReady: vi.fn(),
      initConfidentialEscrow: vi.fn(),
      executeConfidentialDeal: vi.fn(),
      authorizeConfidentialRelease: vi.fn(),
      executeConfidentialRelease: vi.fn(),
      releaseApprovalService: {
        initializeApprovalRequests: vi.fn(),
        getLatestState: vi.fn(),
        maybeAuthorizeRelease: vi.fn(),
        markReleaseSigned: vi.fn(),
        markReleaseExecuted: vi.fn(),
      },
      verifyNegotiationForExecution: vi.fn(),
      prepareSettlementAddressPlan: vi.fn(),
      prepareStealthSettlement: vi.fn(),
      executeStealthSettlement: vi.fn(),
      activateStandardEscrowLifecycle: vi.fn(),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn(),
        completeTicketSession: vi.fn(),
        fetchLiveTerms: vi.fn(),
        fetchLivePrivateHandoffProof: vi.fn().mockResolvedValue({
          sessionPda,
          buyer,
          seller,
          status: "confidentialHandoff",
          termsHash,
          buyerPaymentFundingHash: intent.fundingCommitments.buyerPaymentHash,
          buyerCollateralFundingHash: intent.fundingCommitments.buyerCollateralHash,
          sellerCollateralFundingHash: intent.fundingCommitments.sellerCollateralHash,
          buyerCollateralCiphertext: buyerCt,
          sellerCollateralCiphertext: sellerCt,
          paymentAmountCiphertext: paymentCt,
          settlementResultCiphertext: resultCt,
          networkEncryptionKeyPda,
          proofRecordedAt: new Date().toISOString(),
        }),
      },
    } as any);

    const outcome = await pipeline.buildNegotiationOutcomeFromPrivateIntent(intent);

    expect(outcome).toMatchObject({
      ticketId: "ticket-1",
      buyer,
      seller,
      price: 0,
      collateralBuyer: 0,
      collateralSeller: 0,
      assetType: "So11111111111111111111111111111111111111112",
      rollupMode: "PER",
      negotiationSource: "PER",
      termsVisibility: "REDACTED",
    });
    process.env.PRIVATE_EXECUTION_TERMS_KEY = originalKey;
  });
});
