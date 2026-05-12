/**
 * MeridianClient — Official SDK for the AgentOTC / Meridian platform.
 *
 * Zero new dependencies — uses only packages already in the monorepo:
 *   @solana/web3.js, tweetnacl, bs58, ws
 *
 * Usage:
 *   const client = new MeridianClient({ apiUrl, wsUrl, keypair });
 *   await client.register();
 *   await client.connect();
 *   const ticketId = await client.createOffer({ asset: 'SOL', side: 'buy', amount: 1, price: 0.1, collateral: 0.02 });
 */

import {
    Keypair,
    Connection,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import {
    getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver,
    getClaimSelfClaimableUtxoIntoEncryptedBalanceProver,
    getCreateReceiverClaimableUtxoFromEncryptedBalanceProver,
    getCreateSelfClaimableUtxoFromEncryptedBalanceProver,
} from '@umbra-privacy/web-zk-prover';
import type {
    ReleaseApprovalAction,
    ReleaseApprovalRequestKind,
    ReleaseApprovalRequestEnvelope,
} from '../../src/protocol/releaseApprovalProtocol';
import {
    buildReleaseApprovalPayload,
    encodeReleaseApprovalMessageBase64,
} from '../../src/protocol/releaseApprovalProtocol';
import {
    type ConfidentialFundingRole,
    type PerPrivateHandoffBundle,
} from '../../src/protocol/privateHandoffProtocol';
import type { ConfidentialFundingRequestEnvelope } from '../../src/protocol/confidentialFundingProtocol';
import { buildPrivateHandoffBundleFromTerms } from '../../src/services/privateHandoffBundleBuilder';
import { UmbraService } from '../../src/services/umbraService';

// ─── TEE / MagicBlock Imports ──────────────────────────────
import { AnchorProvider, Program, Wallet, BN } from '@coral-xyz/anchor';
import { ConnectionMagicRouter } from '@magicblock-labs/ephemeral-rollups-sdk';
import negotiationIdl from '../../src/idl/magicblock_negotiation.json';

// ─── Types ──────────────────────────────────────────────────

export interface MeridianConfig {
    /** API Server URL (Observatory). Default: http://localhost:3000 */
    apiUrl: string;
    /** Middleman WebSocket URL. Default: ws://localhost:3001 */
    wsUrl: string;
    /** Solana Keypair for signing */
    keypair: Keypair;
    /** Solana RPC URL. Default: https://api.devnet.solana.com */
    rpcUrl?: string;
    /** Enable TEE-backed Private Ephemeral Rollups (Option C / Pattern B) */
    privateMode?: boolean;
    /** Optional confidential escrow program id for agent-side PER handoff preparation. */
    confidentialEscrowProgramId?: string;
    /** Strict opaque PER mode blocks plaintext fallbacks and requires local private terms. */
    strictOpaquePerMode?: boolean;
    /** Persist pending workflow state locally so reconnects and restarts can resume safely. */
    persistLocalState?: boolean;
    /** Optional override for the local SDK state file path. */
    stateFilePath?: string;
    /** Optional factory override for WebSocket creation (used by tests and custom runtimes). */
    wsFactory?: (url: string) => WebSocket;
    /** Auto-reconnect after unexpected disconnects. Default: true */
    autoReconnect?: boolean;
    /** Initial reconnect delay in milliseconds. Default: 1000 */
    reconnectBackoffMs?: number;
    /** Maximum reconnect delay in milliseconds. Default: 15000 */
    reconnectMaxBackoffMs?: number;
    /** Maximum number of unsent outbound messages retained locally. Default: 128 */
    maxQueuedMessages?: number;
}

export interface OfferParams {
    asset: string;
    side: 'buy' | 'sell';
    amount: number;
    price: number;
    collateral: number;
}

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

export interface UmbraLifecycleRequestEnvelope {
    ticketId: string;
    dealId: string;
    settlementId: string;
    role: 'buyer' | 'seller';
    mint: string;
    baseWallet: string;
    receiverWallet: string;
    amountLamports?: string;
    requiredPhases: Array<'SHIELD' | 'CREATE_UTXO' | 'CLAIM' | 'UNSHIELD'>;
    finalWalletRequired: boolean;
    issuedAt: string;
}

type UmbraLifecyclePhase = 'SHIELD' | 'CREATE_UTXO' | 'CLAIM' | 'UNSHIELD';

export interface UmbraLifecycleEvidenceInput {
    settlementId?: string;
    role?: 'buyer' | 'seller';
    phase: UmbraLifecyclePhase;
    txSignature: string;
    amountLamports?: string | bigint | number;
    finalWallet?: string;
}

export interface UmbraLifecycleExecutionResult {
    ticketId: string;
    settlementId: string;
    role: 'buyer' | 'seller';
    receiverWallet: string;
    finalWallet: string;
    phases: Array<{
        phase: UmbraLifecyclePhase;
        txSignature: string;
        amountLamports: string;
    }>;
}

export interface DealUpdate {
    ticketId: string;
    phase: string;
    escrowAddress?: string;
    message?: string;
}

export interface Offer {
    id: string;
    asset: string;
    price: number;
    amount: number;
    mode: string;
    status: string;
    creator?: { wallet: string };
}

// ─── Solana Agent Kit Types ─────────────────────────────

export interface TokenPriceData {
    mint: string;
    price: number;
    source: string;
}

export interface TokenInfoData {
    name: string;
    symbol: string;
    decimals: number;
    supply: string;
    isRugSafe?: boolean;
    rugScore?: number;
}

export interface SwapParams {
    inputMint: string;
    outputMint: string;
    amount: number;
    slippageBps?: number;
}

function describeSdkError(err: any): string {
    if (!err) return 'unknown error';
    if (err.message) return err.message;
    if (err.errorMessage) return err.errorMessage;
    if (err.transactionError) return err.transactionError;
    if (err.error?.message) return err.error.message;
    if (err.error?.errorMessage) return err.error.errorMessage;
    if (err.msg) return err.code ? `${err.msg} (code ${err.code})` : err.msg;
    if (Array.isArray(err.logs) && err.logs.length > 0) return err.logs.join(' | ');
    if (Array.isArray(err.transactionLogs) && err.transactionLogs.length > 0) {
        return err.transactionLogs.join(' | ');
    }
    if (err.cause) {
        const nested = describeSdkError(err.cause);
        if (nested && nested !== 'Error') return nested;
    }
    if (err.transactionMessage) return err.transactionMessage;
    if (err.code) return `SDK error code ${err.code}`;
    if (typeof err.toString === 'function') {
        const rendered = err.toString();
        if (rendered && rendered !== '[object Object]' && rendered !== 'Error') return rendered;
    }
    if (err.name) return err.name;
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}

export interface TransferParams {
    to: string;
    amount: number;
    mint?: string;
}

// ─── Privacy Mode Types ─────────────────────────────────────

export interface PrivacyTerms {
    price: number;
    collateral_buyer: number;
    collateral_seller: number;
    asset_type: string;
}

export interface PrivacyCommitment {
    termsHash: string;
    termsHashBytes: number[];
    nonce: string;
}

export interface PrivacyStatus {
    isPrivacyMode: boolean;
    termsHash: string | null;
    termsRevealed: boolean;
    canReveal: boolean;
}

export interface AutoApprovalPolicy {
    trustedCounterpartyOnly?: boolean;
    maxPrice?: number;
    allowedAssets?: string[];
    maxCollateral?: number;
    requireStealthSettlement?: boolean;
    autoApproveExpirySeconds?: number;
}

interface PrivateTermCacheEntry {
    assetMint: string;
    assetSymbol: string;
    priceSol: number;
    buyerCollateralSol: number;
    sellerCollateralSol: number;
    priceLamports: bigint;
    buyerCollateralLamports: bigint;
    sellerCollateralLamports: bigint;
}

interface PersistedPrivateTermCacheEntry {
    assetMint: string;
    assetSymbol: string;
    priceSol: number;
    buyerCollateralSol: number;
    sellerCollateralSol: number;
    priceLamports: string;
    buyerCollateralLamports: string;
    sellerCollateralLamports: string;
}

interface PersistedMeridianState {
    currentTicketId: string | null;
    releaseRequests: ReleaseApprovalRequestEnvelope[];
    fundingRequests: ConfidentialFundingRequestEnvelope[];
    umbraLifecycleRequests?: UmbraLifecycleRequestEnvelope[];
    umbraLifecycleProgress?: PersistedUmbraLifecycleProgressEntry[];
    privateTermCache: Array<[string, PersistedPrivateTermCacheEntry]>;
    settlementWallets: PersistedSettlementWalletEntry[];
    rewardWallets: PersistedRewardWalletEntry[];
    fundingWallets: PersistedFundingWalletEntry[];
    outboundQueue: any[];
}

interface PersistedUmbraLifecycleProgressEntry {
    ticketId: string;
    settlementId: string;
    role: 'buyer' | 'seller';
    receiverWallet: string;
    finalWallet: string;
    phases: Array<{
        phase: UmbraLifecyclePhase;
        txSignature: string;
        amountLamports: string;
    }>;
}

interface PersistedSettlementWalletEntry {
    address: string;
    secretKeyBase58: string;
    createdAt: string;
    referenceKind: 'offer_creator' | 'offer_accepter' | 'direct_ticket' | 'umbra_final';
    referenceId?: string;
    reference?: 'settlement:offer_creator' | 'settlement:offer_accepter' | 'settlement:direct_ticket' | 'settlement:umbra_final';
    prewarmed?: boolean;
    consumedAt?: string;
}

interface PersistedRewardWalletEntry {
    address: string;
    secretKeyBase58: string;
    createdAt: string;
    referenceKind: 'offer_creator' | 'offer_accepter' | 'direct_ticket';
    referenceId?: string;
    reference?: 'reward:offer_creator' | 'reward:offer_accepter' | 'reward:direct_ticket';
}

interface PersistedFundingWalletEntry {
    address: string;
    secretKeyBase58: string;
    createdAt: string;
    referenceKind: 'offer_creator' | 'offer_accepter' | 'direct_ticket';
    referenceId?: string;
    reference?: 'funding:offer_creator' | 'funding:offer_accepter' | 'funding:direct_ticket';
}

// ─── SDK ──────────────────────────────────────────────────

export class MeridianClient extends EventEmitter {
    private config: MeridianConfig;
    private ws: WebSocket | null = null;
    private agentId: string | null = null;
    private currentTicketId: string | null = null;
    private wallet: string;
    private privateMode: boolean;
    private rollupMode: 'ER' | 'PER' | null = null;
    private erRpcUrl: string | null = null;
    private erConnection: ConnectionMagicRouter | null = null;
    private sessionPda: PublicKey | null = null;
    private negotiationProgram: Program | null = null;
    private activeSalt: string | null = null; // Stored locally for Option C reveal
    private activeCommitHash: string | null = null; // Stored locally for Option C commit
    private releaseRequests = new Map<string, ReleaseApprovalRequestEnvelope>();
    private fundingRequests = new Map<string, ConfidentialFundingRequestEnvelope>();
    private umbraLifecycleRequests = new Map<string, UmbraLifecycleRequestEnvelope>();
    private umbraLifecycleProgress = new Map<string, PersistedUmbraLifecycleProgressEntry>();
    private autoApprovalPolicy: AutoApprovalPolicy | null = null;
    private privateTermCache = new Map<string, PrivateTermCacheEntry>();
    private settlementWallets = new Map<string, PersistedSettlementWalletEntry>();
    private rewardWallets = new Map<string, PersistedRewardWalletEntry>();
    private fundingWallets = new Map<string, PersistedFundingWalletEntry>();
    private ticketPhases = new Map<string, string>();
    private outboundQueue: any[] = [];
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectAttempt = 0;
    private manualDisconnect = false;
    private connectPromise: Promise<void> | null = null;
    private stateFilePath: string | null;

    constructor(config: MeridianConfig) {
        super();
        this.config = config;
        this.wallet = config.keypair.publicKey.toBase58();
        this.privateMode = config.privateMode || false;
        this.stateFilePath = this.resolveStateFilePath();
        this.restoreLocalState();
    }

    // ─── REST: Registration ─────────────────────────────────

    /** Register this wallet with the Observatory platform. */
    async register(): Promise<void> {
        const res = await fetch(`${this.config.apiUrl}/v1/agents/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: this.wallet }),
        });
        if (!res.ok) {
            if (res.status === 429 || res.status === 409) {
                try {
                    const existing = await fetch(
                        `${this.config.apiUrl}/v1/agents/${this.wallet}`,
                        { method: 'GET' }
                    );
                    if (existing.ok) {
                        console.log(
                            `[SDK] Registration reused existing wallet after ${res.status}: ${this.wallet}`
                        );
                        return;
                    }
                } catch {
                    // fall through to the original error below
                }
            }
            throw new Error(`Registration failed: ${res.status}`);
        }
        const data = await res.json() as any;
        console.log(`[SDK] Registered: ${this.wallet} (new=${data.created})`);
    }

    // ─── REST: Offers ───────────────────────────────────────

    /** Create a buy/sell offer on the marketplace. Returns the offer ID. */
    async createOffer(params: OfferParams): Promise<string> {
        const authPayload = this.signMessage(`create_offer_${Date.now()}`);
        const settlementWallet = await this.createFreshSettlementWallet('offer_creator');
        const rewardWallet = this.createFreshRewardWallet('offer_creator');
        const fundingWallet = this.createFreshFundingWallet('offer_creator');
        const res = await fetch(`${this.config.apiUrl}/v1/offers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...authPayload,
                    asset: params.asset,
                    price: params.price,
                    amount: params.amount,
                    mode: params.side,
                    collateral: params.collateral,
                    rollupMode: this.privateMode ? 'PER' : 'ER',
                    privateMode: this.privateMode,
                    settlementWallet,
                    rewardWallet,
                    fundingWallet,
                }),
            });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Create offer failed: ${err}`);
        }

        const data = await res.json() as any;
        const offerId = data.data?.id;
        this.bindSettlementWalletReference(settlementWallet, 'offer_creator', offerId);
        this.bindRewardWalletReference(rewardWallet, 'offer_creator', offerId);
        this.bindFundingWalletReference(fundingWallet, 'offer_creator', offerId);
        console.log(`[SDK] Offer posted: ${offerId} (${params.amount} ${params.asset} @ ${params.price})`);
        return offerId;
    }

    /** List available offers. */
    async getOffers(filters?: { asset?: string; side?: string }): Promise<Offer[]> {
        const params = new URLSearchParams();
        if (filters?.asset) params.set('asset', filters.asset);
        if (filters?.side) params.set('mode', filters.side);
        const url = `${this.config.apiUrl}/v1/offers?${params.toString()}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Get offers failed: ${res.status}`);
        const data = await res.json() as any;
        return data.data || [];
    }

    /** Accept an existing offer. Returns ticket ID. */
    async acceptOffer(offerId: string): Promise<string> {
        const authPayload = this.signMessage(`accept_offer_${Date.now()}`);
        const settlementWallet = await this.createFreshSettlementWallet('offer_accepter');
        const rewardWallet = this.createFreshRewardWallet('offer_accepter');
        const fundingWallet = this.createFreshFundingWallet('offer_accepter');
        const res = await fetch(`${this.config.apiUrl}/v1/offers/${offerId}/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...authPayload,
                rollupMode: this.privateMode ? 'PER' : 'ER',
                privateMode: this.privateMode,
                settlementWallet,
                rewardWallet,
                fundingWallet,
            }),
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Accept offer failed: ${err}`);
        }
        const data = await res.json() as any;
        const ticketId = data.ticket?.id;
        this.bindSettlementWalletReference(settlementWallet, 'offer_accepter', ticketId);
        this.bindRewardWalletReference(rewardWallet, 'offer_accepter', ticketId);
        this.bindFundingWalletReference(fundingWallet, 'offer_accepter', ticketId);
        console.log(`[SDK] Accepted offer. Ticket: ${ticketId}`);
        return ticketId;
    }

    /**
     * Promote offer-scoped privacy wallets to the concrete matched ticket.
     *
     * External seller agents may learn the final ticket ID after their offer is
     * matched via polling or API recovery rather than through an offer placeholder
     * ticket subscription. This explicit promotion keeps settlement / reward /
     * funding wallets bound to the real ticket so later PER steps never fall back
     * to an unrelated wallet.
     */
    public promoteOfferScopedWalletsToTicket(offerId: string, ticketId: string): void {
        if (!offerId || !ticketId) {
            return;
        }
        this.migrateOfferScopedWalletReferences(offerId, ticketId);
    }

    // ─── WebSocket: Connection & Auth ───────────────────────

    /** Connect to the Middleman WebSocket and authenticate. */
    async connect(): Promise<void> {
        if (this.connectPromise) {
            return this.connectPromise;
        }

        if (this.hasHealthySession()) {
            return;
        }

        this.manualDisconnect = false;
        this.clearReconnectTimer();
        this.connectPromise = this.establishConnection(false).finally(() => {
            this.connectPromise = null;
        });
        return this.connectPromise;
    }

    private async establishConnection(isReconnect: boolean): Promise<void> {
        return new Promise((resolve, reject) => {
            const ws = this.createWebSocket(this.config.wsUrl);
            this.ws = ws;

            let settled = false;
            let authenticated = false;
            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error('WebSocket connection timeout'));
                }
                try {
                    ws.close();
                } catch {
                    // ignore close errors from timed-out sockets
                }
            }, 15000);

            ws.on('open', () => {
                if (this.ws !== ws) {
                    return;
                }
                console.log(`[SDK] WebSocket connected to ${this.config.wsUrl}`);
            });

            ws.on('message', (raw: WebSocket.Data) => {
                if (this.ws !== ws) {
                    return;
                }
                let msg: any;
                try {
                    msg = JSON.parse(raw.toString());
                } catch {
                    return;
                }

                if (msg.type === 'auth_challenge' || msg.challenge) {
                    const challenge = msg.challenge || msg.payload?.challenge;
                    if (challenge) {
                        const messageBytes = new TextEncoder().encode(challenge);
                        const signature = nacl.sign.detached(messageBytes, this.config.keypair.secretKey);
                        this.sendRaw({
                            type: 'auth_response',
                            wallet: this.wallet,
                            signature: bs58.encode(signature),
                            challenge,
                            privateMode: this.privateMode,
                        });
                    }
                    return;
                }

                if (msg.type === 'PER_AUTH_CHALLENGE') {
                    const challengeBase64 = msg.payload?.challengeBytes;
                    if (challengeBase64) {
                        const challengeBuffer = Buffer.from(challengeBase64, 'base64');
                        const signature = nacl.sign.detached(challengeBuffer, this.config.keypair.secretKey);
                        this.sendRaw({
                            version: '1.0',
                            type: 'PER_AUTH_RESPONSE',
                            ticket_id: msg.payload?.ticketId || this.currentTicketId,
                            agent_id: this.agentId!,
                            timestamp: Date.now(),
                            signatureBytes: Buffer.from(signature).toString('base64')
                        });
                    }
                    return;
                }

                if (msg.type === 'ROLLUP_SESSION_READY' || msg.type === 'PER_SESSION_READY') {
                    this.rollupMode = (msg.payload?.rollupMode || (this.privateMode ? 'PER' : 'ER')) as 'ER' | 'PER';
                    this.erRpcUrl = msg.payload?.rollupRpcUrl || msg.payload?.teeRpcUrlWithToken;
                    this.sessionPda = new PublicKey(msg.payload?.sessionPda);
                    console.log(
                        `[SDK] Rollup Session Ready. rollupMode=${this.rollupMode} sessionPda=${this.sessionPda.toBase58()}`
                    );
                    const readyTicketId = msg.payload?.ticketId || this.currentTicketId;
                    if (readyTicketId) {
                        this.ticketPhases.set(readyTicketId, 'rollup_negotiation');
                    }

                    this.erConnection = new ConnectionMagicRouter(this.erRpcUrl!, {
                        commitment: 'confirmed'
                    });

                    const provider = new AnchorProvider(
                        this.erConnection as any,
                        new Wallet(this.config.keypair),
                        { commitment: 'confirmed' }
                    );

                    this.negotiationProgram = new Program(negotiationIdl as any, provider);
                    this.emit('rollup_session_ready', {
                        ticketId: readyTicketId,
                        rollupMode: this.rollupMode,
                    });
                    this.emit('per_session_ready', { ticketId: readyTicketId });
                    return;
                }

                if (msg.type === 'auth_success') {
                    clearTimeout(timeout);
                    authenticated = true;
                    this.agentId = msg.agent_id;
                    this.reconnectAttempt = 0;
                    this.clearReconnectTimer();
                    console.log(`[SDK] Authenticated. Agent ID: ${this.agentId}`);
                    this.restoreSubscriptionsAndFlush();
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                    if (isReconnect) {
                        this.emit('reconnected', {
                            agentId: this.agentId,
                            ticketId: this.currentTicketId,
                        });
                    }
                    return;
                }

                if (msg.type === 'auth_failed') {
                    clearTimeout(timeout);
                    if (!settled) {
                        settled = true;
                        reject(new Error('WebSocket auth failed'));
                    }
                    return;
                }

                if (msg.type === 'error') {
                    console.warn(`[SDK] Server error: ${msg.error || msg.details}`);
                    return;
                }

                this.handleMessage(msg);
            });

            ws.on('close', (code: number, reason: Buffer) => {
                clearTimeout(timeout);
                const isCurrentSocket = this.ws === ws;
                if (isCurrentSocket) {
                    this.ws = null;
                }
                console.log(`[SDK] WebSocket closed: ${code} ${reason?.toString()}`);

                if (!settled && !authenticated) {
                    settled = true;
                    reject(new Error(`WebSocket closed before authentication (${code})`));
                }

                if (isCurrentSocket && !this.manualDisconnect && this.shouldAutoReconnect()) {
                    this.scheduleReconnect();
                }
            });

            ws.on('error', (err: Error) => {
                if (this.ws !== ws) {
                    return;
                }
                console.error(`[SDK] WebSocket error: ${err.message}`);
            });
        });
    }

    // ─── WebSocket: Protocol Messages ──────────────────────

    /** Subscribe to a ticket's events. */
    subscribeToTicket(ticketId: string): void {
        this.currentTicketId = ticketId;
        this.persistLocalState();
        if (this.agentId) {
            this.wsSend({
                version: '1.0',
                type: 'status',
                ticket_id: ticketId,
                agent_id: this.agentId,
                timestamp: Date.now(),
            });
        }
    }

    /** Confirm deposit was sent. */
    async confirmDeposit(ticketId: string, role: 'buyer' | 'seller'): Promise<void> {
        this.wsSend({
            version: '1.0',
            type: 'deposit_confirmed',
            ticket_id: ticketId,
            agent_id: this.agentId || this.wallet,
            timestamp: Date.now(),
            role,
            content: `${role} deposit confirmed`,
        });
        console.log(`[SDK] Deposit confirmed (${role})`);
    }

    /** Confirm receipt of delivery — triggers fund release. */
    async confirmReceipt(ticketId: string): Promise<void> {
        const pendingReleaseRequest = this.releaseRequests.get(ticketId);
        if (pendingReleaseRequest?.requestKind === "BUYER_RELEASE_CONFIRMATION") {
            await this.approveRelease(ticketId);
            console.log(`[SDK] Receipt confirmed — buyer release confirmation signed`);
            return;
        }

        if (this.isStrictOpaquePerMode()) {
            throw new Error(
                "Strict opaque PER mode requires a signed buyer release request. " +
                "Plain chat release fallback is disabled."
            );
        }

        // Must be type 'message' so the WS gateway routes it to the brain
        this.wsSend({
            version: '1.0',
            type: 'message',
            ticket_id: ticketId,
            agent_id: this.agentId || this.wallet,
            timestamp: Date.now(),
            content: '@middleman I received the credentials. You can release the funds now.',
        });
        console.log(`[SDK] Receipt confirmed — requesting fund release`);
    }

    getReleaseRequest(ticketId: string): ReleaseApprovalRequestEnvelope | null {
        return this.releaseRequests.get(ticketId) || null;
    }

    getFundingRequest(ticketId: string): ConfidentialFundingRequestEnvelope | null {
        return this.fundingRequests.get(ticketId) || null;
    }

    getUmbraLifecycleRequest(ticketId: string): UmbraLifecycleRequestEnvelope | null {
        return this.umbraLifecycleRequests.get(ticketId) || null;
    }

    setAutoApprovalPolicy(policy: AutoApprovalPolicy | null): void {
        this.autoApprovalPolicy = policy;
    }

    rememberPrivateTerms(ticketId: string, terms: RollupTerms): void {
        this.storePrivateTerms(ticketId, terms);
    }

    async waitForRollupSessionReady(
        ticketId: string,
        timeoutMs = 120_000
    ): Promise<{ ticketId: string; rollupMode: 'ER' | 'PER' }> {
        if (this.sessionPda && this.rollupMode && this.currentTicketId === ticketId) {
            return { ticketId, rollupMode: this.rollupMode };
        }

        return this.waitForEvent<{ ticketId: string; rollupMode: 'ER' | 'PER' }>(
            'rollup_session_ready',
            (payload) => payload?.ticketId === ticketId,
            timeoutMs,
            `Timed out waiting for rollup session on ticket ${ticketId}`
        );
    }

    async completePrivateAgreement(
        ticketId: string,
        terms: PrivateAgreementTermsInput | RollupTerms,
        options: CompletePrivateAgreementOptions = {}
    ): Promise<void> {
        const normalized = this.normalizePrivateAgreementTerms(terms);

        if (options.autoSubscribe !== false) {
            this.subscribeToTicket(ticketId);
        } else if (this.currentTicketId !== ticketId) {
            this.currentTicketId = ticketId;
            this.persistLocalState();
        }

        await this.waitForRollupSessionReady(
            ticketId,
            options.waitForSessionTimeoutMs ?? 120_000
        );
        await this.submitRollupTerms(normalized);

        if (options.autoFinalize === false) {
            return;
        }

        await this.finalizeConsensusWithRetry(ticketId, normalized, {
            timeoutMs: options.finalizeTimeoutMs ?? 120_000,
            retryMs: options.finalizeRetryMs ?? 1_500,
        });
    }

    async prepareDirectTicketPrivacyWallets(ticketId: string): Promise<{
        settlementWallet: string;
        rewardWallet: string;
        fundingWallet: string;
    }> {
        const settlementWallet =
            this.findWalletReference(this.settlementWallets, ticketId)?.address ??
            await this.createFreshSettlementWallet('direct_ticket');
        const rewardWallet =
            this.findWalletReference(this.rewardWallets, ticketId)?.address ??
            this.createFreshRewardWallet('direct_ticket');
        const fundingWallet =
            this.findWalletReference(this.fundingWallets, ticketId)?.address ??
            this.createFreshFundingWallet('direct_ticket');

        this.bindSettlementWalletReference(settlementWallet, 'direct_ticket', ticketId);
        this.bindRewardWalletReference(rewardWallet, 'direct_ticket', ticketId);
        this.bindFundingWalletReference(fundingWallet, 'direct_ticket', ticketId);

        return {
            settlementWallet,
            rewardWallet,
            fundingWallet,
        };
    }

    async fundConfidentialDeal(ticketId: string): Promise<void> {
        const request = this.fundingRequests.get(ticketId);
        if (!request) {
            throw new Error(`No pending confidential funding request found for ticket ${ticketId}`);
        }

        const privateTerms = this.privateTermCache.get(ticketId);
        if (!privateTerms) {
            throw new Error(
                `Local private terms are required to fund confidential deal ${ticketId}`
            );
        }

        const connection = new Connection(
            this.config.rpcUrl || 'https://api.devnet.solana.com',
            'confirmed'
        );
        const programId = this.getConfidentialEscrowProgramId();
        const txSignatures: string[] = [];
        const fundingWallet = this.resolveFundingWalletKeypair(ticketId);
        if (!fundingWallet) {
            throw new Error(`No confidential funding wallet found for ticket ${ticketId}`);
        }
        console.log(
            `[SDK] Confidential funding signer for ${ticketId}: ${fundingWallet.publicKey.toBase58()}`
        );

        const totalRequiredLamports = request.instructions.reduce((sum, instruction) => (
            sum + this.resolveFundingAmount(privateTerms, instruction.fundingRole)
        ), 0n);
        const fundingRail = request.fundingRail || 'DIRECT_SOL';
        if (
            fundingRail === 'DIRECT_SOL' &&
            this.isStrictOpaquePerMode() &&
            process.env.PER_ALLOW_DIRECT_SOL_UNSAFE !== 'true'
        ) {
            throw new Error(
                'Strict PER rejected DIRECT_SOL funding. Use SHIELDED_CREDIT or set PER_ALLOW_DIRECT_SOL_UNSAFE=true for an explicit legacy demo.'
            );
        }
        await this.ensureFundingWalletBalance(
            connection,
            fundingWallet,
            totalRequiredLamports + (fundingRail === 'SHIELDED_CREDIT' ? 10_000_000n : 0n)
        );

        if (fundingRail === 'SHIELDED_CREDIT') {
            await this.ensureCreditVaultInitialized(connection, programId);
            const depositIx = this.buildDepositSolForCreditInstruction({
                programId,
                owner: fundingWallet.publicKey,
                amountLamports: totalRequiredLamports,
            });
            const depositTx = new Transaction().add(depositIx);
            depositTx.feePayer = this.config.keypair.publicKey;
            const depositSignature = await sendAndConfirmTransaction(
                connection,
                depositTx,
                [this.config.keypair, fundingWallet],
                { commitment: 'confirmed' }
            );
            console.log(
                `[SDK] SHIELDED_CREDIT vault deposit tx role=${request.role} tx=${depositSignature}`
            );

            for (const instruction of request.instructions) {
                const amountLamports = this.resolveFundingAmount(privateTerms, instruction.fundingRole);
                const fundingIx = this.buildShieldedCreditLockInstruction({
                    programId,
                    dealPda: new PublicKey(request.dealPda),
                    owner: fundingWallet.publicKey,
                    fundingRole: instruction.fundingRole,
                    amountLamports,
                });
                const tx = new Transaction().add(fundingIx);
                tx.feePayer = this.config.keypair.publicKey;
                const signature = await sendAndConfirmTransaction(
                    connection,
                    tx,
                    [this.config.keypair, fundingWallet],
                    { commitment: 'confirmed' }
                );
                txSignatures.push(signature);
                console.log(
                    `[SDK] SHIELDED_CREDIT lock tx role=${request.role} fundingRole=${instruction.fundingRole} tx=${signature}`
                );
            }

            this.wsSend({
                version: '1.0',
                type: 'CONFIDENTIAL_FUNDING_SUBMITTED',
                ticket_id: ticketId,
                agent_id: this.agentId || this.wallet,
                timestamp: Date.now(),
                requestId: request.requestId,
                transactionSignatures: txSignatures,
            });
            return;
        }

        for (const instruction of request.instructions) {
            const amountLamports = this.resolveFundingAmount(privateTerms, instruction.fundingRole);
            const fundingIx = this.buildConfidentialFundingInstruction({
                programId,
                dealPda: new PublicKey(request.dealPda),
                depositor: fundingWallet.publicKey,
                fundingRole: instruction.fundingRole,
                amountLamports,
            });
            const tx = new Transaction().add(fundingIx);
            tx.feePayer = this.config.keypair.publicKey;
            const signature = await sendAndConfirmTransaction(connection, tx, [this.config.keypair, fundingWallet], {
                commitment: 'confirmed',
            });
            txSignatures.push(signature);
            console.log(
                `[SDK] DIRECT_SOL confidential funding tx role=${request.role} fundingRole=${instruction.fundingRole} tx=${signature}`
            );
        }

        this.wsSend({
            version: '1.0',
            type: 'CONFIDENTIAL_FUNDING_SUBMITTED',
            ticket_id: ticketId,
            agent_id: this.agentId || this.wallet,
            timestamp: Date.now(),
            requestId: request.requestId,
            transactionSignatures: txSignatures,
        });
    }

    async waitForFundingRequest(
        ticketId: string,
        options: WaitForFundingRequestOptions = {}
    ): Promise<ConfidentialFundingRequestEnvelope> {
        const existing = this.getFundingRequest(ticketId);
        if (existing) {
            return existing;
        }

        return this.waitForEvent<ConfidentialFundingRequestEnvelope>(
            'confidential_funding_request',
            (request) => request?.ticketId === ticketId,
            options.timeoutMs ?? 120_000,
            `Timed out waiting for confidential funding request on ticket ${ticketId}`
        );
    }

    async autoFundPrivateDeal(
        ticketId: string,
        options: WaitForFundingRequestOptions = {}
    ): Promise<void> {
        await this.waitForFundingRequest(ticketId, options);
        await this.fundConfidentialDeal(ticketId);
    }

    async waitForUmbraLifecycleRequest(
        ticketId: string,
        timeoutMs = 120_000
    ): Promise<UmbraLifecycleRequestEnvelope> {
        const existing = this.getUmbraLifecycleRequest(ticketId);
        if (existing) {
            return existing;
        }
        return this.waitForEvent<UmbraLifecycleRequestEnvelope>(
            'umbra_lifecycle_request',
            (request) => request?.ticketId === ticketId,
            timeoutMs,
            `Timed out waiting for Umbra lifecycle request on ticket ${ticketId}`
        );
    }

    submitUmbraLifecycleEvidence(
        ticketId: string,
        input: UmbraLifecycleEvidenceInput
    ): void {
        const request = this.getUmbraLifecycleRequest(ticketId);
        const settlementId = input.settlementId || request?.settlementId;
        const role = input.role || request?.role;
        if (!settlementId || !role) {
            throw new Error(`Umbra lifecycle request missing for ticket ${ticketId}`);
        }
        if (input.txSignature === 'sdk_fallback_tx') {
            throw new Error('Umbra lifecycle evidence cannot use sdk_fallback_tx');
        }
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(input.txSignature)) {
            throw new Error('Umbra lifecycle txSignature must be a base58 Solana signature');
        }
        const amountLamports =
            typeof input.amountLamports === 'bigint'
                ? input.amountLamports.toString()
                : typeof input.amountLamports === 'number'
                    ? Math.trunc(input.amountLamports).toString()
                    : input.amountLamports;

        this.wsSend({
            version: '1.0',
            type: 'UMBRA_SETTLEMENT_SUBMITTED',
            ticket_id: ticketId,
            agent_id: this.agentId || this.wallet,
            timestamp: Date.now(),
            settlementId,
            role,
            phase: input.phase,
            txSignature: input.txSignature,
            amountLamports,
            finalWallet: input.finalWallet,
        });
    }

    async autoCompleteUmbraLifecycle(
        ticketId: string,
        options: { timeoutMs?: number; amountLamports?: string | bigint | number } = {}
    ): Promise<UmbraLifecycleExecutionResult> {
        const request = await this.waitForUmbraLifecycleRequest(
            ticketId,
            options.timeoutMs ?? 180_000
        );
        const amountLamports = this.resolveUmbraLifecycleAmount(request, options.amountLamports);
        const receiverWallet = request.receiverWallet;
        const currentWallet = this.config.keypair.publicKey.toBase58();
        if (request.baseWallet && request.baseWallet !== currentWallet) {
            throw new Error(
                `Umbra lifecycle base wallet mismatch: request expects ${request.baseWallet}, client has ${currentWallet}`
            );
        }
        const receiverKeypair = this.resolveSettlementWalletKeypair(ticketId, receiverWallet);
        const progress = this.getOrCreateUmbraLifecycleProgress(ticketId, request);
        const finalWallet = progress.finalWallet;
        const rpcUrl = this.config.rpcUrl || 'https://api.devnet.solana.com';
        const network = this.resolveUmbraNetwork();

        const baseUmbra = new UmbraService(this.config.keypair.secretKey, rpcUrl, network);
        const receiverUmbra = new UmbraService(receiverKeypair.secretKey, rpcUrl, network);
        console.log(`[SDK] Umbra lifecycle setup starting: role=${request.role} baseWallet=${currentWallet} receiverWallet=${receiverWallet}`);
        await this.withUmbraOperationTimeout(`${request.role} base Umbra client init`, () => baseUmbra.initClient());
        await this.withUmbraOperationTimeout(`${request.role} receiver Umbra client init`, () => receiverUmbra.initClient());
        await this.withUmbraOperationTimeout(`${request.role} base Umbra registration`, () => baseUmbra.ensureRegistered());
        console.log(`[SDK] Umbra lifecycle base wallet ready: role=${request.role} wallet=${currentWallet}`);
        await this.withUmbraOperationTimeout(`${request.role} receiver Umbra registration`, () => receiverUmbra.ensureRegistered());
        console.log(`[SDK] Umbra lifecycle receiver wallet ready: role=${request.role} wallet=${receiverWallet}`);

        const phases: UmbraLifecycleExecutionResult['phases'] = [];
        const requiredPhases = request.requiredPhases?.length
            ? request.requiredPhases
            : ['SHIELD', 'CREATE_UTXO', 'CLAIM', 'UNSHIELD'] as const;
        const utxoMode = (
            process.env.AIROTC_UMBRA_UTXO_MODE || 'RECEIVER_CLAIMABLE'
        ).toUpperCase();
        const useSelfClaimableUtxo = utxoMode === 'SELF_CLAIMABLE';
        const requestedAmount = BigInt(amountLamports);
        const { net: amountAfterShieldFees } = await baseUmbra.estimateDepositFee(requestedAmount);
        const { net: amountAfterCreateFees } = await baseUmbra.estimateCreateUtxoFee(amountAfterShieldFees);
        if (amountAfterShieldFees <= 0n || amountAfterCreateFees <= 0n) {
            throw new Error('Umbra lifecycle amount is too small after protocol fees');
        }
        const amountForPhase = (phase: UmbraLifecyclePhase): string => {
            if (phase === 'SHIELD') return requestedAmount.toString();
            if (phase === 'CREATE_UTXO') return amountAfterShieldFees.toString();
            return amountAfterCreateFees.toString();
        };

        for (const phase of requiredPhases) {
            const completed = progress.phases.find((entry) => entry.phase === phase);
            if (completed) {
                phases.push(completed);
                continue;
            }

            const phaseAmountLamports = amountForPhase(phase);
            console.log(`[SDK] Umbra lifecycle phase starting: role=${request.role} phase=${phase}`);
            const txSignature = await this.withUmbraPhaseTimeout(request.role, phase, async () => {
                if (phase === 'SHIELD') {
                    const result = await baseUmbra.shieldCollateral(
                        request.mint,
                        BigInt(phaseAmountLamports)
                    );
                    return this.extractRequiredUmbraSignature(result, phase);
                }
                if (phase === 'CREATE_UTXO') {
                    await baseUmbra.ensureSharedEncryptedBalance(request.mint);
                    const result = useSelfClaimableUtxo
                        ? await baseUmbra.createSelfClaimableUtxoFromEncryptedBalance(
                            request.mint,
                            BigInt(phaseAmountLamports),
                            getCreateSelfClaimableUtxoFromEncryptedBalanceProver()
                        )
                        : await baseUmbra.createReceiverClaimableUtxoFromEncryptedBalance(
                            receiverWallet,
                            request.mint,
                            BigInt(phaseAmountLamports),
                            getCreateReceiverClaimableUtxoFromEncryptedBalanceProver()
                        );
                    if (!useSelfClaimableUtxo) {
                        await receiverUmbra.rememberUtxoFromSignature((result as any).callbackSignature);
                    }
                    return this.extractRequiredUmbraSignature(result, phase);
                }
                if (phase === 'CLAIM') {
                    const result = useSelfClaimableUtxo
                        ? await baseUmbra.claimSelfUtxos(
                            (await this.waitForSelfClaimableUmbraUtxo(baseUmbra)).selfBurnable,
                            getClaimSelfClaimableUtxoIntoEncryptedBalanceProver()
                        )
                        : await receiverUmbra.claimReceiverUtxos(
                            (await this.waitForClaimableUmbraUtxo(receiverUmbra)).received,
                            getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver()
                        );
                    return this.extractRequiredUmbraSignature(result, phase);
                }
                if (phase === 'UNSHIELD') {
                    const unshieldUmbra = useSelfClaimableUtxo ? baseUmbra : receiverUmbra;
                    const result = await unshieldUmbra.unshieldCollateral(
                        request.mint,
                        BigInt(phaseAmountLamports),
                        finalWallet
                    );
                    return this.extractRequiredUmbraSignature(result, phase);
                }
                throw new Error(`Unsupported Umbra lifecycle phase ${phase}`);
            });

            this.submitUmbraLifecycleEvidence(ticketId, {
                settlementId: request.settlementId,
                role: request.role,
                phase,
                txSignature,
                amountLamports: phaseAmountLamports,
                finalWallet: phase === 'UNSHIELD' ? finalWallet : undefined,
            });
            const progressPhase = { phase, txSignature, amountLamports: phaseAmountLamports };
            phases.push(progressPhase);
            this.recordUmbraLifecyclePhase(ticketId, request, progressPhase, finalWallet);
            console.log(`[SDK] Umbra lifecycle phase submitted: role=${request.role} phase=${phase} tx=${txSignature}`);
        }

        return {
            ticketId,
            settlementId: request.settlementId,
            role: request.role,
            receiverWallet,
            finalWallet,
            phases,
        };
    }

    async approveRelease(ticketId: string): Promise<void> {
        return this.respondToReleaseRequest(ticketId, "RELEASE_APPROVAL_RESPONSE");
    }

    async revokeRelease(ticketId: string): Promise<void> {
        return this.respondToReleaseRequest(ticketId, "RELEASE_APPROVAL_REVOKE");
    }

    async openDispute(ticketId: string, reason: string): Promise<void> {
        return this.respondToReleaseRequest(ticketId, "RELEASE_DISPUTE_OPEN", reason);
    }

    async waitForReleaseRequest(
        ticketId: string,
        options: WaitForReleaseRequestOptions = {}
    ): Promise<ReleaseApprovalRequestEnvelope> {
        const existing = this.getReleaseRequest(ticketId);
        if (existing && (!options.requestKind || existing.requestKind === options.requestKind)) {
            return existing;
        }

        return this.waitForEvent<ReleaseApprovalRequestEnvelope>(
            'release_approval_request',
            (request) =>
                request?.ticketId === ticketId &&
                (!options.requestKind || request.requestKind === options.requestKind),
            options.timeoutMs ?? 120_000,
            `Timed out waiting for release request on ticket ${ticketId}`
        );
    }

    async confirmPrivateDelivery(
        ticketId: string,
        options: WaitForReleaseRequestOptions = {}
    ): Promise<void> {
        await this.waitForReleaseRequest(ticketId, {
            ...options,
            requestKind: options.requestKind ?? "BUYER_RELEASE_CONFIRMATION",
        });
        await this.confirmReceipt(ticketId);
    }

    /** Send a negotiation message. */
    sendMessage(ticketId: string, content: string): void {
        if (
            this.rollupMode &&
            this.sessionPda &&
            /\d/.test(content) &&
            /(price|collateral|asset|lamport|sol|usdc|mint)/i.test(content)
        ) {
            throw new Error(
                "Plaintext deal terms are blocked while a rollup session is active. " +
                "Use submitRollupTerms() / finalizeRollupConsensus() instead."
            );
        }

        this.wsSend({
            version: '1.0',
            type: 'message',
            ticket_id: ticketId,
            agent_id: this.agentId || this.wallet,
            timestamp: Date.now(),
            content,
        });
    }

    // ─── ZK Privacy Mode ──────────────────────────────────

    /**
     * Commit deal terms as a SHA-256 hash for privacy mode.
     * The hash is stored on-chain; plaintext terms stay local.
     * @returns The commitment (hash + nonce). Save the nonce — needed for reveal.
     */
    async commitTerms(dealId: string, terms: PrivacyTerms): Promise<PrivacyCommitment> {
        if (this.isStrictOpaquePerMode()) {
            throw new Error(
                "Strict opaque PER mode does not allow plaintext commit/reveal endpoints. " +
                "Use submitRollupTerms() / finalizeRollupConsensus() instead."
            );
        }
        const res = await fetch(`${this.config.apiUrl}/v1/deals/${dealId}/commit-terms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(terms),
        });
        if (!res.ok) throw new Error(`Commit terms failed: ${await res.text()}`);
        const data = await res.json() as any;
        console.log(`[SDK] Terms committed for deal ${dealId}: ${data.termsHash?.substring(0, 16)}...`);
        return { termsHash: data.termsHash, termsHashBytes: data.termsHashBytes, nonce: data.nonce };
    }

    /**
     * Reveal and verify terms post-settlement.
     * Requires the original nonce from commitTerms().
     * @returns true if the hash matches the on-chain commitment.
     */
    async revealTerms(dealId: string, terms: PrivacyTerms, nonce: string): Promise<boolean> {
        if (this.isStrictOpaquePerMode()) {
            throw new Error(
                "Strict opaque PER mode does not allow plaintext commit/reveal endpoints. " +
                "Use the private rollup handoff flow instead."
            );
        }
        const res = await fetch(`${this.config.apiUrl}/v1/deals/${dealId}/reveal-terms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...terms, nonce }),
        });
        if (!res.ok) {
            const err = await res.json() as any;
            console.warn(`[SDK] Reveal failed: ${err.error}`);
            return false;
        }
        const data = await res.json() as any;
        console.log(`[SDK] Terms revealed for deal ${dealId}: verified=${data.verified}`);
        return data.verified;
    }

    /**
     * Check the privacy status of a deal.
     */
    async getPrivacyStatus(dealId: string): Promise<PrivacyStatus> {
        if (this.isStrictOpaquePerMode()) {
            throw new Error(
                "Strict opaque PER mode does not expose legacy privacy-status endpoints."
            );
        }
        const res = await fetch(`${this.config.apiUrl}/v1/deals/${dealId}/privacy-status`);
        if (!res.ok) throw new Error(`Privacy status failed: ${res.status}`);
        return await res.json() as PrivacyStatus;
    }

    // ─── TEE Privacy Mode (Option C Commit-Reveal) ────────────────────

    /**
     * Submit terms securely to the TEE Enclave.
     */
    async submitRollupTerms(terms: RollupTerms): Promise<void> {
        if (!this.negotiationProgram || !this.sessionPda) throw new Error("Rollup session not initialized. Waiting for ROLLUP_SESSION_READY.");
        
        console.log(`[SDK] Submitting terms to ${this.rollupMode || 'rollup'} session...`);

        try {
            const buyerCollateralLamports = Math.round((terms.collateralBuyer ?? 0) * LAMPORTS_PER_SOL);
            const sellerCollateralLamports = Math.round((terms.collateralSeller ?? 0) * LAMPORTS_PER_SOL);
            const rollupAssetLabel = this.resolveRollupAssetLabel(
                String(terms.assetMint),
                terms.assetSymbol
            );
            if (this.currentTicketId) {
                this.storePrivateTerms(this.currentTicketId, terms);
            }
            const sig = await this.negotiationProgram.methods
                .negotiateTerms(
                    new BN(terms.priceLamports),
                    rollupAssetLabel,
                    new BN(buyerCollateralLamports),
                    new BN(sellerCollateralLamports),
                )
                .accountsPartial({
                    session: this.sessionPda,
                })
                .rpc();

            console.log(`[SDK] Terms submitted to rollup (Signature: ${sig})`);
        } catch (err: any) {
            const detail = describeSdkError(err);
            console.error(`[SDK] Failed to submit terms to rollup: ${detail}`);
            throw new Error(`submitRollupTerms failed: ${detail}`, { cause: err });
        }
    }

    /**
     * Reach consensus on the TEE Enclave.
     */
    async finalizeRollupConsensus(terms: RollupTerms): Promise<void> {
        if (!this.negotiationProgram || !this.sessionPda) throw new Error("Rollup session not initialized.");
        
        console.log(`[SDK] Finalizing consensus on ${this.rollupMode || 'rollup'} session...`);

        const ticketId = this.currentTicketId!;
        const hash = Buffer.from(ticketId.replace(/[^a-f0-9]/gi, "").slice(0, 16).padEnd(16, "0"), "hex");
        const sessionId = new BN(hash.readBigUInt64LE(0).toString());

        try {
            if (this.rollupMode === 'PER') {
                const handoffBundle = await this.buildPerPrivateHandoffBundle(terms);
                this.wsSend({
                    version: '1.0',
                    type: 'PER_PRIVATE_HANDOFF_READY',
                    ticket_id: this.currentTicketId,
                    agent_id: this.agentId || this.wallet,
                    timestamp: Date.now(),
                    bundle: handoffBundle,
                });
                this.wsSend({
                    version: '1.0',
                    type: 'ROLLUP_CONSENSUS_REACHED',
                    ticket_id: this.currentTicketId,
                    agent_id: this.agentId || this.wallet,
                    timestamp: Date.now(),
                });

                console.log(`[SDK] PER consensus signaled with opaque handoff bundle. Backend can continue without fetching plaintext terms.`);
                return;
            }

            const sig = await this.negotiationProgram.methods
                .reachConsensus(sessionId)
                .accountsPartial({
                    session: this.sessionPda,
                    payer: this.config.keypair.publicKey,
                })
                .rpc();

            this.wsSend({
                version: '1.0',
                type: 'ROLLUP_CONSENSUS_REACHED',
                ticket_id: this.currentTicketId,
                agent_id: this.agentId || this.wallet,
                timestamp: Date.now(),
                commitSignature: sig,
            });

            console.log(`[SDK] Rollup consensus reached. (Signature: ${sig})`);
        } catch (err: any) {
            const detail = describeSdkError(err);
            console.error(`[SDK] Failed to reach rollup consensus: ${detail}`);
            throw new Error(`finalizeRollupConsensus failed: ${detail}`, { cause: err });
        }
    }

    async commit(terms: RollupTerms): Promise<void> {
        return this.submitRollupTerms(terms);
    }

    async reveal(terms: RollupTerms): Promise<void> {
        return this.finalizeRollupConsensus(terms);
    }

    // ─── Solana: On-Chain Operations ───────────────────────

    /** Send SOL to an escrow address. Returns the transaction signature. */
    async sendDeposit(escrowAddress: string, amountSol: number): Promise<string> {
        const connection = new Connection(
            this.config.rpcUrl || 'https://api.devnet.solana.com',
            'confirmed'
        );
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: this.config.keypair.publicKey,
                toPubkey: new PublicKey(escrowAddress),
                lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
            })
        );
        const sig = await sendAndConfirmTransaction(connection, tx, [this.config.keypair]);
        console.log(`[SDK] Deposit sent: ${amountSol} SOL → ${escrowAddress} (tx: ${sig})`);
        return sig;
    }

    // ─── Internal ──────────────────────────────────────────

    /** Get the current active ticket ID (may change after match). */
    getCurrentTicketId(): string | null {
        return this.currentTicketId;
    }

    private isOfferPlaceholder(ticketId: string | null): boolean {
        return typeof ticketId === 'string' && ticketId.startsWith('offer-');
    }

    private handleMessage(msg: any): void {
        const phase = msg.phase || msg.payload?.phase;
        const content = msg.content || msg.payload?.content || '';
        const incomingTicketId = msg.ticket_id;
        const ticketId = incomingTicketId || msg.payload?.ticketId || this.currentTicketId || '';

        if (ticketId && phase) {
            this.ticketPhases.set(ticketId, phase);
        }

        const emitPhaseUpdate = () => {
            if (!ticketId || !phase) {
                return;
            }
            this.emit('phase_changed', {
                ticketId,
                phase,
                message: content,
            } as DealUpdate);
        };

        if (msg.type === 'RELEASE_APPROVAL_REQUEST' && msg.payload?.ticketId) {
            const request = this.hydrateReleaseRequestFromLocalTerms(
                msg.payload as ReleaseApprovalRequestEnvelope
            );
            this.releaseRequests.set(request.ticketId, request);
            this.persistLocalState();
            emitPhaseUpdate();
            this.emit('release_approval_request', request);
            void this.tryAutoApprove(request);
            return;
        }

        if (msg.type === 'CONFIDENTIAL_FUNDING_REQUEST' && msg.payload?.ticketId) {
            const request = this.hydrateFundingRequestFromLocalTerms(
                msg.payload as ConfidentialFundingRequestEnvelope
            );
            this.fundingRequests.set(request.ticketId, request);
            this.persistLocalState();
            emitPhaseUpdate();
            this.emit('confidential_funding_request', request);
            return;
        }

        if (msg.type === 'UMBRA_LIFECYCLE_REQUEST' && msg.payload?.ticketId) {
            const request = msg.payload as UmbraLifecycleRequestEnvelope;
            this.umbraLifecycleRequests.set(request.ticketId, request);
            this.persistLocalState();
            emitPhaseUpdate();
            this.emit('umbra_lifecycle_request', request);
            return;
        }

        // AUTO-SWITCH: only promote an offer placeholder to the concrete matched
        // ticket. Never let an unrelated queued message hijack an already active
        // TCK-* workflow after reconnect or restart.
        if (
            incomingTicketId &&
            this.currentTicketId &&
            incomingTicketId !== this.currentTicketId &&
            this.isOfferPlaceholder(this.currentTicketId) &&
            (
                phase === 'negotiation' ||
                msg.type === 'ROLLUP_SESSION_READY' ||
                msg.type === 'PER_SESSION_READY' ||
                (typeof content === 'string' && content.includes('Deal matched'))
            )
        ) {
            const previousReferenceId = this.currentTicketId;
            console.log(`[SDK] Ticket ID switched: ${previousReferenceId} → ${incomingTicketId}`);
            this.migrateOfferScopedWalletReferences(previousReferenceId, incomingTicketId);
            this.currentTicketId = incomingTicketId;
            this.persistLocalState();
            this.subscribeToTicket(incomingTicketId);
        }

        if (
            incomingTicketId &&
            this.currentTicketId &&
            incomingTicketId !== this.currentTicketId &&
            !this.isOfferPlaceholder(this.currentTicketId)
        ) {
            console.warn(
                `[SDK] Ignoring message for unrelated ticket ${incomingTicketId}; active ticket is ${this.currentTicketId}`
            );
            return;
        }

        if (phase === 'settled' && ticketId) {
            this.clearTicketWorkflowState(ticketId);
            this.emit('deal_complete', ticketId);
        }

        // Phase change events
        if (msg.event_type === 'phase_changed' || (content && content.includes('Deal phase updated'))) {
            emitPhaseUpdate();

            if (phase === 'completed' || phase === 'settled') {
                this.clearTicketWorkflowState(ticketId);
                this.emit('deal_complete', ticketId);
            } else if (phase === 'cancelled' || phase === 'failed' || phase === 'refunded') {
                this.clearTicketWorkflowState(ticketId);
            }
        }

        // Deal execution events (escrow ready, deposit detection, etc.)
        if (msg.event_type === 'deal_executed') {
            const status = msg.payload?.status || msg.status;
            if (status === 'created_awaiting_deposits') {
                const escrowAddr = msg.payload?.escrow_address || '';
                this.emit('escrow_ready', {
                    address: escrowAddr,
                    amounts: msg.payload?.amounts || {},
                });
            }
            if (status === 'completed' || status === 'settled') {
                this.clearTicketWorkflowState(ticketId);
                this.emit('deal_complete', ticketId);
            }
        }

        // Extract escrow address from middleman messages
        if (content && content.includes('ESCROW ADDRESS')) {
            const match = content.match(/`([A-Za-z0-9]{32,})`/);
            if (match) {
                this.emit('escrow_address', match[1]);
            }
        }

        // General middleman messages
        if (msg.type === 'middleman_message' || msg.event_type === 'middleman_message' ||
            msg.type === 'middleman_response' || msg.event_type === 'middleman_response') {
            this.emit('message', content, phase);
        }
    }

    private signMessage(message: string): { message: string; signature: string; publicKey: string } {
        const messageBytes = new TextEncoder().encode(message);
        const signature = nacl.sign.detached(messageBytes, this.config.keypair.secretKey);
        return {
            message,
            signature: bs58.encode(signature),
            publicKey: this.wallet,
        };
    }

    private waitForEvent<T>(
        eventName: string,
        predicate: (payload: T) => boolean,
        timeoutMs: number,
        timeoutMessage: string
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const onEvent = (payload: T) => {
                if (!predicate(payload)) {
                    return;
                }
                clearTimeout(timer);
                this.off(eventName, onEvent);
                resolve(payload);
            };

            const timer = setTimeout(() => {
                this.off(eventName, onEvent);
                reject(new Error(timeoutMessage));
            }, timeoutMs);

            this.on(eventName, onEvent);
        });
    }

    private normalizePrivateAgreementTerms(
        terms: PrivateAgreementTermsInput | RollupTerms
    ): RollupTerms {
        if ('priceSol' in terms) {
            const sellerCollateralSol = terms.sellerCollateralSol ?? terms.buyerCollateralSol;
            return {
                assetMint: terms.assetMint,
                assetSymbol: terms.assetSymbol,
                priceLamports: Math.round(terms.priceSol * LAMPORTS_PER_SOL),
                quantity: terms.quantity ?? 1,
                collateralBuyer: terms.buyerCollateralSol,
                collateralSeller: sellerCollateralSol,
            };
        }

        return {
            ...terms,
            assetSymbol: terms.assetSymbol,
        };
    }

    private async finalizeConsensusWithRetry(
        ticketId: string,
        terms: RollupTerms,
        options: { timeoutMs: number; retryMs: number }
    ): Promise<void> {
        const deadline = Date.now() + options.timeoutMs;
        let lastError: any = null;

        while (Date.now() < deadline) {
            if (this.hasAdvancedPastNegotiation(ticketId)) {
                return;
            }

            try {
                await this.finalizeRollupConsensus(terms);
                return;
            } catch (error: any) {
                const detail = describeSdkError(error);
                if (this.isConsensusAlreadyFinalized(detail)) {
                    return;
                }
                if (this.isPossiblyConcurrentConsensusFinalize(detail)) {
                    lastError = error;
                    await this.sleep(options.retryMs);
                    if (this.hasAdvancedPastNegotiation(ticketId)) {
                        return;
                    }
                    continue;
                }
                if (!this.isRetryableConsensusWait(detail)) {
                    throw error;
                }
                lastError = error;
                await this.sleep(options.retryMs);
            }
        }

        if (this.hasAdvancedPastNegotiation(ticketId)) {
            return;
        }

        throw new Error(
            `completePrivateAgreement timed out waiting for consensus finalization on ${ticketId}: ${describeSdkError(lastError)}`
        );
    }

    private hasAdvancedPastNegotiation(ticketId: string): boolean {
        const phase = this.ticketPhases.get(ticketId);
        return !!phase && phase !== 'negotiation' && phase !== 'rollup_negotiation';
    }

    private isRetryableConsensusWait(detail: string): boolean {
        const normalized = detail.toLowerCase();
        return (
            normalized.includes('both parties') ||
            normalized.includes('must submit terms') ||
            normalized.includes('terms not submitted') ||
            normalized.includes('not ready to reach consensus') ||
            normalized.includes('consensus cannot be reached') ||
            normalized.includes('has not submitted') ||
            normalized.includes('session not finalized')
        );
    }

    private isConsensusAlreadyFinalized(detail: string): boolean {
        const normalized = detail.toLowerCase();
        return (
            normalized.includes('consensus already') ||
            normalized.includes('already finalized') ||
            normalized.includes('already reached consensus') ||
            normalized.includes('session already agreed')
        );
    }

    private isPossiblyConcurrentConsensusFinalize(detail: string): boolean {
        const normalized = detail.toLowerCase();
        const effectiveRollupMode = this.rollupMode || (this.privateMode ? 'PER' : 'ER');
        return (
            effectiveRollupMode === 'ER' &&
            normalized.includes('instruction modified data of a read-only account')
        );
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private wsSend(payload: any): void {
        if (this.canSendImmediately()) {
            this.sendRaw(payload);
            return;
        }

        this.enqueueOutbound(payload);
        console.warn('[SDK] WebSocket not connected — queued message for retry');
        if (!this.manualDisconnect && this.shouldAutoReconnect()) {
            this.scheduleReconnect();
        }
    }

    private async respondToReleaseRequest(
        ticketId: string,
        messageType: "RELEASE_APPROVAL_RESPONSE" | "RELEASE_APPROVAL_REVOKE" | "RELEASE_DISPUTE_OPEN",
        disputeReason?: string
    ): Promise<void> {
        const request = this.releaseRequests.get(ticketId);
        if (!request) {
            throw new Error(`No pending release request found for ticket ${ticketId}`);
        }

        if (request.summary.localTermsRequired || request.summary.redacted) {
            throw new Error(
                `Local private terms are required before responding to PER release request ${ticketId}`
            );
        }

        let payload = request.payload;
        if (messageType !== "RELEASE_APPROVAL_RESPONSE") {
            if (request.requestKind !== "SETTLEMENT_PLAN" && messageType === "RELEASE_APPROVAL_REVOKE") {
                throw new Error("Settlement-plan revocation is only supported for settlement approval requests.");
            }
            payload = buildReleaseApprovalPayload({
                action:
                    messageType === "RELEASE_APPROVAL_REVOKE"
                        ? "REVOKE_SETTLEMENT"
                        : "OPEN_DISPUTE",
                ticketId: request.ticketId,
                dealPda: request.payload.dealPda,
                sessionPda: request.payload.sessionPda,
                intentId: request.requestId,
                role: request.role,
                route: request.payload.route,
                settlementPolicy: request.payload.settlementPolicy,
                termsHash: request.payload.termsHash,
                planHash: request.payload.planHash,
                nonce: BigInt(request.payload.nonce) + 1n,
                expiresAt: BigInt(Date.now() + 10 * 60 * 1000),
                timestamp: BigInt(Date.now()),
            });
        }

        const messageBytes = Buffer.from(encodeReleaseApprovalMessageBase64(payload), 'base64');
        const approvalSigner = this.resolveFundingWalletKeypair(ticketId, true) || this.config.keypair;
        const signature = nacl.sign.detached(messageBytes, approvalSigner.secretKey);

        this.wsSend({
            version: '1.0',
            type: messageType,
            ticket_id: ticketId,
            agent_id: this.agentId || this.wallet,
            timestamp: Date.now(),
            requestId: request.requestId,
            signatureBase64: Buffer.from(signature).toString('base64'),
            disputeReason,
        });
    }

    private async tryAutoApprove(request: ReleaseApprovalRequestEnvelope): Promise<void> {
        const policy = this.autoApprovalPolicy;
        if (!policy) {
            return;
        }
        if (request.requestKind !== "SETTLEMENT_PLAN") {
            return;
        }
        if (request.summary.localTermsRequired || request.summary.redacted) {
            return;
        }

        const allowedAsset =
            !policy.allowedAssets || policy.allowedAssets.includes(request.summary.asset);
        const allowedPrice =
            policy.maxPrice == null || request.summary.price <= policy.maxPrice;
        const maxCollateral = policy.maxCollateral;
        const collateralOk =
            maxCollateral == null ||
            (request.summary.buyerCollateral <= maxCollateral &&
                request.summary.sellerCollateral <= maxCollateral);
        const stealthOk =
            !policy.requireStealthSettlement ||
            request.summary.settlementMode === "Stealth settlement";

        if (allowedAsset && allowedPrice && collateralOk && stealthOk) {
            await this.approveRelease(request.ticketId);
        }
    }

    private hydrateReleaseRequestFromLocalTerms(
        request: ReleaseApprovalRequestEnvelope
    ): ReleaseApprovalRequestEnvelope {
        if (!request.summary.localTermsRequired) {
            return request;
        }

        const cached = this.privateTermCache.get(request.ticketId);
        if (!cached) {
            return request;
        }

        return {
            ...request,
            summary: {
                ...request.summary,
                asset: cached.assetSymbol,
                price: cached.priceSol,
                buyerCollateral: cached.buyerCollateralSol,
                sellerCollateral: cached.sellerCollateralSol,
                redacted: false,
                localTermsRequired: false,
            },
        };
    }

    private hydrateFundingRequestFromLocalTerms(
        request: ConfidentialFundingRequestEnvelope
    ): ConfidentialFundingRequestEnvelope {
        if (!request.summary.localTermsRequired) {
            return request;
        }

        const cached = this.privateTermCache.get(request.ticketId);
        if (!cached) {
            return request;
        }

        return {
            ...request,
            summary: {
                ...request.summary,
                asset: cached.assetSymbol,
                buyerPayment: cached.priceSol,
                buyerCollateral: cached.buyerCollateralSol,
                sellerCollateral: cached.sellerCollateralSol,
                redacted: false,
                localTermsRequired: false,
            },
        };
    }

    private storePrivateTerms(ticketId: string, terms: RollupTerms): void {
        const buyerCollateralLamports = Math.round((terms.collateralBuyer ?? 0) * LAMPORTS_PER_SOL);
        const sellerCollateralLamports = Math.round((terms.collateralSeller ?? 0) * LAMPORTS_PER_SOL);
        const assetMint = String(terms.assetMint);
        const assetSymbol = this.resolveRollupAssetLabel(assetMint, terms.assetSymbol);

        this.privateTermCache.set(ticketId, {
            assetMint,
            assetSymbol,
            priceSol: Number(terms.priceLamports) / LAMPORTS_PER_SOL,
            buyerCollateralSol: Number(terms.collateralBuyer ?? 0),
            sellerCollateralSol: Number(terms.collateralSeller ?? 0),
            priceLamports: BigInt(terms.priceLamports),
            buyerCollateralLamports: BigInt(buyerCollateralLamports),
            sellerCollateralLamports: BigInt(sellerCollateralLamports),
        });
        this.persistLocalState();
    }

    private resolveFundingAmount(
        terms: PrivateTermCacheEntry,
        fundingRole: ConfidentialFundingRole
    ): bigint {
        switch (fundingRole) {
            case 'buyer_payment':
                return terms.priceLamports;
            case 'buyer_collateral':
                return terms.buyerCollateralLamports;
            case 'seller_collateral':
                return terms.sellerCollateralLamports;
            default:
                throw new Error(`Unsupported confidential funding role: ${fundingRole}`);
        }
    }

    private isStrictOpaquePerMode(): boolean {
        return this.privateMode && this.config.strictOpaquePerMode !== false;
    }

    private anchorGlobalDiscriminator(name: string): Buffer {
        return createHash('sha256')
            .update(`global:${name}`, 'utf8')
            .digest()
            .subarray(0, 8);
    }

    private encodeConfidentialDepositType(role: ConfidentialFundingRole): number {
        switch (role) {
            case 'buyer_payment':
                return 0;
            case 'buyer_collateral':
                return 1;
            case 'seller_collateral':
                return 2;
            default:
                throw new Error(`Unsupported confidential funding role: ${role}`);
        }
    }

    private buildConfidentialFundingInstruction(input: {
        programId: PublicKey;
        dealPda: PublicKey;
        depositor: PublicKey;
        fundingRole: ConfidentialFundingRole;
        amountLamports: bigint;
    }): TransactionInstruction {
        const amountBuffer = Buffer.alloc(8);
        amountBuffer.writeBigUInt64LE(input.amountLamports);
        const data = Buffer.concat([
            this.anchorGlobalDiscriminator('deposit_encrypted'),
            Buffer.from([this.encodeConfidentialDepositType(input.fundingRole)]),
            amountBuffer,
        ]);

        return new TransactionInstruction({
            programId: input.programId,
            keys: [
                { pubkey: input.dealPda, isSigner: false, isWritable: true },
                { pubkey: input.depositor, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data,
        });
    }

    private deriveCreditVaultPda(programId: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync([Buffer.from('credit_vault')], programId)[0];
    }

    private buildInitializeCreditVaultInstruction(input: {
        programId: PublicKey;
        authority: PublicKey;
    }): TransactionInstruction {
        const vault = this.deriveCreditVaultPda(input.programId);
        return new TransactionInstruction({
            programId: input.programId,
            keys: [
                { pubkey: vault, isSigner: false, isWritable: true },
                { pubkey: input.authority, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: this.anchorGlobalDiscriminator('initialize_credit_vault'),
        });
    }

    private async ensureCreditVaultInitialized(
        connection: Connection,
        programId: PublicKey
    ): Promise<void> {
        const vault = this.deriveCreditVaultPda(programId);
        const existing = await connection.getAccountInfo(vault, 'confirmed');
        if (existing) {
            return;
        }

        const initTx = new Transaction().add(
            this.buildInitializeCreditVaultInstruction({
                programId,
                authority: this.config.keypair.publicKey,
            })
        );
        initTx.feePayer = this.config.keypair.publicKey;

        try {
            await sendAndConfirmTransaction(
                connection,
                initTx,
                [this.config.keypair],
                { commitment: 'confirmed' }
            );
            return;
        } catch (error: any) {
            const detail = `${error?.message || error}`;
            const maybeConcurrentCreate =
                detail.includes('already in use') ||
                detail.includes('custom program error: 0x0') ||
                detail.includes('"Custom":0');
            if (!maybeConcurrentCreate) {
                throw error;
            }

            for (let attempt = 0; attempt < 5; attempt += 1) {
                const refreshed = await connection.getAccountInfo(vault, 'confirmed');
                if (refreshed) {
                    return;
                }
                await this.sleep(500);
            }

            throw error;
        }
    }

    private deriveCreditBalancePda(programId: PublicKey, vault: PublicKey, owner: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync(
            [Buffer.from('credit_balance'), vault.toBuffer(), owner.toBuffer()],
            programId
        )[0];
    }

    private deriveCreditLockPda(
        programId: PublicKey,
        dealPda: PublicKey,
        owner: PublicKey,
        fundingRole: ConfidentialFundingRole
    ): PublicKey {
        return PublicKey.findProgramAddressSync(
            [
                Buffer.from('credit_lock'),
                dealPda.toBuffer(),
                owner.toBuffer(),
                Buffer.from([this.encodeConfidentialDepositType(fundingRole)]),
            ],
            programId
        )[0];
    }

    private buildDepositSolForCreditInstruction(input: {
        programId: PublicKey;
        owner: PublicKey;
        amountLamports: bigint;
    }): TransactionInstruction {
        const amountBuffer = Buffer.alloc(8);
        amountBuffer.writeBigUInt64LE(input.amountLamports);
        const vault = this.deriveCreditVaultPda(input.programId);
        const creditBalance = this.deriveCreditBalancePda(input.programId, vault, input.owner);

        return new TransactionInstruction({
            programId: input.programId,
            keys: [
                { pubkey: vault, isSigner: false, isWritable: true },
                { pubkey: creditBalance, isSigner: false, isWritable: true },
                { pubkey: input.owner, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: Buffer.concat([
                this.anchorGlobalDiscriminator('deposit_sol_for_credit'),
                amountBuffer,
            ]),
        });
    }

    private buildShieldedCreditLockInstruction(input: {
        programId: PublicKey;
        dealPda: PublicKey;
        owner: PublicKey;
        fundingRole: ConfidentialFundingRole;
        amountLamports: bigint;
    }): TransactionInstruction {
        const amountBuffer = Buffer.alloc(8);
        amountBuffer.writeBigUInt64LE(input.amountLamports);
        const roleCode = this.encodeConfidentialDepositType(input.fundingRole);
        const vault = this.deriveCreditVaultPda(input.programId);
        const creditBalance = this.deriveCreditBalancePda(input.programId, vault, input.owner);
        const creditLock = this.deriveCreditLockPda(
            input.programId,
            input.dealPda,
            input.owner,
            input.fundingRole
        );

        return new TransactionInstruction({
            programId: input.programId,
            keys: [
                { pubkey: vault, isSigner: false, isWritable: true },
                { pubkey: creditBalance, isSigner: false, isWritable: true },
                { pubkey: creditLock, isSigner: false, isWritable: true },
                { pubkey: input.dealPda, isSigner: false, isWritable: true },
                { pubkey: input.owner, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: Buffer.concat([
                this.anchorGlobalDiscriminator('lock_credit_for_deal'),
                Buffer.from([roleCode]),
                amountBuffer,
            ]),
        });
    }

    private getConfidentialEscrowProgramId(): PublicKey {
        const value =
            this.config.confidentialEscrowProgramId ||
            process.env.CONFIDENTIAL_ESCROW_PROGRAM_ID ||
            'BuTf7gVrjD2wzKe4Tu1Ny2m7gC9SY65fRCY7gHnBgLqj';
        return new PublicKey(value);
    }

    private async buildPerPrivateHandoffBundle(
        terms: RollupTerms
    ): Promise<PerPrivateHandoffBundle> {
        if (!this.sessionPda || !this.currentTicketId) {
            throw new Error('PER handoff bundle requires an active rollup session and ticket');
        }

        const programId = this.getConfidentialEscrowProgramId();
        const connection = new Connection(
            this.config.rpcUrl || 'https://api.devnet.solana.com',
            'confirmed'
        );
        const priceLamports = BigInt(terms.priceLamports);
        const buyerCollateralLamports = BigInt(
            Math.round((terms.collateralBuyer ?? 0) * LAMPORTS_PER_SOL)
        );
        const sellerCollateralLamports = BigInt(
            Math.round((terms.collateralSeller ?? 0) * LAMPORTS_PER_SOL)
        );

        return buildPrivateHandoffBundleFromTerms({
            connection,
            payer: this.config.keypair,
            authorizedProgram: programId,
            sessionPda: this.sessionPda.toBase58(),
            assetMint: String(terms.assetMint),
            assetSymbol: this.resolveRollupAssetLabel(
                String(terms.assetMint),
                terms.assetSymbol
            ),
            priceLamports,
            buyerCollateralLamports,
            sellerCollateralLamports,
            status: 'confidentialHandoff',
        });
    }

    private resolveRollupAssetLabel(assetMint: string, assetSymbol?: string): string {
        const explicit = assetSymbol?.trim();
        if (explicit) {
            return this.compactRollupAssetLabel(explicit);
        }

        const normalizedMint = assetMint.trim();
        const knownLabels: Record<string, string> = {
            So11111111111111111111111111111111111111112: 'SOL',
            EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
            Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
            PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta: 'UMBRA',
        };
        const known = knownLabels[normalizedMint];
        if (known) {
            return known;
        }
        return this.compactRollupAssetLabel(normalizedMint);
    }

    private compactRollupAssetLabel(value: string): string {
        const trimmed = value.trim();
        if (trimmed.length <= 32) {
            return trimmed;
        }
        return `${trimmed.slice(0, 12)}...${trimmed.slice(-8)}`;
    }

    // ─── Solana Agent Kit: FULL HYBRID API ────────────────────

    /** Internal helper for SAK GET requests */
    private async sakGet(path: string): Promise<any> {
        const res = await fetch(`${this.config.apiUrl}${path}`);
        const data = await res.json() as any;
        if (!data.success) throw new Error(data.error || 'Request failed');
        return data.data;
    }

    /** Internal helper for SAK POST requests */
    private async sakPost(path: string, body: any): Promise<any> {
        const res = await fetch(`${this.config.apiUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json() as any;
        if (!data.success) throw new Error(data.error || 'Request failed');
        return data.data;
    }

    // ── TOKEN: READ ──────────────────────────────────────────

    /** Get real-time token price. Accepts mint address or symbol (SOL, USDC, BONK, JUP). */
    async getTokenPrice(mintOrSymbol: string): Promise<TokenPriceData> {
        return this.sakGet(`/v1/solana/price/${encodeURIComponent(mintOrSymbol)}`);
    }

    /** Get wallet balance (SOL or SPL token). */
    async getSolanaBalance(mintOrSymbol?: string): Promise<{ balance: number; mint: string }> {
        const path = mintOrSymbol ? `/v1/solana/balance/${encodeURIComponent(mintOrSymbol)}` : '/v1/solana/balance';
        return this.sakGet(path);
    }

    /** Get token metadata (name, symbol, decimals, supply). */
    async getTokenData(mintOrSymbol: string): Promise<any> {
        return this.sakGet(`/v1/solana/token-data/${encodeURIComponent(mintOrSymbol)}`);
    }

    /** Rug check — returns safety score. */
    async rugCheck(mintOrSymbol: string): Promise<any> {
        return this.sakGet(`/v1/solana/rug-check/${encodeURIComponent(mintOrSymbol)}`);
    }

    /** Get the middleman agent's wallet address. */
    async getAgentWallet(): Promise<string> {
        return this.sakGet('/v1/solana/wallet');
    }

    /** List all available SAK methods (for discovery). */
    async listSAKMethods(): Promise<string[]> {
        return this.sakGet('/v1/solana/methods');
    }

    // ── TOKEN: WRITE ─────────────────────────────────────────

    /** Swap tokens via Jupiter DEX. */
    async swapTokens(params: SwapParams): Promise<any> {
        return this.sakPost('/v1/solana/swap', params);
    }

    /** Transfer SOL or SPL tokens. */
    async transferToken(params: TransferParams): Promise<any> {
        return this.sakPost('/v1/solana/transfer', params);
    }

    /** Stake SOL via JupSOL. */
    async stakeSOL(amount: number): Promise<any> {
        return this.sakPost('/v1/solana/stake', { amount });
    }

    /** Burn SPL tokens. */
    async burnTokens(mint: string, amount: number): Promise<any> {
        return this.sakPost('/v1/solana/burn', { mint, amount });
    }

    /** Close an empty token account. */
    async closeTokenAccount(mint: string): Promise<any> {
        return this.sakPost('/v1/solana/close-account', { mint });
    }

    /** Request SOL airdrop (devnet only). */
    async requestAirdrop(amount: number = 1): Promise<any> {
        return this.sakPost('/v1/solana/airdrop', { amount });
    }

    // ── TOKEN: ADMIN ─────────────────────────────────────────

    /** Deploy a new SPL token. */
    async deployToken(name: string, symbol: string, uri?: string, decimals?: number, supply?: number): Promise<any> {
        return this.sakPost('/v1/solana/deploy-token', { name, symbol, uri, decimals, supply });
    }

    /** Deploy a Token2022. */
    async deployToken2022(name: string, symbol: string, uri?: string, decimals?: number, supply?: number): Promise<any> {
        return this.sakPost('/v1/solana/deploy-token2022', { name, symbol, uri, decimals, supply });
    }

    /** Bridge tokens via Wormhole. */
    async bridgeTokens(destChain: string, mint: string, amount: number, destAddress: string): Promise<any> {
        return this.sakPost('/v1/solana/bridge', { destChain, mint, amount, destAddress });
    }

    /** ZK compressed airdrop. */
    async compressedAirdrop(mint: string, recipients: string[], amounts: number[]): Promise<any> {
        return this.sakPost('/v1/solana/compressed-airdrop', { mint, recipients, amounts });
    }

    // ── NFT ──────────────────────────────────────────────────

    /** Deploy an NFT collection via Metaplex. */
    async deployNFTCollection(name: string, uri: string, royaltyBps?: number): Promise<any> {
        return this.sakPost('/v1/solana/nft/deploy-collection', { name, uri, royaltyBps });
    }

    /** Mint an NFT to a collection. */
    async mintNFT(collectionMint: string, name: string, uri: string): Promise<any> {
        return this.sakPost('/v1/solana/nft/mint', { collectionMint, name, uri });
    }

    /** Create 3Land collection. */
    async create3LandCollection(opts: { name: string; symbol?: string; description?: string; imageUrl?: string }): Promise<any> {
        return this.sakPost('/v1/solana/nft/3land-collection', opts);
    }

    /** Create and list NFT on 3Land. */
    async create3LandNFT(collectionAccount: string, options: any): Promise<any> {
        return this.sakPost('/v1/solana/nft/3land-mint', { collectionAccount, options });
    }

    // ── DEFI ─────────────────────────────────────────────────

    /** Lend assets via Lulo (best USDC APR). */
    async lendAssets(amount: number, mint?: string): Promise<any> {
        return this.sakPost('/v1/solana/defi/lend', { amount, mint });
    }

    /** Create a Raydium CPMM pool. */
    async createRaydiumPool(mintA: string, mintB: string, amountA: number, amountB: number): Promise<any> {
        return this.sakPost('/v1/solana/defi/raydium-pool', { mintA, mintB, amountA, amountB });
    }

    /** Create an Orca Whirlpool position. */
    async createOrcaPool(mintA: string, mintB: string, initialPrice: number, feeTier: number): Promise<any> {
        return this.sakPost('/v1/solana/defi/orca-pool', { mintA, mintB, initialPrice, feeTier });
    }

    /** Create a Meteora DLMM pool. */
    async createMeteoraPool(mintA: string, mintB: string, binStep: number, initialPrice: number): Promise<any> {
        return this.sakPost('/v1/solana/defi/meteora-pool', { mintA, mintB, binStep, initialPrice });
    }

    /** Place a Manifest limit order. */
    async createLimitOrder(mint: string, quantity: number, side: 'buy' | 'sell', price: number): Promise<any> {
        return this.sakPost('/v1/solana/defi/limit-order', { mint, quantity, side, price });
    }

    /** Open a Drift perpetual trade. */
    async openDriftPerp(amount: number, symbol: string, side: 'long' | 'short', leverage?: number): Promise<any> {
        return this.sakPost('/v1/solana/defi/drift-perp', { amount, symbol, side, leverage });
    }

    /** Drift deposit (lending). */
    async driftDeposit(amount: number, symbol: string): Promise<any> {
        return this.sakPost('/v1/solana/defi/drift-deposit', { amount, symbol });
    }

    /** Drift withdrawal. */
    async driftWithdraw(amount: number, symbol: string): Promise<any> {
        return this.sakPost('/v1/solana/defi/drift-withdraw', { amount, symbol });
    }

    /** Open Adrena perpetuals position. */
    async openAdrenaPerp(amount: number, symbol: string, side: 'long' | 'short', leverage?: number): Promise<any> {
        return this.sakPost('/v1/solana/defi/adrena-perp', { amount, symbol, side, leverage });
    }

    // ── MISC ─────────────────────────────────────────────────

    /** CoinGecko token info. */
    async getCoinGeckoInfo(coinId: string): Promise<any> {
        return this.sakGet(`/v1/solana/coingecko/${encodeURIComponent(coinId)}`);
    }

    /** Trending tokens (CoinGecko). */
    async getTrendingTokens(): Promise<any> {
        return this.sakGet('/v1/solana/trending');
    }

    /** Top gainers. */
    async getTopGainers(duration: string = '24h'): Promise<any> {
        return this.sakGet(`/v1/solana/top-gainers/${encodeURIComponent(duration)}`);
    }

    /** Latest liquidity pools. */
    async getLatestPools(): Promise<any> {
        return this.sakGet('/v1/solana/latest-pools');
    }

    /** Pyth oracle price feed. */
    async getPythPrice(feedId: string): Promise<any> {
        return this.sakGet(`/v1/solana/pyth-price/${encodeURIComponent(feedId)}`);
    }

    /** Resolve .sol domain to address. */
    async resolveDomain(domain: string): Promise<any> {
        return this.sakGet(`/v1/solana/resolve-domain/${encodeURIComponent(domain)}`);
    }

    /** Register SNS domain. */
    async registerDomain(domain: string, space?: number): Promise<any> {
        return this.sakPost('/v1/solana/register-domain', { domain, space });
    }

    /** Create a GibWork bounty. */
    async createBounty(title: string, description: string, requirements: string, tags: string[], payout: number): Promise<any> {
        return this.sakPost('/v1/solana/gibwork-bounty', { title, description, requirements, tags, payout });
    }

    // ── BLINKS & CROSS-CHAIN ─────────────────────────────────

    /** Execute a Solana Blink/Action. */
    async executeBlink(url: string): Promise<any> {
        return this.sakPost('/v1/solana/blink', { url });
    }

    /** Bridge via deBridge DLN. */
    async deBridge(srcChain: number, dstChain: number, srcToken: string, dstToken: string, amount: number): Promise<any> {
        return this.sakPost('/v1/solana/debridge', { srcChain, dstChain, srcToken, dstToken, amount });
    }

    // ── GENERIC ESCAPE HATCH ─────────────────────────────────

    /** Call ANY SAK method by name. Use listSAKMethods() to discover available methods. */
    async callSAK(method: string, args: any[] = []): Promise<any> {
        return this.sakPost('/v1/solana/call', { method, args });
    }

    private resolveUmbraNetwork(): 'mainnet' | 'devnet' {
        const rpcUrl = this.config.rpcUrl || 'https://api.devnet.solana.com';
        return rpcUrl.includes('mainnet') ? 'mainnet' : 'devnet';
    }

    private async createFreshSettlementWallet(
        referenceKind: 'offer_creator' | 'offer_accepter' | 'direct_ticket'
    ): Promise<string> {
        if (process.env.AIROTC_USE_PREWARMED_UMBRA_SETTLEMENT_WALLETS === 'true') {
            const prewarmed = Array.from(this.settlementWallets.values()).find((entry) => (
                entry.referenceKind === referenceKind &&
                entry.prewarmed === true &&
                !entry.referenceId &&
                !entry.consumedAt
            ));
            if (prewarmed) {
                this.settlementWallets.set(prewarmed.address, {
                    ...prewarmed,
                    prewarmed: false,
                    consumedAt: new Date().toISOString(),
                });
                this.persistLocalState();
                console.log(`[SDK] Prewarmed Umbra settlement wallet ready: ${prewarmed.address}`);
                return prewarmed.address;
            }
        }

        const settlementKeypair = Keypair.generate();
        const rpcUrl = this.config.rpcUrl || 'https://api.devnet.solana.com';
        const connection = new Connection(rpcUrl, 'confirmed');
        const sponsorshipLamports = Math.max(Math.floor(0.02 * LAMPORTS_PER_SOL), 2_000_000);

        const sponsorTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: this.config.keypair.publicKey,
                toPubkey: settlementKeypair.publicKey,
                lamports: sponsorshipLamports,
            })
        );
        await sendAndConfirmTransaction(connection, sponsorTx, [this.config.keypair], {
            commitment: 'confirmed',
        });

        const umbra = new UmbraService(
            settlementKeypair.secretKey,
            rpcUrl,
            this.resolveUmbraNetwork()
        );

        await umbra.initClient();
        await umbra.ensureRegistered();

        const address = settlementKeypair.publicKey.toBase58();
        this.settlementWallets.set(address, {
            address,
            secretKeyBase58: bs58.encode(settlementKeypair.secretKey),
            createdAt: new Date().toISOString(),
            referenceKind,
            reference: `settlement:${referenceKind}`,
            prewarmed: process.env.AIROTC_PREWARM_UMBRA_SETTLEMENT_WALLET === 'true',
        });
        this.persistLocalState();
        console.log(
            `[SDK] Fresh Umbra settlement wallet ready: ${address} (sponsored ${(sponsorshipLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL)`
        );
        return address;
    }

    private createFreshRewardWallet(
        referenceKind: 'offer_creator' | 'offer_accepter' | 'direct_ticket'
    ): string {
        const rewardKeypair = Keypair.generate();
        const address = rewardKeypair.publicKey.toBase58();
        this.rewardWallets.set(address, {
            address,
            secretKeyBase58: bs58.encode(rewardKeypair.secretKey),
            createdAt: new Date().toISOString(),
            referenceKind,
            reference: `reward:${referenceKind}`,
        });
        this.persistLocalState();
        console.log(`[SDK] Fresh private reward wallet ready for ${referenceKind}.`);
        return address;
    }

    private createFreshFundingWallet(
        referenceKind: 'offer_creator' | 'offer_accepter' | 'direct_ticket'
    ): string {
        const fundingKeypair = Keypair.generate();
        const address = fundingKeypair.publicKey.toBase58();
        this.fundingWallets.set(address, {
            address,
            secretKeyBase58: bs58.encode(fundingKeypair.secretKey),
            createdAt: new Date().toISOString(),
            referenceKind,
            reference: `funding:${referenceKind}`,
        });
        this.persistLocalState();
        console.log(`[SDK] Fresh confidential funding wallet ready for ${referenceKind}.`);
        return address;
    }

    private createFreshUmbraFinalWallet(ticketId: string): string {
        const finalKeypair = Keypair.generate();
        const address = finalKeypair.publicKey.toBase58();
        this.settlementWallets.set(address, {
            address,
            secretKeyBase58: bs58.encode(finalKeypair.secretKey),
            createdAt: new Date().toISOString(),
            referenceKind: 'umbra_final',
            referenceId: ticketId,
            reference: 'settlement:umbra_final',
        });
        this.persistLocalState();
        console.log(`[SDK] Fresh Umbra final wallet ready for ${ticketId}: ${address}`);
        return address;
    }

    private bindSettlementWalletReference(
        address: string,
        referenceKind: 'offer_creator' | 'offer_accepter' | 'direct_ticket',
        referenceId?: string | null
    ): void {
        const current = this.settlementWallets.get(address);
        if (!current) {
            return;
        }

        this.settlementWallets.set(address, {
            ...current,
            referenceKind,
            referenceId: referenceId || undefined,
            reference: `settlement:${referenceKind}`,
        });
        this.persistLocalState();
    }

    private bindRewardWalletReference(
        address: string,
        referenceKind: 'offer_creator' | 'offer_accepter' | 'direct_ticket',
        referenceId?: string | null
    ): void {
        const current = this.rewardWallets.get(address);
        if (!current) {
            return;
        }

        this.rewardWallets.set(address, {
            ...current,
            referenceKind,
            referenceId: referenceId || undefined,
            reference: `reward:${referenceKind}`,
        });
        this.persistLocalState();
    }

    private bindFundingWalletReference(
        address: string,
        referenceKind: 'offer_creator' | 'offer_accepter' | 'direct_ticket',
        referenceId?: string | null
    ): void {
        const current = this.fundingWallets.get(address);
        if (!current) {
            return;
        }

        this.fundingWallets.set(address, {
            ...current,
            referenceKind,
            referenceId: referenceId || undefined,
            reference: `funding:${referenceKind}`,
        });
        this.persistLocalState();
    }

    private findWalletReference<T extends { address: string; referenceId?: string }>(
        store: Map<string, T>,
        ticketId: string
    ): T | null {
        return Array.from(store.values()).find((entry) => entry.referenceId === ticketId) || null;
    }

    private resolveSettlementWalletKeypair(ticketId: string, expectedAddress?: string): Keypair {
        const exact = Array.from(this.settlementWallets.values()).find((entry) => {
            if (expectedAddress && entry.address !== expectedAddress) {
                return false;
            }
            return entry.referenceId === ticketId || entry.referenceKind === 'offer_creator';
        });

        if (!exact) {
            throw new Error(
                expectedAddress
                    ? `No fresh Umbra settlement wallet ${expectedAddress} found for ticket ${ticketId}`
                    : `No fresh Umbra settlement wallet found for ticket ${ticketId}`
            );
        }

        return Keypair.fromSecretKey(bs58.decode(exact.secretKeyBase58));
    }

    private getOrCreateUmbraLifecycleProgress(
        ticketId: string,
        request: UmbraLifecycleRequestEnvelope
    ): PersistedUmbraLifecycleProgressEntry {
        const current = this.umbraLifecycleProgress.get(ticketId);
        if (
            current &&
            current.settlementId === request.settlementId &&
            current.role === request.role &&
            current.receiverWallet === request.receiverWallet
        ) {
            return current;
        }

        const entry: PersistedUmbraLifecycleProgressEntry = {
            ticketId,
            settlementId: request.settlementId,
            role: request.role,
            receiverWallet: request.receiverWallet,
            finalWallet: this.createFreshUmbraFinalWallet(ticketId),
            phases: [],
        };
        this.umbraLifecycleProgress.set(ticketId, entry);
        this.persistLocalState();
        return entry;
    }

    private recordUmbraLifecyclePhase(
        ticketId: string,
        request: UmbraLifecycleRequestEnvelope,
        phase: PersistedUmbraLifecycleProgressEntry['phases'][number],
        finalWallet: string
    ): void {
        const current = this.getOrCreateUmbraLifecycleProgress(ticketId, request);
        current.finalWallet = finalWallet;
        current.phases = [
            ...current.phases.filter((entry) => entry.phase !== phase.phase),
            phase,
        ];
        this.umbraLifecycleProgress.set(ticketId, current);
        this.persistLocalState();
    }

    private resolveUmbraLifecycleAmount(
        request: UmbraLifecycleRequestEnvelope,
        override?: string | bigint | number
    ): string {
        const value = override ?? request.amountLamports ?? process.env.AIROTC_UMBRA_LIFECYCLE_AMOUNT_LAMPORTS;
        if (typeof value === 'bigint') {
            if (value <= 0n) throw new Error('Umbra lifecycle amount must be positive');
            return value.toString();
        }
        if (typeof value === 'number') {
            if (!Number.isSafeInteger(value) || value <= 0) {
                throw new Error('Umbra lifecycle amount must be a positive safe integer');
            }
            return String(value);
        }
        if (!value || !/^\d+$/.test(value) || BigInt(value) <= 0n) {
            throw new Error('Umbra lifecycle request is missing a positive amountLamports');
        }
        return value;
    }

    private async withUmbraPhaseTimeout<T>(
        role: 'buyer' | 'seller',
        phase: 'SHIELD' | 'CREATE_UTXO' | 'CLAIM' | 'UNSHIELD',
        task: () => Promise<T>
    ): Promise<T> {
        const timeoutMs = Number(process.env.AIROTC_UMBRA_PHASE_TIMEOUT_MS || 120_000);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return task();
        }
        let timeout: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                task(),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error(`Umbra ${role} ${phase} timed out after ${timeoutMs}ms`)),
                        timeoutMs
                    );
                }),
            ]);
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    private async withUmbraOperationTimeout<T>(
        label: string,
        task: () => Promise<T>
    ): Promise<T> {
        const timeoutMs = Number(process.env.AIROTC_UMBRA_PHASE_TIMEOUT_MS || 120_000);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return task();
        }
        let timeout: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                task(),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
                        timeoutMs
                    );
                }),
            ]);
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    private async waitForClaimableUmbraUtxo(
        umbra: UmbraService,
        options: { attempts?: number; delayMs?: number } = {}
    ): Promise<{ received: readonly any[] }> {
        const attempts = options.attempts ?? Number(process.env.AIROTC_UMBRA_SCAN_ATTEMPTS || 60);
        const delayMs = options.delayMs ?? Number(process.env.AIROTC_UMBRA_SCAN_DELAY_MS || 3_000);
        const treeCount = Number(process.env.AIROTC_UMBRA_SCAN_TREE_COUNT || 4);
        const lookback = BigInt(process.env.AIROTC_UMBRA_SCAN_LOOKBACK || 25);
        const initialStart = process.env.AIROTC_UMBRA_SCAN_START_INDEX
            ? BigInt(process.env.AIROTC_UMBRA_SCAN_START_INDEX)
            : 0n;
        const nextStartByTree = Array.from({ length: treeCount }, () => initialStart);
        const endIndex = process.env.AIROTC_UMBRA_SCAN_END_INDEX
            ? BigInt(process.env.AIROTC_UMBRA_SCAN_END_INDEX)
            : undefined;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            for (let treeIndex = 0; treeIndex < treeCount; treeIndex += 1) {
                try {
                    const scan = await umbra.scanIncomingUtxos(
                        treeIndex,
                        nextStartByTree[treeIndex],
                        endIndex
                    );
                    const receiverClaimable = [
                        ...(scan.received || []),
                        ...(scan.publicReceived || []),
                    ];
                    if (receiverClaimable.length) {
                        return { received: receiverClaimable };
                    }
                    if (scan.nextScanStartIndex !== undefined) {
                        const next = BigInt(scan.nextScanStartIndex);
                        if (next > nextStartByTree[treeIndex]) {
                            nextStartByTree[treeIndex] = next > lookback ? next - lookback : 0n;
                        }
                    }
                } catch (error: any) {
                    console.warn(
                        `[SDK] Umbra UTXO scan attempt ${attempt}/${attempts} tree=${treeIndex} failed: ${error?.message || String(error)}`
                    );
                }
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        throw new Error(`No receiver-claimable Umbra UTXO found after ${attempts} scan attempts`);
    }

    private async waitForSelfClaimableUmbraUtxo(
        umbra: UmbraService,
        options: { attempts?: number; delayMs?: number } = {}
    ): Promise<{ selfBurnable: readonly any[] }> {
        const attempts = options.attempts ?? Number(process.env.AIROTC_UMBRA_SCAN_ATTEMPTS || 60);
        const delayMs = options.delayMs ?? Number(process.env.AIROTC_UMBRA_SCAN_DELAY_MS || 3_000);
        const treeCount = Number(process.env.AIROTC_UMBRA_SCAN_TREE_COUNT || 4);
        const lookback = BigInt(process.env.AIROTC_UMBRA_SCAN_LOOKBACK || 25);
        const initialStart = process.env.AIROTC_UMBRA_SCAN_START_INDEX
            ? BigInt(process.env.AIROTC_UMBRA_SCAN_START_INDEX)
            : 0n;
        const nextStartByTree = Array.from({ length: treeCount }, () => initialStart);
        const endIndex = process.env.AIROTC_UMBRA_SCAN_END_INDEX
            ? BigInt(process.env.AIROTC_UMBRA_SCAN_END_INDEX)
            : undefined;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            for (let treeIndex = 0; treeIndex < treeCount; treeIndex += 1) {
                try {
                    const scan = await umbra.scanIncomingUtxos(
                        treeIndex,
                        nextStartByTree[treeIndex],
                        endIndex
                    );
                    const selfClaimable = [
                        ...(scan.selfBurnable || []),
                        ...(scan.publicSelfBurnable || []),
                    ];
                    if (selfClaimable.length) {
                        return { selfBurnable: selfClaimable };
                    }
                    if (scan.nextScanStartIndex !== undefined) {
                        const next = BigInt(scan.nextScanStartIndex);
                        if (next > nextStartByTree[treeIndex]) {
                            nextStartByTree[treeIndex] = next > lookback ? next - lookback : 0n;
                        }
                    }
                } catch (error: any) {
                    console.warn(
                        `[SDK] Umbra self-UTXO scan attempt ${attempt}/${attempts} tree=${treeIndex} failed: ${error?.message || String(error)}`
                    );
                }
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        throw new Error(`No self-claimable Umbra UTXO found after ${attempts} scan attempts`);
    }

    private extractRequiredUmbraSignature(
        result: any,
        phase: 'SHIELD' | 'CREATE_UTXO' | 'CLAIM' | 'UNSHIELD'
    ): string {
        const candidates: unknown[] = [];
        if (phase === 'CLAIM' && result?.batches instanceof Map) {
            for (const batch of result.batches.values()) {
                candidates.push(batch?.txSignature, batch?.callbackSignature);
            }
        }
        if (phase === 'CREATE_UTXO') {
            candidates.push(result?.callbackSignature, result?.createUtxoSignature, result?.queueSignature);
        } else if (phase === 'SHIELD' || phase === 'UNSHIELD') {
            candidates.push(result?.callbackSignature, result?.queueSignature);
        }
        candidates.push(result?.createProofAccountSignature, Array.isArray(result) ? result[result.length - 1] : undefined);
        const signature = candidates.find(
            (value): value is string =>
                typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(value)
        );
        if (!signature) {
            throw new Error(`Umbra ${phase} did not return a real Solana transaction signature`);
        }
        return signature;
    }

    private migrateOfferScopedWalletReferences(previousReferenceId: string, ticketId: string): void {
        for (const [address, entry] of this.settlementWallets.entries()) {
            if (entry.referenceKind === 'offer_creator' && entry.referenceId === previousReferenceId) {
                this.settlementWallets.set(address, {
                    ...entry,
                    referenceId: ticketId,
                });
            }
        }

        for (const [address, entry] of this.rewardWallets.entries()) {
            if (entry.referenceKind === 'offer_creator' && entry.referenceId === previousReferenceId) {
                this.rewardWallets.set(address, {
                    ...entry,
                    referenceId: ticketId,
                });
            }
        }

        for (const [address, entry] of this.fundingWallets.entries()) {
            if (entry.referenceKind === 'offer_creator' && entry.referenceId === previousReferenceId) {
                this.fundingWallets.set(address, {
                    ...entry,
                    referenceId: ticketId,
                });
            }
        }

        this.persistLocalState();
    }

    private resolveFundingWalletKeypair(
        ticketId: string,
        allowMissing: boolean = false
    ): Keypair | null {
        const exact = Array.from(this.fundingWallets.values()).find(
            (entry) => entry.referenceId === ticketId
        );
        const fallback = exact || Array.from(this.fundingWallets.values())
            .filter((entry) => entry.referenceKind === 'offer_creator')
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

        if (!fallback) {
            if (allowMissing) {
                return null;
            }
            throw new Error(`No confidential funding wallet found for ticket ${ticketId}`);
        }

        return Keypair.fromSecretKey(bs58.decode(fallback.secretKeyBase58));
    }

    private async ensureFundingWalletBalance(
        connection: Connection,
        fundingWallet: Keypair,
        requiredLamports: bigint
    ): Promise<void> {
        const currentBalance = BigInt(
            await connection.getBalance(fundingWallet.publicKey, "confirmed")
        );
        if (currentBalance >= requiredLamports) {
            return;
        }

        const topUpLamports = requiredLamports - currentBalance;
        const topUpTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: this.config.keypair.publicKey,
                toPubkey: fundingWallet.publicKey,
                lamports: Number(topUpLamports),
            })
        );
        await sendAndConfirmTransaction(connection, topUpTx, [this.config.keypair], {
            commitment: "confirmed",
        });
    }

    private resolveStateFilePath(): string | null {
        if (this.config.persistLocalState === false) {
            return null;
        }

        if (this.config.stateFilePath) {
            return this.config.stateFilePath;
        }

        const safeWallet = this.wallet.replace(/[^a-zA-Z0-9_-]/g, "_");
        return path.join(os.homedir(), ".air-otc", "meridian-client-state", `${safeWallet}.json`);
    }

    private serializePrivateTermCacheEntry(
        entry: PrivateTermCacheEntry
    ): PersistedPrivateTermCacheEntry {
        return {
            assetMint: entry.assetMint,
            assetSymbol: entry.assetSymbol,
            priceSol: entry.priceSol,
            buyerCollateralSol: entry.buyerCollateralSol,
            sellerCollateralSol: entry.sellerCollateralSol,
            priceLamports: entry.priceLamports.toString(),
            buyerCollateralLamports: entry.buyerCollateralLamports.toString(),
            sellerCollateralLamports: entry.sellerCollateralLamports.toString(),
        };
    }

    private deserializePrivateTermCacheEntry(
        entry: PersistedPrivateTermCacheEntry
    ): PrivateTermCacheEntry {
        return {
            assetMint: entry.assetMint,
            assetSymbol: entry.assetSymbol,
            priceSol: entry.priceSol,
            buyerCollateralSol: entry.buyerCollateralSol,
            sellerCollateralSol: entry.sellerCollateralSol,
            priceLamports: BigInt(entry.priceLamports),
            buyerCollateralLamports: BigInt(entry.buyerCollateralLamports),
            sellerCollateralLamports: BigInt(entry.sellerCollateralLamports),
        };
    }

    private restoreLocalState(): void {
        if (!this.stateFilePath || !fs.existsSync(this.stateFilePath)) {
            return;
        }

        try {
            const raw = fs.readFileSync(this.stateFilePath, 'utf8');
            const parsed = JSON.parse(raw) as PersistedMeridianState;

            const resetWorkflowState = process.env.AIROTC_DEMO_RESET_WORKFLOW_STATE === 'true';
            this.currentTicketId = resetWorkflowState ? null : parsed.currentTicketId || null;
            this.releaseRequests = resetWorkflowState ? new Map() : new Map(
                (parsed.releaseRequests || []).map((request) => [request.ticketId, request])
            );
            this.fundingRequests = resetWorkflowState ? new Map() : new Map(
                (parsed.fundingRequests || []).map((request) => [request.ticketId, request])
            );
            this.umbraLifecycleRequests = resetWorkflowState ? new Map() : new Map(
                (parsed.umbraLifecycleRequests || []).map((request) => [request.ticketId, request])
            );
            this.umbraLifecycleProgress = resetWorkflowState ? new Map() : new Map(
                (parsed.umbraLifecycleProgress || []).map((entry) => [entry.ticketId, entry])
            );
            this.privateTermCache = resetWorkflowState ? new Map() : new Map(
                (parsed.privateTermCache || []).map(([ticketId, entry]) => [
                    ticketId,
                    this.deserializePrivateTermCacheEntry(entry),
                ])
            );
            this.settlementWallets = new Map(
                (parsed.settlementWallets || []).map((entry) => [
                    entry.address,
                    {
                        ...entry,
                        reference: entry.reference || `settlement:${entry.referenceKind}`,
                    },
                ])
            );
            this.rewardWallets = new Map(
                (parsed.rewardWallets || []).map((entry) => [
                    entry.address,
                    {
                        ...entry,
                        reference: entry.reference || `reward:${entry.referenceKind}`,
                    },
                ])
            );
            this.fundingWallets = new Map(
                (parsed.fundingWallets || []).map((entry) => [
                    entry.address,
                    {
                        ...entry,
                        reference: entry.reference || `funding:${entry.referenceKind}`,
                    },
                ])
            );
            this.outboundQueue = resetWorkflowState
                ? []
                : Array.isArray(parsed.outboundQueue) ? parsed.outboundQueue : [];
        } catch (error: any) {
            console.warn(`[SDK] Failed to restore local workflow state: ${error.message}`);
        }
    }

    private persistLocalState(): void {
        if (!this.stateFilePath) {
            return;
        }

        try {
            fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
            const payload: PersistedMeridianState = {
                currentTicketId: this.currentTicketId,
                releaseRequests: Array.from(this.releaseRequests.values()),
                fundingRequests: Array.from(this.fundingRequests.values()),
                umbraLifecycleRequests: Array.from(this.umbraLifecycleRequests.values()),
                umbraLifecycleProgress: Array.from(this.umbraLifecycleProgress.values()),
                privateTermCache: Array.from(this.privateTermCache.entries()).map(([ticketId, entry]) => [
                    ticketId,
                    this.serializePrivateTermCacheEntry(entry),
                ]),
                settlementWallets: Array.from(this.settlementWallets.values()),
                rewardWallets: Array.from(this.rewardWallets.values()),
                fundingWallets: Array.from(this.fundingWallets.values()),
                outboundQueue: this.outboundQueue,
            };
            fs.writeFileSync(this.stateFilePath, JSON.stringify(payload, null, 2), {
                encoding: 'utf8',
                mode: 0o600,
            });
        } catch (error: any) {
            console.warn(`[SDK] Failed to persist local workflow state: ${error.message}`);
        }
    }

    private canSendImmediately(): boolean {
        return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    private hasHealthySession(): boolean {
        return this.canSendImmediately() && !!this.agentId;
    }

    private clearReconnectTimer(): void {
        if (!this.reconnectTimer) {
            return;
        }
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    private sendRaw(payload: any): void {
        if (!this.canSendImmediately()) {
            throw new Error("WebSocket is not open");
        }
        this.ws!.send(JSON.stringify(payload));
    }

    private enqueueOutbound(payload: any): void {
        const maxQueuedMessages = this.config.maxQueuedMessages ?? 128;
        if (this.outboundQueue.length >= maxQueuedMessages) {
            this.outboundQueue.shift();
        }
        this.outboundQueue.push(payload);
        this.persistLocalState();
    }

    private flushOutboundQueue(): void {
        if (!this.canSendImmediately() || this.outboundQueue.length === 0) {
            return;
        }

        const pending = [...this.outboundQueue];
        this.outboundQueue = [];
        this.persistLocalState();

        for (let index = 0; index < pending.length; index += 1) {
            try {
                this.sendRaw(pending[index]);
            } catch (error: any) {
                this.outboundQueue = pending.slice(index);
                this.persistLocalState();
                console.warn(`[SDK] Failed to flush queued message: ${error.message}`);
                break;
            }
        }
    }

    private restoreSubscriptionsAndFlush(): void {
        if (this.currentTicketId && this.agentId) {
            this.sendRaw({
                version: '1.0',
                type: 'status',
                ticket_id: this.currentTicketId,
                agent_id: this.agentId,
                timestamp: Date.now(),
            });
        }
        this.flushOutboundQueue();
    }

    private shouldAutoReconnect(): boolean {
        return this.config.autoReconnect !== false;
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer || this.connectPromise || this.hasHealthySession() || !this.shouldAutoReconnect()) {
            return;
        }

        const baseDelay = this.config.reconnectBackoffMs ?? 1_000;
        const maxDelay = this.config.reconnectMaxBackoffMs ?? 15_000;
        const delay = Math.min(baseDelay * 2 ** this.reconnectAttempt, maxDelay);
        this.reconnectAttempt += 1;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect()
                .catch((error) => {
                    console.warn(`[SDK] Auto-reconnect failed: ${error.message}`);
                });
        }, delay);
    }

    private clearTicketWorkflowState(ticketId: string): void {
        this.releaseRequests.delete(ticketId);
        this.fundingRequests.delete(ticketId);
        this.umbraLifecycleRequests.delete(ticketId);
        this.privateTermCache.delete(ticketId);
        this.ticketPhases.delete(ticketId);
        if (this.currentTicketId === ticketId) {
            this.currentTicketId = null;
        }
        this.persistLocalState();
    }

    private createWebSocket(url: string): WebSocket {
        return this.config.wsFactory ? this.config.wsFactory(url) : new WebSocket(url);
    }

    /** Disconnect cleanly. */
    disconnect(): void {
        this.manualDisconnect = true;
        this.clearReconnectTimer();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
