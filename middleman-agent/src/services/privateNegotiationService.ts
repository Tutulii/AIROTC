import fs from "fs";
import os from "os";
import path from "path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { createHash, randomBytes } from "crypto";
import {
    verifyTeeRpcIntegrity,
    verifyTeeIntegrity as verifyFastTeeIntegrity,
    getAuthToken,
    createClosePermissionInstruction,
    DELEGATION_PROGRAM_ID,
    PERMISSION_PROGRAM_ID,
    MAGIC_CONTEXT_ID,
    MAGIC_PROGRAM_ID,
    delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
    delegationMetadataPdaFromDelegatedAccount,
    delegationRecordPdaFromDelegatedAccount,
    permissionPdaFromAccount,
    createCreatePermissionInstruction,
    AUTHORITY_FLAG,
    TX_LOGS_FLAG,
    TX_MESSAGE_FLAG,
    type Member
} from "@magicblock-labs/ephemeral-rollups-sdk";
import * as nacl from "tweetnacl";
import { logger } from "../utils/logger";
import { withRetry, sleep } from "../utils/retry";
import { rpcManager } from "../utils/rpcManager";
import { dependencyHealthService } from "./dependencyHealthService";
import negotiationIdl from "../idl/magicblock_negotiation.json";
import type { MagicblockNegotiation } from "../idl/magicblock_negotiation";
import {
    PER_TEE_RPC_URL,
    PER_TEE_VALIDATOR_DEVNET,
} from "./magicblockPerContract";
const NEGOTIATION_PROGRAM_ID = new PublicKey((negotiationIdl as any).address);

export interface NegotiatedTerms {
    priceLamports: BN;
    quantity: BN;
    assetMint: PublicKey;
}

export class PendingL1PermissionCloseError extends Error {
    readonly commitSig: string;
    readonly sessionId: bigint;
    readonly sessionPda: PublicKey;

    constructor(sessionId: bigint, sessionPda: PublicKey, commitSig: string, message: string) {
        super(message);
        this.name = "PendingL1PermissionCloseError";
        this.sessionId = sessionId;
        this.sessionPda = sessionPda;
        this.commitSig = commitSig;
    }
}

export interface PermissionActivationProbeResult {
    active: boolean;
    degraded: boolean;
    source: "permission_status" | "l1_confirmed_fallback" | "timeout";
    attempts: number;
    lastError?: string;
}

function isPermissionStatusServerFailure(message: string): boolean {
    const lower = message.toLowerCase();
    return (
        lower.includes("internal server error") ||
        lower.includes("permission status request failed") ||
        lower.includes("status 500") ||
        lower.includes("failed to get permission status")
    );
}

function isPermissionDelegateBorrowConflict(message: string): boolean {
    const lower = message.toLowerCase();
    return (
        lower.includes("already borrowed") ||
        lower.includes("borrow reference for an account") ||
        lower.includes("accountborrowfailed")
    );
}

async function getPermissionStatusDirect(
    rpcUrl: string,
    publicKey: PublicKey
): Promise<{ authorizedUsers?: unknown[] }> {
    const [baseUrl, query] = rpcUrl.replace("/?", "?").split("?");
    const url = query
        ? `${baseUrl}/permission?${query}&pubkey=${publicKey.toBase58()}`
        : `${baseUrl}/permission?pubkey=${publicKey.toBase58()}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `Permission status request failed: ${response.status} ${response.statusText}`.trim()
        );
    }
    return (await response.json()) as { authorizedUsers?: unknown[] };
}

export async function waitForPermissionActivationWithFallback(input: {
    rpcUrl: string;
    sessionPda: PublicKey;
    timeoutMs?: number;
    allowL1ConfirmedFallback?: boolean;
}): Promise<PermissionActivationProbeResult> {
    const timeoutMs = input.timeoutMs ?? 30_000;
    const startedAt = Date.now();
    let attempts = 0;
    let hadSuccessfulProbe = false;
    let lastError: string | undefined;

    while (Date.now() - startedAt < timeoutMs) {
        attempts += 1;
        try {
            const status = await getPermissionStatusDirect(input.rpcUrl, input.sessionPda);
            hadSuccessfulProbe = true;
            if (Array.isArray(status.authorizedUsers) && status.authorizedUsers.length > 0) {
                return {
                    active: true,
                    degraded: false,
                    source: "permission_status",
                    attempts,
                };
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }

        await sleep(400);
    }

    if (
        input.allowL1ConfirmedFallback !== false &&
        !hadSuccessfulProbe &&
        lastError &&
        isPermissionStatusServerFailure(lastError)
    ) {
        return {
            active: true,
            degraded: true,
            source: "l1_confirmed_fallback",
            attempts,
            lastError,
        };
    }

    return {
        active: false,
        degraded: false,
        source: "timeout",
        attempts,
        lastError,
    };
}

export class PrivateNegotiationService {
    private static readonly AUTH_TOKEN_CACHE_PATH = path.join(
        os.tmpdir(),
        "air-otc-per-auth-cache.json"
    );
    private static readonly TEE_VERIFICATION_TTL_MS = 5 * 60 * 1000;
    private static authCacheLoaded = false;
    private static readonly authTokenCache = new Map<string, { token: string; expiresAt: number }>();
    private static teeVerificationCache:
        | { verifiedAt: number; verificationApi: "fast-quote" | "quote" }
        | null = null;
    private readonly baseConnection: Connection;
    private readonly serverPayer: Keypair;
    private readonly permissionFeePayer: Keypair;
    private isTeeVerified: boolean = false;

    constructor(connection: Connection, serverPayer: Keypair) {
        this.baseConnection = connection;
        this.serverPayer = serverPayer;
        this.permissionFeePayer = PrivateNegotiationService.derivePermissionFeePayer(serverPayer);
        PrivateNegotiationService.loadPersistedAuthTokenCache();
    }

    private static derivePermissionFeePayer(serverPayer: Keypair): Keypair {
        const seed = createHash("sha256")
            .update(serverPayer.secretKey)
            .update("air-otc/per-permission-fee-payer")
            .digest()
            .subarray(0, 32);
        return Keypair.fromSeed(seed);
    }

    private static loadPersistedAuthTokenCache(): void {
        if (PrivateNegotiationService.authCacheLoaded) {
            return;
        }

        PrivateNegotiationService.authCacheLoaded = true;
        try {
            if (!fs.existsSync(PrivateNegotiationService.AUTH_TOKEN_CACHE_PATH)) {
                return;
            }

            const raw = fs.readFileSync(PrivateNegotiationService.AUTH_TOKEN_CACHE_PATH, "utf8");
            const parsed = JSON.parse(raw) as Record<string, { token: string; expiresAt: number }>;
            for (const [wallet, entry] of Object.entries(parsed)) {
                if (
                    entry &&
                    typeof entry.token === "string" &&
                    entry.token.length > 0 &&
                    typeof entry.expiresAt === "number" &&
                    Number.isFinite(entry.expiresAt) &&
                    entry.expiresAt > Date.now()
                ) {
                    PrivateNegotiationService.authTokenCache.set(wallet, entry);
                }
            }
        } catch (error) {
            logger.warn("per_auth_token_cache_load_failed", {
                path: PrivateNegotiationService.AUTH_TOKEN_CACHE_PATH,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private static persistAuthTokenCache(): void {
        try {
            const entries = Object.fromEntries(
                [...PrivateNegotiationService.authTokenCache.entries()].filter(
                    ([, value]) => value.expiresAt > Date.now()
                )
            );
            fs.writeFileSync(
                PrivateNegotiationService.AUTH_TOKEN_CACHE_PATH,
                JSON.stringify(entries, null, 2),
                { encoding: "utf8", mode: 0o600 }
            );
        } catch (error) {
            logger.warn("per_auth_token_cache_persist_failed", {
                path: PrivateNegotiationService.AUTH_TOKEN_CACHE_PATH,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private async logSignatureStatus(
        connection: Connection,
        label: string,
        signature: string,
        extra?: Record<string, unknown>
    ): Promise<void> {
        try {
            const statuses = await connection.getSignatureStatuses([signature], {
                searchTransactionHistory: true,
            });
            const status = statuses.value[0];
            logger.warn("per_transaction_status_checked", {
                label,
                signature,
                confirmationStatus: status?.confirmationStatus ?? null,
                confirmations: status?.confirmations ?? null,
                slot: status?.slot ?? null,
                err: status?.err ?? null,
                ...extra,
            });
        } catch (statusError) {
            logger.warn("per_transaction_status_check_failed", {
                label,
                signature,
                error: statusError instanceof Error ? statusError.message : String(statusError),
                ...extra,
            });
        }
    }

    private getNegotiationProgram(connection: Connection): Program<MagicblockNegotiation> {
        const provider = new AnchorProvider(connection, new Wallet(this.serverPayer), {
            commitment: "confirmed",
        });

        return new Program(
            negotiationIdl as any,
            provider
        ) as unknown as Program<MagicblockNegotiation>;
    }

    private async sendPermissionTransaction(
        label: string,
        buildTransaction: () => Promise<import("@solana/web3.js").Transaction>,
        options?: {
            feePayer?: Keypair;
            extraSigners?: Keypair[];
        }
    ): Promise<string> {
        return withRetry(
            async () => {
                const connection = rpcManager.getConnection("confirmed");
                const feePayer = options?.feePayer ?? this.serverPayer;
                const extraSigners = options?.extraSigners ?? [];
                await this.ensurePermissionFeePayerFunded(connection, feePayer);
                const tx = await buildTransaction();
                const latestBlockhash = await connection.getLatestBlockhash("confirmed");
                tx.recentBlockhash = latestBlockhash.blockhash;
                tx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
                tx.feePayer = feePayer.publicKey;
                tx.sign(feePayer, this.serverPayer, ...extraSigners);

                const signature = await connection.sendRawTransaction(tx.serialize(), {
                    skipPreflight: false,
                    maxRetries: 2,
                });

                try {
                    const confirmation = await connection.confirmTransaction(
                        {
                            signature,
                            blockhash: latestBlockhash.blockhash,
                            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                        },
                        "confirmed"
                    );

                    if (confirmation.value.err) {
                        throw new Error(
                            `${label} transaction ${signature} failed: ${JSON.stringify(
                                confirmation.value.err
                            )}`
                        );
                    }

                    return signature;
                } catch (error) {
                    await this.logSignatureStatus(connection, `per_${label}`, signature, {
                        confirmationVenue: "l1",
                    });
                    throw error;
                }
            },
            { label: `per_${label}`, step: label }
        );
    }

    private async ensurePermissionFeePayerFunded(connection: Connection, feePayer: Keypair): Promise<void> {
        if (feePayer.publicKey.equals(this.serverPayer.publicKey)) {
            return;
        }

        const minimumLamports = 0.01 * LAMPORTS_PER_SOL;
        const topUpLamports = 0.05 * LAMPORTS_PER_SOL;
        const currentBalance = await connection.getBalance(feePayer.publicKey, "confirmed");
        if (currentBalance >= minimumLamports) {
            return;
        }

        const { SystemProgram, Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
        logger.info("per_permission_fee_payer_top_up", {
            feePayer: feePayer.publicKey.toBase58(),
            currentBalance,
            topUpLamports,
        });
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: this.serverPayer.publicKey,
                toPubkey: feePayer.publicKey,
                lamports: topUpLamports,
            })
        );
        await sendAndConfirmTransaction(connection, tx, [this.serverPayer], { commitment: "confirmed" });
    }

    /**
     * Step 1 (Foundation): Verify the TEE RPC runs on genuine Intel TDX hardware
     */
    public async verifyTeeIntegrity(options?: { throwOnError?: boolean }): Promise<boolean> {
        await dependencyHealthService.assertHealthyForOperation("per_tee_integrity", [
            "solana_rpc",
            "magicblock_tee",
        ]);

        const cached = PrivateNegotiationService.teeVerificationCache;
        if (
            cached &&
            Date.now() - cached.verifiedAt < PrivateNegotiationService.TEE_VERIFICATION_TTL_MS
        ) {
            this.isTeeVerified = true;
            logger.info("per_tee_integrity_cache_hit", {
                url: PER_TEE_RPC_URL,
                verificationApi: cached.verificationApi,
                verifiedAt: cached.verifiedAt,
            });
            return true;
        }

        try {
            logger.info("per_verifying_tee_integrity", { url: PER_TEE_RPC_URL });
            await verifyFastTeeIntegrity(PER_TEE_RPC_URL);
            this.isTeeVerified = true;
            PrivateNegotiationService.teeVerificationCache = {
                verifiedAt: Date.now(),
                verificationApi: "fast-quote",
            };
            logger.info("per_tee_integrity_verified", {
                url: PER_TEE_RPC_URL,
                verificationApi: "fast-quote",
            });
            return true;
        } catch (error: any) {
            const message = String(error?.message || error || "");
            const lower = message.toLowerCase();
            const shouldTryFullQuote =
                lower.includes("too many open files") ||
                lower.includes("timeout") ||
                lower.includes("etimedout") ||
                lower.includes("unavailable") ||
                lower.includes("connect") ||
                lower.includes("fetch failed") ||
                lower.includes("socket hang up");

            if (shouldTryFullQuote) {
                try {
                    logger.warn("per_tee_integrity_fast_quote_failed_falling_back", {
                        error: message,
                        verificationApi: "quote",
                    });
                    await verifyTeeRpcIntegrity(PER_TEE_RPC_URL);
                    this.isTeeVerified = true;
                    PrivateNegotiationService.teeVerificationCache = {
                        verifiedAt: Date.now(),
                        verificationApi: "quote",
                    };
                    logger.info("per_tee_integrity_verified", {
                        url: PER_TEE_RPC_URL,
                        verificationApi: "quote",
                    });
                    return true;
                } catch (fallbackError: any) {
                    this.isTeeVerified = false;
                    logger.error("per_tee_integrity_error", {
                        error: fallbackError.message,
                        verificationApi: "quote",
                        initialError: message,
                    });
                    if (options?.throwOnError) {
                        throw fallbackError;
                    }
                    return false;
                }
            }

            this.isTeeVerified = false;
            logger.error("per_tee_integrity_error", {
                error: message,
                verificationApi: "fast-quote",
            });
            if (options?.throwOnError) {
                throw error;
            }
            return false;
        }
    }

    /**
     * Day 4 (Pattern B Auth): Server proxies agent token acquisition.
     * Uses a 10 second WS challenge timeout, long-lived token reuse, and retry.
     */
    public async getAgentAuthTokenPatternB(
        agentPubkey: PublicKey,
        requestSignatureFromAgent: (challengeBase64: string) => Promise<string>
    ): Promise<{ token: string; expiresAt: number }> {
        await dependencyHealthService.assertHealthyForOperation("per_auth", [
            "solana_rpc",
            "magicblock_tee",
            "magicblock_auth",
        ]);
        if (!this.isTeeVerified) {
            throw new Error("TEE integrity not verified. Cannot fetch auth token.");
        }

        const cacheKey = agentPubkey.toBase58();
        const cached = PrivateNegotiationService.authTokenCache.get(cacheKey);
        if (cached && cached.expiresAt - 60_000 > Date.now()) {
            logger.info("per_auth_token_cache_hit", { agentPubkey: cacheKey });
            return cached;
        }

        let attempts = 0;
        const MAX_ATTEMPTS = 4;

        while (attempts < MAX_ATTEMPTS) {
            attempts++;
            try {
                const signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
                    const challengeBase64 = Buffer.from(message).toString("base64");
                    
                    // 10 second timeout for the WS response
                    const timeoutPromise = new Promise<string>((_, reject) => {
                        setTimeout(() => reject(new Error("WS_TIMEOUT")), 10_000);
                    });

                    const signatureBase64 = await Promise.race([
                        requestSignatureFromAgent(challengeBase64),
                        timeoutPromise
                    ]);

                    return Buffer.from(signatureBase64, "base64");
                };

                const authResult = await getAuthToken(
                    PER_TEE_RPC_URL,
                    agentPubkey,
                    signMessage
                );

                logger.info("per_auth_token_acquired", { agentPubkey: agentPubkey.toBase58() });
                const result = { token: authResult.token, expiresAt: authResult.expiresAt };
                PrivateNegotiationService.authTokenCache.set(cacheKey, result);
                PrivateNegotiationService.persistAuthTokenCache();
                return result;

            } catch (error: any) {
                const message = String(error?.message || error || "");
                const lower = message.toLowerCase();
                const transientAuthFailure =
                    error.message === "WS_TIMEOUT" ||
                    lower.includes("failed to authenticate") ||
                    lower.includes("too many open files") ||
                    lower.includes("scorechain client") ||
                    lower.includes("no native root ca certificates") ||
                    lower.includes("timeout") ||
                    lower.includes("unavailable");

                if (transientAuthFailure && attempts < MAX_ATTEMPTS) {
                    logger.warn("per_auth_retry", {
                        agentPubkey: cacheKey,
                        attempt: attempts,
                        error: message,
                    });
                    await sleep(1_500 * attempts);
                    continue;
                }

                if (attempts >= MAX_ATTEMPTS) {
                    logger.error("per_auth_failed", {
                        agentPubkey: cacheKey,
                        error: message,
                        attempts,
                    });
                    throw new Error("Auth failed after retries");
                }

                throw error;
            }
        }
        throw new Error("Unreachable");
    }

    // ========================================================================
    // Option C: TypeScript Commit-Reveal Scheme for Blind Bilateral Negotiation
    // ========================================================================

    /**
     * AGENT-SIDE HELPER: Generates a cryptographically secure salt and computes the hash locally.
     * The agent MUST run this locally. They send the `hash` during the Commit phase,
     * and keep the `salt` secret until the Reveal phase.
     */
    public static generateAgentCommitment(terms: NegotiatedTerms): { hash: string, salt: string } {
        // 16 bytes of cryptographically secure randomness, base64 encoded
        const salt = randomBytes(16).toString("base64");
        
        // Hash format: sha256(priceLamports:quantity:salt)
        const payload = `${terms.priceLamports.toString()}:${terms.quantity.toString()}:${salt}`;
        const hash = createHash("sha256").update(payload).digest("hex");
        
        return { hash, salt };
    }



    // Skeleton methods for future days
    /**
     * Step 2 (Permission Lifecycle): Create the Permission PDA to protect the session
     * IMPORTANT: The sessionPda must ALREADY be initialized on L1 (via Anchor initialize_session)
     * before this function is called, otherwise creation will fail.
     */
    public async createPermissionSession(
        sessionPda: PublicKey, 
        buyerPubkey: PublicKey, 
        sellerPubkey: PublicKey
    ): Promise<string> {
        logger.info("per_creating_permission", { sessionPda: sessionPda.toBase58() });

        const members: Member[] = [
            {
                flags: AUTHORITY_FLAG,
                pubkey: this.serverPayer.publicKey, // AIR OTC server (cannot read messages)
            },
            {
                flags: TX_MESSAGE_FLAG | TX_LOGS_FLAG,
                pubkey: buyerPubkey, // buyer agent
            },
            {
                flags: TX_MESSAGE_FLAG | TX_LOGS_FLAG,
                pubkey: sellerPubkey, // seller agent
            },
        ];

        const createPermIx = createCreatePermissionInstruction(
            {
                permissionedAccount: sessionPda,
                payer: this.serverPayer.publicKey,
            },
            { members }
        );

        const { Transaction } = await import("@solana/web3.js");
        const sig = await this.sendPermissionTransaction(
            "create_permission",
            async () => new Transaction().add(createPermIx)
        );

        logger.info("per_permission_created", { signature: sig, sessionPda: sessionPda.toBase58() });
        return sig;
    }

    /**
     * Step 3 (Delegation): Delegate the session PDA to the TEE Validator
     */
    public async delegateToTee(sessionId: bigint, sessionPda: PublicKey): Promise<string> {
        logger.info("per_delegating_to_tee", {
            sessionId: sessionId.toString(),
            sessionPda: sessionPda.toBase58(),
        });

        const permissionPda = permissionPdaFromAccount(sessionPda);
        const delegationBuffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(
            permissionPda,
            PERMISSION_PROGRAM_ID
        );
        const delegationRecord = delegationRecordPdaFromDelegatedAccount(permissionPda);
        const delegationMetadata = delegationMetadataPdaFromDelegatedAccount(permissionPda);

        const delegateOnce = async (): Promise<string> => {
            const connection = rpcManager.getConnection("confirmed");
            const program = this.getNegotiationProgram(connection);
            return (program.methods as any)
                .delegatePrivatePermission(new BN(sessionId.toString()))
                .accounts({
                    payer: this.serverPayer.publicKey,
                    session: sessionPda,
                    permission: permissionPda,
                    permissionProgram: PERMISSION_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                    delegationBuffer,
                    delegationRecord,
                    delegationMetadata,
                    delegationProgram: DELEGATION_PROGRAM_ID,
                    validator: PER_TEE_VALIDATOR_DEVNET,
                })
                .rpc();
        };

        let sig: string;
        try {
            sig = await delegateOnce();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (isPermissionDelegateBorrowConflict(detail)) {
                throw error;
            }

            sig = await withRetry(
                delegateOnce,
                { label: "per_delegate_private_permission", step: "delegate_private_permission" }
            );
        }

        logger.info("per_delegation_confirmed", {
            signature: sig,
            sessionId: sessionId.toString(),
            sessionPda: sessionPda.toBase58(),
            validator: PER_TEE_VALIDATOR_DEVNET.toBase58(),
        });
        return sig;
    }

    /**
     * Step 5 (Commit and Close): submit commit+undelegate on TEE, wait for
     * ownership to return on L1, then close the permission on L1.
     *
     * This is the canonical two-step PER finalization contract:
     * 1. Commit + undelegate is submitted on the TEE/PER connection.
     * 2. ClosePermission is submitted on base layer only after the session
     *    owner is observed back on the negotiation program on L1.
     */
    public async commitAndClose(
        sessionId: bigint,
        sessionPda: PublicKey,
        authorityConnection: Connection
    ): Promise<{ commitSig: string, closeSig: string }> {
        logger.info("per_committing_and_closing", {
            sessionPda: sessionPda.toBase58(),
            finalizationVenue: "TEE commit -> L1 close",
        });

        const commitSig = await this.commitScrubbedSessionOnTee(
            sessionId,
            sessionPda,
            authorityConnection
        );
        logger.info("per_session_committed_on_tee", { signature: commitSig });

        await this.waitForOwnerReturnOnL1(sessionPda);

        let closeSig: string;
        try {
            closeSig = await this.closePermissionOnL1(sessionPda);
        } catch (error) {
            logger.error("per_close_failed_after_successful_commit", {
                sessionPda: sessionPda.toBase58(),
                commitSig,
                recovery: "retry closePermissionOnly on L1",
                error: error instanceof Error ? error.message : String(error),
            });
            throw new PendingL1PermissionCloseError(
                sessionId,
                sessionPda,
                commitSig,
                `PER close failed after successful TEE commit ${commitSig}. ` +
                `The session is back on L1 but the permission may still be open; ` +
                `retry closePermissionOnly on base layer.`
            );
        }

        logger.info("per_session_closed", { signature: closeSig });
        return { commitSig, closeSig };
    }

    public async closePermissionOnly(_sessionId: bigint, sessionPda: PublicKey): Promise<string> {
        logger.info("per_closing_permission_only", { sessionPda: sessionPda.toBase58() });
        const closeSig = await this.closePermissionOnL1(sessionPda);

        logger.info("per_permission_closed", { signature: closeSig });
        return closeSig;
    }

    private async commitScrubbedSessionOnTee(
        sessionId: bigint,
        sessionPda: PublicKey,
        authorityConnection: Connection
    ): Promise<string> {
        return withRetry(
            async () => {
                const { Transaction } = await import("@solana/web3.js");
                const program = this.getNegotiationProgram(authorityConnection);
                const permissionPda = permissionPdaFromAccount(sessionPda);
                const commitIx = await (program.methods as any)
                    .commitPrivatePermission(new BN(sessionId.toString()))
                    .accounts({
                        payer: this.serverPayer.publicKey,
                        session: sessionPda,
                        permission: permissionPda,
                        permissionProgram: PERMISSION_PROGRAM_ID,
                        magicProgram: MAGIC_PROGRAM_ID,
                        magicContext: MAGIC_CONTEXT_ID,
                    })
                    .instruction();

                const tx = new Transaction().add(commitIx);
                const latestBlockhash = await authorityConnection.getLatestBlockhash("confirmed");
                tx.recentBlockhash = latestBlockhash.blockhash;
                tx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
                tx.feePayer = this.serverPayer.publicKey;
                tx.sign(this.serverPayer);

                const signature = await authorityConnection.sendRawTransaction(tx.serialize(), {
                    skipPreflight: true,
                });
                try {
                    const confirmation = await authorityConnection.confirmTransaction(
                        {
                            signature,
                            blockhash: latestBlockhash.blockhash,
                            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                        },
                        "confirmed"
                    );

                    if (confirmation.value.err) {
                        throw new Error(`PER commit on TEE failed: ${JSON.stringify(confirmation.value.err)}`);
                    }
                } catch (error) {
                    await this.logSignatureStatus(authorityConnection, "per_commit_permission", signature, {
                        confirmationVenue: "tee",
                        sessionPda: sessionPda.toBase58(),
                        sessionId: sessionId.toString(),
                        visibilityHint:
                            "Enable additional PER visibility flags during debugging for deeper private tx diagnostics.",
                    });
                    throw error;
                }

                return signature;
            },
            { label: "per_commit_permission", step: "commit_permission" }
        );
    }

    private async waitForOwnerReturnOnL1(sessionPda: PublicKey): Promise<void> {
        for (let attempt = 0; attempt < 15; attempt++) {
            await sleep(3000);
            const accountInfo = await this.baseConnection.getAccountInfo(sessionPda, "confirmed");
            if (accountInfo?.owner.equals(NEGOTIATION_PROGRAM_ID)) {
                logger.info("per_session_undelegated_to_l1", {
                    sessionPda: sessionPda.toBase58(),
                    attempt: attempt + 1,
                });
                return;
            }
        }

        throw new Error("PER session owner did not return to negotiation program after TEE commit");
    }

    private async closePermissionOnL1(sessionPda: PublicKey): Promise<string> {
        const maxAttempts = 4;
        const baseDelayMs = 1_000;
        let lastError: unknown = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const { Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
                return await sendAndConfirmTransaction(
                    this.baseConnection,
                    new Transaction().add(
                        createClosePermissionInstruction({
                            payer: this.permissionFeePayer.publicKey,
                            authority: [this.serverPayer.publicKey, true],
                            permissionedAccount: [sessionPda, false],
                        })
                    ),
                    [this.serverPayer],
                    { commitment: "confirmed" }
                );
            } catch (error) {
                lastError = error;
                if (attempt === maxAttempts - 1) {
                    break;
                }

                const delayMs = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
                logger.warn("per_close_permission_retrying", {
                    sessionPda: sessionPda.toBase58(),
                    attempt: attempt + 1,
                    nextAttempt: attempt + 2,
                    delayMs,
                    error: error instanceof Error ? error.message : String(error),
                });
                await sleep(delayMs);
            }
        }

        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    public async waitForOwnerReturn(sessionPda: PublicKey): Promise<void> {
        await this.waitForOwnerReturnOnL1(sessionPda);
    }
}
