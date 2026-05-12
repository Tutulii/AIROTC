import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";

export type ReleaseApprovalAction =
  | "APPROVE_SETTLEMENT"
  | "REVOKE_SETTLEMENT"
  | "CONFIRM_RELEASE"
  | "OPEN_DISPUTE";

export type ReleaseApprovalRole = "buyer" | "seller";
export type ReleaseApprovalRoute = "CONFIDENTIAL_ESCROW";
export type ReleaseApprovalSettlementPolicy = "DIRECT" | "STEALTH";
export type ReleaseApprovalRequestKind =
  | "SETTLEMENT_PLAN"
  | "BUYER_RELEASE_CONFIRMATION";

export interface ReleaseApprovalSummary {
  ticketId: string;
  role: ReleaseApprovalRole;
  counterparty: string;
  asset: string;
  price: number;
  buyerCollateral: number;
  sellerCollateral: number;
  settlementMode: "Public wallet settlement" | "Stealth settlement";
  actionLabel: string;
  expiresAt: string;
  disputeWindowEndsAt?: string;
  redacted?: boolean;
  localTermsRequired?: boolean;
}

export interface ReleaseApprovalCanonicalPayload {
  version: number;
  action: ReleaseApprovalAction;
  ticketIdHash: string;
  dealPda: string;
  sessionPda: string;
  intentIdHash: string;
  role: ReleaseApprovalRole;
  route: ReleaseApprovalRoute;
  settlementPolicy: ReleaseApprovalSettlementPolicy;
  termsHash: string;
  planHash: string;
  nonce: string;
  expiresAt: string;
  timestamp: string;
}

export interface ReleaseApprovalRequestEnvelope {
  requestId: string;
  ticketId: string;
  role: ReleaseApprovalRole;
  requestKind: ReleaseApprovalRequestKind;
  summary: ReleaseApprovalSummary;
  payload: ReleaseApprovalCanonicalPayload;
  messageBase64: string;
  issuedAt: string;
}

export interface ReleaseApprovalAgentResponse {
  requestId: string;
  ticketId: string;
  action: ReleaseApprovalAction;
  signatureBase64: string;
  disputeReason?: string;
  timestamp: number;
}

export interface ReleaseApprovalRecord {
  agentId: string;
  wallet: string;
  action: ReleaseApprovalAction;
  signatureBase64: string;
  txSignature?: string;
  approvalPda?: string;
  recordedAt: string;
  nonce: string;
  active: boolean;
}

export interface ReleaseApprovalStateSnapshot {
  ticketId: string;
  dealPda: string;
  sessionPda: string;
  intentId?: string;
  buyerWallet: string;
  sellerWallet: string;
  buyerFundingWallet?: string;
  sellerFundingWallet?: string;
  route: ReleaseApprovalRoute;
  settlementPolicy: ReleaseApprovalSettlementPolicy;
  termsHash: string;
  planHash: string;
  buyerSettlementTarget: string;
  sellerSettlementTarget: string;
  requestIssuedAt: string;
  buyerRequest: ReleaseApprovalRequestEnvelope;
  sellerRequest: ReleaseApprovalRequestEnvelope;
  buyerReleaseRequest?: ReleaseApprovalRequestEnvelope;
  buyerApproval?: ReleaseApprovalRecord;
  sellerApproval?: ReleaseApprovalRecord;
  buyerReleaseConfirmation?: ReleaseApprovalRecord;
  settlementPlanApproved: boolean;
  buyerReleaseConfirmed: boolean;
  disputeOpen: boolean;
  sellerDisputeWindowOpenedAt?: string;
  sellerDisputeDeadlineAt?: string;
  releaseAuthorized: boolean;
  releaseSigned: boolean;
  releaseExecuted: boolean;
  requestAccount?: string;
  messageApprovalPda?: string;
  dwalletPda?: string;
  signatureScheme?: string;
  decryptedValue?: string;
  winner?: string;
  approvalTxSignature?: string;
  crossChainSignature?: string;
  releaseTxSignature?: string;
  txSignatures: string[];
  updatedAt: string;
}

const PUBKEY_BYTES = 32;
const HEX_32_BYTES = 64;

const ACTION_CODES: Record<ReleaseApprovalAction, number> = {
  APPROVE_SETTLEMENT: 0,
  REVOKE_SETTLEMENT: 1,
  CONFIRM_RELEASE: 2,
  OPEN_DISPUTE: 3,
};

const ROLE_CODES: Record<ReleaseApprovalRole, number> = {
  buyer: 0,
  seller: 1,
};

const ROUTE_CODES: Record<ReleaseApprovalRoute, number> = {
  CONFIDENTIAL_ESCROW: 0,
};

const SETTLEMENT_POLICY_CODES: Record<ReleaseApprovalSettlementPolicy, number> = {
  DIRECT: 0,
  STEALTH: 1,
};

function assertPubkey(value: string, field: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`invalid_release_approval_payload:${field}`);
  }
}

export function hashIdentifier32(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function computeNegotiationTermsHash(input: {
  priceLamports: bigint | number | string;
  buyerCollateralLamports: bigint | number | string;
  sellerCollateralLamports: bigint | number | string;
  assetType: string;
}): string {
  const normalized = JSON.stringify({
    assetType: input.assetType,
    buyerCollateralLamports: BigInt(input.buyerCollateralLamports).toString(),
    priceLamports: BigInt(input.priceLamports).toString(),
    sellerCollateralLamports: BigInt(input.sellerCollateralLamports).toString(),
  });
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function computeSettlementPlanHash(input: {
  policy: ReleaseApprovalSettlementPolicy;
  buyerSettlementTarget: string;
  sellerSettlementTarget: string;
}): string {
  const normalized = JSON.stringify({
    buyerSettlementTarget: input.buyerSettlementTarget,
    policy: input.policy,
    sellerSettlementTarget: input.sellerSettlementTarget,
  });
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function normalizeHex32(value: string, field: string): string {
  const normalized = value.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length !== HEX_32_BYTES) {
    throw new Error(`invalid_release_approval_payload:${field}`);
  }
  return normalized;
}

function writeU64LE(buf: Buffer, value: bigint, offset: number): number {
  buf.writeBigUInt64LE(value, offset);
  return offset + 8;
}

function writeI64LE(buf: Buffer, value: bigint, offset: number): number {
  buf.writeBigInt64LE(value, offset);
  return offset + 8;
}

export function serializeReleaseApprovalPayload(
  payload: ReleaseApprovalCanonicalPayload
): Buffer {
  const ticketIdHash = Buffer.from(normalizeHex32(payload.ticketIdHash, "ticketIdHash"), "hex");
  const intentIdHash = Buffer.from(normalizeHex32(payload.intentIdHash, "intentIdHash"), "hex");
  const termsHash = Buffer.from(normalizeHex32(payload.termsHash, "termsHash"), "hex");
  const planHash = Buffer.from(normalizeHex32(payload.planHash, "planHash"), "hex");
  const dealPda = assertPubkey(payload.dealPda, "dealPda").toBuffer();
  const sessionPda = assertPubkey(payload.sessionPda, "sessionPda").toBuffer();
  const buf = Buffer.alloc(
    1 + // version
      1 + // action
      32 +
      PUBKEY_BYTES +
      PUBKEY_BYTES +
      32 +
      1 + // role
      1 + // route
      1 + // settlement policy
      32 +
      32 +
      8 + // nonce
      8 + // expiresAt
      8 // timestamp
  );

  let offset = 0;
  buf.writeUInt8(payload.version, offset++);
  buf.writeUInt8(ACTION_CODES[payload.action], offset++);
  ticketIdHash.copy(buf, offset);
  offset += 32;
  dealPda.copy(buf, offset);
  offset += PUBKEY_BYTES;
  sessionPda.copy(buf, offset);
  offset += PUBKEY_BYTES;
  intentIdHash.copy(buf, offset);
  offset += 32;
  buf.writeUInt8(ROLE_CODES[payload.role], offset++);
  buf.writeUInt8(ROUTE_CODES[payload.route], offset++);
  buf.writeUInt8(SETTLEMENT_POLICY_CODES[payload.settlementPolicy], offset++);
  termsHash.copy(buf, offset);
  offset += 32;
  planHash.copy(buf, offset);
  offset += 32;
  offset = writeU64LE(buf, BigInt(payload.nonce), offset);
  offset = writeI64LE(buf, BigInt(payload.expiresAt), offset);
  writeI64LE(buf, BigInt(payload.timestamp), offset);

  return buf;
}

export function encodeReleaseApprovalMessageBase64(
  payload: ReleaseApprovalCanonicalPayload
): string {
  return serializeReleaseApprovalPayload(payload).toString("base64");
}

export function buildReleaseApprovalPayload(input: {
  action: ReleaseApprovalAction;
  ticketId: string;
  dealPda: string;
  sessionPda: string;
  intentId?: string;
  role: ReleaseApprovalRole;
  route: ReleaseApprovalRoute;
  settlementPolicy: ReleaseApprovalSettlementPolicy;
  termsHash: string;
  planHash: string;
  nonce: bigint | number | string;
  expiresAt: bigint | number | string;
  timestamp: bigint | number | string;
}): ReleaseApprovalCanonicalPayload {
  return {
    version: 1,
    action: input.action,
    ticketIdHash: hashIdentifier32(input.ticketId),
    dealPda: input.dealPda,
    sessionPda: input.sessionPda,
    intentIdHash: hashIdentifier32(input.intentId || input.ticketId),
    role: input.role,
    route: input.route,
    settlementPolicy: input.settlementPolicy,
    termsHash: normalizeHex32(input.termsHash, "termsHash"),
    planHash: normalizeHex32(input.planHash, "planHash"),
    nonce: BigInt(input.nonce).toString(),
    expiresAt: BigInt(input.expiresAt).toString(),
    timestamp: BigInt(input.timestamp).toString(),
  };
}
