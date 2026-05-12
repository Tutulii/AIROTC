/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  Negotiation Rollup Service — MagicBlock ER & PER Integration      ║
 * ║                                                                    ║
 * ║  Production-grade orchestrator for MagicBlock Ephemeral Rollups.   ║
 * ║  Split-lifecycle architecture:                                     ║
 * ║    openERSession()  / closeERSession()  — Public trades            ║
 * ║    openPERSession() / closePERSession() — Private (TEE) trades     ║
 * ║                                                                    ║
 * ║  Between open and close, external agent loops send transactions    ║
 * ║  through the ConnectionMagicRouter for sub-100ms state updates.    ║
 * ║                                                                    ║
 * ║  Rust program: #[delegate] macro from ephemeral-rollups-sdk        ║
 * ║  TS client:    Anchor Program calls (IDL-driven)                   ║
 * ║  PER privacy:  Intel TDX TEE hardware (NOT FHE/encryption)         ║
 * ║                                                                    ║
 * ║  SDK:    @magicblock-labs/ephemeral-rollups-sdk v0.11.1            ║
 * ║  Source: All APIs verified from SDK source + official GitHub       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    sendAndConfirmTransaction,
    ComputeBudgetProgram,
    Signer,
    TransactionInstruction,
} from "@solana/web3.js";
import { AnchorProvider, Program, BN, Wallet } from "@coral-xyz/anchor";
import nacl from "tweetnacl";

// ── MagicBlock SDK Imports (verified from node_modules .d.ts) ────────
import {
    // Constants — Official MagicBlock program IDs
    DELEGATION_PROGRAM_ID,
    PERMISSION_PROGRAM_ID,
    createCreatePermissionInstruction,

    // PDA derivation helpers
    permissionPdaFromAccount,

    // Access control (PER-specific — TEE, not FHE)
    getAuthToken,
    verifyTeeRpcIntegrity,

    // Access control types
    AUTHORITY_FLAG,
    TX_LOGS_FLAG,
    TX_BALANCES_FLAG,

    // Magic Router — extends Connection for ER routing
    ConnectionMagicRouter,

    // Utils
    GetCommitmentSignature,
} from "@magicblock-labs/ephemeral-rollups-sdk";

import type { Member, MembersArgs } from "@magicblock-labs/ephemeral-rollups-sdk";

// ── Anchor IDL + types for the deployed magicblock-negotiation program ──
import negotiationIdl from "../idl/magicblock_negotiation.json";
import type { MagicblockNegotiation } from "../idl/magicblock_negotiation";

import { logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import { rpcManager } from "../utils/rpcManager";
import { FHEHandoffAdapter, type NegotiatedTerms } from "./fheHandoffAdapter";
import { walletRegistry } from "../state/walletRegistry";
import { sessionManager } from "../gateway/sessionManager";
import { eventBus } from "./eventBus";
import {
    PER_TEE_RPC_URL,
    PER_TEE_VALIDATOR_DEVNET,
    PER_TEE_VALIDATOR_FQDN,
} from "./magicblockPerContract";
import {
    rollupSessionJournal,
    type PersistedRollupPhase,
    type PersistedRollupSessionRecord,
} from "./rollupSessionJournal";
import {
    PendingL1PermissionCloseError,
    waitForPermissionActivationWithFallback,
} from "./privateNegotiationService";
import type { AttestedEscrowIntent, PrivateHandoffProofState } from "../types/dealPipeline";

export type { NegotiatedTerms } from "./fheHandoffAdapter";

// ══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════

/**
 * MagicBlock ER validator endpoints.
 * FQDNs are stable; identity keys are fallbacks only.
 * At runtime, resolveValidatorIdentity() calls getClosestValidator()
 * to fetch the live identity from the validator itself.
 */
const ER_VALIDATOR_FQDNS = {
    ASIA: "devnet-as.magicblock.app",
    EU: "devnet-eu.magicblock.app",
    US: "devnet-us.magicblock.app",
} as const;

const EMPTY_PUBLIC_KEY = new PublicKey("11111111111111111111111111111111");

/** Fallback validator identity keys — used only if getClosestValidator() fails.
 *  ✅ Verified 2026-04-23 via live `getIdentity` JSON-RPC on each endpoint.
 *  Note: keys may rotate over time. The runtime always tries getClosestValidator()
 *  first (which fetches the live key from the validator itself). These are
 *  last-resort fallbacks only. If they fail, re-verify with:
 *    curl -s -X POST https://devnet-as.magicblock.app \
 *      -H "Content-Type: application/json" \
 *      -d '{"jsonrpc":"2.0","id":1,"method":"getIdentity","params":[]}' */
const ER_IDENTITY_FALLBACKS: Record<string, PublicKey> = {
    "devnet-as.magicblock.app": new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"),
    "devnet-eu.magicblock.app": new PublicKey("MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e"),
    "devnet-us.magicblock.app": new PublicKey("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd"),
    [PER_TEE_VALIDATOR_FQDN]: PER_TEE_VALIDATOR_DEVNET,
};

/* COMMIT_FREQUENCY_MS removed — delegation config uses DelegateConfig::default()
   in the Rust program. No client-side commit frequency is needed. */

/** TEE verification retry config */
const TEE_VERIFY_MAX_RETRIES = 3;
const TEE_VERIFY_RETRY_DELAY_MS = 2_000;

/** Permission activation timeout */
const PERMISSION_ACTIVATION_TIMEOUT_MS = 30_000;

/** Session timeout — auto-close after 5 minutes of negotiation */
const SESSION_TIMEOUT_MS = Number(process.env.MAGICBLOCK_SESSION_TIMEOUT_MS || 5 * 60 * 1000);

/** Undelegation retry config */
const UNDELEGATE_RETRY_MAX = 5;
const UNDELEGATE_RETRY_INTERVAL_MS = 30_000;
const UNDELEGATE_RETRY_BACKOFF_FACTOR = 2;

/** MagicBlock Negotiation program ID — the delegation-compatible program.
 * Uses #[delegate] macro from ephemeral-rollups-sdk on account structs.
 * The escrow program stays on L1 untouched.
 */
const NEGOTIATION_PROGRAM_ID = new PublicKey(
    process.env.NEGOTIATION_PROGRAM_ID || "BfFvxgysVSGdP2TwAjBRSFhDYtK2JA1VBd8BUqh8nGGq"
);

let cachedPerAuthorityAuthToken: { token: string; expiresAt: number } | null = null;

function isStrictOpaquePerModeEnabled(): boolean {
    return (process.env.PER_STRICT_OPAQUE_MODE || "true").toLowerCase() !== "false";
}

/**
 * Derives a Session PDA from the negotiation program.
 * Must match the Rust seeds: [b"session", &session_id.to_le_bytes()]
 */
function deriveSessionPda(sessionId: bigint): PublicKey {
    const sessionIdBuffer = Buffer.alloc(8);
    sessionIdBuffer.writeBigUInt64LE(sessionId);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), sessionIdBuffer],
        NEGOTIATION_PROGRAM_ID
    );
    return pda;
}

/** Generates a deterministic session ID from a ticket ID string */
function ticketToSessionId(ticketId: string): bigint {
    // Use first 8 bytes of a hash of the ticket ID for a deterministic u64
    const hash = Buffer.from(ticketId.replace(/[^a-f0-9]/gi, "").slice(0, 16).padEnd(16, "0"), "hex");
    return hash.readBigUInt64LE(0);
}

async function getPerAuthorityAuthToken(
    payer: Keypair,
    context: { ticketId?: string; step: string }
): Promise<{ token: string; expiresAt: number }> {
    if (cachedPerAuthorityAuthToken && cachedPerAuthorityAuthToken.expiresAt - 60_000 > Date.now()) {
        logger.info("per_server_auth_token_cache_hit", {
            ticketId: context.ticketId ?? null,
            step: context.step,
        });
        return cachedPerAuthorityAuthToken;
    }

    const authResult = await withRetry(
        () =>
            getAuthToken(
                PER_TEE_RPC_URL,
                payer.publicKey,
                async (message: Uint8Array) => nacl.sign.detached(message, payer.secretKey)
            ),
        {
            label: "per_server_auth",
            ticketId: context.ticketId,
            step: context.step,
        }
    );

    cachedPerAuthorityAuthToken = {
        token: authResult.token,
        expiresAt: authResult.expiresAt,
    };

    logger.info("per_server_auth_token_acquired", {
        ticketId: context.ticketId ?? null,
        step: context.step,
    });

    return cachedPerAuthorityAuthToken;
}

// ══════════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════════

export interface NegotiationSession {
    ticketId: string;
    dealPda?: PublicKey;
    /** The Session PDA that was actually delegated to the ER/PER validator.
     *  This is the account that must be commit+undelegated — NOT dealPda. */
    sessionPda: PublicKey;
    delegatedAt: number;
    validator: string;
    validatorIdentity: PublicKey;
    isPrivate: boolean;
    buyerAgentId?: string;
    sellerAgentId?: string;
    permissionMode?: "delegated" | "session_only_fallback";
    authToken?: string;
    authExpiresAt?: number;
    erConnection: ConnectionMagicRouter;
    authorityConnection?: ConnectionMagicRouter;
    /** NodeJS timer handle for automatic session timeout */
    timeoutHandle?: ReturnType<typeof setTimeout>;
    /** Negotiated terms — set by the agent loop when consensus is reached */
    negotiatedTerms?: NegotiatedTerms;
}

/** Tracks a failed undelegation for retry */
interface FailedUndelegation {
    ticketId: string;
    dealPda?: PublicKey;
    /** The delegated Session PDA — this is what must be undelegated */
    sessionPda: PublicKey;
    erConnection: ConnectionMagicRouter;
    validator: string;
    validatorIdentity: PublicKey;
    failedAt: number;
    attempts: number;
    lastError: string;
}

function isPermissionDelegateBorrowConflict(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    return (
        lower.includes("already borrowed") ||
        lower.includes("borrow reference for an account") ||
        lower.includes("accountborrowfailed")
    );
}

function isAccountAlreadyInUseError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    return (
        lower.includes("already in use") ||
        lower.includes("account already exists") ||
        lower.includes("already initialized")
    );
}

function isAlreadyDelegatedSessionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    return (
        (lower.includes("accountownedbywrongprogram") ||
            lower.includes("owned by a different program")) &&
        lower.includes(DELEGATION_PROGRAM_ID.toBase58().toLowerCase()) &&
        lower.includes(NEGOTIATION_PROGRAM_ID.toBase58().toLowerCase())
    );
}

interface PendingPermissionClose {
    ticketId: string;
    sessionPda: PublicKey;
    sessionId: bigint;
    commitSig: string;
    attempts: number;
    failedAt: number;
    lastError: string;
}

interface SessionAccountSnapshot {
    sessionPda: PublicKey;
    agreedPriceLamports: bigint;
    agreedAsset: string;
    buyerCollateralLamports: bigint;
    sellerCollateralLamports: bigint;
    status: string;
    buyerParticipant: PublicKey;
    sellerParticipant: PublicKey;
    termsHashHex: string;
    buyerPaymentFundingHashHex: string;
    buyerCollateralFundingHashHex: string;
    sellerCollateralFundingHashHex: string;
    buyerCollateralCiphertext: PublicKey;
    sellerCollateralCiphertext: PublicKey;
    paymentAmountCiphertext: PublicKey;
    settlementResultCiphertext: PublicKey;
    networkEncryptionKey: PublicKey;
    proofRecordedAt: bigint;
}

export interface SessionOpenResult {
    ticketId: string;
    dealPda?: PublicKey;
    delegationSignature: string;
    erConnection: ConnectionMagicRouter;
    validator: string;
    isPrivate: boolean;
    sessionPda: PublicKey;
    sessionRpcUrl: string;
}

export interface SessionCloseResult {
    success: boolean;
    ticketId: string;
    commitSignature: string;
    l1TransactionSignature: string | null;
    /** TEE-sealed state data (only for PER sessions). PER uses Intel TDX
     *  hardware privacy — NOT FHE encryption. This field contains the
     *  serialized negotiation state that was protected by TEE during the session. */
    teeSealedState: string | null;
    sessionDurationMs: number;
    validator: string;
}

// ══════════════════════════════════════════════════════════════════════
// SERVICE
// ══════════════════════════════════════════════════════════════════════

export class NegotiationRollupService {
    private readonly baseConnection: Connection;
    private readonly payer: Keypair;
    private readonly rollupMode: "ER" | "PER";
    /** FHE adapter — retained for downstream escrow pipeline (separate from MagicBlock PER).
     *  NOT used for PER privacy — PER uses Intel TDX TEE hardware. */
    private readonly fheAdapter: FHEHandoffAdapter;
    private readonly activeSessions: Map<string, NegotiationSession> = new Map();
    private readonly pendingUndelegations: FailedUndelegation[] = [];
    private readonly pendingPermissionCloses: PendingPermissionClose[] = [];
    private retryLoopHandle: ReturnType<typeof setInterval> | null = null;
    /** Anchor Program instance for the magicblock-negotiation program */
    private readonly negotiationProgram: Program<MagicblockNegotiation>;

    constructor(connection: Connection, payer: Keypair, rollupMode: "ER" | "PER" = "ER") {
        this.baseConnection = connection;
        this.payer = payer;
        this.rollupMode = rollupMode;
        this.fheAdapter = new FHEHandoffAdapter(connection, payer);
        this.startRetryLoop();

        // Create the Anchor program instance from the generated IDL
        const wallet = new Wallet(payer);
        const provider = new AnchorProvider(connection, wallet, {
            commitment: "confirmed",
        });
        this.negotiationProgram = new Program(
            negotiationIdl as any,
            provider
        ) as unknown as Program<MagicblockNegotiation>;

        logger.info("negotiation_rollup_service_initialized", {
            delegationProgram: DELEGATION_PROGRAM_ID.toBase58(),
            permissionProgram: PERMISSION_PROGRAM_ID.toBase58(),
            negotiationProgram: NEGOTIATION_PROGRAM_ID.toBase58(),
        });
    }



    // ════════════════════════════════════════════════════════════════════
    // ER — PUBLIC TRADE PATH
    // ════════════════════════════════════════════════════════════════════

    /**
     * Opens a public ER negotiation session.
     *
     * Delegates the Deal PDA to the nearest ER validator.
     * Returns a ConnectionMagicRouter that the agent negotiation loop
     * must use for all subsequent state mutations (sub-100ms).
     *
     * The caller is responsible for:
     *   1. Sending negotiation transactions through the returned erConnection
     *   2. Calling closeERSession() when both agents reach consensus
     *   3. Calling forceCloseSession() if the timeout expires
     *
     * @param ticketId — Unique deal ticket identifier
     * @param dealPda  — The on-chain Deal PDA (already initialized by create_deal)
     * @param agents   — Public keys (base58) of the two negotiating agents
     */
    async openERSession(
        ticketId: string,
        dealPda: PublicKey | undefined,
        agents: string[]
    ): Promise<SessionOpenResult> {
        const validatorFqdn = ER_VALIDATOR_FQDNS.EU;

        // ── Runtime-resolve validator identity ──
        const validatorIdentity = await this.resolveValidatorIdentity(validatorFqdn);

        logger.info("er_session_opening", {
            ticketId,
            validator: validatorFqdn,
            validatorIdentity: validatorIdentity.toBase58(),
            dealPda: dealPda?.toBase58() || "not_created_yet",
            agents,
        });

        // ── Derive session PDA owned by the negotiation program ──
        const sessionId = ticketToSessionId(ticketId);
        const sessionPda = deriveSessionPda(sessionId);

        // ── Step 1: Initialize Session PDA on L1 ──
        // Creates the on-chain account that will be delegated.
        const initSig = await this.initializeSessionOnL1(ticketId, sessionId, sessionPda);

        logger.info("er_session_initialized", {
            ticketId,
            signature: initSig,
            sessionPda: sessionPda.toBase58(),
        });

        // ── Step 2: Delegate Session PDA via program CPI ──
        // The program's #[delegate] macro handles PDA signing internally.
        // The client CANNOT delegate PDAs directly (no private key).
        const delegateSig = await this.negotiationProgram.methods
            .delegateSession()
            .accountsPartial({
                payer: this.payer.publicKey,
                validator: validatorIdentity,
                session: sessionPda,
            })
            .rpc();

        logger.info("er_delegation_confirmed", {
            ticketId,
            signature: delegateSig,
            sessionPda: sessionPda.toBase58(),
            validatorIdentity: validatorIdentity.toBase58(),
        });

        // ── Create ConnectionMagicRouter for ER state updates ──
        const erConnection = new ConnectionMagicRouter(
            `https://${validatorFqdn}`,
            { commitment: "confirmed" }
        );
        const sessionRpcUrl = `https://${validatorFqdn}`;

        // ── Verify delegation status ──
        const delegationStatus = await erConnection.getDelegationStatus(sessionPda);
        if (!delegationStatus.isDelegated) {
            throw new Error(
                `ER delegation verification failed for ${sessionPda.toBase58()}. ` +
                `Expected isDelegated=true, got isDelegated=false.`
            );
        }

        logger.info("er_delegation_verified", {
            ticketId,
            isDelegated: delegationStatus.isDelegated,
        });

        // ── Track active session with auto-timeout ──
        const session: NegotiationSession = {
            ticketId,
            dealPda,
            sessionPda,
            delegatedAt: Date.now(),
            validator: validatorFqdn,
            validatorIdentity,
            isPrivate: false,
            erConnection,
        };
        this.registerSessionTimeout(session);
        this.activeSessions.set(ticketId, session);
        this.persistSessionRecord(session, "active");

        try {
            const agentRecords = await Promise.all(
                agents.map(async (wallet) => walletRegistry.getOrCreateAgent(wallet))
            );
            for (const agent of agentRecords) {
                sessionManager.sendToAgent(agent.id, {
                    version: "1.0",
                    type: "ROLLUP_SESSION_READY",
                    ticket_id: ticketId,
                    agent_id: agent.id,
                    timestamp: Date.now(),
                    payload: {
                        rollupMode: "ER",
                        rollupRpcUrl: sessionRpcUrl,
                        sessionPda: sessionPda.toBase58(),
                        ticketId,
                    },
                });
            }
        } catch (error) {
            logger.warn("er_session_ready_broadcast_skipped", {
                ticketId,
                reason: error instanceof Error ? error.message : String(error),
            });
        }

        return {
            ticketId,
            dealPda,
            delegationSignature: delegateSig,
            erConnection,
            validator: validatorFqdn,
            isPrivate: false,
            sessionPda,
            sessionRpcUrl,
        };
    }

    /**
     * Closes an ER session after agents reach consensus.
     *
     * Commits the finalized negotiation state and undelegates the Deal PDA
     * back to Solana L1 in a single atomic transaction. After this call,
     * the Deal PDA is back on mainnet with the agreed terms written.
     *
     * @param ticketId — The ticket whose session to close
     */
    async closeERSession(ticketId: string): Promise<SessionCloseResult> {
        const session = this.getActiveSessionOrThrow(ticketId);
        this.clearSessionTimeout(session);

        logger.info("er_session_closing", {
            ticketId,
            sessionDurationMs: Date.now() - session.delegatedAt,
        });

        const result = await this.commitAndUndelegate(session);
        this.activeSessions.delete(ticketId);
        this.clearPersistedSession(ticketId);

        return {
            ...result,
            teeSealedState: null, // ER sessions are public — no TEE sealed state
        };
    }

    // ════════════════════════════════════════════════════════════════════
    // PER — PRIVATE TRADE PATH
    // ════════════════════════════════════════════════════════════════════

    /**
     * Opens a private PER (Private Ephemeral Rollup) negotiation session.
     *
     * PER uses Intel TDX TEE hardware for privacy — the validator runs
     * inside a CPU enclave. State is hardware-shielded, NOT encrypted.
     *
     * Full lifecycle:
     *   1. Verify TEE RPC integrity (Intel TDX DCAP attestation)
     *   2. Acquire signed auth token for TEE validator access
     *   3. Create on-chain permission (restrict state visibility to matched agents)
     *   4. Wait for permission activation on TEE
     *   5. Initialize + delegate Session PDA to TEE validator
     *
     * @param ticketId — Unique deal ticket identifier
     * @param dealPda  — The on-chain Deal PDA (already initialized by create_deal)
     * @param agents   — Public keys (base58) of the two negotiating agents
     */
    /**
     * Opens a private PER (Private Ephemeral Rollup) negotiation session.
     * Uses the PrivateNegotiationService to coordinate Intel TDX hardware privacy.
     */
    async openPERSession(
        ticketId: string,
        dealPda: PublicKey | undefined,
        buyerPubkey: PublicKey,
        sellerPubkey: PublicKey
    ): Promise<SessionOpenResult> {
        const teeRpcUrl = PER_TEE_RPC_URL;
        const teeValidatorIdentity = await this.resolveValidatorIdentity(PER_TEE_VALIDATOR_FQDN);

        logger.info("per_session_opening", {
            ticketId,
            validator: PER_TEE_VALIDATOR_FQDN,
            dealPda: dealPda?.toBase58() || "not_created_yet",
        });

        // Initialize the PrivateNegotiationService
        const { PrivateNegotiationService } = await import("./privateNegotiationService");
        const privateService = new PrivateNegotiationService(this.baseConnection, this.payer);

        // Step 1: Verify TEE Integrity
        const isVerified = await withRetry(
            () => privateService.verifyTeeIntegrity({ throwOnError: true }),
            { label: "per_verify_tee_integrity", ticketId, step: "verify_tee_integrity" }
        );
        if (!isVerified) {
            throw new Error("TEE RPC Integrity Verification Failed");
        }

        // Pattern B Auth: Server proxies agent token acquisition
        // The AIROTC server routes the cryptographic challenge to the agent via WebSocket.
        const buyerAgent = await walletRegistry.getOrCreateAgent(buyerPubkey.toBase58());
        const sellerAgent = await walletRegistry.getOrCreateAgent(sellerPubkey.toBase58());

        const buyerAuthTokenPromise = privateService.getAgentAuthTokenPatternB(
            buyerPubkey,
            this.createAgentChallengeSigner(buyerAgent.id, ticketId)
        );

        const sellerAuthTokenPromise = privateService.getAgentAuthTokenPatternB(
            sellerPubkey,
            this.createAgentChallengeSigner(sellerAgent.id, ticketId)
        );

        // Wait for both agents to respond concurrently
        const [buyerAuth, sellerAuth] = await Promise.all([buyerAuthTokenPromise, sellerAuthTokenPromise]);
        const serverAuth = await getPerAuthorityAuthToken(this.payer, {
            ticketId,
            step: "open_per_session",
        });

        // Step 0 (Note 1): Initialize Session PDA on L1 FIRST
        const sessionId = ticketToSessionId(ticketId);
        const sessionPda = deriveSessionPda(sessionId);

        logger.info("per_initializing_session_on_l1", { sessionPda: sessionPda.toBase58() });
        const initSig = await this.initializeSessionOnL1(ticketId, sessionId, sessionPda);

        // Step 2: Create Permission PDA via program CPI so the session PDA can sign with seeds
        const permissionPda = permissionPdaFromAccount(sessionPda);
        let createPermissionSig: string;
        try {
            createPermissionSig = await this.runL1NegotiationRpc(
                "create_private_permission",
                ticketId,
                async (program) => program.methods
                    .createPrivatePermission(
                        new BN(sessionId.toString()),
                        buyerPubkey,
                        sellerPubkey
                    )
                    .accounts({
                        payer: this.payer.publicKey,
                        permission: permissionPda,
                        permissionProgram: PERMISSION_PROGRAM_ID,
                    })
                    .rpc()
            );
        } catch (error) {
            if (!isAccountAlreadyInUseError(error)) {
                throw error;
            }

            const connection = rpcManager.getConnection("confirmed");
            const existingPermission = await connection.getAccountInfo(permissionPda, "confirmed");
            if (!existingPermission?.owner.equals(PERMISSION_PROGRAM_ID)) {
                throw error;
            }

            createPermissionSig = `already_created:${permissionPda.toBase58()}`;
            logger.warn("per_private_permission_idempotent_recovered", {
                ticketId,
                sessionPda: sessionPda.toBase58(),
                permissionPda: permissionPda.toBase58(),
                owner: existingPermission.owner.toBase58(),
                error: error instanceof Error ? error.message : String(error),
            });
        }

        logger.info("per_permission_created_via_program", {
            ticketId,
            sessionPda: sessionPda.toBase58(),
            permissionPda: permissionPda.toBase58(),
            signature: createPermissionSig,
        });

        // Step 3a: Delegate the session account itself to the TEE validator so it
        // becomes writable inside PER.
        let sessionDelegateSig: string;
        try {
            sessionDelegateSig = await this.runL1NegotiationRpc(
                "delegate_per_session",
                ticketId,
                async (program) => program.methods
                    .delegateSession()
                    .accountsPartial({
                        payer: this.payer.publicKey,
                        validator: teeValidatorIdentity,
                        session: sessionPda,
                    })
                    .rpc()
            );
        } catch (error) {
            if (!isAlreadyDelegatedSessionError(error)) {
                throw error;
            }

            const connection = rpcManager.getConnection("confirmed");
            const delegatedAccount = await connection.getAccountInfo(sessionPda, "confirmed");
            if (!delegatedAccount?.owner.equals(DELEGATION_PROGRAM_ID)) {
                throw error;
            }

            sessionDelegateSig = `already_delegated:${sessionPda.toBase58()}`;
            logger.warn("per_session_delegate_idempotent_recovered", {
                ticketId,
                sessionPda: sessionPda.toBase58(),
                owner: delegatedAccount.owner.toBase58(),
                error: error instanceof Error ? error.message : String(error),
            });
        }

        logger.info("per_session_delegated_to_validator", {
            ticketId,
            sessionPda: sessionPda.toBase58(),
            validatorIdentity: teeValidatorIdentity.toBase58(),
            signature: sessionDelegateSig,
        });

        let delegateSig = sessionDelegateSig;
        let permissionMode: "delegated" | "session_only_fallback" = "delegated";
        try {
            // Step 3b: Activate permission enforcement on the delegated session.
            delegateSig = await privateService.delegateToTee(sessionId, sessionPda);

            const permissionActivation = await waitForPermissionActivationWithFallback({
                rpcUrl: teeRpcUrl,
                sessionPda,
                timeoutMs: PERMISSION_ACTIVATION_TIMEOUT_MS,
                allowL1ConfirmedFallback: true,
            });

            if (!permissionActivation.active) {
                throw new Error(`PER permission activation timed out for session ${sessionPda.toBase58()}`);
            }

            if (permissionActivation.degraded) {
                logger.warn("per_permission_status_unavailable_proceeding_on_l1_confirmation", {
                    ticketId,
                    sessionPda: sessionPda.toBase58(),
                    attempts: permissionActivation.attempts,
                    lastError: permissionActivation.lastError ?? null,
                });
            } else {
                logger.info("per_permission_active_on_tee", {
                    ticketId,
                    sessionPda: sessionPda.toBase58(),
                    attempts: permissionActivation.attempts,
                });
            }
        } catch (error) {
            if (!isPermissionDelegateBorrowConflict(error)) {
                throw error;
            }

            permissionMode = "session_only_fallback";
            delegateSig = sessionDelegateSig;
            logger.warn("per_permission_delegate_borrow_conflict_using_session_only_fallback", {
                ticketId,
                sessionPda: sessionPda.toBase58(),
                validatorIdentity: teeValidatorIdentity.toBase58(),
                error: error instanceof Error ? error.message : String(error),
            });
        }

        // ConnectionMagicRouter setup (server uses buyer's token for monitoring)
        const teeRpcUrlWithToken = `${teeRpcUrl}?token=${buyerAuth.token}`;
        const erConnection = new ConnectionMagicRouter(teeRpcUrlWithToken, {
            commitment: "confirmed",
        });
        const authorityConnection = new ConnectionMagicRouter(
            `${teeRpcUrl}?token=${serverAuth.token}`,
            { commitment: "confirmed" }
        );

        // ── Pattern B Handoff ──
        // The server securely passes the ER RPC URL to both agents over WebSockets.
        // The agents will now negotiate directly with the TEE Enclave.
        sessionManager.sendToAgent(buyerAgent.id, {
            version: "1.0",
            type: "ROLLUP_SESSION_READY",
            ticket_id: ticketId,
            agent_id: buyerAgent.id,
            timestamp: Date.now(),
            payload: {
                rollupMode: "PER",
                rollupRpcUrl: `${teeRpcUrl}?token=${buyerAuth.token}`,
                sessionPda: sessionPda.toBase58(),
                ticketId,
            }
        });

        sessionManager.sendToAgent(sellerAgent.id, {
            version: "1.0",
            type: "ROLLUP_SESSION_READY",
            ticket_id: ticketId,
            agent_id: sellerAgent.id,
            timestamp: Date.now(),
            payload: {
                rollupMode: "PER",
                rollupRpcUrl: `${teeRpcUrl}?token=${sellerAuth.token}`,
                sessionPda: sessionPda.toBase58(),
                ticketId,
            }
        });

        const session: NegotiationSession = {
            ticketId,
            dealPda,
            sessionPda,
            delegatedAt: Date.now(),
            validator: PER_TEE_VALIDATOR_FQDN,
            validatorIdentity: teeValidatorIdentity,
            isPrivate: true,
            buyerAgentId: buyerAgent.id,
            sellerAgentId: sellerAgent.id,
            permissionMode,
            authToken: serverAuth.token,
            authExpiresAt: serverAuth.expiresAt,
            erConnection,
            authorityConnection,
        };
        this.registerSessionTimeout(session);
        this.activeSessions.set(ticketId, session);
        this.persistSessionRecord(session, "active");

        return {
            ticketId,
            dealPda,
            delegationSignature: delegateSig,
            erConnection,
            validator: PER_TEE_VALIDATOR_FQDN,
            isPrivate: true,
            sessionPda,
            sessionRpcUrl: teeRpcUrl,
        };
    }

    /**
     * Closes a PER session after agents reach consensus.
     *
     * PER privacy comes from Intel TDX hardware — the validator CPU enclave
     * protects state during negotiation. Before finalization, the sensitive
     * terms are redacted on the TEE so the permission-program commit only
     * synchronizes a scrubbed coordination record back to Solana L1.
     *
     * @param ticketId — The ticket whose session to close
     */
    async closePERSession(
        ticketId: string
    ): Promise<SessionCloseResult> {
        const session = this.getActiveSessionOrThrow(ticketId);
        this.clearSessionTimeout(session);

        logger.info("per_session_closing", {
            ticketId,
            sessionDurationMs: Date.now() - session.delegatedAt,
            privacyModel: "TEE (Intel TDX)",
        });

        await this.preparePrivateHandoff(session);

        const finalization = await this.finalizePrivateSession(session);
        
        this.activeSessions.delete(ticketId);
        this.clearPersistedSession(ticketId);

        return {
            success: true,
            ticketId,
            commitSignature: finalization.commitSig,
            l1TransactionSignature: finalization.l1TransactionSignature,
            sessionDurationMs: Date.now() - session.delegatedAt,
            validator: session.validator,
            teeSealedState: finalization.teeSealedState,
        };
    }

    private async finalizePrivateSession(session: NegotiationSession): Promise<{
        commitSig: string;
        l1TransactionSignature: string | null;
        teeSealedState: string;
    }> {
        const { PrivateNegotiationService } = await import("./privateNegotiationService");
        const privateService = new PrivateNegotiationService(this.baseConnection, this.payer);

        if (session.permissionMode === "session_only_fallback") {
            const closeResult = await this.commitAndUndelegate(session);
            try {
                await privateService.waitForOwnerReturn(session.sessionPda);
                await privateService.closePermissionOnly(
                    ticketToSessionId(session.ticketId),
                    session.sessionPda
                );
                return {
                    commitSig: closeResult.commitSignature,
                    l1TransactionSignature: closeResult.l1TransactionSignature,
                    teeSealedState: "Committed securely via session-only PER fallback",
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.queuePermissionCloseRetry(session, closeResult.commitSignature, message);
                return {
                    commitSig: closeResult.commitSignature,
                    l1TransactionSignature: closeResult.l1TransactionSignature,
                    teeSealedState:
                        "Committed securely via session-only PER fallback (permission close queued on L1)",
                };
            }
        }

        try {
            const { commitSig } = await privateService.commitAndClose(
                ticketToSessionId(session.ticketId),
                session.sessionPda,
                session.authorityConnection!
            );
            return {
                commitSig,
                l1TransactionSignature: commitSig,
                teeSealedState: "Committed securely via Anchor CPI",
            };
        } catch (error) {
            if (error instanceof PendingL1PermissionCloseError) {
                this.queuePermissionCloseRetry(session, error.commitSig, error.message);
                return {
                    commitSig: error.commitSig,
                    l1TransactionSignature: error.commitSig,
                    teeSealedState: "Committed securely via Anchor CPI (permission close queued on L1)",
                };
            }
            throw error;
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // SESSION MANAGEMENT
    // ════════════════════════════════════════════════════════════════════

    /**
     * Returns the ConnectionMagicRouter for an active session.
     * Agent negotiation loops use this for sub-100ms state updates
     * instead of the base Solana connection.
     */
    getSessionConnection(ticketId: string): ConnectionMagicRouter | null {
        const session = this.activeSessions.get(ticketId);
        return session?.erConnection ?? null;
    }

    /**
     * Returns the active session metadata for a ticket.
     */
    getSession(ticketId: string): NegotiationSession | null {
        return this.activeSessions.get(ticketId) ?? null;
    }

    async resendSessionReadyForAgent(ticketId: string, agentId: string): Promise<boolean> {
        const session = this.activeSessions.get(ticketId);
        if (!session) return false;

        if (!session.isPrivate) {
            return sessionManager.sendToAgent(agentId, {
                version: "1.0",
                type: "ROLLUP_SESSION_READY",
                ticket_id: ticketId,
                agent_id: agentId,
                timestamp: Date.now(),
                payload: {
                    rollupMode: "ER",
                    rollupRpcUrl: `https://${session.validator}`,
                    sessionPda: session.sessionPda.toBase58(),
                    ticketId,
                },
            });
        }

        const agent = await walletRegistry.getAgentById(agentId);
        if (!agent) return false;

        const { PrivateNegotiationService } = await import("./privateNegotiationService");
        const privateService = new PrivateNegotiationService(this.baseConnection, this.payer);
        await withRetry(
            () => privateService.verifyTeeIntegrity({ throwOnError: true }),
            { label: "per_verify_tee_integrity", ticketId, step: "verify_tee_integrity" }
        );

        const auth = await privateService.getAgentAuthTokenPatternB(
            new PublicKey(agent.wallet),
            this.createAgentChallengeSigner(agentId, ticketId)
        );

        return sessionManager.sendToAgent(agentId, {
            version: "1.0",
            type: "ROLLUP_SESSION_READY",
            ticket_id: ticketId,
            agent_id: agentId,
            timestamp: Date.now(),
            payload: {
                rollupMode: "PER",
                rollupRpcUrl: `${PER_TEE_RPC_URL}?token=${auth.token}`,
                sessionPda: session.sessionPda.toBase58(),
                ticketId,
            },
        });
    }

    async reconcilePersistedSessions(): Promise<void> {
        const records = rollupSessionJournal
            .list()
            .filter((record) => record.isPrivate === (this.rollupMode === "PER"));
        if (records.length === 0) return;

        logger.info("rollup_session_reconcile_start", { count: records.length });

        for (const record of records) {
            try {
                await this.rehydratePersistedRecord(record);
            } catch (error) {
                logger.error(
                    "rollup_session_reconcile_failed",
                    { ticketId: record.ticketId, phase: record.phase },
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        }
    }

    completeSession(ticketId: string): void {
        const session = this.activeSessions.get(ticketId);
        if (!session) return;
        this.clearSessionTimeout(session);
        this.activeSessions.delete(ticketId);
        this.clearPersistedSession(ticketId);
    }

    /**
     * Checks if a PER session's TEE auth token is still valid.
     */
    isSessionAuthValid(ticketId: string): boolean {
        const session = this.activeSessions.get(ticketId);
        if (!session?.authExpiresAt) return false;
        return Date.now() < session.authExpiresAt;
    }

    /**
     * Stores the agreed negotiation terms in the session.
     * Called by the agent negotiation loop when both agents confirm terms.
     * These terms are serialized as TEE-sealed state when closePERSession() is called.
     */
    setSessionTerms(ticketId: string, terms: NegotiatedTerms): void {
        const session = this.getActiveSessionOrThrow(ticketId);
        if (session.isPrivate && isStrictOpaquePerModeEnabled()) {
            throw new Error(
                `per_strict_opaque_mode_violation:set_session_terms_disabled:${ticketId}`
            );
        }
        session.negotiatedTerms = terms;
        logger.info("session_terms_stored", {
            ticketId,
            priceLamports: session.isPrivate ? "redacted" : terms.priceLamports.toString(),
            quantity: session.isPrivate ? "redacted" : terms.quantity.toString(),
            assetMint: session.isPrivate ? "redacted" : terms.assetMint.toBase58(),
        });
    }

    async fetchLiveTerms(ticketId: string): Promise<{
        sessionPda: PublicKey;
        agreedPriceLamports: bigint;
        agreedAsset: string;
        buyerCollateralLamports: bigint;
        sellerCollateralLamports: bigint;
        status: string;
    }> {
        const session = this.getActiveSessionOrThrow(ticketId);
        if (session.isPrivate && isStrictOpaquePerModeEnabled()) {
            throw new Error(
                `per_strict_opaque_mode_violation:fetch_live_terms_disabled:${ticketId}`
            );
        }
        const account = await this.fetchSessionAccount(session.sessionPda, session.erConnection);
        return {
            sessionPda: account.sessionPda,
            agreedPriceLamports: account.agreedPriceLamports,
            agreedAsset: account.agreedAsset,
            buyerCollateralLamports: account.buyerCollateralLamports,
            sellerCollateralLamports: account.sellerCollateralLamports,
            status: account.status,
        };
    }

    async fetchCommittedTerms(ticketId: string): Promise<{
        sessionPda: PublicKey;
        agreedPriceLamports: bigint;
        agreedAsset: string;
        buyerCollateralLamports: bigint;
        sellerCollateralLamports: bigint;
        status: string;
    }> {
        const activeSession = this.activeSessions.get(ticketId);
        if (activeSession?.isPrivate && isStrictOpaquePerModeEnabled()) {
            throw new Error(
                `per_strict_opaque_mode_violation:fetch_committed_terms_disabled:${ticketId}`
            );
        }
        const sessionPda = this.activeSessions.get(ticketId)?.sessionPda ?? deriveSessionPda(ticketToSessionId(ticketId));
        const account = await this.fetchSessionAccount(sessionPda);
        return {
            sessionPda: account.sessionPda,
            agreedPriceLamports: account.agreedPriceLamports,
            agreedAsset: account.agreedAsset,
            buyerCollateralLamports: account.buyerCollateralLamports,
            sellerCollateralLamports: account.sellerCollateralLamports,
            status: account.status,
        };
    }

    async fetchLivePrivateHandoffProof(ticketId: string): Promise<PrivateHandoffProofState> {
        const session = this.getActiveSessionOrThrow(ticketId);
        return this.fetchPrivateHandoffProofFromProgram(session.sessionPda, session.erConnection);
    }

    async fetchCommittedPrivateHandoffProof(ticketId: string): Promise<PrivateHandoffProofState> {
        const sessionPda = this.activeSessions.get(ticketId)?.sessionPda ?? deriveSessionPda(ticketToSessionId(ticketId));
        return this.fetchPrivateHandoffProofFromProgram(sessionPda);
    }

    async recordPrivateHandoffProof(ticketId: string, intent: AttestedEscrowIntent): Promise<string> {
        const session = this.getActiveSessionOrThrow(ticketId);
        const sessionId = ticketToSessionId(ticketId);
        const handoffConnection = session.authorityConnection ?? session.erConnection;
        const ix = await this.buildRecordPrivateHandoffProofInstruction(
            sessionId,
            intent,
            handoffConnection
        );

        const tx = new Transaction()
            .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }))
            .add(ix);

        const { blockhash, lastValidBlockHeight } = await handoffConnection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = this.payer.publicKey;
        tx.sign(this.payer);

        const signature = await handoffConnection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
        });
        await this.confirmErTransaction(handoffConnection, signature, blockhash, lastValidBlockHeight);

        logger.info("per_private_handoff_proof_recorded", {
            ticketId,
            sessionPda: session.sessionPda.toBase58(),
            intentId: intent.intentId,
            signature,
        });

        return signature;
    }

    async finalizePERSession(ticketId: string): Promise<string> {
        const session = this.getActiveSessionOrThrow(ticketId);
        this.clearSessionTimeout(session);
        await this.preparePrivateHandoff(session);
        const finalization = await this.finalizePrivateSession(session);
        this.activeSessions.delete(ticketId);
        this.clearPersistedSession(ticketId);
        return finalization.commitSig;
    }

    /**
     * Force-closes a timed-out session.
     * Commits any pending state and undelegates the Session PDA back to L1.
     * No TEE state capture — the negotiation timed out.
     */
    async forceCloseSession(ticketId: string): Promise<void> {
        const session = this.activeSessions.get(ticketId);
        if (!session) {
            logger.warn("force_close_session_not_found", { ticketId });
            return;
        }

        this.clearSessionTimeout(session);

        logger.warn("force_closing_expired_session", {
            ticketId,
            sessionDurationMs: Date.now() - session.delegatedAt,
            validator: session.validator,
        });

        try {
            if (session.isPrivate) {
                await this.preparePrivateHandoff(session);
                await this.finalizePrivateSession(session);
                logger.info("private_session_force_closed", { ticketId });
                this.activeSessions.delete(ticketId);
                this.clearPersistedSession(ticketId);
                return;
            }

            const sessionId = ticketToSessionId(session.ticketId);
            const commitUndelegateIx = await this.buildReachConsensusInstruction(sessionId);

            const tx = new Transaction().add(commitUndelegateIx);

            // The close instruction must be sent through the validator that
            // currently owns the delegated session.
            const { blockhash, lastValidBlockHeight } = await session.erConnection.getLatestBlockhash("confirmed");
            tx.recentBlockhash = blockhash;
            tx.lastValidBlockHeight = lastValidBlockHeight;
            tx.feePayer = this.payer.publicKey;
            tx.sign(this.payer);

            const rawTx = tx.serialize();
            const commitSig = await session.erConnection.sendRawTransaction(rawTx, { skipPreflight: true });
            await this.confirmErTransaction(session.erConnection, commitSig, blockhash, lastValidBlockHeight);

            logger.info("session_force_closed", { ticketId });
            this.activeSessions.delete(ticketId);
            this.clearPersistedSession(ticketId);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);

            logger.error(
                "session_force_close_failed_queuing_retry",
                { ticketId, error: errorMsg },
                error instanceof Error ? error : new Error(errorMsg)
            );

            // Move to retry queue instead of silently dropping
            this.pendingUndelegations.push({
                ticketId: session.ticketId,
                dealPda: session.dealPda,
                sessionPda: session.sessionPda,
                erConnection: session.erConnection,
                validator: session.validator,
                validatorIdentity: session.validatorIdentity,
                failedAt: Date.now(),
                attempts: 1,
                lastError: errorMsg,
            });

            // Remove from active sessions — it's now tracked in the retry queue
            this.activeSessions.delete(ticketId);
            this.persistRetryRecord({
                ticketId: session.ticketId,
                dealPda: session.dealPda,
                sessionPda: session.sessionPda,
                validator: session.validator,
                validatorIdentity: session.validatorIdentity,
                isPrivate: false,
                delegatedAt: session.delegatedAt,
                phase: "pending_er_undelegation",
                attempts: 1,
                lastError: errorMsg,
            });

            logger.info("undelegation_queued_for_retry", {
                ticketId,
                queueLength: this.pendingUndelegations.length,
            });
        }
    }

    private queuePermissionCloseRetry(
        session: NegotiationSession,
        commitSig: string,
        lastError: string
    ): void {
        const existing = this.pendingPermissionCloses.find((entry) => entry.ticketId === session.ticketId);
        if (existing) {
            existing.commitSig = commitSig;
            existing.lastError = lastError;
            existing.failedAt = Date.now();
            existing.attempts += 1;
        } else {
            this.pendingPermissionCloses.push({
                ticketId: session.ticketId,
                sessionPda: session.sessionPda,
                sessionId: ticketToSessionId(session.ticketId),
                commitSig,
                attempts: 1,
                failedAt: Date.now(),
                lastError,
            });
        }

        this.persistRetryRecord({
            ticketId: session.ticketId,
            dealPda: session.dealPda,
            sessionPda: session.sessionPda,
            validator: session.validator,
            validatorIdentity: session.validatorIdentity,
            isPrivate: true,
            delegatedAt: session.delegatedAt,
            buyerAgentId: session.buyerAgentId,
            sellerAgentId: session.sellerAgentId,
            phase: "pending_per_close",
            attempts: this.pendingPermissionCloses.find((entry) => entry.ticketId === session.ticketId)?.attempts || 1,
            lastError,
            commitSignature: commitSig,
        });

        logger.warn("per_permission_close_queued_for_retry", {
            ticketId: session.ticketId,
            sessionPda: session.sessionPda.toBase58(),
            commitSig,
            lastError,
        });
    }

    /**
     * Returns metadata for all currently active sessions.
     */
    getActiveSessions(): Array<{
        ticketId: string;
        dealPda: string;
        validator: string;
        isPrivate: boolean;
        durationMs: number;
    }> {
        const now = Date.now();
        return Array.from(this.activeSessions.values()).map((s) => ({
            ticketId: s.ticketId,
            dealPda: s.dealPda?.toBase58() || "not_created_yet",
            validator: s.validator,
            isPrivate: s.isPrivate,
            durationMs: now - s.delegatedAt,
        }));
    }

    private createAgentChallengeSigner(
        agentId: string,
        ticketId: string
    ): (challengeBase64: string) => Promise<string> {
        return (challengeBase64: string) =>
            new Promise<string>((resolve, reject) => {
                const agentWs = sessionManager.getSessionByAgent(agentId);
                if (!agentWs) {
                    reject(new Error(`Agent ${agentId} is not connected to WebSocket.`));
                    return;
                }

                const timeout = setTimeout(() => {
                    eventBus.unsubscribe("agent_message_received", handler);
                    reject(new Error(`WebSocket timeout waiting for PER_AUTH_RESPONSE from ${agentId}`));
                }, 10000);

                const handler = (msg: any) => {
                    if (
                        msg.type === "PER_AUTH_RESPONSE" &&
                        msg.agent_id === agentId &&
                        msg.ticket_id === ticketId
                    ) {
                        clearTimeout(timeout);
                        eventBus.unsubscribe("agent_message_received", handler);
                        resolve(msg.signatureBytes);
                    }
                };

                eventBus.subscribe("agent_message_received", handler);
                sessionManager.sendToAgent(agentId, {
                    version: "1.0",
                    type: "PER_AUTH_CHALLENGE",
                    ticket_id: ticketId,
                    agent_id: agentId,
                    timestamp: Date.now(),
                    payload: { challengeBytes: challengeBase64, ticketId }
                });
            });
    }

    // ════════════════════════════════════════════════════════════════════
    // INTERNAL METHODS
    // ════════════════════════════════════════════════════════════════════

    /**
     * The MagicBlock commit+undelegate must be invoked as a CPI from the
     * negotiation program. Sending the magic instruction directly from the
     * client fails on ER with "failed to find parent program id".
     */
    private getProgramForConnection(connection?: Connection): Program<MagicblockNegotiation> {
        if (!connection) {
            return this.negotiationProgram;
        }

        const wallet = new Wallet(this.payer);
        const provider = new AnchorProvider(connection, wallet, {
            commitment: "confirmed",
        });

        return new Program(
            negotiationIdl as any,
            provider
        ) as unknown as Program<MagicblockNegotiation>;
    }

    private persistSessionRecord(
        session: NegotiationSession,
        phase: PersistedRollupPhase,
        extra?: Partial<PersistedRollupSessionRecord>
    ): void {
        rollupSessionJournal.upsert({
            ticketId: session.ticketId,
            dealPda: session.dealPda?.toBase58(),
            sessionPda: session.sessionPda.toBase58(),
            validator: session.validator,
            validatorIdentity: session.validatorIdentity.toBase58(),
            isPrivate: session.isPrivate,
            permissionMode: session.permissionMode,
            delegatedAt: session.delegatedAt,
            buyerAgentId: session.buyerAgentId,
            sellerAgentId: session.sellerAgentId,
            phase,
            updatedAt: Date.now(),
            ...extra,
        });
    }

    private persistRetryRecord(record: {
        ticketId: string;
        dealPda?: PublicKey;
        sessionPda: PublicKey;
        validator: string;
        validatorIdentity: PublicKey;
        isPrivate: boolean;
        permissionMode?: "delegated" | "session_only_fallback";
        delegatedAt: number;
        phase: PersistedRollupPhase;
        attempts: number;
        lastError: string;
        commitSignature?: string;
        buyerAgentId?: string;
        sellerAgentId?: string;
    }): void {
        rollupSessionJournal.upsert({
            ticketId: record.ticketId,
            dealPda: record.dealPda?.toBase58(),
            sessionPda: record.sessionPda.toBase58(),
            validator: record.validator,
            validatorIdentity: record.validatorIdentity.toBase58(),
            isPrivate: record.isPrivate,
            permissionMode: record.permissionMode,
            delegatedAt: record.delegatedAt,
            phase: record.phase,
            attempts: record.attempts,
            lastError: record.lastError,
            commitSignature: record.commitSignature,
            buyerAgentId: record.buyerAgentId,
            sellerAgentId: record.sellerAgentId,
            updatedAt: Date.now(),
        });
    }

    private clearPersistedSession(ticketId: string): void {
        rollupSessionJournal.remove(ticketId);
    }

    private async buildPerAuthorityConnection(): Promise<ConnectionMagicRouter> {
        const serverAuth = await getPerAuthorityAuthToken(this.payer, {
            step: "build_per_authority_connection",
        });

        return new ConnectionMagicRouter(`${PER_TEE_RPC_URL}?token=${serverAuth.token}`, {
            commitment: "confirmed",
        });
    }

    private async rehydratePersistedRecord(record: PersistedRollupSessionRecord): Promise<void> {
        if (record.phase === "pending_er_undelegation") {
            this.pendingUndelegations.push({
                ticketId: record.ticketId,
                dealPda: record.dealPda ? new PublicKey(record.dealPda) : undefined,
                sessionPda: new PublicKey(record.sessionPda),
                erConnection: new ConnectionMagicRouter(`https://${record.validator}`, {
                    commitment: "confirmed",
                }),
                validator: record.validator,
                validatorIdentity: new PublicKey(record.validatorIdentity),
                failedAt: record.updatedAt,
                attempts: record.attempts || 1,
                lastError: record.lastError || "Recovered from journal",
            });
            return;
        }

        if (record.phase === "pending_per_close") {
            this.pendingPermissionCloses.push({
                ticketId: record.ticketId,
                sessionPda: new PublicKey(record.sessionPda),
                sessionId: ticketToSessionId(record.ticketId),
                commitSig: record.commitSignature || "unknown",
                attempts: record.attempts || 1,
                failedAt: record.updatedAt,
                lastError: record.lastError || "Recovered from journal",
            });
            return;
        }

        if (this.activeSessions.has(record.ticketId)) {
            return;
        }

        const connection = record.isPrivate
            ? await this.buildPerAuthorityConnection()
            : new ConnectionMagicRouter(`https://${record.validator}`, {
                commitment: "confirmed",
            });

        const session: NegotiationSession = {
            ticketId: record.ticketId,
            dealPda: record.dealPda ? new PublicKey(record.dealPda) : undefined,
            sessionPda: new PublicKey(record.sessionPda),
            delegatedAt: record.delegatedAt,
            validator: record.validator,
            validatorIdentity: new PublicKey(record.validatorIdentity),
            isPrivate: record.isPrivate,
            permissionMode: record.permissionMode,
            buyerAgentId: record.buyerAgentId,
            sellerAgentId: record.sellerAgentId,
            erConnection: connection,
            authorityConnection: record.isPrivate ? connection : undefined,
        };

        this.registerSessionTimeout(session);
        this.activeSessions.set(record.ticketId, session);

        logger.info("rollup_session_rehydrated", {
            ticketId: record.ticketId,
            rollupMode: record.isPrivate ? "PER" : "ER",
            validator: record.validator,
        });
    }

    private async runL1NegotiationRpc<T>(
        label: string,
        ticketId: string,
        fn: (program: Program<MagicblockNegotiation>) => Promise<T>
    ): Promise<T> {
        return withRetry(
            async () => {
                const connection = rpcManager.getConnection("confirmed");
                const program = this.getProgramForConnection(connection);
                return fn(program);
            },
            {
                label: `negotiation_rollup_${label}`,
                ticketId,
                step: label,
            }
        );
    }

    private async initializeSessionOnL1(
        ticketId: string,
        sessionId: bigint,
        sessionPda: PublicKey
    ): Promise<string> {
        return withRetry(
            async () => {
                const connection = rpcManager.getConnection("confirmed");
                const existing = await connection.getAccountInfo(sessionPda, "confirmed");
                if (existing) {
                    if (!existing.owner.equals(NEGOTIATION_PROGRAM_ID)) {
                        throw new Error(
                            `Session PDA ${sessionPda.toBase58()} already exists with unexpected owner ${existing.owner.toBase58()}`
                        );
                    }

                    logger.info("rollup_session_initialize_idempotent_skip", {
                        ticketId,
                        sessionPda: sessionPda.toBase58(),
                        owner: existing.owner.toBase58(),
                    });
                    return `already_initialized:${sessionPda.toBase58()}`;
                }

                const program = this.getProgramForConnection(connection);
                try {
                    return await program.methods
                        .initializeSession(new BN(sessionId.toString()))
                        .accountsPartial({
                            session: sessionPda,
                            buyer: this.payer.publicKey,
                        })
                        .rpc();
                } catch (error) {
                    if (!isAccountAlreadyInUseError(error)) {
                        throw error;
                    }

                    const recovered = await connection.getAccountInfo(sessionPda, "confirmed");
                    if (!recovered || !recovered.owner.equals(NEGOTIATION_PROGRAM_ID)) {
                        throw error;
                    }

                    logger.warn("rollup_session_initialize_idempotent_recovered", {
                        ticketId,
                        sessionPda: sessionPda.toBase58(),
                        owner: recovered.owner.toBase58(),
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return `already_initialized:${sessionPda.toBase58()}`;
                }
            },
            {
                label: "negotiation_rollup_initialize_per_session",
                ticketId,
                step: "initialize_per_session",
            }
        );
    }

    private async buildReachConsensusInstruction(
        sessionId: bigint,
        connection?: Connection
    ) {
        const program = this.getProgramForConnection(connection);
        return program.methods
            .reachConsensus(new BN(sessionId.toString()))
            .accounts({
                payer: this.payer.publicKey,
            })
            .instruction();
    }

    private async buildPreparePrivateHandoffInstruction(
        sessionId: bigint,
        connection: Connection
    ) {
        const program = this.getProgramForConnection(connection);

        return program.methods
            .preparePrivateHandoff(new BN(sessionId.toString()))
            .accounts({
                payer: this.payer.publicKey,
            })
            .instruction();
    }

    private async buildRecordPrivateHandoffProofInstruction(
        sessionId: bigint,
        intent: AttestedEscrowIntent,
        connection: Connection
    ) {
        const program = this.getProgramForConnection(connection);
        return (program.methods as any)
            .recordPrivateHandoffProof(
                new BN(sessionId.toString()),
                new PublicKey(intent.buyer),
                new PublicKey(intent.seller),
                Array.from(Buffer.from(intent.termsHash, "hex")),
                Array.from(Buffer.from(intent.fundingCommitments.buyerPaymentHash, "hex")),
                Array.from(Buffer.from(intent.fundingCommitments.buyerCollateralHash, "hex")),
                Array.from(Buffer.from(intent.fundingCommitments.sellerCollateralHash, "hex")),
                new PublicKey(intent.encryptedTerms.buyerCollateral.account),
                new PublicKey(intent.encryptedTerms.sellerCollateral.account),
                new PublicKey(intent.encryptedTerms.paymentAmount.account),
                new PublicKey(intent.encryptedTerms.settlementResult.account),
                new PublicKey(intent.encryptedTerms.networkEncryptionKeyPda),
            )
            .accounts({
                payer: this.payer.publicKey,
            })
            .instruction();
    }

    private async confirmErTransaction(
        connection: ConnectionMagicRouter,
        signature: string,
        blockhash: string,
        lastValidBlockHeight: number
    ): Promise<void> {
        const confirmation = await connection.confirmTransaction(
            { signature, blockhash, lastValidBlockHeight },
            "confirmed"
        );

        if (confirmation.value.err) {
            throw new Error(
                `ER transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`
            );
        }
    }

    /**
     * Commits finalized negotiation state and undelegates the Deal PDA
     * back to Solana L1 in a single atomic transaction.
     *
     * Uses the negotiation program's `reachConsensus` instruction, which does
     * the MagicBlock commit+undelegate as a CPI on the validator.
     */
    private async commitAndUndelegate(
        session: NegotiationSession
    ): Promise<Omit<SessionCloseResult, "teeSealedState">> {
        const { ticketId, dealPda, sessionPda, erConnection, validator, delegatedAt } = session;

        logger.info("committing_and_undelegating", {
            ticketId,
            dealPda: dealPda?.toBase58() || "not_created_yet",
            sessionPda: sessionPda.toBase58(),
        });

        // commit+undelegate the SESSION PDA (the delegated account),
        // NOT the dealPda which lives on L1 untouched.
        const sessionId = ticketToSessionId(ticketId);
        const commitUndelegateIx = await this.buildReachConsensusInstruction(sessionId);

        const tx = new Transaction()
            .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }))
            .add(commitUndelegateIx);

        // This transaction is constructed locally but must be submitted through
        // the ER connection because the delegated Session PDA lives there.
        const { blockhash, lastValidBlockHeight } = await erConnection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = this.payer.publicKey;
        tx.sign(this.payer);

        const rawTx = tx.serialize();
        const commitSig = await erConnection.sendRawTransaction(rawTx, {
            skipPreflight: true,
        });
        await this.confirmErTransaction(erConnection, commitSig, blockhash, lastValidBlockHeight);

        logger.info("ephemeral_commit_confirmed", {
            ticketId,
            commitSignature: commitSig,
        });

        // Track the resulting L1 commitment.
        // The ER schedules the L1 commit asynchronously — the "ScheduledCommitSent"
        // log entry may not appear immediately. Retry with delay.
        let l1Signature: string | null = null;
        const L1_TRACK_RETRIES = 15;
        const L1_TRACK_DELAY_MS = 4_000;
        for (let attempt = 0; attempt < L1_TRACK_RETRIES; attempt++) {
            try {
                // Wait for ER to process the scheduled commit
                await new Promise((r) => setTimeout(r, L1_TRACK_DELAY_MS));
                l1Signature = await GetCommitmentSignature(commitSig, erConnection);
                logger.info("l1_commitment_received", { ticketId, l1Signature, attempt: attempt + 1 });
                break;
            } catch (error) {
                if (attempt === L1_TRACK_RETRIES - 1) {
                    // Non-fatal: the commit still happened, we just can't track the L1 sig
                    logger.warn("l1_commitment_tracking_failed", {
                        ticketId,
                        error: error instanceof Error ? error.message : String(error),
                        attempts: L1_TRACK_RETRIES,
                    });
                }
            }
        }

        return {
            success: true,
            ticketId,
            commitSignature: commitSig,
            l1TransactionSignature: l1Signature,
            sessionDurationMs: Date.now() - delegatedAt,
            validator,
        };
    }

    private decodeSessionAccount(
        sessionPda: PublicKey,
        account: any
    ): SessionAccountSnapshot {
        const statusKey = Object.keys(account.status || {})[0] || "unknown";
        const toPubkey = (value: any): PublicKey =>
            value instanceof PublicKey ? value : new PublicKey(value);
        const termsHashBytes = Buffer.from(account.termsHash ?? []);
        const buyerPaymentFundingHashBytes = Buffer.from(account.buyerPaymentFundingHash ?? []);
        const buyerCollateralFundingHashBytes = Buffer.from(
            account.buyerCollateralFundingHash ?? []
        );
        const sellerCollateralFundingHashBytes = Buffer.from(
            account.sellerCollateralFundingHash ?? []
        );

        return {
            sessionPda,
            agreedPriceLamports: BigInt(account.agreedPrice.toString()),
            agreedAsset: account.agreedAsset,
            buyerCollateralLamports: BigInt(account.buyerCollateral.toString()),
            sellerCollateralLamports: BigInt(account.sellerCollateral.toString()),
            status: statusKey,
            buyerParticipant: toPubkey(account.buyerParticipant),
            sellerParticipant: toPubkey(account.sellerParticipant),
            termsHashHex: termsHashBytes.toString("hex"),
            buyerPaymentFundingHashHex: buyerPaymentFundingHashBytes.toString("hex"),
            buyerCollateralFundingHashHex: buyerCollateralFundingHashBytes.toString("hex"),
            sellerCollateralFundingHashHex: sellerCollateralFundingHashBytes.toString("hex"),
            buyerCollateralCiphertext: toPubkey(account.buyerCollateralCiphertext),
            sellerCollateralCiphertext: toPubkey(account.sellerCollateralCiphertext),
            paymentAmountCiphertext: toPubkey(account.paymentAmountCiphertext),
            settlementResultCiphertext: toPubkey(account.settlementResultCiphertext),
            networkEncryptionKey: toPubkey(account.networkEncryptionKey),
            proofRecordedAt: BigInt(account.proofRecordedAt?.toString?.() ?? account.proofRecordedAt ?? 0),
        };
    }

    private async fetchSessionAccount(
        sessionPda: PublicKey,
        connection?: Connection
    ): Promise<SessionAccountSnapshot> {
        const program = this.getProgramForConnection(connection);
        const account = await (program.account as any).session.fetch(sessionPda);
        return this.decodeSessionAccount(sessionPda, account);
    }

    private async fetchPrivateHandoffProofFromProgram(
        sessionPda: PublicKey,
        connection?: Connection
    ): Promise<PrivateHandoffProofState> {
        const account = await this.fetchSessionAccount(sessionPda, connection);

        if (
            account.status !== "confidentialHandoff" ||
            account.buyerParticipant.equals(EMPTY_PUBLIC_KEY) ||
            account.sellerParticipant.equals(EMPTY_PUBLIC_KEY) ||
            account.termsHashHex === "0".repeat(64) ||
            account.buyerPaymentFundingHashHex === "0".repeat(64) ||
            account.buyerCollateralFundingHashHex === "0".repeat(64) ||
            account.sellerCollateralFundingHashHex === "0".repeat(64) ||
            account.buyerCollateralCiphertext.equals(EMPTY_PUBLIC_KEY) ||
            account.sellerCollateralCiphertext.equals(EMPTY_PUBLIC_KEY) ||
            account.paymentAmountCiphertext.equals(EMPTY_PUBLIC_KEY) ||
            account.settlementResultCiphertext.equals(EMPTY_PUBLIC_KEY) ||
            account.networkEncryptionKey.equals(EMPTY_PUBLIC_KEY) ||
            account.proofRecordedAt === 0n
        ) {
            throw new Error(
                `private_handoff_proof_missing_or_incomplete:${sessionPda.toBase58()}`
            );
        }

        return {
            sessionPda: account.sessionPda.toBase58(),
            buyer: account.buyerParticipant.toBase58(),
            seller: account.sellerParticipant.toBase58(),
            status: account.status,
            termsHash: account.termsHashHex,
            buyerPaymentFundingHash: account.buyerPaymentFundingHashHex,
            buyerCollateralFundingHash: account.buyerCollateralFundingHashHex,
            sellerCollateralFundingHash: account.sellerCollateralFundingHashHex,
            buyerCollateralCiphertext: account.buyerCollateralCiphertext.toBase58(),
            sellerCollateralCiphertext: account.sellerCollateralCiphertext.toBase58(),
            paymentAmountCiphertext: account.paymentAmountCiphertext.toBase58(),
            settlementResultCiphertext: account.settlementResultCiphertext.toBase58(),
            networkEncryptionKeyPda: account.networkEncryptionKey.toBase58(),
            proofRecordedAt: new Date(Number(account.proofRecordedAt) * 1000).toISOString(),
        };
    }

    private async preparePrivateHandoff(session: NegotiationSession): Promise<string> {
        const sessionId = ticketToSessionId(session.ticketId);
        const handoffConnection = session.authorityConnection ?? session.erConnection;
        const ix = await this.buildPreparePrivateHandoffInstruction(
            sessionId,
            handoffConnection
        );

        const tx = new Transaction()
            .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }))
            .add(ix);

        const { blockhash, lastValidBlockHeight } = await handoffConnection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.feePayer = this.payer.publicKey;
        tx.sign(this.payer);

        const signature = await handoffConnection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
        });
        await this.confirmErTransaction(handoffConnection, signature, blockhash, lastValidBlockHeight);

        logger.info("per_private_handoff_prepared", {
            ticketId: session.ticketId,
            sessionPda: session.sessionPda.toBase58(),
            signature,
        });

        return signature;
    }

    /**
     * Resolves a validator's identity public key at runtime.
     *
     * SDK: ConnectionMagicRouter.getClosestValidator()
     *   Returns { identity: string, fqdn?: string }
     *
     * This avoids hardcoding validator public keys, which can rotate.
     * If the validator is unreachable, falls back to the known identity
     * from the ER_IDENTITY_FALLBACKS map.
     */
    private async resolveValidatorIdentity(fqdn: string): Promise<PublicKey> {
        try {
            const tempConnection = new ConnectionMagicRouter(
                `https://${fqdn}`,
                { commitment: "confirmed" }
            );

            const { identity } = await tempConnection.getClosestValidator();

            logger.info("validator_identity_resolved", {
                fqdn,
                identity,
                source: "live_rpc",
            });

            return new PublicKey(identity);
        } catch (error) {
            // Fallback to known identity
            const fallback = ER_IDENTITY_FALLBACKS[fqdn];
            if (!fallback) {
                throw new Error(
                    `Failed to resolve validator identity for ${fqdn} ` +
                    `and no fallback key is configured. ` +
                    `Error: ${error instanceof Error ? error.message : String(error)}`
                );
            }

            logger.warn("validator_identity_fallback_used", {
                fqdn,
                fallbackIdentity: fallback.toBase58(),
                error: error instanceof Error ? error.message : String(error),
            });

            return fallback;
        }
    }

    /**
     * Verifies TEE RPC integrity with exponential backoff retry.
     * Uses @phala/dcap-qvl for Intel TDX DCAP attestation verification.
     *
     * SDK: verifyTeeRpcIntegrity(rpcUrl) → Promise<void>
     */
    private async verifyTeeWithRetry(
        teeRpcUrl: string,
        ticketId: string
    ): Promise<void> {
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= TEE_VERIFY_MAX_RETRIES; attempt++) {
            try {
                logger.info("per_verifying_tee_integrity", {
                    ticketId,
                    attempt,
                    maxRetries: TEE_VERIFY_MAX_RETRIES,
                    rpcUrl: teeRpcUrl,
                });

                await verifyTeeRpcIntegrity(teeRpcUrl);

                logger.info("per_tee_integrity_verified", { ticketId, attempt });
                return;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                logger.warn("per_tee_verify_attempt_failed", {
                    ticketId,
                    attempt,
                    error: lastError.message,
                });

                if (attempt < TEE_VERIFY_MAX_RETRIES) {
                    const delay = TEE_VERIFY_RETRY_DELAY_MS * attempt; // Linear backoff
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }

        throw new Error(
            `TEE integrity verification failed after ${TEE_VERIFY_MAX_RETRIES} attempts ` +
            `for ticket ${ticketId}: ${lastError?.message}`
        );
    }

    /**
     * Gets an active session or throws a descriptive error.
     */
    private getActiveSessionOrThrow(ticketId: string): NegotiationSession {
        const session = this.activeSessions.get(ticketId);
        if (!session) {
            throw new Error(
                `No active negotiation session found for ticket ${ticketId}. ` +
                `Ensure openERSession() or openPERSession() was called first.`
            );
        }
        return session;
    }

    /**
     * Registers an automatic timeout for a session.
     * When the timeout fires, the session is force-closed.
     * This prevents stale delegations from locking Deal PDAs indefinitely.
     */
    private registerSessionTimeout(session: NegotiationSession): void {
        const elapsedMs = Date.now() - session.delegatedAt;
        const timeoutMs = Math.max(1_000, SESSION_TIMEOUT_MS - elapsedMs);
        session.timeoutHandle = setTimeout(async () => {
            logger.warn("session_auto_timeout_triggered", {
                ticketId: session.ticketId,
                sessionDurationMs: Date.now() - session.delegatedAt,
                validator: session.validator,
                isPrivate: session.isPrivate,
            });
            await this.forceCloseSession(session.ticketId);
        }, timeoutMs);

        // Prevent the timer from keeping the Node.js process alive
        if (session.timeoutHandle && typeof session.timeoutHandle === "object" && "unref" in session.timeoutHandle) {
            session.timeoutHandle.unref();
        }

        logger.info("session_timeout_registered", {
            ticketId: session.ticketId,
            timeoutMs,
        });
    }

    /**
     * Clears the timeout timer for a session.
     * Called when the session is closed normally (before timeout fires).
     */
    private clearSessionTimeout(session: NegotiationSession): void {
        if (session.timeoutHandle) {
            clearTimeout(session.timeoutHandle);
            session.timeoutHandle = undefined;
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // UNDELEGATION RETRY QUEUE
    // ════════════════════════════════════════════════════════════════════

    /**
     * Starts the background retry loop for failed undelegations.
     * Runs every UNDELEGATE_RETRY_INTERVAL_MS (30s).
     * The interval is unref'd so it doesn't keep Node.js alive.
     */
    private startRetryLoop(): void {
        this.retryLoopHandle = setInterval(() => {
            this.retryFailedUndelegations().catch((err) => {
                logger.error(
                    "undelegation_retry_loop_error",
                    {},
                    err instanceof Error ? err : new Error(String(err))
                );
            });
            this.retryFailedPermissionCloses().catch((err) => {
                logger.error(
                    "permission_close_retry_loop_error",
                    {},
                    err instanceof Error ? err : new Error(String(err))
                );
            });
        }, UNDELEGATE_RETRY_INTERVAL_MS);

        // Don't keep Node.js alive just for retries
        if (this.retryLoopHandle && typeof this.retryLoopHandle === "object" && "unref" in this.retryLoopHandle) {
            this.retryLoopHandle.unref();
        }
    }

    /**
     * Stops the background retry loop.
     */
    private stopRetryLoop(): void {
        if (this.retryLoopHandle) {
            clearInterval(this.retryLoopHandle);
            this.retryLoopHandle = null;
        }
    }

    /**
     * Processes the pending undelegation queue.
     * Each entry gets exponential backoff: attempt N waits N * BACKOFF_FACTOR * BASE.
     * After UNDELEGATE_RETRY_MAX attempts, the entry is dropped with an error log
     * so the operator can manually recover the PDA.
     */
    private async retryFailedUndelegations(): Promise<void> {
        if (this.pendingUndelegations.length === 0) return;

        logger.info("undelegation_retry_cycle_starting", {
            queueLength: this.pendingUndelegations.length,
        });

        // Process in reverse so we can splice without index shifting
        for (let i = this.pendingUndelegations.length - 1; i >= 0; i--) {
            const entry = this.pendingUndelegations[i];

            // Check if enough time has passed for this attempt (exponential backoff)
            const backoffMs =
                UNDELEGATE_RETRY_INTERVAL_MS *
                Math.pow(UNDELEGATE_RETRY_BACKOFF_FACTOR, entry.attempts - 1);
            const nextRetryAt = entry.failedAt + backoffMs;

            if (Date.now() < nextRetryAt) {
                continue; // Not yet time to retry
            }

            try {
                const sessionId = ticketToSessionId(entry.ticketId);
                const commitUndelegateIx = await this.buildReachConsensusInstruction(sessionId);

                const tx = new Transaction().add(commitUndelegateIx);

                const { blockhash, lastValidBlockHeight } = await entry.erConnection.getLatestBlockhash("confirmed");
                tx.recentBlockhash = blockhash;
                tx.lastValidBlockHeight = lastValidBlockHeight;
                tx.feePayer = this.payer.publicKey;
                tx.sign(this.payer);

                const rawTx = tx.serialize();
                const commitSig = await entry.erConnection.sendRawTransaction(rawTx, { skipPreflight: true });
                await this.confirmErTransaction(entry.erConnection, commitSig, blockhash, lastValidBlockHeight);

                // Success — remove from queue
                this.pendingUndelegations.splice(i, 1);
                this.clearPersistedSession(entry.ticketId);

                logger.info("undelegation_retry_succeeded", {
                    ticketId: entry.ticketId,
                    dealPda: entry.dealPda?.toBase58() || "not_created_yet",
                    totalAttempts: entry.attempts + 1,
                });
            } catch (error) {
                entry.attempts += 1;
                entry.failedAt = Date.now();
                entry.lastError = error instanceof Error ? error.message : String(error);

                if (entry.attempts >= UNDELEGATE_RETRY_MAX) {
                    // Exhausted retries — drop with critical error
                    this.pendingUndelegations.splice(i, 1);
                    this.persistRetryRecord({
                        ticketId: entry.ticketId,
                        dealPda: entry.dealPda,
                        sessionPda: entry.sessionPda,
                        validator: entry.validator,
                        validatorIdentity: entry.validatorIdentity,
                        isPrivate: false,
                        delegatedAt: entry.failedAt,
                        phase: "pending_er_undelegation",
                        attempts: entry.attempts,
                        lastError: entry.lastError,
                    });

                    logger.error(
                        "undelegation_retry_exhausted",
                        {
                            ticketId: entry.ticketId,
                            dealPda: entry.dealPda?.toBase58() || "not_created_yet",
                            validator: entry.validator,
                            totalAttempts: entry.attempts,
                            lastError: entry.lastError,
                        },
                        new Error(
                            `Failed to undelegate ${entry.dealPda?.toBase58() || "not_created_yet"} after ${entry.attempts} attempts. ` +
                            `Manual intervention required.`
                        )
                    );
                } else {
                    this.persistRetryRecord({
                        ticketId: entry.ticketId,
                        dealPda: entry.dealPda,
                        sessionPda: entry.sessionPda,
                        validator: entry.validator,
                        validatorIdentity: entry.validatorIdentity,
                        isPrivate: false,
                        delegatedAt: entry.failedAt,
                        phase: "pending_er_undelegation",
                        attempts: entry.attempts,
                        lastError: entry.lastError,
                    });

                    const nextBackoffMs =
                        UNDELEGATE_RETRY_INTERVAL_MS *
                        Math.pow(UNDELEGATE_RETRY_BACKOFF_FACTOR, entry.attempts - 1);

                    logger.warn("undelegation_retry_failed", {
                        ticketId: entry.ticketId,
                        attempt: entry.attempts,
                        maxRetries: UNDELEGATE_RETRY_MAX,
                        nextRetryInMs: nextBackoffMs,
                        error: entry.lastError,
                    });
                }
            }
        }
    }

    private async retryFailedPermissionCloses(): Promise<void> {
        if (this.pendingPermissionCloses.length === 0) return;

        for (let i = this.pendingPermissionCloses.length - 1; i >= 0; i--) {
            const entry = this.pendingPermissionCloses[i];
            const backoffMs =
                UNDELEGATE_RETRY_INTERVAL_MS *
                Math.pow(UNDELEGATE_RETRY_BACKOFF_FACTOR, entry.attempts - 1);
            const nextRetryAt = entry.failedAt + backoffMs;

            if (Date.now() < nextRetryAt) {
                continue;
            }

            try {
                const { PrivateNegotiationService } = await import("./privateNegotiationService");
                const privateService = new PrivateNegotiationService(this.baseConnection, this.payer);
                await privateService.closePermissionOnly(entry.sessionId, entry.sessionPda);
                this.pendingPermissionCloses.splice(i, 1);
                this.clearPersistedSession(entry.ticketId);

                logger.info("per_permission_close_retry_succeeded", {
                    ticketId: entry.ticketId,
                    sessionPda: entry.sessionPda.toBase58(),
                    attempts: entry.attempts,
                    commitSig: entry.commitSig,
                });
            } catch (error) {
                entry.attempts += 1;
                entry.failedAt = Date.now();
                entry.lastError = error instanceof Error ? error.message : String(error);

                if (entry.attempts >= UNDELEGATE_RETRY_MAX) {
                    this.pendingPermissionCloses.splice(i, 1);
                    this.persistRetryRecord({
                        ticketId: entry.ticketId,
                        sessionPda: entry.sessionPda,
                        validator: PER_TEE_VALIDATOR_FQDN,
                        validatorIdentity: PER_TEE_VALIDATOR_DEVNET,
                        isPrivate: true,
                        delegatedAt: Date.now(),
                        phase: "pending_per_close",
                        attempts: entry.attempts,
                        lastError: entry.lastError,
                        commitSignature: entry.commitSig,
                    });

                    logger.error("per_permission_close_retry_exhausted", {
                        ticketId: entry.ticketId,
                        sessionPda: entry.sessionPda.toBase58(),
                        attempts: entry.attempts,
                        lastError: entry.lastError,
                        recovery: "manual closePermissionOnly on L1",
                    });
                    continue;
                }

                this.persistRetryRecord({
                    ticketId: entry.ticketId,
                    sessionPda: entry.sessionPda,
                    validator: PER_TEE_VALIDATOR_FQDN,
                    validatorIdentity: PER_TEE_VALIDATOR_DEVNET,
                    isPrivate: true,
                    delegatedAt: Date.now(),
                    phase: "pending_per_close",
                    attempts: entry.attempts,
                    lastError: entry.lastError,
                    commitSignature: entry.commitSig,
                });

                logger.warn("per_permission_close_retry_failed", {
                    ticketId: entry.ticketId,
                    attempt: entry.attempts,
                    nextRetryInMs:
                        UNDELEGATE_RETRY_INTERVAL_MS *
                        Math.pow(UNDELEGATE_RETRY_BACKOFF_FACTOR, entry.attempts - 1),
                    error: entry.lastError,
                });
            }
        }
    }

    /**
     * Returns the current undelegation retry queue for observability.
     */
    getPendingUndelegations(): ReadonlyArray<{
        ticketId: string;
        dealPda: string;
        validator: string;
        attempts: number;
        lastError: string;
    }> {
        return this.pendingUndelegations.map((e) => ({
            ticketId: e.ticketId,
            dealPda: e.dealPda?.toBase58() || "not_created_yet",
            validator: e.validator,
            attempts: e.attempts,
            lastError: e.lastError,
        }));
    }

    /**
     * Graceful shutdown — stops retry loop, clears all session timers.
     */
    shutdown(): void {
        this.stopRetryLoop();
        for (const session of this.activeSessions.values()) {
            this.clearSessionTimeout(session);
        }
        this.fheAdapter.close();
        logger.info("negotiation_rollup_service_shutdown", {
            activeSessionsCleared: this.activeSessions.size,
            pendingUndelegationsRemaining: this.pendingUndelegations.length,
        });
    }
}
