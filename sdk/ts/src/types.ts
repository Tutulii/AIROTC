import { Keypair } from '@solana/web3.js';

export interface AgentOTCConfig {
    /** 
     * Optional API key provided by the AgentOTC platform registration.
     * When omitted, the SDK falls back to signed wallet-header auth for
     * protected REST endpoints so long-lived external agents remain usable
     * even if their one-time API key is not locally available.
     */
    apiKey?: string;
    /** 
     * Solana Wallet Private Key (Base58) used for signing on-chain deposits.
     * While the platform uses the API key for backend communications, 
     * the actual funds are transacted on-chain using this wallet.
     */
    walletPrivateKey: string;
    /** 
     * Target environment. 
     * 'devnet' - Default testing cluster.
     * 'mainnet' - Production cluster.
     * 'localnet' - For local testing instances.
     * @default 'devnet'
     */
    environment?: 'devnet' | 'mainnet' | 'localnet';
    /** Custom API base URL (overrides environment default) */
    apiUrl?: string;
    /** Custom WebSocket base URL (overrides environment default) */
    wsUrl?: string;
    /** Custom Solana RPC URL (overrides environment default) */
    rpcUrl?: string;
    /**
     * Persist live Meridian workflow state across process restarts.
     * Disabled by default for external-agent runtimes so stale local tickets
     * from a prior session do not hijack fresh deal-matching flows.
     */
    persistLocalState?: boolean;
    /**
     * Re-enable the legacy secondary raw WebSocket event channel.
     * Disabled by default because the live Meridian client already maintains
     * the authoritative realtime session, and duplicate sessions can cause
     * session replacement churn for long-lived external agents.
     */
    legacyWsEvents?: boolean;
    /** Enable private rollup mode semantics for deal helpers. */
    privateMode?: boolean;
    /**
     * When true, plaintext PER commit/reveal and chat-based release helpers fail closed.
     * @default true when privateMode is enabled
     */
    strictOpaquePerMode?: boolean;
}

export interface OfferCreationParams {
    /** Target asset for the trade */
    asset: string;
    /** Mode of operation */
    mode: 'buy' | 'sell';
    /** Amount of the asset being traded */
    amount: number;
    /** Price evaluated in SOL */
    price: number;
    /** Mutual required collateral evaluated in SOL */
    collateral: number;
    /** Optional explicit rollup mode override; defaults to SDK privateMode -> PER, else ER */
    rollupMode?: 'ER' | 'PER';
}

export interface OfferData {
    id: string;
    asset: string;
    price: number;
    amount: number;
    mode: 'buy' | 'sell';
    status: string;
    collateral: number;
    rollupMode?: 'ER' | 'PER';
    tokenMint?: string | null;
    creator?: { wallet: string };
    ticket?: TicketData | null;
    createdAt?: string;
}

export interface TicketData {
    id: string;
    buyer: string;
    seller: string;
    status: string;
    createdAt?: string;
}

export interface DealStatusData {
    ticketId: string;
    phase: string;
    details?: string;
    buyer?: string;
    seller?: string;
    escrowAddress?: string;
    rollupMode?: 'ER' | 'PER';
}

export interface NegotiationMessage {
    sender: string;
    content: string;
    timestamp: Date;
    isSystem: boolean;
}

// ─── PER / Private Rollup Flow ───

export interface RollupTerms {
    priceLamports: string | number;
    quantity: string | number;
    assetMint: string;
    assetSymbol?: string;
    collateralBuyer?: number;
    collateralSeller?: number;
}

export interface PrivateAgreementTermsInput {
    assetMint: string;
    assetSymbol?: string;
    priceSol: number;
    buyerCollateralSol: number;
    sellerCollateralSol?: number;
    quantity?: number;
}

export interface CompletePrivateAgreementOptions {
    autoSubscribe?: boolean;
    autoFinalize?: boolean;
    waitForSessionTimeoutMs?: number;
    finalizeTimeoutMs?: number;
    finalizeRetryMs?: number;
}

export interface WaitForFundingRequestOptions {
    timeoutMs?: number;
}

export interface WaitForReleaseRequestOptions {
    timeoutMs?: number;
    requestKind?: ReleaseApprovalRequestKind;
}

export interface AutoApprovalPolicy {
    trustedCounterpartyOnly?: boolean;
    maxPrice?: number;
    allowedAssets?: string[];
    maxCollateral?: number;
    requireStealthSettlement?: boolean;
    autoApproveExpirySeconds?: number;
}

export type ReleaseApprovalAction =
    | 'APPROVE_SETTLEMENT'
    | 'REVOKE_SETTLEMENT'
    | 'CONFIRM_RELEASE'
    | 'OPEN_DISPUTE';

export type ReleaseApprovalRole = 'buyer' | 'seller';
export type ReleaseApprovalRoute = 'CONFIDENTIAL_ESCROW';
export type ReleaseApprovalSettlementPolicy = 'DIRECT' | 'STEALTH';
export type ReleaseApprovalRequestKind =
    | 'SETTLEMENT_PLAN'
    | 'BUYER_RELEASE_CONFIRMATION';

export interface ReleaseApprovalSummary {
    ticketId: string;
    role: ReleaseApprovalRole;
    counterparty: string;
    asset: string;
    price: number;
    buyerCollateral: number;
    sellerCollateral: number;
    settlementMode: 'Public wallet settlement' | 'Stealth settlement';
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

export type ConfidentialFundingRole =
    | 'buyer_payment'
    | 'buyer_collateral'
    | 'seller_collateral';

export type ConfidentialFundingRequestKind = 'BUYER_FUNDING' | 'SELLER_FUNDING';
export type ConfidentialFundingPartyRole = 'buyer' | 'seller';
export type FundingPrivacyTier = 'DIRECT_SOL' | 'STEALTH_SOL' | 'SHIELDED_CREDIT';

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
    settlementMode: 'Public wallet settlement' | 'Stealth settlement';
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

// ─── Agent Registry ───

export interface RegistrationResult {
    /** The Solana wallet address that was registered. */
    wallet: string;
    /** True if the agent was freshly created, false if it already existed. */
    created: boolean;
    /** 
     * The API key for this agent. Only returned on FIRST registration (created === true).
     * ⚠️ SAVE THIS IMMEDIATELY — it is never shown again.
     */
    apiKey: string | null;
}

export interface AgentProfile {
    wallet: string;
    reputationScore: number;
    /** Reputation tier: 'new' | 'risky' | 'neutral' | 'trusted' | 'elite' */
    tier: 'new' | 'risky' | 'neutral' | 'trusted' | 'elite';
    /** Human-readable trust summary. */
    trustSummary: string;
    stats: {
        totalDeals: number;
        successfulDeals: number;
        cancelledDeals: number;
        disputedDeals: number;
        totalVolume: number;
        avgSettlementTime: number;
        avgSettlementTimeFormatted: string;
    };
    metrics: {
        successRate: number;
        disputeRate: number;
    };
}

export interface WebhookConfig {
    wallet: string;
    webhookUrl: string | null;
    /** HMAC-SHA256 secret for verifying inbound webhook payloads. Only shown when setting a URL. */
    webhookSecret: string | null;
    configured: boolean;
    events: WebhookEventName[];
}

export type WebhookEventName =
    | 'deal.matched'
    | 'deal.expiring'
    | 'deal.message'
    | 'dm.received'
    | 'deal.phase_changed'
    | 'deal.escrow_created'
    | 'deal.deposit_received'
    | 'deal.delivery_confirmed'
    | 'deal.completed'
    | 'deal.cancelled'
    | 'deal.refunded'
    | 'reputation.update';

// ─── ZK Privacy Mode ───

export interface PrivacyTerms {
    /** Trade price */
    price: number;
    /** Buyer's collateral amount */
    collateral_buyer: number;
    /** Seller's collateral amount */
    collateral_seller: number;
    /** Asset type being traded */
    asset_type: string;
}

export interface PrivacyCommitment {
    /** SHA-256 hash of the terms (hex string) */
    termsHash: string;
    /** Raw 32-byte hash as number array (for on-chain use) */
    termsHashBytes: number[];
    /** Cryptographic nonce (hex string) — SAVE THIS for reveal */
    nonce: string;
}

export interface PrivacyStatus {
    isPrivacyMode: boolean;
    termsHash: string | null;
    termsRevealed: boolean;
    canReveal: boolean;
}

// ─── Deal Phase Constants ───
// These are the exact phase names the Middleman sends. Use these instead of raw strings.

export const DealPhase = {
    /** Initial state — agents are negotiating terms */
    NEGOTIATION: 'negotiation',
    /** Rollup or PER enclave negotiation is active */
    ROLLUP_NEGOTIATION: 'rollup_negotiation',
    /** Middleman has created the escrow on-chain */
    ESCROW_CREATED: 'escrow_created',
    /** Escrow exists, waiting for both parties to deposit */
    AWAITING_DEPOSITS: 'awaiting_deposits',
    /** Deposits confirmed, seller should deliver the product */
    DELIVERY: 'delivery',
    /** Private release confirmation is pending from the buyer */
    AWAITING_BUYER_RELEASE_CONFIRMATION: 'awaiting_buyer_release_confirmation',
    /** Trade completed — funds released */
    COMPLETED: 'completed',
    /** Trade reached final settled state in the unified pipeline */
    SETTLED: 'settled',
    /** Trade cancelled or failed */
    CANCELLED: 'cancelled',
    /** Trade failed due to error */
    FAILED: 'failed',
} as const;

export type DealPhaseType = typeof DealPhase[keyof typeof DealPhase];

// ─── Quick Buy Options ───

export interface QuickBuyOptions {
    /** The offer ID to purchase */
    offerId: string;
    /** Maximum price in SOL you're willing to pay */
    maxPrice: number;
    /** Collateral amount in SOL */
    collateral: number;
    /** Timeout for each phase in milliseconds. Default: 120000 (2 min) */
    phaseTimeoutMs?: number;
    /** Called when the deal is created */
    onDealCreated?: (deal: Deal) => void;
    /** Called when escrow is ready */
    onEscrowReady?: (escrowAddress: string) => void;
    /** Called on each phase transition */
    onPhaseChange?: (phase: string) => void;
}

export interface QuickBuyResult {
    /** Whether the trade completed successfully */
    success: boolean;
    /** The deal object when the offer was successfully accepted */
    deal?: Deal;
    /** Transaction signatures from deposits */
    collateralTx?: string;
    /** Transaction signature from payment */
    paymentTx?: string;
    /** Error message if failed */
    error?: string;
}

export interface WaitForMatchedDealOptions {
    offerId?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
}

// Forward declaration to avoid circular imports
import type { Deal } from './deal';

// ─── Direct Messages ───

/** Content type classification for DMs */
export type DMContentType = 'text' | 'api_key' | 'url' | 'file_link' | 'credentials';

/** A direct message between agents */
export interface DirectMessage {
    id: string;
    fromWallet: string;
    toWallet: string;
    content: string;
    contentType: DMContentType;
    ticketId: string | null;
    encrypted: boolean;
    metadata: string | null;
    readAt: string | null;
    expiresAt: string | null;
    createdAt: string;
}

/** Options for sending a DM */
export interface SendDMOptions {
    /** Recipient's Solana wallet address */
    toWallet: string;
    /** Message content (API key, URL, credentials, etc.) */
    content: string;
    /** Content type classification */
    contentType?: DMContentType;
    /** Optional deal/ticket ID to link this message to */
    ticketId?: string;
    /** Whether the content is E2E encrypted */
    encrypted?: boolean;
    /** Optional JSON metadata (e.g. { label, expiresAt }) */
    metadata?: Record<string, any>;
    /** Optional expiry time for sensitive content (ISO date string) */
    expiresAt?: string;
}

/** Result from sending a DM */
export interface SendDMResult {
    id: string;
    fromWallet: string;
    toWallet: string;
    contentType: DMContentType;
    ticketId: string | null;
    encrypted: boolean;
    createdAt: string;
}

/** Paginated inbox response */
export interface DMInboxResponse {
    messages: DirectMessage[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
        hasMore: boolean;
    };
}

/** Conversation response (messages with a specific agent) */
export interface DMConversationResponse {
    conversation: {
        with: string;
        messages: DirectMessage[];
    };
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
}

/** Unread count breakdown */
export interface DMUnreadResponse {
    total: number;
    byAgent: Array<{
        fromWallet: string;
        count: number;
    }>;
}

// ─── File Attachments ───

/** File attachment metadata */
export interface AttachmentInfo {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sizeFormatted?: string;
    checksum: string;
    encrypted: boolean;
    uploadedBy?: string;
    createdAt: string;
    linkedDm?: {
        id: string;
        fromWallet: string;
        toWallet: string;
        ticketId: string | null;
    } | null;
}

/** Options for sending a file via DM */
export interface SendFileOptions {
    /** Recipient wallet address */
    toWallet: string;
    /** File content as Buffer, Blob, or ReadableStream */
    file: Buffer | Blob;
    /** Original filename */
    filename: string;
    /** Optional text message alongside the file */
    message?: string;
    /** Optional deal/ticket ID */
    ticketId?: string;
}

/** Result from uploading a file */
export interface UploadResult {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    checksum: string;
    createdAt: string;
}

/** Result from sending a file as DM */
export interface SendFileResult {
    message: SendDMResult;
    attachment: UploadResult;
}

export interface EncryptedDeliveryOptions {
    label?: string;
    expiresAt?: string;
}
