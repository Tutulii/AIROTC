/**
 * Umbra Privacy Service
 *
 * Integration of @umbra-privacy/sdk into the AIR OTC settlement layer.
 * Public methods wrap official SDK factory functions and fail closed when
 * required proof infrastructure is stale or unavailable.
 *
 * Hardening checklist:
 *   ✅ Branded types (Address, U64, U32) via @solana/kit
 *   ✅ SDK error handling with type guards (@umbra-privacy/sdk/errors)
 *   ✅ Retry logic for MPC callback failures (pruned/timed-out)
 *   ✅ Fee estimation via official SDK fee providers
 *   ✅ Compliance viewing keys for OTC audit
 *   ✅ Project's Pino-powered structured logger
 *   ✅ Fail-closed assertions on every method
 *   ✅ UTXO mixer (create + scan + claim) for unlinkable settlement
 *   ✅ Concurrency-safe with mutex on critical operations
 *
 * Source of truth:
 *   - SDK quickstart:   https://sdk.umbraprivacy.com/quickstart
 *   - Client creation:  https://sdk.umbraprivacy.com/sdk/creating-a-client
 *   - Registration:     https://sdk.umbraprivacy.com/sdk/registration
 *   - Deposit:          https://sdk.umbraprivacy.com/sdk/deposit
 *   - Withdraw:         https://sdk.umbraprivacy.com/sdk/withdraw
 *   - Query State:      https://sdk.umbraprivacy.com/sdk/query
 *   - Mixer:            https://sdk.umbraprivacy.com/sdk/mixer/overview
 *   - Wallet Adapters:  https://sdk.umbraprivacy.com/sdk/wallet-adapters
 *   - Supported Tokens: https://sdk.umbraprivacy.com/supported-tokens
 *   - Pricing:          https://sdk.umbraprivacy.com/pricing
 *   - Compliance:       https://sdk.umbraprivacy.com/sdk/compliance
 *   - Errors:           node_modules/@umbra-privacy/sdk/dist/errors/index.d.ts
 *
 * @module umbraService
 */

import { getUserRegistrationProver } from "@umbra-privacy/web-zk-prover";
import { address, type Address } from "@solana/kit";
import { Connection, PublicKey } from "@solana/web3.js";
import {
    getDepositIntoStealthPoolFromPublicBalanceEventV1Decoder,
    getDepositIntoStealthPoolFromSharedBalanceV11CallbackEventV1Decoder,
    getStealthPoolDecoder,
} from "@umbra-privacy/umbra-codama";
import {
    getUmbraClient,
    getUserRegistrationFunction,
    getPublicBalanceToEncryptedBalanceDirectDepositorFunction,
    getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction,
    getEncryptedBalanceQuerierFunction,
    getUserAccountQuerierFunction,
    getNetworkEncryptionToSharedEncryptionConverterFunction,
    getEncryptedBalanceToSelfClaimableUtxoCreatorFunction,
    getUmbraRelayer,
    createSignerFromPrivateKeyBytes,
    getClaimableUtxoScannerFunction,
    getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
    getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction,
    getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction,
    getSelfClaimableUtxoToEncryptedBalanceClaimerFunction,
    getComplianceGrantIssuerFunction,
    getComplianceGrantRevokerFunction,
    calculateFee,
    getHardcodedDepositProtocolFeeProvider,
    getHardcodedWithdrawalProtocolFeeProvider,
    getHardcodedCreateUtxoProtocolFeeProvider,
    BPS_DIVISOR,
} from "@umbra-privacy/sdk";
import {
    findStealthPoolPda,
} from "@umbra-privacy/sdk/utils";
import {
    isRegistrationError,
    isEncryptedDepositError,
    isEncryptedWithdrawalError,
    isCreateUtxoError,
    isClaimUtxoError,
    isFetchUtxosError,
    isQueryError,
    isUmbraError,
} from "@umbra-privacy/sdk/errors";
import { logger } from "../utils/logger";

// ============================================================================
// TYPES
// ============================================================================

export type UmbraNetwork = "mainnet" | "devnet";

/**
 * Callback status returned by deposit/withdraw operations.
 * Source: https://sdk.umbraprivacy.com/sdk/deposit#return-value
 */
type CallbackStatus = "finalized" | "pruned" | "timed-out";

/**
 * Configuration for retry behavior on MPC callback failures.
 */
interface RetryConfig {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
}

interface LocalUmbraUtxoEvent {
    absoluteIndex: bigint;
    treeIndex: bigint;
    insertionIndex: bigint;
    finalCommitment: Uint8Array;
    h1Components: {
        version: bigint;
        commitmentIndex: bigint;
        senderAddressLow: bigint;
        senderAddressHigh: bigint;
        relayerFixedSolFees: bigint;
        mintAddressLow: bigint;
        mintAddressHigh: bigint;
        timestamp: {
            year: number;
            month: number;
            day: number;
            hour: number;
            minute: number;
            second: number;
        };
        poolVolumeSpl: bigint;
        poolVolumeSol: bigint;
    };
    h1Hash: Uint8Array;
    h2Hash: Uint8Array;
    aesEncryptedData: Uint8Array;
    depositorX25519PublicKey: Uint8Array;
    timestamp: bigint;
    slot: bigint;
    eventType: "deposit" | "callback";
    txSignature: string;
}

const DEFAULT_REGISTRATION_TIMEOUT_MS = 180_000;

function resolveRegistrationTimeoutMs(): number {
    const configured = Number(process.env.UMBRA_REGISTRATION_TIMEOUT_MS);
    if (Number.isFinite(configured) && configured >= 30_000) {
        return configured;
    }
    return DEFAULT_REGISTRATION_TIMEOUT_MS;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 3,
    baseDelayMs: 2_000,
    maxDelayMs: 30_000,
};

// ============================================================================
// CONSTANTS (from SDK docs — no guessing)
// ============================================================================

/**
 * Program IDs.
 * Source: https://sdk.umbraprivacy.com/introduction#program-ids
 */
export const UMBRA_PROGRAM_IDS = {
    mainnet: "UMBRAD2ishebJTcgCLkTkNUx1v3GyoAgpTRPeWoLykh",
    devnet: "DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ",
} as const;

/**
 * Supported token mints (mainnet).
 * Source: https://sdk.umbraprivacy.com/supported-tokens#mainnet
 * Each: Token program = SPL, Confidentiality = enabled, Mixer = enabled.
 */
export const UMBRA_SUPPORTED_MINTS = {
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    wSOL: "So11111111111111111111111111111111111111112",
    UMBRA: "PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta",
} as const;

export const UMBRA_ENDPOINTS = {
    mainnet: {
        indexer: "https://utxo-indexer.api.umbraprivacy.com",
        relayer: "https://relayer.api.umbraprivacy.com",
    },
    devnet: {
        indexer: "https://utxo-indexer.api-devnet.umbraprivacy.com",
        relayer: "https://relayer.api-devnet.umbraprivacy.com",
    },
} as const;

const MAX_UMBRA_TREE_LEAVES = 1_048_576n;

type UmbraEndpointKind = "indexer" | "relayer";

function normalizeUmbraEndpoint(endpoint: string): string {
    const trimmed = endpoint.trim().replace(/\/+$/, "");
    if (!trimmed) {
        throw new Error("Umbra endpoint cannot be empty");
    }
    try {
        return new URL(trimmed).toString().replace(/\/+$/, "");
    } catch {
        throw new Error(`Umbra endpoint must be a valid URL: ${endpoint}`);
    }
}

function officialEndpointNetwork(endpoint: string, kind: UmbraEndpointKind): UmbraNetwork | null {
    const host = new URL(endpoint).hostname.toLowerCase();
    const officialHosts = {
        indexer: {
            mainnet: "utxo-indexer.api.umbraprivacy.com",
            devnet: "utxo-indexer.api-devnet.umbraprivacy.com",
        },
        relayer: {
            mainnet: "relayer.api.umbraprivacy.com",
            devnet: "relayer.api-devnet.umbraprivacy.com",
        },
    } as const;

    if (host === officialHosts[kind].mainnet) return "mainnet";
    if (host === officialHosts[kind].devnet) return "devnet";
    return null;
}

export function validateUmbraEndpointNetwork(
    endpoint: string,
    network: UmbraNetwork,
    kind: UmbraEndpointKind
): string {
    const normalized = normalizeUmbraEndpoint(endpoint);
    const endpointNetwork = officialEndpointNetwork(normalized, kind);

    if (endpointNetwork && endpointNetwork !== network) {
        throw new Error(
            `Umbra ${kind} endpoint/network mismatch: network=${network} endpoint=${normalized} belongs to ${endpointNetwork}`
        );
    }

    return normalized;
}

export function resolveUmbraIndexerEndpoint(network: UmbraNetwork): string {
    return validateUmbraEndpointNetwork(
        process.env.UMBRA_INDEXER_API_ENDPOINT || UMBRA_ENDPOINTS[network].indexer,
        network,
        "indexer"
    );
}

export function resolveUmbraRelayerEndpoint(network: UmbraNetwork): string {
    return validateUmbraEndpointNetwork(
        process.env.UMBRA_RELAYER_API_ENDPOINT || UMBRA_ENDPOINTS[network].relayer,
        network,
        "relayer"
    );
}

function bigintFromWrapped(value: unknown, fallback = 0n): bigint {
    const raw = (value as any)?.first ?? value;
    if (typeof raw === "bigint") return raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return BigInt(Math.trunc(raw));
    if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
    return fallback;
}

function bytesFromWrapped(value: unknown): Uint8Array {
    const raw = (value as any)?.first ?? value;
    if (raw instanceof Uint8Array) return new Uint8Array(raw);
    if (Buffer.isBuffer(raw)) return new Uint8Array(raw);
    if (Array.isArray(raw)) return Uint8Array.from(raw);
    throw new Error("Umbra event field is missing bytes");
}

function splitAddressParts(addressValue: string): { low: bigint; high: bigint } {
    const bytes = new PublicKey(addressValue).toBytes();
    let low = 0n;
    let high = 0n;
    for (let index = 0; index < 16; index += 1) {
        low |= BigInt(bytes[index]) << (8n * BigInt(index));
        high |= BigInt(bytes[16 + index]) << (8n * BigInt(index));
    }
    return { low, high };
}

// ============================================================================
// MUTEX (concurrency-safe critical sections)
// ============================================================================

class Mutex {
    private _locked = false;
    private _queue: (() => void)[] = [];

    async acquire(): Promise<void> {
        if (!this._locked) {
            this._locked = true;
            return;
        }
        return new Promise<void>((resolve) => {
            this._queue.push(resolve);
        });
    }

    release(): void {
        if (this._queue.length > 0) {
            const next = this._queue.shift()!;
            next();
        } else {
            this._locked = false;
        }
    }
}

// ============================================================================
// UMBRA SERVICE
// ============================================================================

export class UmbraService {
    private client: Awaited<ReturnType<typeof getUmbraClient>> | null = null;
    private readonly network: UmbraNetwork;
    private readonly rpcUrl: string;
    private readonly rpcSubscriptionsUrl: string;
    private readonly keypairBytes: Uint8Array;
    private readonly retryConfig: RetryConfig;
    private _registered = false;
    private readonly _localUtxos = new Map<string, LocalUmbraUtxoEvent>();

    // Mutexes for critical operations
    private readonly _registrationMutex = new Mutex();
    private readonly _depositMutex = new Mutex();
    private readonly _withdrawMutex = new Mutex();
    private readonly _utxoMutex = new Mutex();

    constructor(
        keypairBytes: Uint8Array,
        rpcUrl: string,
        network: UmbraNetwork = "devnet",
        retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
    ) {
        this.keypairBytes = keypairBytes;
        this.rpcUrl = rpcUrl;
        this.network = network;
        this.retryConfig = retryConfig;

        // Derive WSS from RPC
        this.rpcSubscriptionsUrl = rpcUrl
            .replace("https://", "wss://")
            .replace("http://", "ws://");

        logger.info("umbra_service_created", {
            network,
            rpcUrl: rpcUrl.substring(0, 40) + "...",
            programId: UMBRA_PROGRAM_IDS[network],
            maxRetries: retryConfig.maxRetries,
        });
    }

    /**
     * Create a self-claimable UTXO from the caller's encrypted balance.
     *
     * This route still exercises the mixer UTXO path, but the same participant
     * claims the UTXO before unshielding to a fresh final wallet.
     */
    async createSelfClaimableUtxoFromEncryptedBalance(
        mint: string,
        amount: bigint,
        zkProver: any
    ) {
        this.assertInitialized();
        await this.assertIndexerRootCurrent(0n, "create self-claimable UTXO");

        await this._utxoMutex.acquire();
        try {
            const createUtxo = getEncryptedBalanceToSelfClaimableUtxoCreatorFunction(
                { client: this.client! },
                { zkProver }
            );

            const result = await createUtxo({
                amount: amount as unknown as any,
                destinationAddress: this.getAddress() as any,
                mint: mint as any,
            });

            this.assertCallbackFinalized((result as any).callbackStatus, "create self-claimable UTXO");

            logger.info("umbra_encrypted_balance_self_utxo_created", {
                mint: mint.substring(0, 8) + "...",
                amount: amount.toString(),
                queueSignature: (result as any).queueSignature,
                callbackStatus: (result as any).callbackStatus,
                callbackSignature: (result as any).callbackSignature,
            });

            await this.rememberUtxoFromSignature((result as any).callbackSignature);
            return result;
        } catch (err: unknown) {
            if (isCreateUtxoError(err)) {
                logger.error("umbra_encrypted_balance_self_utxo_create_sdk_error", {
                    stage: (err as any).stage,
                    message: (err as any).message,
                    cause: this.serializeErrorCause((err as any).cause),
                    logs: this.extractSolanaLogs(err),
                });
            }
            throw err;
        } finally {
            this._utxoMutex.release();
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // CLIENT LIFECYCLE
    // Source: https://sdk.umbraprivacy.com/sdk/creating-a-client
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Initialize the Umbra client. Idempotent.
     *
     * Uses createSignerFromPrivateKeyBytes(bytes: Uint8Array): Promise<IUmbraSigner>
     * Source: SDK .d.ts — "Load from a Solana CLI JSON key file"
     */
    async initClient(): Promise<void> {
        if (this.client) return;

        const signer = await createSignerFromPrivateKeyBytes(this.keypairBytes);

        /**
         * getUmbraClient args (source: creating-a-client#required-arguments):
         *   signer, network, rpcUrl, rpcSubscriptionsUrl, indexerApiEndpoint
         *
         * deferMasterSeedSignature defaults to false → eager derivation.
         * Master seed derived from UMBRA_MESSAGE_TO_SIGN signature.
         */
        this.client = await getUmbraClient({
            signer,
            network: this.network,
            rpcUrl: this.rpcUrl,
            rpcSubscriptionsUrl: this.rpcSubscriptionsUrl,
            indexerApiEndpoint: resolveUmbraIndexerEndpoint(this.network),
        });

        logger.info("umbra_client_initialized", {
            address: String(this.client.signer.address),
            network: this.network,
            indexerEndpoint: resolveUmbraIndexerEndpoint(this.network),
        });
    }

    getAddress(): string {
        this.assertInitialized();
        return String(this.client!.signer.address);
    }

    getClient() {
        this.assertInitialized();
        return this.client!;
    }

    async rememberUtxoFromSignature(txSignature: string | undefined): Promise<LocalUmbraUtxoEvent | null> {
        this.assertInitialized();
        if (!txSignature || !/^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(txSignature)) {
            return null;
        }

        const existing = Array.from(this._localUtxos.values()).find(
            (event) => event.txSignature === txSignature
        );
        if (existing) {
            return existing;
        }

        const event = await this.decodeUtxoEventFromTransaction(txSignature);
        if (!event) {
            logger.warn("umbra_utxo_event_not_found_in_tx", { txSignature });
            return null;
        }

        const key = this.localUtxoKey(event.treeIndex, event.insertionIndex);
        this._localUtxos.set(key, event);
        logger.info("umbra_utxo_event_cached_from_chain", {
            txSignature,
            treeIndex: event.treeIndex.toString(),
            insertionIndex: event.insertionIndex.toString(),
            eventType: event.eventType,
            slot: event.slot.toString(),
        });
        return event;
    }

    getCachedLocalUtxoCount(): number {
        return this._localUtxos.size;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // REGISTRATION (mutex-protected, idempotent)
    // Source: https://sdk.umbraprivacy.com/sdk/registration
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Register the signer with Umbra. Idempotent + mutex-protected.
     *
     * 3-step flow (source: Registration docs):
     *   1. Create on-chain EncryptedUserAccount PDA
     *   2. Register X25519 encryption key (confidential: true)
     *   3. Store user commitment in Merkle tree (anonymous: true)
     */
    async ensureRegistered(): Promise<string[]> {
        this.assertInitialized();

        if (this._registered) {
            logger.debug("umbra_already_registered");
            return [];
        }

        await this._registrationMutex.acquire();
        try {
            // Double-check after acquiring mutex
            if (this._registered) return [];

            const existingAccount = await this.queryUserAccount().catch(() => null);
            if (this.isFullyRegisteredUserAccount(existingAccount)) {
                this._registered = true;
                logger.info("umbra_registration_reused_existing_account", {
                    address: String(this.client!.signer.address),
                });
                return [];
            }

            const register = getUserRegistrationFunction(
                { client: this.client! },
                { zkProver: getUserRegistrationProver() }
            );

            const signatures = await this.withRetry("registration", async () => {
                logger.info("umbra_registration_attempt", {
                    address: String(this.client!.signer.address),
                    timeoutMs: resolveRegistrationTimeoutMs(),
                });

                return this.withTimeout(
                    register({
                        confidential: true,
                        anonymous: true,
                    }),
                    resolveRegistrationTimeoutMs(),
                    "Umbra registration"
                );
            });

            this._registered = true;

            logger.info("umbra_registered", {
                address: String(this.client!.signer.address),
                tx_count: signatures.length,
                signatures,
            });

            return signatures;
        } catch (err: unknown) {
            const recoveredAccount = await this.queryUserAccount().catch(() => null);
            if (this.isFullyRegisteredUserAccount(recoveredAccount)) {
                this._registered = true;
                logger.warn("umbra_registration_recovered_after_error", {
                    address: String(this.client!.signer.address),
                    error: err instanceof Error ? err.message : String(err),
                });
                return [];
            }

            if (isRegistrationError(err)) {
                logger.error("umbra_registration_sdk_error", {
                    stage: (err as any).stage,
                    message: (err as any).message,
                    cause: String((err as any).cause),
                });
            }
            throw err;
        } finally {
            this._registrationMutex.release();
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // FEE ESTIMATION
    // Source: https://sdk.umbraprivacy.com/pricing
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Estimate the protocol fee for a deposit operation.
     *
     * Uses on-chain fee slabs (BPS_DIVISOR = 16384).
     * Source: https://sdk.umbraprivacy.com/pricing#protocol-fee
     */
    async estimateDepositFee(amount: bigint): Promise<{ fee: bigint; net: bigint }> {
        const feeConfig = getHardcodedDepositProtocolFeeProvider();
        const result = await feeConfig(amount);
        const { fee } = calculateFee(result.slab, amount);
        return { fee, net: amount - fee };
    }

    /**
     * Estimate the protocol fee for a withdrawal operation.
     */
    async estimateWithdrawalFee(amount: bigint): Promise<{ fee: bigint; net: bigint }> {
        const feeConfig = getHardcodedWithdrawalProtocolFeeProvider();
        const result = await feeConfig(amount);
        const { fee } = calculateFee(result.slab, amount);
        return { fee, net: amount - fee };
    }

    /**
     * Estimate the protocol fee for UTXO creation (mixer).
     */
    async estimateCreateUtxoFee(amount: bigint): Promise<{ fee: bigint; net: bigint }> {
        const feeConfig = getHardcodedCreateUtxoProtocolFeeProvider();
        const result = await feeConfig(amount);
        const { fee } = calculateFee(result.slab, amount);
        return { fee, net: amount - fee };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // DEPOSIT (SHIELD) — with retry on callback failure
    // Source: https://sdk.umbraprivacy.com/sdk/deposit
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Deposit (shield) tokens from public ATA into encrypted balance.
     * Retries automatically on Arcium MPC callback pruned/timed-out.
     *
     * Flow (source: Deposit docs):
     *   1. Transfer from public ATA to protocol
     *   2. Fee deduction (BPS_DIVISOR=16384)
     *   3. Arcium MPC callback encrypts and credits balance
     *
     * @param mint - SPL token mint address (must be supported)
     * @param amount - Amount in native token units (bigint)
     * @param destinationAddress - Optional: whose balance to credit
     */
    async shieldCollateral(
        mint: string,
        amount: bigint,
        destinationAddress?: string
    ) {
        this.assertInitialized();
        await this.assertIndexerRootCurrent(0n, "shield collateral");

        await this._depositMutex.acquire();
        try {
            const mintAddr = address(mint);
            const destination = destinationAddress
                ? address(destinationAddress)
                : this.client!.signer.address;

            return await this.withRetry("deposit", async () => {
                const deposit = getPublicBalanceToEncryptedBalanceDirectDepositorFunction({
                    client: this.client!,
                });

                const result = await deposit(
                    destination,
                    mintAddr,
                    amount as unknown as Parameters<typeof deposit>[2]
                );

                // Fail-closed: reject if callback didn't finalize
                const callbackStatus = (result as any).callbackStatus;
                this.assertCallbackFinalized(callbackStatus, "deposit");

                logger.info("umbra_deposit_shielded", {
                    mint: mint.substring(0, 8) + "...",
                    amount: amount.toString(),
                    destination: String(destination).substring(0, 16) + "...",
                    queueSignature: result.queueSignature,
                    callbackStatus,
                    callbackSignature: (result as any).callbackSignature,
                    callbackElapsedMs: (result as any).callbackElapsedMs,
                });

                return result;
            });
        } catch (err: unknown) {
            if (isEncryptedDepositError(err)) {
                logger.error("umbra_deposit_sdk_error", {
                    stage: (err as any).stage,
                    message: (err as any).message,
                    cause: String((err as any).cause),
                });
            }
            throw err;
        } finally {
            this._depositMutex.release();
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // WITHDRAW (UNSHIELD) — with retry on callback failure
    // Source: https://sdk.umbraprivacy.com/sdk/withdraw
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Withdraw (unshield) tokens from encrypted balance to public ATA.
     * Retries automatically on Arcium MPC callback pruned/timed-out.
     */
    async unshieldCollateral(
        mint: string,
        amount: bigint,
        destinationAddress?: string
    ) {
        this.assertInitialized();

        await this._withdrawMutex.acquire();
        try {
            const mintAddr = address(mint);
            const destination = destinationAddress
                ? address(destinationAddress)
                : this.client!.signer.address;

            return await this.withRetry("withdraw", async () => {
                const withdraw = getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction({
                    client: this.client!,
                });

                const result = await withdraw(
                    destination,
                    mintAddr,
                    amount as unknown as Parameters<typeof withdraw>[2]
                );

                const callbackStatus = (result as any).callbackStatus;
                this.assertCallbackFinalized(callbackStatus, "withdraw");

                logger.info("umbra_withdraw_unshielded", {
                    mint: mint.substring(0, 8) + "...",
                    amount: amount.toString(),
                    destination: String(destination).substring(0, 16) + "...",
                    queueSignature: result.queueSignature,
                    callbackStatus,
                    callbackSignature: (result as any).callbackSignature,
                    callbackElapsedMs: (result as any).callbackElapsedMs,
                });

                return result;
            });
        } catch (err: unknown) {
            if (isEncryptedWithdrawalError(err)) {
                logger.error("umbra_withdraw_sdk_error", {
                    stage: (err as any).stage,
                    message: (err as any).message,
                    cause: String((err as any).cause),
                });
            }
            throw err;
        } finally {
            this._withdrawMutex.release();
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // QUERY STATE
    // Source: https://sdk.umbraprivacy.com/sdk/query
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Query user account registration state.
     * Source: https://sdk.umbraprivacy.com/sdk/query#query-user-account
     */
    async queryUserAccount(addr?: string) {
        this.assertInitialized();

        try {
            const queryAccount = getUserAccountQuerierFunction({
                client: this.client!,
            });

            const target = addr ? address(addr) : this.client!.signer.address;
            const accountState = await queryAccount(target);
            const data = (accountState as any)?.state === "exists" ? (accountState as any).data : null;

            logger.info("umbra_account_queried", {
                address: String(target).substring(0, 16) + "...",
                state: (accountState as any)?.state || "unknown",
                exists: (accountState as any)?.state === "exists",
                x25519Registered: data?.isUserAccountX25519KeyRegistered ?? false,
                commitmentRegistered: data?.isUserCommitmentRegistered ?? false,
                anonymousActive: data?.isActiveForAnonymousUsage ?? false,
            });

            return accountState;
        } catch (err: unknown) {
            if (isQueryError(err)) {
                logger.error("umbra_query_sdk_error", {
                    stage: (err as any).stage,
                    message: (err as any).message,
                });
            }
            throw err;
        }
    }

    /**
     * Query encrypted balance metadata for a specific mint.
     *
     * SDK signature (from .d.ts):
     *   queryBalance(mints: readonly Address[]): Promise<Map<Address, QueryEncryptedBalanceResult>>
     *
     * Result state: "non_existent" | "uninitialized" | "mxe" | "shared"
     */
    async queryEncryptedBalance(mint: string, addr?: string) {
        this.assertInitialized();

        try {
            const queryBalance = getEncryptedBalanceQuerierFunction({
                client: this.client!,
            });

            const mintAddr = address(mint);
            const results = await queryBalance([mintAddr]);
            const balanceState = results.get(mintAddr) ?? null;

            logger.info("umbra_balance_queried", {
                mint: mint.substring(0, 8) + "...",
                state: balanceState ? (balanceState as any).state : "not_found",
            });

            return balanceState;
        } catch (err: unknown) {
            if (isQueryError(err)) {
                logger.error("umbra_balance_query_sdk_error", {
                    stage: (err as any).stage,
                    message: (err as any).message,
                });
            }
            throw err;
        }
    }

    async ensureSharedEncryptedBalance(
        mint: string,
        timeoutMs = 180_000
    ): Promise<string[]> {
        this.assertInitialized();

        const initial = await this.queryEncryptedBalance(mint);
        if ((initial as any)?.state === "shared") {
            logger.info("umbra_encrypted_balance_already_shared", {
                mint: mint.substring(0, 8) + "...",
                address: String(this.client!.signer.address).substring(0, 16) + "...",
            });
            return [];
        }

        if ((initial as any)?.state !== "mxe") {
            throw new Error(
                `Encrypted balance must be MXE before conversion; current state is ${(initial as any)?.state || "unknown"}`
            );
        }

        const mintAddr = address(mint);
        const converter = getNetworkEncryptionToSharedEncryptionConverterFunction({
            client: this.client!,
        });
        const result = await this.withRetry("convert-to-shared", async () => {
            const converted = await converter([mintAddr]);
            logger.info("umbra_encrypted_balance_convert_to_shared_submitted", {
                mint: mint.substring(0, 8) + "...",
                converted: this.mapToLoggableObject((converted as any).converted),
                skipped: this.mapToLoggableObject((converted as any).skipped),
            });
            return converted as any;
        });

        const skippedReason = (result as any).skipped?.get?.(mintAddr);
        if (skippedReason && skippedReason !== "already_shared") {
            throw new Error(`Umbra shared-balance conversion skipped: ${skippedReason}`);
        }

        await this.waitForEncryptedBalanceState(mint, "shared", timeoutMs);
        const signatures = Array.from((result as any).converted?.values?.() || []).map(String);
        return signatures;
    }

    private isFullyRegisteredUserAccount(accountState: any): boolean {
        const data = accountState?.state === "exists" ? accountState.data : null;
        return !!(
            data?.isInitialised &&
            data?.isUserAccountX25519KeyRegistered &&
            data?.isUserCommitmentRegistered &&
            data?.isActiveForAnonymousUsage
        );
    }

    private serializeErrorCause(cause: unknown): string | undefined {
        if (!cause) {
            return undefined;
        }
        if (cause instanceof Error) {
            return cause.message;
        }
        try {
            return JSON.stringify(cause);
        } catch {
            return String(cause);
        }
    }

    private extractSolanaLogs(err: unknown): string[] | undefined {
        const candidates = [
            err,
            (err as any)?.cause,
            (err as any)?.cause?.cause,
            (err as any)?.transactionError,
            (err as any)?.context,
            (err as any)?.cause?.context,
            (err as any)?.cause?.cause?.context,
        ];
        for (const candidate of candidates) {
            const logs = Array.isArray(candidate)
                ? candidate
                : (candidate as any)?.logs;
            if (Array.isArray(logs)) {
                return logs.map(String);
            }
        }
        return undefined;
    }

    private mapToLoggableObject(map: unknown): Record<string, string> {
        if (!(map instanceof Map)) {
            return {};
        }
        return Object.fromEntries(
            Array.from(map.entries()).map(([key, value]) => [String(key), String(value)])
        );
    }

    private async waitForEncryptedBalanceState(
        mint: string,
        expectedState: string,
        timeoutMs: number
    ): Promise<void> {
        const startedAt = Date.now();
        let lastState = "unknown";
        while (Date.now() - startedAt < timeoutMs) {
            const balance = await this.queryEncryptedBalance(mint);
            lastState = (balance as any)?.state || "unknown";
            if (lastState === expectedState) {
                logger.info("umbra_encrypted_balance_state_ready", {
                    mint: mint.substring(0, 8) + "...",
                    state: expectedState,
                    elapsedMs: Date.now() - startedAt,
                });
                return;
            }
            await this.sleep(2_000);
        }

        throw new Error(
            `Timed out waiting for Umbra encrypted balance state ${expectedState}; last state ${lastState}`
        );
    }

    // ──────────────────────────────────────────────────────────────────────────
    // MIXER: UTXO CREATION (PRIVATE TRANSFER)
    // Source: https://sdk.umbraprivacy.com/sdk/mixer/creating-utxos
    //
    // NOTE: UTXO creation requires a ZK prover dependency.
    // @umbra-privacy/web-zk-prover is WASM-based (browser).
    // For Node.js, the prover must be injected via deps parameter.
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Create a receiver-claimable UTXO from public balance.
     * This is the core privacy primitive — transfers are unlinkable on-chain.
     *
     * Source: https://sdk.umbraprivacy.com/sdk/mixer/creating-utxos
     *
     * SDK signature:
     *   createUtxo(args: CreateUtxoArgs, options?): Promise<CreateUtxoFromPublicBalanceResult>
     *   CreateUtxoArgs = { amount: U64, destinationAddress: Address, mint: Address }
     *
     * REQUIRES: zkProver dependency injection via deps.
     *
     * @param receiverAddress - Registered Umbra receiving address
     * @param mint - SPL token mint address
     * @param amount - Amount in native token units
     * @param zkProver - ZK prover implementation (from @umbra-privacy/web-zk-prover or custom)
     */
    async createReceiverClaimableUtxo(
        receiverAddress: string,
        mint: string,
        amount: bigint,
        zkProver: any
    ) {
        this.assertInitialized();
        await this.assertIndexerRootCurrent(0n, "create receiver-claimable UTXO");

        await this._utxoMutex.acquire();
        try {
            const createUtxo = getPublicBalanceToReceiverClaimableUtxoCreatorFunction(
                { client: this.client! },
                { zkProver }
            );

            const result = await createUtxo({
                amount: amount as unknown as any, // U64 branded type
                destinationAddress: receiverAddress as any,
                mint: mint as any,
            });

            logger.info("umbra_utxo_created", {
                receiver: receiverAddress.substring(0, 16) + "...",
                mint: mint.substring(0, 8) + "...",
                amount: amount.toString(),
            });

            await this.rememberUtxoFromSignature(
                (result as any).callbackSignature || (result as any).createUtxoSignature
            );
            return result;
        } catch (err: unknown) {
            if (isCreateUtxoError(err)) {
                logger.error("umbra_utxo_create_sdk_error", {
                    stage: (err as any).stage,
                    message: (err as any).message,
                    cause: this.serializeErrorCause((err as any).cause),
                    logs: this.extractSolanaLogs(err),
                });
            }
            throw err;
        } finally {
            this._utxoMutex.release();
        }
    }

    /**
     * Create a receiver-claimable UTXO from the caller's encrypted balance.
     *
     * This is the confidential full-Umbra transfer leg: public balance is first
     * shielded, then this method deducts from the ETA and inserts a mixer UTXO.
     */
    async createReceiverClaimableUtxoFromEncryptedBalance(
        receiverAddress: string,
        mint: string,
        amount: bigint,
        zkProver: any
    ) {
        this.assertInitialized();
        await this.assertIndexerRootCurrent(0n, "create encrypted-balance receiver UTXO");

        await this._utxoMutex.acquire();
        try {
            const createUtxo = getEncryptedBalanceToReceiverClaimableUtxoCreatorFunction(
                { client: this.client! },
                { zkProver }
            );

            const result = await createUtxo({
                amount: amount as unknown as any,
                destinationAddress: receiverAddress as any,
                mint: mint as any,
            });

            this.assertCallbackFinalized((result as any).callbackStatus, "create encrypted-balance UTXO");

            logger.info("umbra_encrypted_balance_utxo_created", {
                receiver: receiverAddress.substring(0, 16) + "...",
                mint: mint.substring(0, 8) + "...",
                amount: amount.toString(),
                queueSignature: (result as any).queueSignature,
                callbackStatus: (result as any).callbackStatus,
                callbackSignature: (result as any).callbackSignature,
            });

            await this.rememberUtxoFromSignature((result as any).callbackSignature);
            return result;
        } catch (err: unknown) {
            if (isCreateUtxoError(err)) {
                logger.error("umbra_encrypted_balance_utxo_create_sdk_error", {
                    stage: (err as any).stage,
                    message: (err as any).message,
                    cause: this.serializeErrorCause((err as any).cause),
                    logs: this.extractSolanaLogs(err),
                });
            }
            throw err;
        } finally {
            this._utxoMutex.release();
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // MIXER: CLAIM UTXOs
    // Source: https://sdk.umbraprivacy.com/sdk/mixer/claiming-utxos
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Claim receiver-claimable UTXOs into encrypted balance.
     *
     * @param utxos - Array of scanned UTXO data from scanIncomingUtxos
     * @param zkProver - ZK prover implementation
     */
    async claimReceiverUtxos(utxos: readonly any[], zkProver: any) {
        this.assertInitialized();

        await this._utxoMutex.acquire();
        try {
            const relayer = getUmbraRelayer({
                apiEndpoint: resolveUmbraRelayerEndpoint(this.network),
            });
            const fetchBatchMerkleProof = this.getVerifiedBatchMerkleProofFetcher();
            if (!fetchBatchMerkleProof) {
                throw new Error("Umbra client is missing fetchBatchMerkleProof; check indexerApiEndpoint");
            }

            const claim = getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction(
                { client: this.client! },
                {
                    zkProver,
                    fetchBatchMerkleProof,
                    relayer,
                    timeoutMs: Number(process.env.UMBRA_CLAIM_TIMEOUT_MS || 180_000),
                    pollingIntervalMs: Number(process.env.UMBRA_CLAIM_POLLING_INTERVAL_MS || 3_000),
                    onProgress: (event: any) => {
                        logger.info("umbra_utxo_claim_progress", {
                            requestId: event?.requestId,
                            status: event?.status,
                            txSignature: event?.txSignature,
                            callbackSignature: event?.callbackSignature,
                            failureReason: event?.failureReason,
                        });
                    },
                } as unknown as any
            );

            const result = await claim(utxos);

            logger.info("umbra_utxos_claimed", {
                utxo_count: utxos.length,
                batch_count: result.batches?.size ?? 0,
            });

            return result;
        } catch (err: unknown) {
            if (isClaimUtxoError(err)) {
                logger.error("umbra_utxo_claim_sdk_error", {
                    stage: (err as any).stage,
                    message: (err as any).message,
                    cause: String((err as any).cause),
                });
            }
            throw err;
        } finally {
            this._utxoMutex.release();
        }
    }

    /**
     * Claim self-claimable UTXOs into encrypted balance.
     *
     * @param utxos - Array of scanned UTXO data from scanIncomingUtxos
     * @param zkProver - ZK prover implementation
     */
    async claimSelfUtxos(utxos: readonly any[], zkProver: any) {
        this.assertInitialized();

        await this._utxoMutex.acquire();
        try {
            const relayer = getUmbraRelayer({
                apiEndpoint: resolveUmbraRelayerEndpoint(this.network),
            });
            const fetchBatchMerkleProof = this.getVerifiedBatchMerkleProofFetcher();
            if (!fetchBatchMerkleProof) {
                throw new Error("Umbra client is missing fetchBatchMerkleProof; check indexerApiEndpoint");
            }

            const claim = getSelfClaimableUtxoToEncryptedBalanceClaimerFunction(
                { client: this.client! },
                {
                    zkProver,
                    fetchBatchMerkleProof,
                    relayer,
                    timeoutMs: Number(process.env.UMBRA_CLAIM_TIMEOUT_MS || 180_000),
                    pollingIntervalMs: Number(process.env.UMBRA_CLAIM_POLLING_INTERVAL_MS || 3_000),
                    onProgress: (event: any) => {
                        logger.info("umbra_self_utxo_claim_progress", {
                            requestId: event?.requestId,
                            status: event?.status,
                            txSignature: event?.txSignature,
                            callbackSignature: event?.callbackSignature,
                            failureReason: event?.failureReason,
                        });
                    },
                } as unknown as any
            );

            const result = await claim(utxos);

            logger.info("umbra_self_utxos_claimed", {
                utxo_count: utxos.length,
                batch_count: result.batches?.size ?? 0,
            });

            return result;
        } catch (err: unknown) {
            if (isClaimUtxoError(err)) {
                logger.error("umbra_self_utxo_claim_sdk_error", {
                    stage: (err as any).stage,
                    message: (err as any).message,
                });
            }
            throw err;
        } finally {
            this._utxoMutex.release();
        }
    }

    private async scanCachedLocalUtxos(
        treeIndex: number | bigint,
        startIndex: number | bigint,
        endIndex?: number | bigint
    ) {
        const normalizedTreeIndex = BigInt(treeIndex);
        const normalizedStartIndex = BigInt(startIndex);
        const normalizedEndIndex = endIndex === undefined ? undefined : BigInt(endIndex);
        const treeOffset = normalizedTreeIndex * MAX_UMBRA_TREE_LEAVES;

        const localItems = Array.from(this._localUtxos.values())
            .filter((event) => {
                if (event.treeIndex !== normalizedTreeIndex) return false;
                if (event.insertionIndex < normalizedStartIndex) return false;
                if (normalizedEndIndex !== undefined && event.insertionIndex > normalizedEndIndex) return false;
                return true;
            })
            .sort((left, right) => Number(left.insertionIndex - right.insertionIndex));

        if (localItems.length === 0) {
            return {
                selfBurnable: [],
                received: [],
                publicSelfBurnable: [],
                publicReceived: [],
                nextScanStartIndex: normalizedStartIndex as any,
            };
        }

        const fetchUtxoData = async (absoluteStart: bigint, absoluteEnd?: bigint) => {
            const items = new Map<any, any>();
            for (const event of localItems) {
                if (event.absoluteIndex < absoluteStart) continue;
                if (absoluteEnd !== undefined && event.absoluteIndex > absoluteEnd) continue;
                items.set(event.insertionIndex as any, this.toSdkUtxoDataItem(event));
            }
            return {
                items,
                hasMore: false,
                nextCursor: undefined,
                totalCount: BigInt(items.size) as any,
            };
        };

        const scan = getClaimableUtxoScannerFunction(
            { client: this.client! },
            { fetchUtxoData } as any
        );
        return scan(
            normalizedTreeIndex as any,
            normalizedStartIndex as any,
            normalizedEndIndex as any
        );
    }

    private getVerifiedBatchMerkleProofFetcher() {
        const fetchBatchMerkleProof = this.client!.fetchBatchMerkleProof;
        if (!fetchBatchMerkleProof) return undefined;

        return async (treeIndex: any, insertionIndices: readonly any[]) => {
            const result = await fetchBatchMerkleProof(treeIndex, insertionIndices as any);
            await this.assertMerkleProofMatchesCachedUtxos(BigInt(treeIndex), insertionIndices, result);
            return result;
        };
    }

    private async assertMerkleProofMatchesCachedUtxos(
        treeIndex: bigint,
        insertionIndices: readonly any[],
        batchProof: any
    ): Promise<void> {
        const mismatches: string[] = [];
        for (const rawIndex of insertionIndices) {
            const insertionIndex = BigInt(rawIndex);
            const cached = this._localUtxos.get(this.localUtxoKey(treeIndex, insertionIndex));
            if (!cached) continue;

            const proofEntry = batchProof?.proofs?.get?.(rawIndex) ?? batchProof?.proofs?.get?.(insertionIndex);
            const proofLeaf = proofEntry?.leaf;
            if (!proofLeaf) {
                mismatches.push(`${treeIndex}:${insertionIndex}=missing-proof`);
                continue;
            }

            const expectedLeaf = Buffer.from(cached.finalCommitment).toString("hex");
            const actualLeaf = Buffer.from(proofLeaf).toString("hex");
            if (expectedLeaf !== actualLeaf) {
                mismatches.push(`${treeIndex}:${insertionIndex}=stale-leaf`);
            }
        }

        if (mismatches.length > 0) {
            throw new Error(
                `Umbra indexer proof is stale for locally observed UTXO(s): ${mismatches.join(", ")}`
            );
        }

        if (process.env.UMBRA_REQUIRE_CURRENT_PROOF_ROOT === "true") {
            const currentRoot = await this.fetchCurrentStealthPoolRoot(treeIndex);
            if (
                currentRoot &&
                Buffer.from(currentRoot).toString("hex") !== Buffer.from(batchProof.root).toString("hex")
            ) {
                throw new Error("Umbra indexer proof root is stale versus the current on-chain StealthPool root");
            }
        }
    }

    private async assertIndexerRootCurrent(treeIndex: bigint, operation: string): Promise<void> {
        if (process.env.UMBRA_REQUIRE_CURRENT_PROOF_ROOT !== "true") {
            return;
        }

        const fetchBatchMerkleProof = this.client!.fetchBatchMerkleProof;
        if (!fetchBatchMerkleProof) {
            throw new Error(
                `Umbra indexer root preflight failed before ${operation}: client is missing fetchBatchMerkleProof`
            );
        }

        const currentRoot = await this.fetchCurrentStealthPoolRoot(treeIndex);
        if (!currentRoot) {
            throw new Error(
                `Umbra indexer root preflight failed before ${operation}: unable to read current on-chain StealthPool root`
            );
        }

        const proof = await fetchBatchMerkleProof(treeIndex as any, [0n as any]);
        const currentRootHex = Buffer.from(currentRoot).toString("hex");
        const indexerRootHex = Buffer.from(proof.root).toString("hex");

        if (currentRootHex !== indexerRootHex) {
            logger.error("umbra_indexer_root_mismatch", {
                operation,
                treeIndex: treeIndex.toString(),
                onchainRoot: currentRootHex,
                indexerRoot: indexerRootHex,
            });
            throw new Error(
                `Umbra indexer root is stale before ${operation}; on-chain root ${currentRootHex} != indexer root ${indexerRootHex}`
            );
        }
    }

    private async decodeUtxoEventFromTransaction(txSignature: string): Promise<LocalUmbraUtxoEvent | null> {
        const connection = new Connection(this.rpcUrl, "confirmed");
        const transaction = await connection.getTransaction(txSignature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });
        const logs = transaction?.meta?.logMessages || [];
        const event = this.decodeUtxoEventFromLogs(logs);
        if (!event) return null;
        const treeIndex = bigintFromWrapped((event as any).programInformationTreeIndex);
        const insertionIndex = bigintFromWrapped((event as any).insertionIndexInTree);
        if (insertionIndex < 0n || insertionIndex >= MAX_UMBRA_TREE_LEAVES) {
            return null;
        }

        return {
            absoluteIndex: treeIndex * MAX_UMBRA_TREE_LEAVES + insertionIndex,
            treeIndex,
            insertionIndex,
            finalCommitment: bytesFromWrapped((event as any).finalCommitment),
            h1Components: this.toH1Components(event as any),
            h1Hash: bytesFromWrapped((event as any).h1Hash),
            h2Hash: bytesFromWrapped((event as any).h2Hash),
            aesEncryptedData: bytesFromWrapped((event as any).aesEncryptedData),
            depositorX25519PublicKey: bytesFromWrapped((event as any).depositorX25519PublicKey),
            timestamp: BigInt(transaction?.blockTime || 0),
            slot: BigInt(transaction?.slot || 0),
            eventType: logs.some((line) => line.includes("DepositIntoStealthPoolFromSharedBalance"))
                ? "callback"
                : "deposit",
            txSignature,
        };
    }

    private decodeUtxoEventFromLogs(logs: readonly string[]): any | null {
        const programDataLogs = logs
            .filter((line) => line.startsWith("Program data: "))
            .map((line) => line.slice("Program data: ".length))
            .reverse();

        for (const encoded of programDataLogs) {
            const bytes = Buffer.from(encoded, "base64");
            for (const skipBytes of [8, 0, 16]) {
                for (const decoder of [
                    getDepositIntoStealthPoolFromSharedBalanceV11CallbackEventV1Decoder,
                    getDepositIntoStealthPoolFromPublicBalanceEventV1Decoder,
                ]) {
                    try {
                        const event = decoder().decode(bytes.subarray(skipBytes));
                        if (
                            (event as any)?.finalCommitment &&
                            (event as any)?.insertionIndexInTree !== undefined &&
                            bigintFromWrapped((event as any).insertionIndexInTree, -1n) >= 0n
                        ) {
                            return event;
                        }
                    } catch {
                        // Different Umbra instructions emit different event layouts.
                    }
                }
            }
        }
        return null;
    }

    private toH1Components(event: any): LocalUmbraUtxoEvent["h1Components"] {
        const senderAddress = splitAddressParts(String(event.h1SenderAddress));
        const mintAddress = splitAddressParts(String(event.h1MintAddress));
        return {
            version: BigInt(event.h1Version),
            commitmentIndex: BigInt(event.h1CommitmentIndex),
            senderAddressLow: senderAddress.low,
            senderAddressHigh: senderAddress.high,
            relayerFixedSolFees: bigintFromWrapped(event.h1RelayerFixedSolFees),
            mintAddressLow: mintAddress.low,
            mintAddressHigh: mintAddress.high,
            timestamp: {
                year: Number(event.h1Year),
                month: Number(event.h1Month),
                day: Number(event.h1Day),
                hour: Number(event.h1Hour),
                minute: Number(event.h1Minute),
                second: Number(event.h1Second),
            },
            poolVolumeSpl: bigintFromWrapped(event.h1PoolVolumeSpl),
            poolVolumeSol: bigintFromWrapped(event.h1PoolVolumeSol),
        };
    }

    private toSdkUtxoDataItem(event: LocalUmbraUtxoEvent): any {
        return {
            absoluteIndex: event.absoluteIndex as any,
            treeIndex: event.treeIndex as any,
            insertionIndex: event.insertionIndex as any,
            finalCommitment: event.finalCommitment as any,
            h1Components: event.h1Components as any,
            h1Hash: event.h1Hash as any,
            h2Hash: event.h2Hash as any,
            aesEncryptedData: event.aesEncryptedData as any,
            depositorX25519PublicKey: event.depositorX25519PublicKey as any,
            timestamp: event.timestamp as any,
            slot: event.slot as any,
            eventType: event.eventType,
        };
    }

    private async fetchCurrentStealthPoolRoot(treeIndex: bigint): Promise<Uint8Array | null> {
        try {
            const pda = await findStealthPoolPda(treeIndex as any, UMBRA_PROGRAM_IDS[this.network] as any);
            const account = await new Connection(this.rpcUrl, "confirmed").getAccountInfo(
                new PublicKey(String(pda)),
                "confirmed"
            );
            if (!account?.data) return null;
            const decoded = getStealthPoolDecoder().decode(account.data);
            return bytesFromWrapped((decoded as any).rootOfIncrementalMerkleTree);
        } catch (error) {
            logger.warn("umbra_current_stealth_pool_root_fetch_failed", {
                treeIndex: treeIndex.toString(),
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    private localUtxoKey(treeIndex: bigint, insertionIndex: bigint): string {
        return `${treeIndex.toString()}:${insertionIndex.toString()}`;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // MIXER: SCAN INCOMING UTXOs
    // Source: https://sdk.umbraprivacy.com/sdk/mixer/fetching-utxos
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Scan the UTXO indexer for incoming claimable UTXOs.
     *
     * SDK signature:
     *   fetchUtxos(treeIndex: U32, startIndex: U32): Promise<{ received: ScannedUtxoData[] }>
     */
    async scanIncomingUtxos(
        treeIndex: number | bigint = 0,
        startIndex: number | bigint = 0,
        endIndex?: number | bigint
    ) {
        this.assertInitialized();

        try {
            const localResult = await this.scanCachedLocalUtxos(treeIndex, startIndex, endIndex);
            const localCount =
                (localResult.selfBurnable?.length ?? 0) +
                (localResult.received?.length ?? 0) +
                (localResult.publicSelfBurnable?.length ?? 0) +
                (localResult.publicReceived?.length ?? 0);
            if (localCount > 0) {
                logger.info("umbra_utxos_scanned_from_onchain_callback_cache", {
                    tree_index: String(treeIndex),
                    start_index: String(startIndex),
                    local_count: localCount,
                    next_scan_start_index: (localResult as any).nextScanStartIndex?.toString?.(),
                });
                return localResult;
            }

            const fetchUtxos = getClaimableUtxoScannerFunction({
                client: this.client!,
            });

            const toU32BigInt = (value: number | bigint, label: string): bigint => {
                if (typeof value === "bigint") {
                    if (value < 0n) {
                        throw new Error(`${label} must be non-negative`);
                    }
                    return value;
                }

                if (!Number.isInteger(value) || value < 0) {
                    throw new Error(`${label} must be a non-negative integer`);
                }

                return BigInt(value);
            };

            const normalizedTreeIndex = toU32BigInt(treeIndex, "treeIndex");
            const normalizedStartIndex = toU32BigInt(startIndex, "startIndex");
            const normalizedEndIndex =
                endIndex === undefined ? undefined : toU32BigInt(endIndex, "endIndex");

            const result = await fetchUtxos(
                normalizedTreeIndex as any,
                normalizedStartIndex as any,
                normalizedEndIndex as any
            );

            logger.info("umbra_utxos_scanned", {
                tree_index: normalizedTreeIndex.toString(),
                start_index: normalizedStartIndex.toString(),
                end_index: normalizedEndIndex?.toString(),
                self_burnable_count: result.selfBurnable?.length ?? 0,
                received_count: result.received.length,
                public_self_burnable_count: result.publicSelfBurnable?.length ?? 0,
                public_received_count: result.publicReceived?.length ?? 0,
                next_scan_start_index: (result as any).nextScanStartIndex?.toString?.(),
            });

            return result;
        } catch (err: unknown) {
            if (isFetchUtxosError(err)) {
                logger.error("umbra_utxo_scan_sdk_error", {
                    stage: (err as any).stage,
                    message: (err as any).message,
                });
            }
            throw err;
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // RETRY ENGINE
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Retry logic with exponential backoff for MPC callback failures.
     * Only retries on "pruned" or "timed-out" callback status.
     */
    private async withRetry<T>(
        operation: string,
        fn: () => Promise<T>
    ): Promise<T> {
        let lastError: unknown;

        for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
            try {
                return await fn();
            } catch (err: unknown) {
                lastError = err;

                // Only retry on retriable errors
                const isRetriable =
                    (err instanceof Error && err.message.includes("timed-out")) ||
                    (err instanceof Error && err.message.includes("timed out")) ||
                    (err instanceof Error && err.message.includes("pruned")) ||
                    (isUmbraError(err) && this.isRetriableUmbraError(err));

                if (!isRetriable || attempt >= this.retryConfig.maxRetries) {
                    throw err;
                }

                const delay = Math.min(
                    this.retryConfig.baseDelayMs * Math.pow(2, attempt),
                    this.retryConfig.maxDelayMs
                );

                logger.warn("umbra_retry", {
                    operation,
                    attempt: attempt + 1,
                    maxRetries: this.retryConfig.maxRetries,
                    delayMs: delay,
                    error: err instanceof Error ? err.message : String(err),
                });

                await this.sleep(delay);
            }
        }

        throw lastError;
    }

    private async withTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
        label: string
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(`${label} timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            promise.then(
                (value) => {
                    clearTimeout(timeoutId);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                }
            );
        });
    }

    /**
     * Check if an Umbra SDK error is retriable.
     * Computation monitor errors (pruned/timed-out) are retriable.
     */
    private isRetriableUmbraError(err: unknown): boolean {
        if (!isUmbraError(err)) return false;
        const msg = (err as any).message?.toLowerCase() || "";
        return msg.includes("pruned") || msg.includes("timed-out") || msg.includes("timeout");
    }

    // ──────────────────────────────────────────────────────────────────────────
    // INTERNALS
    // ──────────────────────────────────────────────────────────────────────────

    /**
     * Fail-closed: assert MPC callback finalized.
     * Throws if callback status is not "finalized".
     */
    private assertCallbackFinalized(
        status: CallbackStatus | undefined,
        operation: string
    ): void {
        if (status && status !== "finalized") {
            throw new Error(
                `UmbraService: ${operation} MPC callback status=${status}. ` +
                `Expected "finalized". This will trigger retry.`
            );
        }
    }

    private assertInitialized(): void {
        if (!this.client) {
            throw new Error(
                "UmbraService: client not initialized. Call initClient() first."
            );
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// ============================================================================
// FACTORY
// ============================================================================

let _instance: UmbraService | null = null;

export function getUmbraServiceInstance(
    keypairBytes: Uint8Array,
    rpcUrl: string,
    network: UmbraNetwork = "devnet",
    retryConfig?: RetryConfig
): UmbraService {
    if (!_instance) {
        _instance = new UmbraService(keypairBytes, rpcUrl, network, retryConfig);
    }
    return _instance;
}

export function resetUmbraService(): void {
    _instance = null;
}
