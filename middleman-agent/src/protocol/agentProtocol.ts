import { z } from "zod";

const MetadataSchema = z.record(z.string()).refine((val) => Object.keys(val).length <= 5, {
  message: "Metadata cannot exceed 5 keys",
}).optional();

const PrivateCiphertextHandleSchema = z.object({
  identifierHex: z.string().regex(/^[0-9a-fA-F]+$/).max(128),
  account: z.string().max(64),
  fheType: z.number().int().nonnegative(),
}).strict();

const PerPrivateHandoffBundleSchema = z.object({
  version: z.literal(1),
  sessionPda: z.string().max(64),
  assetMint: z.string().max(96),
  assetSymbol: z.string().max(32).optional(),
  termsNonceHex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  termsHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  encryptedTerms: z.object({
    buyerCollateral: PrivateCiphertextHandleSchema,
    sellerCollateral: PrivateCiphertextHandleSchema,
    paymentAmount: PrivateCiphertextHandleSchema,
    settlementResult: PrivateCiphertextHandleSchema,
    networkEncryptionKeyPda: z.string().max(64),
  }).strict(),
  fundingCommitments: z.object({
    buyerPaymentHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
    buyerCollateralHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
    sellerCollateralHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
  }).strict(),
}).strict();

export const AgentMessageSchema = z.discriminatedUnion("type", [
  // Offer / Counter / Accept (Structured Negotiation)
  z.object({
    version: z.literal("1.0"),
    type: z.enum(["offer", "counter", "accept"]),
    ticket_id: z.string().max(64).optional(),
    agent_id: z.string().max(64),
    timestamp: z.number().int().positive(),
    price: z.number().positive(),
    collateral_buyer: z.number().nonnegative(),
    collateral_seller: z.number().nonnegative(),
    asset_type: z.string().regex(/^[A-Za-z0-9_]+$/).max(96),
    asset_description: z.string().max(512).optional(),
    signature: z.string().max(256).optional(), // Forward compatible for wallet signature tasks
    metadata: MetadataSchema,
  }).strict(),

  // Unstructured messages (reject, cancel, message, dispute, confirm_delivery, status, deposit_confirmed)
  z.object({
    version: z.literal("1.0"),
    type: z.enum(["reject", "cancel", "message", "dispute", "confirm_delivery", "status", "deposit_confirmed"]),
    ticket_id: z.string().max(64),
    agent_id: z.string().max(64),
    timestamp: z.number().int().positive(),
    content: z.string().max(1024).optional(),
    role: z.string().max(20).optional(),
    signature: z.string().max(256).optional(),
    metadata: MetadataSchema,
  }),

  // PER Protocol Messages (Private Ephemeral Rollups)
  z.object({
    version: z.literal("1.0"),
    type: z.enum(["PER_AUTH_RESPONSE"]),
    ticket_id: z.string().max(64),
    agent_id: z.string().max(64),
    timestamp: z.number().int().positive(),
    signatureBytes: z.string().optional(),
    metadata: MetadataSchema,
  }).strict(),

  // Rollup control-plane messages
  z.object({
    version: z.literal("1.0"),
    type: z.enum(["ROLLUP_CONSENSUS_REACHED"]),
    ticket_id: z.string().max(64),
    agent_id: z.string().max(64),
    timestamp: z.number().int().positive(),
    commitSignature: z.string().max(128).optional(),
    metadata: MetadataSchema,
  }).strict(),

  z.object({
    version: z.literal("1.0"),
    type: z.literal("PER_PRIVATE_HANDOFF_READY"),
    ticket_id: z.string().max(64),
    agent_id: z.string().max(64),
    timestamp: z.number().int().positive(),
    bundle: PerPrivateHandoffBundleSchema,
    metadata: MetadataSchema,
  }).strict(),

  z.object({
    version: z.literal("1.0"),
    type: z.literal("CONFIDENTIAL_FUNDING_SUBMITTED"),
    ticket_id: z.string().max(64),
    agent_id: z.string().max(64),
    timestamp: z.number().int().positive(),
    requestId: z.string().max(128),
    transactionSignatures: z.array(z.string().max(128)).min(1).max(4),
    metadata: MetadataSchema,
  }).strict(),

  z.object({
    version: z.literal("1.0"),
    type: z.literal("UMBRA_SETTLEMENT_SUBMITTED"),
    ticket_id: z.string().max(64),
    agent_id: z.string().max(64),
    timestamp: z.number().int().positive(),
    settlementId: z.string().max(128),
    role: z.enum(["buyer", "seller"]),
    phase: z.enum(["SHIELD", "CREATE_UTXO", "CLAIM", "UNSHIELD"]),
    txSignature: z.string().max(128),
    amountLamports: z.string().regex(/^\d+$/).optional(),
    finalWallet: z.string().max(64).optional(),
    metadata: MetadataSchema,
  }).strict(),

  // Release approval control-plane messages
  z.object({
    version: z.literal("1.0"),
    type: z.enum([
      "RELEASE_APPROVAL_RESPONSE",
      "RELEASE_APPROVAL_REVOKE",
      "RELEASE_DISPUTE_OPEN",
    ]),
    ticket_id: z.string().max(64),
    agent_id: z.string().max(64),
    timestamp: z.number().int().positive(),
    requestId: z.string().max(128),
    signatureBase64: z.string().max(512),
    disputeReason: z.string().max(512).optional(),
    metadata: MetadataSchema,
  }).strict(),
]);

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export function validateAgentMessage(input: unknown): AgentMessage {
  const result = AgentMessageSchema.safeParse(input);

  if (!result.success) {
    const errorMessages = result.error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join(", ");
    throw new Error(`Invalid agent message: ${errorMessages}`);
  }

  return result.data;
}
