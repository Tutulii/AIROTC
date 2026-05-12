import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import crypto from "crypto";
import { EncryptService, FheType } from "./encryptService";
import {
  computeFundingCommitmentHash,
  computePrivateTermsHash,
  type PerPrivateHandoffBundle,
} from "../protocol/privateHandoffProtocol";
import { MeridianOtcGuard } from "./meridianOtcGuard";

export interface PrivateHandoffBundleTermsInput {
  sessionPda: string;
  assetMint: string;
  assetSymbol?: string;
  priceLamports: bigint;
  buyerCollateralLamports: bigint;
  sellerCollateralLamports: bigint;
  status?: string;
}

export interface BuildPrivateHandoffBundleInput extends PrivateHandoffBundleTermsInput {
  connection: Connection;
  payer: Keypair;
  authorizedProgram: PublicKey;
}

function encodeUint64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function toCiphertextHandle(result: { ciphertextIdentifiers: Buffer[] }, fheType: number) {
  const identifier = result.ciphertextIdentifiers[0];
  if (!identifier) {
    throw new Error("Encrypt gRPC did not return a ciphertext identifier");
  }
  return {
    identifierHex: Buffer.from(identifier).toString("hex"),
    account: new PublicKey(identifier).toBase58(),
    fheType,
  };
}

export async function buildPrivateHandoffBundleFromTerms(
  input: BuildPrivateHandoffBundleInput
): Promise<PerPrivateHandoffBundle> {
  const encryptService = new EncryptService(input.connection, input.payer);
  const normalizedAssetMint =
    MeridianOtcGuard.normalizeSupportedAsset(input.assetMint) ||
    input.assetMint;

  try {
    const networkEncryptionKeyPda = await encryptService.findNetworkEncryptionKey();
    const networkEncryptionKeyInfo = await input.connection.getAccountInfo(
      networkEncryptionKeyPda,
      "confirmed"
    );
    if (!networkEncryptionKeyInfo || networkEncryptionKeyInfo.data.length < 34) {
      throw new Error(
        `Invalid NetworkEncryptionKey account: ${networkEncryptionKeyPda.toBase58()}`
      );
    }

    const networkEncryptionPublicKey = Buffer.from(
      networkEncryptionKeyInfo.data.subarray(2, 34)
    );

    const [buyerCtRaw, sellerCtRaw, paymentCtRaw, resultCtRaw] = await Promise.all([
      encryptService.createInputViaGrpc(
        encodeUint64(input.buyerCollateralLamports),
        FheType.Uint64,
        input.authorizedProgram,
        networkEncryptionPublicKey
      ),
      encryptService.createInputViaGrpc(
        encodeUint64(input.sellerCollateralLamports),
        FheType.Uint64,
        input.authorizedProgram,
        networkEncryptionPublicKey
      ),
      encryptService.createInputViaGrpc(
        encodeUint64(input.priceLamports),
        FheType.Uint64,
        input.authorizedProgram,
        networkEncryptionPublicKey
      ),
      encryptService.createInputViaGrpc(
        encodeUint64(0n),
        FheType.Uint64,
        input.authorizedProgram,
        networkEncryptionPublicKey
      ),
    ]);

    const termsNonceHex = crypto
      .createHash("sha256")
      .update(
        [
          input.sessionPda,
          normalizedAssetMint,
          input.status || "confidentialHandoff",
          "per-handoff-bundle-v1",
        ].join(":"),
        "utf8"
      )
      .digest("hex");
    const saltedTermsHash = computePrivateTermsHash({
      sessionPda: input.sessionPda,
      assetMint: normalizedAssetMint,
      priceLamports: input.priceLamports,
      buyerCollateralLamports: input.buyerCollateralLamports,
      sellerCollateralLamports: input.sellerCollateralLamports,
      status: input.status || "confidentialHandoff",
      termsNonceHex,
    });

    return {
      version: 1,
      sessionPda: input.sessionPda,
      assetMint: normalizedAssetMint,
      assetSymbol: input.assetSymbol,
      termsNonceHex,
      termsHash: saltedTermsHash,
      encryptedTerms: {
        buyerCollateral: toCiphertextHandle(buyerCtRaw, FheType.Uint64),
        sellerCollateral: toCiphertextHandle(sellerCtRaw, FheType.Uint64),
        paymentAmount: toCiphertextHandle(paymentCtRaw, FheType.Uint64),
        settlementResult: toCiphertextHandle(resultCtRaw, FheType.Uint64),
        networkEncryptionKeyPda: networkEncryptionKeyPda.toBase58(),
      },
      fundingCommitments: {
        buyerPaymentHash: computeFundingCommitmentHash({
          sessionPda: input.sessionPda,
          role: "buyer_payment",
          termsHash: saltedTermsHash,
          amountLamports: input.priceLamports,
        }),
        buyerCollateralHash: computeFundingCommitmentHash({
          sessionPda: input.sessionPda,
          role: "buyer_collateral",
          termsHash: saltedTermsHash,
          amountLamports: input.buyerCollateralLamports,
        }),
        sellerCollateralHash: computeFundingCommitmentHash({
          sessionPda: input.sessionPda,
          role: "seller_collateral",
          termsHash: saltedTermsHash,
          amountLamports: input.sellerCollateralLamports,
        }),
      },
    };
  } finally {
    encryptService.close();
  }
}
