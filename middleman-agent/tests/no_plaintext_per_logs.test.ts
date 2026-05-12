import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { PerPrivateHandoffBundle } from "../src/protocol/privateHandoffProtocol";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
}));

vi.mock("../src/utils/logger", () => ({
  logger: {
    info: mocks.info,
  },
}));

vi.mock("../src/config", () => ({
  loadConfig: vi.fn(() => ({
    privateKey: "test-private-key",
  })),
}));

vi.mock("../src/solana/wallet", () => ({
  loadWallet: vi.fn(() => Keypair.generate()),
}));

vi.mock("../src/services/magicblockTeeAttestationService", () => ({
  fetchAndVerifyTeeRemoteAttestation: vi.fn(async () => ({
    verificationApi: "fast-quote",
    verifiedAt: new Date().toISOString(),
    challengeBase64: "challenge",
    quoteBase64: "quote",
    quoteSha256: "f".repeat(64),
  })),
}));

function buildBundle(): PerPrivateHandoffBundle {
  return {
    version: 1,
    sessionPda: Keypair.generate().publicKey.toBase58(),
    assetMint: "So11111111111111111111111111111111111111112",
    assetSymbol: "SOL",
    termsNonceHex: "b".repeat(64),
    termsHash: "a".repeat(64),
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
    fundingCommitments: {
      buyerPaymentHash: "b".repeat(64),
      buyerCollateralHash: "c".repeat(64),
      sellerCollateralHash: "d".repeat(64),
    },
  };
}

describe("PER plaintext log guard", () => {
  it("logs only opaque PER handoff metadata during intent creation", async () => {
    mocks.info.mockReset();
    const { buildPrivateEscrowIntentFromBundle } = await import(
      "../src/services/perEscrowIntentService"
    );

    await buildPrivateEscrowIntentFromBundle({
      ticketId: "ticket-opaque-1",
      buyer: Keypair.generate().publicKey.toBase58(),
      seller: Keypair.generate().publicKey.toBase58(),
      bundle: buildBundle(),
    });

    expect(mocks.info).toHaveBeenCalledWith(
      "per_attested_escrow_intent_created_from_bundle",
      expect.objectContaining({
        ticket_id: "ticket-opaque-1",
        termsHash: "a".repeat(64),
      })
    );

    const loggedPayload = JSON.stringify(mocks.info.mock.calls[0]?.[1] ?? {});
    expect(loggedPayload).not.toContain("5000000000");
    expect(loggedPayload).not.toContain("2000000000");
    expect(loggedPayload).not.toContain("agreedPriceLamports");
    expect(loggedPayload).not.toContain("buyerCollateralLamports");
    expect(loggedPayload).not.toContain("sellerCollateralLamports");
  });
});
