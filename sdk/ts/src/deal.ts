import { EventEmitter } from 'events';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    createSyncNativeInstruction,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Program, Idl, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { ApiClient } from './api';
import { WsManager } from './ws';
import { TimeoutError, PhaseViolationError, OnChainExecutionError } from './errors';
import {
    CompletePrivateAgreementOptions,
    ConfidentialFundingRequestEnvelope,
    DealStatusData,
    DirectMessage,
    EncryptedDeliveryOptions,
    PrivateAgreementTermsInput,
    ReleaseApprovalRequestEnvelope,
    RollupTerms,
    WaitForFundingRequestOptions,
    WaitForReleaseRequestOptions,
} from './types';
import { DMClient } from './dm';
import idlRaw from './idl/escrow.json';
import { MeridianClient } from '../../../middleman-agent/agents/sdk/MeridianClient';

const ESCROW_PROGRAM_ID = new PublicKey((idlRaw as any).address || (idlRaw as any).metadata?.address || "Hp6RbB21KrKQEaKvqAZPLHYYVDFKNJaiRtzE1494dpmx");

function solToLamports(amountSol: number): bigint {
    const text = String(amountSol);
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
        throw new Error('SOL amount must be a plain non-negative decimal value');
    }
    const [whole, fraction = ''] = text.split('.');
    if (fraction.length > 9) {
        throw new Error('SOL amount has more than 9 decimals');
    }
    return BigInt(`${whole}${fraction.padEnd(9, '0')}`.replace(/^0+(?=\d)/, '') || '0');
}



export class Deal extends EventEmitter {
    public readonly id: string;
    private api: ApiClient;
    private ws: WsManager;
    private live: MeridianClient;
    private dm: DMClient;
    private rpcUrl: string;
    private keypair: Keypair;
    private privateMode: boolean;
    private strictOpaquePerMode: boolean;

    // Internal state cache to handle phase violations locally before network hops
    private currentPhase: string = 'created';
    private escrowAddress: string | null = null;

    constructor(
        ticketId: string,
        api: ApiClient,
        ws: WsManager,
        live: MeridianClient,
        dm: DMClient,
        rpcUrl: string,
        keypair: Keypair,
        privateMode: boolean = false,
        strictOpaquePerMode: boolean = true
    ) {
        super();
        this.id = ticketId;
        this.api = api;
        this.ws = ws;
        this.live = live;
        this.dm = dm;
        this.rpcUrl = rpcUrl;
        this.keypair = keypair;
        this.privateMode = privateMode;
        this.strictOpaquePerMode = strictOpaquePerMode;

        this.setupWsListeners();
        this.setupLiveListeners();
    }

    private isStrictOpaquePerMode(): boolean {
        return this.privateMode && this.strictOpaquePerMode !== false;
    }

    private setupWsListeners() {
        this.ws.on('message', (msg: any) => {
            // Filter out messages not related to this ticket
            if (msg.ticket_id !== this.id && msg.payload?.ticket_id !== this.id) return;

            const phase = msg.phase || msg.payload?.phase || msg.payload?.to_phase;
            const content = msg.content || msg.payload?.content || '';

            // Emit raw messages for negotiation
            if (msg.type === 'middleman_message' || msg.event_type === 'middleman_message' || msg.type === 'message') {
                this.emit('message_received', { sender: msg.role || 'system', content, phase });
            }

            // Stateful Phase Changes
            if (msg.event_type === 'phase_changed' || phase) {
                if (phase && phase !== this.currentPhase) {
                    this.currentPhase = phase;
                    this.emit('phase_changed', phase);
                }
            }

            // Address Capture
            const addr = msg.escrowAddress || msg.dealId || msg.payload?.dealId || this.extractAddress(content);
            if (addr && addr !== this.escrowAddress) {
                this.escrowAddress = addr;
                this.emit('escrow_ready', addr);
            }
        });
    }

    private setupLiveListeners() {
        this.live.on('rollup_session_ready', (payload: any) => {
            if (payload?.ticketId !== this.id) return;
            this.emit('rollup_session_ready', payload);
        });

        this.live.on('confidential_funding_request', (request: ConfidentialFundingRequestEnvelope) => {
            if (request?.ticketId !== this.id) return;
            this.emit('confidential_funding_request', request);
        });

        this.live.on('release_approval_request', (request: ReleaseApprovalRequestEnvelope) => {
            if (request?.ticketId !== this.id) return;
            this.emit('release_approval_request', request);
        });

        this.live.on('umbra_lifecycle_request', (request: any) => {
            if (request?.ticketId !== this.id) return;
            this.emit('umbra_lifecycle_request', request);
        });

        this.live.on('phase_changed', (update: any) => {
            if (update?.ticketId !== this.id) return;
            const phase = update.phase || update.payload?.phase || update.payload?.to_phase;
            if (phase && phase !== this.currentPhase) {
                this.currentPhase = phase;
                this.emit('phase_changed', phase);
            }
        });

        this.live.on('message', (content: string, phase: string) => {
            if (this.live.getCurrentTicketId() !== this.id) return;
            this.emit('message_received', { sender: 'system', content, phase });
        });

        this.live.on('deal_complete', (ticketId: string) => {
            if (ticketId !== this.id) return;
            this.currentPhase = 'completed';
            this.emit('phase_changed', 'completed');
            this.emit('deal_complete', ticketId);
        });
    }

    private extractAddress(text: string): string | null {
        if (!text) return null;
        const m = text.match(/`([1-9A-HJ-NP-Za-km-z]{32,44})`/) ||
            text.match(/\\*\\*([1-9A-HJ-NP-Za-km-z]{32,44})\\*\\*/) ||
            text.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
        return m ? m[1] : null;
    }

    // --- Developer API ---

    /** Get the current synchronized status from the API. */
    public async refreshStatus(): Promise<DealStatusData> {
        const status = await this.api.getDealStatus(this.id);
        this.currentPhase = status.phase;
        if (status.escrowAddress) this.escrowAddress = status.escrowAddress;
        return status;
    }

    private async ensureEscrowAddress(timeoutMs = 90_000): Promise<string> {
        if (this.escrowAddress) return this.escrowAddress;

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const status = await this.refreshStatus();
            if (status.escrowAddress) return status.escrowAddress;
            await this.sleep(1_000);
        }

        throw new PhaseViolationError("Escrow address not assigned yet.", this.currentPhase, "escrow_created");
    }

    /** Helper to block execution until a target phase is reached via WS events OR REST polling */
    public waitForPhase(targetPhase: string | string[], options?: { timeoutMs?: number; pollIntervalMs?: number }): Promise<void> {
        const targets = Array.isArray(targetPhase) ? targetPhase : [targetPhase];
        const pollInterval = options?.pollIntervalMs ?? 5000;

        return new Promise((resolve, reject) => {
            if (targets.includes(this.currentPhase)) {
                resolve();
                return;
            }

            let timeoutId: NodeJS.Timeout;
            let pollId: NodeJS.Timeout;
            let settled = false;

            const cleanup = () => {
                if (settled) return;
                settled = true;
                super.removeListener('phase_changed', listener);
                if (timeoutId) clearTimeout(timeoutId);
                if (pollId) clearInterval(pollId);
            };

            // Path 1: WebSocket events (instant, if WS is connected)
            const listener = (phase: string) => {
                if (targets.includes(phase)) {
                    cleanup();
                    resolve();
                }
            };
            this.on('phase_changed', listener);

            // Path 2: REST polling fallback (resilient, always works)
            pollId = setInterval(async () => {
                if (settled) return;
                try {
                    const status = await this.refreshStatus();
                    if (targets.includes(status.phase)) {
                        cleanup();
                        resolve();
                    }
                } catch {
                    // Poll failed — WS may catch it, or next poll will retry
                }
            }, pollInterval);

            // Timeout guard
            if (options?.timeoutMs) {
                timeoutId = setTimeout(() => {
                    cleanup();
                    reject(new TimeoutError(`Waiting for phase ${targets.join(' or ')} timed out.`, options.timeoutMs!, targets.join(',')));
                }, options.timeoutMs);
            }
        });
    }

    /** Send a negotiation message directly into the deal context. */
    public async sendMessage(content: string): Promise<void> {
        this.live.subscribeToTicket(this.id);
        this.live.sendMessage(this.id, content);
    }

    /** Wait for the PER / rollup session to become ready for this deal. */
    public async waitForRollupSessionReady(timeoutMs = 120_000): Promise<{ ticketId: string; rollupMode: 'ER' | 'PER' }> {
        this.live.subscribeToTicket(this.id);
        return this.live.waitForRollupSessionReady(this.id, timeoutMs);
    }

    /** Complete the private agreement flow without exposing price/collateral in plaintext chat. */
    public async completePrivateAgreement(
        terms: PrivateAgreementTermsInput | RollupTerms,
        options: CompletePrivateAgreementOptions = {}
    ): Promise<void> {
        this.live.subscribeToTicket(this.id);
        await this.live.completePrivateAgreement(this.id, terms as any, options as any);
    }

    /** Return the pending confidential funding request, if the server has issued one. */
    public getFundingRequest(): ConfidentialFundingRequestEnvelope | null {
        return this.live.getFundingRequest(this.id) as ConfidentialFundingRequestEnvelope | null;
    }

    /** Wait for the confidential funding request that gates the PER funding step. */
    public async waitForFundingRequest(
        options: WaitForFundingRequestOptions = {}
    ): Promise<ConfidentialFundingRequestEnvelope> {
        this.live.subscribeToTicket(this.id);
        return this.live.waitForFundingRequest(this.id, options as any) as Promise<ConfidentialFundingRequestEnvelope>;
    }

    /** Auto-fund the confidential deal using the fresh per-deal funding wallet. */
    public async autoFundPrivateDeal(options: WaitForFundingRequestOptions = {}): Promise<void> {
        this.live.subscribeToTicket(this.id);
        await this.live.autoFundPrivateDeal(this.id, options as any);
    }

    /** Return the latest signed release request envelope, if one exists. */
    public getReleaseRequest(): ReleaseApprovalRequestEnvelope | null {
        return this.live.getReleaseRequest(this.id) as ReleaseApprovalRequestEnvelope | null;
    }

    /** Wait for a signed release request on this ticket. */
    public async waitForReleaseRequest(
        options: WaitForReleaseRequestOptions = {}
    ): Promise<ReleaseApprovalRequestEnvelope> {
        this.live.subscribeToTicket(this.id);
        return this.live.waitForReleaseRequest(this.id, options as any) as Promise<ReleaseApprovalRequestEnvelope>;
    }

    /** Confirm private delivery through the signed release-approval flow. */
    public async confirmPrivateDelivery(
        options: WaitForReleaseRequestOptions = {}
    ): Promise<void> {
        this.live.subscribeToTicket(this.id);
        await this.live.confirmPrivateDelivery(this.id, options as any);
    }

    /** Wait for a full-Umbra lifecycle task when the server is in FULL_UMBRA mode. */
    public async waitForUmbraLifecycleRequest(options: { timeoutMs?: number } = {}): Promise<any> {
        this.live.subscribeToTicket(this.id);
        return this.live.waitForUmbraLifecycleRequest(this.id, options.timeoutMs ?? 120_000);
    }

    /** Submit real Umbra lifecycle transaction evidence. Fake SDK fallback signatures are rejected. */
    public submitUmbraLifecycleEvidence(input: any): void {
        this.live.subscribeToTicket(this.id);
        this.live.submitUmbraLifecycleEvidence(this.id, input);
    }

    /** Execute the full Umbra shield -> UTXO -> claim -> unshield lifecycle for this deal. */
    public async autoCompleteUmbraLifecycle(options: {
        timeoutMs?: number;
        amountLamports?: string | bigint | number;
        scanAttempts?: number;
        scanDelayMs?: number;
    } = {}): Promise<any> {
        this.live.subscribeToTicket(this.id);
        return this.live.autoCompleteUmbraLifecycle(this.id, options);
    }

    /** Send the delivery payload over E2E encrypted DM instead of plaintext ticket chat. */
    public async sendEncryptedDelivery(
        content: string,
        options: EncryptedDeliveryOptions = {}
    ): Promise<DirectMessage> {
        const toWallet = await this.resolveCounterpartyWallet();
        await this.dm.publishEncryptionKey().catch(() => undefined);
        const sent = await this.dm.sendCredentials(toWallet, content, {
            ticketId: this.id,
            label: options.label,
            expiresAt: options.expiresAt,
        });

        return {
            id: sent.id,
            fromWallet: sent.fromWallet,
            toWallet: sent.toWallet,
            content,
            contentType: 'credentials',
            ticketId: sent.ticketId,
            encrypted: sent.encrypted,
            metadata: options.label ? JSON.stringify({ label: options.label }) : null,
            readAt: null,
            expiresAt: options.expiresAt || null,
            createdAt: sent.createdAt,
        };
    }

    /** Poll the encrypted DM channel for a delivery payload linked to this deal. */
    public async waitForEncryptedDelivery(options?: {
        timeoutMs?: number;
        pollIntervalMs?: number;
        fromWallet?: string;
        markRead?: boolean;
    }): Promise<DirectMessage> {
        const timeoutMs = options?.timeoutMs ?? 120_000;
        const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
        const fromWallet = options?.fromWallet ?? await this.resolveCounterpartyWallet();
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const messages = await this.dm.dealMessages(this.id);
            const candidate = messages
                .filter((message) => message.fromWallet === fromWallet)
                .filter((message) => message.encrypted)
                .filter((message) => message.contentType === 'credentials' || message.contentType === 'api_key' || message.contentType === 'url' || message.contentType === 'text')
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

            if (candidate) {
                if (options?.markRead !== false) {
                    await this.dm.markRead(candidate.id).catch(() => undefined);
                }
                this.emit('encrypted_delivery_received', candidate);
                return candidate;
            }

            await this.sleep(pollIntervalMs);
        }

        throw new TimeoutError(
            `Waiting for encrypted delivery on deal ${this.id} timed out.`,
            timeoutMs,
            'encrypted_delivery'
        );
    }

    /** Trigger the secure on-chain SOL deposit to the Escrow Address with idempotency via Smart Contract IDL. */
    public async depositToEscrow(amountSol: number, role: 'buyer' | 'seller'): Promise<string> {
        const escrowAddress = await this.ensureEscrowAddress();

        const connection = new Connection(this.rpcUrl, 'confirmed');
        const targetPubKey = new PublicKey(escrowAddress);

        // Execute Anchor Instruction with correct SPL token accounts
        try {
            const provider = new AnchorProvider(connection, new Wallet(this.keypair), { commitment: "confirmed" });
            const program = new Program(idlRaw as Idl, provider);
            const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ESCROW_PROGRAM_ID);
            const onChainDeal = await (program.account as any).deal.fetch(targetPubKey).catch(() => null);
            if (onChainDeal) {
                if (role === 'buyer' && ['escrow_created', 'awaiting_deposits'].includes(this.currentPhase) && onChainDeal.buyerCollateralLocked) {
                    return 'idempotent-skip:buyer-collateral';
                }
                if (role === 'seller' && ['escrow_created', 'awaiting_deposits'].includes(this.currentPhase) && onChainDeal.sellerCollateralLocked) {
                    return 'idempotent-skip:seller-collateral';
                }
                if (role === 'buyer' && this.currentPhase === 'delivery' && onChainDeal.paymentLocked) {
                    return 'idempotent-skip:buyer-payment';
                }
            }
            const mint = NATIVE_MINT;
            const dealAta = getAssociatedTokenAddressSync(mint, targetPubKey, true);
            const userAta = getAssociatedTokenAddressSync(mint, this.keypair.publicKey);
            const depositLamports = solToLamports(amountSol);

            let wrappedBalance = 0n;
            try {
                wrappedBalance = BigInt((await connection.getTokenAccountBalance(userAta)).value.amount);
            } catch {
                wrappedBalance = 0n;
            }

            const preInstructions = [
                createAssociatedTokenAccountIdempotentInstruction(this.keypair.publicKey, userAta, this.keypair.publicKey, mint),
                createAssociatedTokenAccountIdempotentInstruction(this.keypair.publicKey, dealAta, targetPubKey, mint),
            ];

            if (wrappedBalance < depositLamports) {
                preInstructions.push(
                    SystemProgram.transfer({
                        fromPubkey: this.keypair.publicKey,
                        toPubkey: userAta,
                        lamports: Number(depositLamports - wrappedBalance),
                    }),
                    createSyncNativeInstruction(userAta),
                );
            }

            let sig: string;

            if (['escrow_created', 'awaiting_deposits'].includes(this.currentPhase)) {
                // Lock collateral phase
                sig = await program.methods.lockCollateral()
                    .accounts({
                        deal: targetPubKey,
                        user: this.keypair.publicKey,
                        config: configPda,
                        dealAta,
                        userAta,
                        systemProgram: SystemProgram.programId,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .preInstructions(preInstructions)
                    .signers([this.keypair])
                    .rpc();
            } else if (this.currentPhase === 'delivery') {
                // Lock payment phase (buyer only)
                if (role !== 'buyer') throw new PhaseViolationError("Only the buyer can lock payment", this.currentPhase, "buyer");
                sig = await program.methods.lockPayment()
                    .accounts({
                        deal: targetPubKey,
                        buyer: this.keypair.publicKey,
                        config: configPda,
                        dealAta,
                        buyerAta: userAta,
                        systemProgram: SystemProgram.programId,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .preInstructions(preInstructions)
                    .signers([this.keypair])
                    .rpc();
            } else {
                throw new PhaseViolationError("Cannot deposit in current phase", this.currentPhase, "escrow_created or delivery");
            }

            // Notify Middleman natively
            this.ws.send({
                version: "1.0",
                type: 'deposit_confirmed',
                ticket_id: this.id,
                role: role
            });

            return sig;
        } catch (e: any) {
            if (e instanceof PhaseViolationError) throw e;
            throw new OnChainExecutionError(`Failed processing Anchor Smart Contract instruction: ${e.message}`);
        }
    }

    /** Complete the deal by acknowledging receipt. */
    public async confirmDelivery(): Promise<void> {
        if (this.isStrictOpaquePerMode()) {
            throw new PhaseViolationError(
                "Strict opaque PER mode requires the signed release-approval protocol; confirmDelivery chat fallback is disabled.",
                this.currentPhase,
                "signed_release_approval"
            );
        }
        await this.api.sendMessage(this.id, "@middleman I received the credentials. You can release the funds now.");
    }

    // ─── USDC / SPL Token Deposits ──────────────────────────

    /**
     * Deposit USDC (or any SPL token) to the escrow PDA.
     * Uses a direct SPL token transfer to the deal PDA's Associated Token Account.
     * The Middleman's deposit watcher detects the balance change and calls confirm_deposit.
     *
     * @param amount - Amount in token units (e.g. 500 for 500 USDC)
     * @param role - 'buyer' or 'seller'
     * @param tokenMint - SPL token mint address (defaults to USDC on mainnet)
     * @param decimals - Token decimal places (defaults to 6 for USDC)
     *
     * @example
     * // Pay 500 USDC into escrow
     * const sig = await deal.depositUSDC(500, 'buyer');
     *
     * @example
     * // Pay with custom SPL token
     * const sig = await deal.depositUSDC(1000, 'buyer', 'Es9vMFrzaCE...', 6);
     */
    public async depositUSDC(
        amount: number,
        role: 'buyer' | 'seller',
        tokenMint?: string,
        decimals: number = 6
    ): Promise<string> {
        if (!this.escrowAddress) {
            await this.refreshStatus();
            if (!this.escrowAddress) {
                throw new PhaseViolationError("Escrow address not assigned yet.", this.currentPhase, "escrow_created");
            }
        }

        // USDC mint addresses per network
        const USDC_MINTS: Record<string, string> = {
            mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Devnet USDC
        };

        const mint = new PublicKey(tokenMint || USDC_MINTS.devnet);
        const dealPda = new PublicKey(this.escrowAddress);
        const connection = new Connection(this.rpcUrl, 'confirmed');

        // Import SPL token functions
        const { createTransferInstruction, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');

        // Get token accounts
        const userAta = getAssociatedTokenAddressSync(mint, this.keypair.publicKey);
        const dealAta = getAssociatedTokenAddressSync(mint, dealPda, true); // allowOwnerOffCurve for PDA

        // IDEMPOTENCY CHECK: verify we haven't already transferred
        try {
            const dealAtaInfo = await connection.getTokenAccountBalance(dealAta);
            const currentBalance = Number(dealAtaInfo.value.amount) / Math.pow(10, decimals);
            if (currentBalance >= amount) {
                console.log(`[AgentOTC] USDC idempotency: deal ATA already has ${currentBalance} tokens`);
                return 'idempotent-skip';
            }
        } catch {
            // ATA doesn't exist yet — that's fine, we'll create it
        }

        const amountRaw = BigInt(Math.round(amount * Math.pow(10, decimals)));

        // Build transaction
        const { Transaction } = await import('@solana/web3.js');
        const tx = new Transaction();

        // Create the deal PDA's ATA if it doesn't exist (idempotent)
        tx.add(
            createAssociatedTokenAccountIdempotentInstruction(
                this.keypair.publicKey, // payer
                dealAta,                // ATA to create
                dealPda,                // owner (the deal PDA)
                mint                    // token mint
            )
        );

        // Transfer tokens
        tx.add(
            createTransferInstruction(
                userAta,                 // from
                dealAta,                 // to
                this.keypair.publicKey,   // authority
                amountRaw               // amount in raw units
            )
        );

        const { sendAndConfirmTransaction } = await import('@solana/web3.js');
        const sig = await sendAndConfirmTransaction(connection, tx, [this.keypair], {
            commitment: 'confirmed',
        });

        // Notify Middleman
        this.ws.send({
            version: "1.0",
            type: 'deposit_confirmed',
            ticket_id: this.id,
            role,
            token: tokenMint || 'USDC',
            amount,
        });

        return sig;
    }

    // ─── Safety Escapes ──────────────────────────────────────

    /**
     * Claim a timeout refund if the Middleman has gone offline or the deal expired.
     * This is the TRUSTLESS SAFETY NET — agents can ALWAYS recover their funds
     * after the timeout period, even if the Middleman disappears.
     *
     * The Anchor program verifies:
     *   1. Caller is buyer, seller, or middleman
     *   2. Deal is NOT in a terminal state (completed/cancelled/refunded)
     *   3. Current timestamp > deal.created_at + deal.timeout
     *
     * @returns Transaction signature
     *
     * @example
     * // Middleman went offline — recover funds after timeout
     * try {
     *     const sig = await deal.claimTimeoutRefund();
     *     console.log('Funds recovered:', sig);
     * } catch (e) {
     *     console.log('Timeout not reached yet or deal already completed');
     * }
     */
    public async claimTimeoutRefund(): Promise<string> {
        if (!this.escrowAddress) {
            await this.refreshStatus();
            if (!this.escrowAddress) {
                throw new PhaseViolationError("No escrow to refund.", this.currentPhase, "escrow_created");
            }
        }

        const connection = new Connection(this.rpcUrl, 'confirmed');
        const provider = new AnchorProvider(connection, new Wallet(this.keypair), { commitment: 'confirmed' });
        const program = new Program(idlRaw as Idl, provider);
        const dealPda = new PublicKey(this.escrowAddress);
        const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], ESCROW_PROGRAM_ID);

        // Fetch deal status to get buyer/seller addresses
        const status = await this.refreshStatus();
        if (!status.buyer || !status.seller) {
            throw new OnChainExecutionError('Cannot refund: deal buyer/seller addresses unknown');
        }

        try {
            const sig = await program.methods.refundOnTimeout()
                .accounts({
                    deal: dealPda,
                    caller: this.keypair.publicKey,
                    buyer: new PublicKey(status.buyer),
                    seller: new PublicKey(status.seller),
                    config: configPda,
                    systemProgram: SystemProgram.programId,
                })
                .signers([this.keypair])
                .rpc();

            this.currentPhase = 'refunded';
            this.emit('phase_changed', 'refunded');

            return sig;
        } catch (e: any) {
            throw new OnChainExecutionError(`Timeout refund failed: ${e.message}`);
        }
    }

    /**
     * Cancel the deal on-chain and refund locked funds.
     *
     * Authorization rules (enforced by Anchor program):
     *   - Created status: any participant can cancel
     *   - CollateralLocked: only the Middleman can cancel
     *   - PaymentLocked / terminal states: cannot cancel
     *
     * @returns Transaction signature
     */
    public async cancelDeal(): Promise<string> {
        if (!this.escrowAddress) {
            await this.refreshStatus();
            if (!this.escrowAddress) {
                throw new PhaseViolationError("No escrow to cancel.", this.currentPhase, "escrow_created");
            }
        }

        const connection = new Connection(this.rpcUrl, 'confirmed');
        const provider = new AnchorProvider(connection, new Wallet(this.keypair), { commitment: 'confirmed' });
        const program = new Program(idlRaw as Idl, provider);
        const dealPda = new PublicKey(this.escrowAddress);
        const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], ESCROW_PROGRAM_ID);

        const status = await this.refreshStatus();
        if (!status.buyer || !status.seller) {
            throw new OnChainExecutionError('Cannot cancel: deal buyer/seller addresses unknown');
        }

        try {
            const sig = await program.methods.cancelDeal()
                .accounts({
                    deal: dealPda,
                    caller: this.keypair.publicKey,
                    buyer: new PublicKey(status.buyer),
                    seller: new PublicKey(status.seller),
                    config: configPda,
                    systemProgram: SystemProgram.programId,
                })
                .signers([this.keypair])
                .rpc();

            this.currentPhase = 'cancelled';
            this.emit('phase_changed', 'cancelled');

            return sig;
        } catch (e: any) {
            throw new OnChainExecutionError(`Cancel deal failed: ${e.message}`);
        }
    }

    // ─── ZK Privacy Mode ──────────────────────────────────

    /**
     * Commit deal terms as a SHA-256 hash for privacy mode.
     * Returns the commitment including the nonce (SAVE IT for reveal).
     */
    public async commitTerms(terms: {
        price: number;
        collateral_buyer: number;
        collateral_seller: number;
        asset_type: string;
    }): Promise<{ termsHash: string; termsHashBytes: number[]; nonce: string }> {
        if (this.isStrictOpaquePerMode()) {
            throw new OnChainExecutionError(
                "Strict opaque PER mode does not allow plaintext commit/reveal endpoints. Use the private rollup handoff flow instead."
            );
        }
        return this.api.post(`/v1/deals/${this.id}/commit-terms`, terms);
    }

    /**
     * Reveal and verify terms post-settlement.
     * Requires the original nonce from commitTerms().
     */
    public async revealTerms(terms: {
        price: number;
        collateral_buyer: number;
        collateral_seller: number;
        asset_type: string;
    }, nonce: string): Promise<{ verified: boolean }> {
        if (this.isStrictOpaquePerMode()) {
            throw new OnChainExecutionError(
                "Strict opaque PER mode does not allow plaintext commit/reveal endpoints. Use the private rollup handoff flow instead."
            );
        }
        return this.api.post(`/v1/deals/${this.id}/reveal-terms`, { ...terms, nonce });
    }

    /** Check the privacy status of this deal. */
    public async getPrivacyStatus(): Promise<{
        isPrivacyMode: boolean;
        termsHash: string | null;
        termsRevealed: boolean;
        canReveal: boolean;
    }> {
        if (this.isStrictOpaquePerMode()) {
            throw new PhaseViolationError(
                "Strict opaque PER mode does not expose legacy privacy-status endpoints.",
                this.currentPhase,
                "private_rollup_handoff"
            );
        }
        return this.api.get(`/v1/deals/${this.id}/privacy-status`);
    }

    private async resolveCounterpartyWallet(): Promise<string> {
        const status = await this.refreshStatus();
        const ownWallet = this.keypair.publicKey.toBase58();
        const statusBuyer = this.isWalletAddress(status.buyer) ? status.buyer : null;
        const statusSeller = this.isWalletAddress(status.seller) ? status.seller : null;
        if (statusBuyer && statusSeller) {
            if (statusBuyer === ownWallet) return statusSeller;
            if (statusSeller === ownWallet) return statusBuyer;
        }

        const ticket = await this.api.getTicket(this.id).catch(() => null);
        const ticketBuyer = this.isWalletAddress(ticket?.buyer) ? ticket!.buyer : null;
        const ticketSeller = this.isWalletAddress(ticket?.seller) ? ticket!.seller : null;
        if (ticketBuyer && ticketSeller) {
            if (ticketBuyer === ownWallet) return ticketSeller;
            if (ticketSeller === ownWallet) return ticketBuyer;
        }

        throw new OnChainExecutionError(
            `Unable to resolve counterparty wallet for encrypted delivery on ${this.id}`
        );
    }

    private isWalletAddress(value?: string | null): value is string {
        if (!value) {
            return false;
        }
        try {
            new PublicKey(value);
            return true;
        } catch {
            return false;
        }
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
}
