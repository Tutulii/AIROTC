import type { RollupMode } from "./ticket";
import type {
  ConfidentialFundingCommitments,
  PerPrivateHandoffBundle,
} from "../protocol/privateHandoffProtocol";

export type NegotiationSource = "ER" | "PER" | "OFFCHAIN";
export type ExecutionPolicy = "STANDARD" | "CONFIDENTIAL";
export type SettlementPolicy = "DIRECT" | "STEALTH";
export type PipelineRoute = "STANDARD_ESCROW" | "CONFIDENTIAL_ESCROW";

export type DealPipelineStage =
  | "received"
  | "verified"
  | "settlement_address_ready"
  | "stealth_settlement_ready"
  | "stealth_shielding"
  | "stealth_balances_verified"
  | "stealth_settling"
  | "stealth_claiming"
  | "umbra_lifecycle_pending"
  | "umbra_lifecycle_completed"
  | "awaiting_settlement_plan_approvals"
  | "awaiting_buyer_release_confirmation"
  | "seller_dispute_window"
  | "awaiting_release_approvals"
  | "release_authorized"
  | "release_signed"
  | "route_selected"
  | "dispatching"
  | "encrypted"
  | "escrow_created"
  | "release_pending"
  | "settled"
  | "failed";

export type PipelineStageStatus = "pending" | "confirmed" | "failed";

export interface NegotiationOutcome {
  ticketId: string;
  buyer: string;
  seller: string;
  price: number;
  collateralBuyer: number;
  collateralSeller: number;
  assetType: string;
  tokenMint?: string;
  decimals?: number;
  confidence: number;
  rollupMode: RollupMode;
  negotiationSource: NegotiationSource;
  /**
   * In strict PER mode, redacted outcomes intentionally carry placeholder
   * numeric fields. The confidential pipeline must continue from proof,
   * hashes, commitments, and on-chain state rather than these numbers.
   */
  termsVisibility?: "PLAINTEXT" | "REDACTED";
}

export interface DealPipelineContext extends NegotiationOutcome {
  route: PipelineRoute;
  executionPolicy: ExecutionPolicy;
  settlementPolicy: SettlementPolicy;
  routeReason: string;
  buyerSettlementWallet?: string;
  sellerSettlementWallet?: string;
}

export interface PipelineStageRecord {
  ticketId: string;
  stage: DealPipelineStage;
  status: PipelineStageStatus;
  createdAt: string;
}

export type VerificationLevel =
  | "policy_only"
  | "zerion_position_check"
  | "onchain_balance_check";
export type VerificationProvider = "ZERION_API" | "SOLANA_RPC";
export type VerificationScope = "balance_readiness" | "custody_locked";

export interface VerificationSummary {
  verificationLevel: VerificationLevel;
  provider: VerificationProvider;
  verificationScope: VerificationScope;
  sellerWallet: string;
  assetMint?: string;
  assetSymbol?: string;
  assetResolution?: "native_sol" | "supported_alias" | "token_mint" | "unknown";
  requiredAmountRaw?: string;
  availableAmountRaw?: string;
  observationSlot?: number;
  observationBlock?: number;
  chainId?: string;
  validationSources?: VerificationProvider[];
  fallbackReason?: string;
  positionCount?: number;
  checkedAt: string;
  reason: string;
}

export type SettlementTargetStrategy = "DIRECT_WALLET" | "UMBRA_STEALTH";
export type SettlementTargetStatus = "resolved" | "deferred";
export type SettlementTargetAddressKind =
  | "participant_wallet"
  | "umbra_registered_receiver_wallet";

export interface SettlementTarget {
  role: "buyer" | "seller";
  strategy: SettlementTargetStrategy;
  baseWallet: string;
  resolvedAddress?: string;
  resolvedAddressKind?: SettlementTargetAddressKind;
  status: SettlementTargetStatus;
}

export interface SettlementAddressPlan {
  policy: SettlementPolicy;
  resolution: "resolved" | "deferred";
  assetMint?: string;
  buyerTarget: SettlementTarget;
  sellerTarget: SettlementTarget;
  notes: string[];
}

export interface StealthSettlementPreparation {
  dealId: string;
  settlementId: string;
  mint: string;
  phase: string;
  created: boolean;
}

export interface CiphertextHandle {
  /**
   * Encrypt returns ciphertext identifiers as raw bytes.
   * We persist them as hex so the intent object is JSON-safe and durable.
   */
  identifierHex: string;
  /**
   * On Solana, the ciphertext identifier is also the ciphertext account pubkey.
   */
  account: string;
  fheType: number;
}

export interface TeeConsensusEvidence {
  kind: "magicblock_per_live_state";
  teeRpcUrl: string;
  sessionPda: string;
  observedAt: string;
  verifierWallet: string;
  integrityVerified: boolean;
  sourceEvent: "ROLLUP_CONSENSUS_REACHED";
  termsHash: string;
  commitSignature?: string;
  remoteAttestation: {
    verificationApi: "fast-quote" | "quote";
    verifiedAt: string;
    challengeBase64: string;
    quoteBase64: string;
    quoteSha256: string;
    teePubkeyBase64?: string;
    teeSignatureBase64?: string;
  };
}

export interface PrivateExecutionTermsSnapshot {
  agreedPriceLamports: string;
  agreedAsset: string;
  buyerCollateralLamports: string;
  sellerCollateralLamports: string;
  observedStatus: string;
}

export interface SealedPrivateExecutionTerms {
  version: 1;
  algorithm: "aes-256-gcm";
  nonceBase64: string;
  ciphertextBase64: string;
  authTagBase64: string;
  digestHex: string;
}

export interface AttestedEscrowIntent {
  intentId: string;
  ticketId: string;
  rollupMode: "PER";
  negotiationSource: "PER";
  buyer: string;
  seller: string;
  sessionPda: string;
  assetMint: string;
  assetSymbol?: string;
  handoffBundleVersion?: PerPrivateHandoffBundle["version"];
  /**
   * Legacy migration capsule only. Strict opaque PER runtime should not depend
   * on decrypting or reviving this payload for normal execution.
   */
  sealedExecutionTerms?: SealedPrivateExecutionTerms;
  /**
   * Legacy compatibility for older snapshots created before sealed terms were
   * introduced. New snapshots should omit this field and strict opaque PER
   * runtime must never require it.
   */
  executionTerms?: PrivateExecutionTermsSnapshot;
  termsNonceHex?: string;
  termsHash: string;
  fundingCommitments: ConfidentialFundingCommitments;
  encryptedTerms: {
    buyerCollateral: CiphertextHandle;
    sellerCollateral: CiphertextHandle;
    paymentAmount: CiphertextHandle;
    settlementResult: CiphertextHandle;
    networkEncryptionKeyPda: string;
  };
  evidence: TeeConsensusEvidence;
  status:
    | "consensus_confirmed"
    | "encrypted"
    | "escrow_created"
    | "release_signed"
    | "settled"
    | "failed";
  dealPda?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateHandoffProofState {
  sessionPda: string;
  buyer: string;
  seller: string;
  status: string;
  termsHash: string;
  buyerPaymentFundingHash: string;
  buyerCollateralFundingHash: string;
  sellerCollateralFundingHash: string;
  buyerCollateralCiphertext: string;
  sellerCollateralCiphertext: string;
  paymentAmountCiphertext: string;
  settlementResultCiphertext: string;
  networkEncryptionKeyPda: string;
  proofRecordedAt: string;
}

export interface DealPipelineExecutionResult {
  success: boolean;
  stage: DealPipelineStage;
  route: PipelineRoute;
  status:
    | "created_awaiting_deposits"
    | "awaiting_settlement_plan_approvals"
    | "awaiting_buyer_release_confirmation"
    | "seller_dispute_window"
    | "awaiting_release_approvals"
    | "release_authorized"
    | "confidential_completed"
    | "confidential_pending_session_close"
    | "settled_pending_session_close"
    | "settled"
    | "failed";
  dealPda?: string;
  txSignatures?: string[];
  error?: string;
}
