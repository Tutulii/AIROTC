import type { ConfidentialFundingRole } from "./privateHandoffProtocol";

export type ConfidentialFundingRequestKind = "BUYER_FUNDING" | "SELLER_FUNDING";
export type ConfidentialFundingPartyRole = "buyer" | "seller";
export type FundingPrivacyTier = "DIRECT_SOL" | "STEALTH_SOL" | "SHIELDED_CREDIT";

export interface ConfidentialFundingRoleInstruction {
  fundingRole: ConfidentialFundingRole;
  fundingHash: string;
  amountCommitment?: string;
}

export interface ConfidentialFundingSummary {
  ticketId: string;
  role: ConfidentialFundingPartyRole;
  counterparty: string;
  asset: string;
  buyerPayment: number;
  buyerCollateral: number;
  sellerCollateral: number;
  settlementMode: "Public wallet settlement" | "Stealth settlement";
  actionLabel: string;
  expiresAt: string;
  redacted?: boolean;
  localTermsRequired?: boolean;
}

export interface ConfidentialFundingRequestEnvelope {
  version?: 1 | 2;
  requestId: string;
  ticketId: string;
  role: ConfidentialFundingPartyRole;
  requestKind: ConfidentialFundingRequestKind;
  fundingRail?: FundingPrivacyTier;
  summary: ConfidentialFundingSummary;
  dealPda: string;
  sessionPda: string;
  intentId?: string;
  termsHash: string;
  vaultPda?: string;
  creditAccountPda?: string;
  requiredCreditLamports?: string;
  instructions: ConfidentialFundingRoleInstruction[];
  issuedAt: string;
}

export interface ConfidentialFundingSubmissionRecord {
  agentId: string;
  wallet: string;
  fundingRail?: FundingPrivacyTier;
  transactionSignatures: string[];
  observedFundingRoleAmounts?: Partial<Record<ConfidentialFundingRole, string>>;
  recordedAt: string;
  active: boolean;
}

export interface ConfidentialFundingAmountsSnapshot {
  buyerPaymentLamports?: string;
  buyerCollateralLamports?: string;
  sellerCollateralLamports?: string;
}

export interface ConfidentialFundingStateSnapshot {
  ticketId: string;
  dealPda: string;
  sessionPda: string;
  intentId?: string;
  buyerWallet: string;
  sellerWallet: string;
  buyerFundingWallet?: string;
  sellerFundingWallet?: string;
  buyerSettlementTarget: string;
  sellerSettlementTarget: string;
  dwalletPda?: string;
  termsHash: string;
  planHash: string;
  requestIssuedAt: string;
  buyerRequest: ConfidentialFundingRequestEnvelope;
  sellerRequest: ConfidentialFundingRequestEnvelope;
  buyerFunding?: ConfidentialFundingSubmissionRecord;
  sellerFunding?: ConfidentialFundingSubmissionRecord;
  fundingAmounts?: ConfidentialFundingAmountsSnapshot;
  allFundingRecorded: boolean;
  txSignatures: string[];
  updatedAt: string;
}
