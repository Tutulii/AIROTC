import { createHash } from "crypto";

export type ConfidentialFundingRole =
  | "buyer_payment"
  | "buyer_collateral"
  | "seller_collateral";

export interface PrivateCiphertextHandlePayload {
  identifierHex: string;
  account: string;
  fheType: number;
}

export interface ConfidentialFundingCommitments {
  buyerPaymentHash: string;
  buyerCollateralHash: string;
  sellerCollateralHash: string;
}

export interface PerPrivateHandoffBundle {
  version: 1;
  sessionPda: string;
  assetMint: string;
  assetSymbol?: string;
  termsNonceHex: string;
  termsHash: string;
  encryptedTerms: {
    buyerCollateral: PrivateCiphertextHandlePayload;
    sellerCollateral: PrivateCiphertextHandlePayload;
    paymentAmount: PrivateCiphertextHandlePayload;
    settlementResult: PrivateCiphertextHandlePayload;
    networkEncryptionKeyPda: string;
  };
  fundingCommitments: ConfidentialFundingCommitments;
}

export interface FundingCommitmentInput {
  sessionPda: string;
  role: ConfidentialFundingRole;
  termsHash: string;
  amountLamports: bigint | number | string;
}

export function normalizeHash32(value: string, field: string): string {
  const normalized = value.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`invalid_private_handoff_${field}`);
  }
  return normalized;
}

export function normalizeNonceHex32(value: string, field: string): string {
  return normalizeHash32(value, field);
}

export function computePrivateTermsHash(input: {
  sessionPda: string;
  assetMint: string;
  priceLamports: bigint | number | string;
  buyerCollateralLamports: bigint | number | string;
  sellerCollateralLamports: bigint | number | string;
  status?: string;
  termsNonceHex?: string;
}): string {
  const nonceHex = input.termsNonceHex
    ? normalizeNonceHex32(input.termsNonceHex, "termsNonceHex")
    : null;
  return createHash("sha256")
    .update(
      [
        input.sessionPda,
        input.assetMint,
        BigInt(input.priceLamports).toString(),
        BigInt(input.buyerCollateralLamports).toString(),
        BigInt(input.sellerCollateralLamports).toString(),
        input.status || "confidentialHandoff",
        nonceHex || "legacy-no-terms-nonce",
      ].join(":"),
      "utf8"
    )
    .digest("hex");
}

export function computeFundingCommitmentHash(input: FundingCommitmentInput): string {
  const normalized = JSON.stringify({
    amountLamports: BigInt(input.amountLamports).toString(),
    role: input.role,
    sessionPda: input.sessionPda,
    termsHash: normalizeHash32(input.termsHash, "termsHash"),
    version: 1,
  });
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
