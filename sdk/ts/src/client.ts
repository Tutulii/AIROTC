import { EventEmitter } from 'events';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { AgentOTCConfig, OfferCreationParams, OfferData, RegistrationResult, AgentProfile, WebhookConfig, QuickBuyOptions, QuickBuyResult, DealPhase, AutoApprovalPolicy, WaitForMatchedDealOptions, WebhookEventName } from './types';
import { ApiClient } from './api';
import { WsManager } from './ws';
import { Deal } from './deal';
import { AutoBuyer } from './autopilot';
import { DMClient } from './dm';
import { AgentOTCError, TimeoutError } from './errors';
import { AgentOTCWorkflows } from './workflows';
import { MeridianClient } from '../../../middleman-agent/agents/sdk/MeridianClient';

export class AgentOTC extends EventEmitter {
    private config: AgentOTCConfig;
    private api: ApiClient;
    private ws: WsManager;
    private live: MeridianClient;
    private keypair: Keypair;
    private activeDeals: Map<string, Deal> = new Map();
    private liveConnected = false;
    private matchedDeals: Set<string> = new Set();
    public readonly autoBuyer: AutoBuyer;
    /** Direct Messages — agent-to-agent private messaging for delivery */
    public readonly dm: DMClient;
    /** High-level mode-safe workflows for technical and runtime users */
    public readonly workflows: AgentOTCWorkflows;

    constructor(config: AgentOTCConfig) {
        super();
        this.config = this.normalizeConfig(config);
        this.keypair = Keypair.fromSecretKey(bs58.decode(this.config.walletPrivateKey));

        this.api = new ApiClient(this.config.apiUrl!, {
            apiKey: this.config.apiKey,
            keypair: this.keypair,
        });
        this.ws = new WsManager({ wsUrl: this.config.wsUrl!, apiKey: this.config.apiKey, keypair: this.keypair });
        this.live = new MeridianClient({
            apiUrl: this.config.apiUrl!,
            wsUrl: this.config.wsUrl!,
            keypair: this.keypair,
            rpcUrl: this.config.rpcUrl!,
            privateMode: this.config.privateMode === true,
            strictOpaquePerMode: this.config.strictOpaquePerMode !== false,
            persistLocalState: this.config.persistLocalState === true,
            autoReconnect: true,
        });
        this.autoBuyer = new AutoBuyer(this);
        this.dm = new DMClient(this.api, this.keypair);
        this.workflows = new AgentOTCWorkflows(this);

        this.setupWsGlobalRouting();
        this.setupLiveGlobalRouting();
    }

    private normalizeConfig(config: AgentOTCConfig): AgentOTCConfig {
        const env = config.environment || 'devnet';
        const defaults = {
            devnet: {
                apiUrl: 'https://otc.yourdomain.com/v1',
                wsUrl: 'wss://otc.yourdomain.com/ws',
                rpcUrl: 'https://api.devnet.solana.com'
            },
            mainnet: {
                apiUrl: 'https://api.meridian.com/v1',
                wsUrl: 'wss://api.meridian.com/ws',
                rpcUrl: 'https://api.mainnet-beta.solana.com'
            },
            localnet: {
                apiUrl: 'http://localhost:3000',
                wsUrl: 'ws://localhost:8080',
                rpcUrl: 'http://localhost:8899'
            }
        };

        return {
            ...defaults[env],
            ...config,
            environment: env
        };
    }

    private setupWsGlobalRouting() {
        this.ws.on('disconnect', (err) => this.emit('disconnect', err));
        this.ws.on('system_error', (err) => this.emit('error', err));
        
        // Listen for new matches/tickets created from the Middleman
        this.ws.on('message', async (msg) => {
            // Forward event type logic
            if (msg.event_type === 'ticket_created' || (msg.type === 'middleman_message' && msg.content?.includes('Trade Matched'))) {
                const ticketId = msg.ticket_id || msg.payload?.ticket_id || this.extractTicketId(msg.content);
                if (ticketId) {
                    this.noteMatchedDeal(ticketId);
                }
            }
        });
    }

    private setupLiveGlobalRouting() {
        this.live.on('phase_changed', (update: any) => {
            if (update?.ticketId) {
                this.noteMatchedDeal(update.ticketId);
            }
            this.emit('phase_changed', update);
        });

        this.live.on('rollup_session_ready', (payload: any) => {
            if (payload?.ticketId) {
                this.noteMatchedDeal(payload.ticketId);
            }
            this.emit('rollup_session_ready', payload);
        });

        this.live.on('confidential_funding_request', (payload: any) => {
            if (payload?.ticketId) {
                this.noteMatchedDeal(payload.ticketId);
            }
            this.emit('confidential_funding_request', payload);
        });

        this.live.on('release_approval_request', (payload: any) => {
            if (payload?.ticketId) {
                this.noteMatchedDeal(payload.ticketId);
            }
            this.emit('release_approval_request', payload);
        });

        this.live.on('umbra_lifecycle_request', (payload: any) => {
            if (payload?.ticketId) {
                this.noteMatchedDeal(payload.ticketId);
            }
            this.emit('umbra_lifecycle_request', payload);
        });

        this.live.on('message', (content: string, phase: string) => {
            const ticketId = this.live.getCurrentTicketId();
            if (ticketId && (content?.includes('Trade Matched') || phase === 'negotiation' || phase === 'rollup_negotiation')) {
                this.noteMatchedDeal(ticketId);
            }
            this.emit('message', {
                ticketId,
                content,
                phase,
            });
        });

        this.live.on('deal_complete', (ticketId: string) => {
            if (ticketId) {
                this.noteMatchedDeal(ticketId);
            }
            this.emit('deal_complete', ticketId);
        });

        this.live.on('reconnected', () => {
            this.liveConnected = true;
        });
    }

    private extractTicketId(content?: string): string | null {
        if (!content) return null;
        const match = content.match(/TCK-[A-Z0-9]+/);
        return match ? match[0] : null;
    }

    /** 
     * Start the connection to the backend, enabling real-time events.
     * Required before listening to Deal events.
     */
    public async connect(): Promise<void> {
        if (!this.liveConnected) {
            await this.live.connect();
            this.liveConnected = true;
        }

        if (this.config.legacyWsEvents === true && !this.ws.isConnected) {
            await this.ws.connect();
        }
        
        // Once connected, re-subscribe to any active deals we care about
        for (const dealId of this.activeDeals.keys()) {
            if (this.config.legacyWsEvents === true && this.ws.isConnected) {
                this.ws.send({
                    version: "1.0",
                    type: 'status',
                    ticket_id: dealId
                });
            }
            this.live.subscribeToTicket(dealId);
        }
    }

    /** Disconnect cleanly. */
    public disconnect(): void {
        if (this.ws.isConnected || this.config.legacyWsEvents === true) {
            this.ws.disconnect();
        }
        this.live.disconnect();
        this.liveConnected = false;
    }

    /** Register this wallet with the platform via the live external-agent path. */
    public async register(): Promise<void> {
        await this.live.register();
    }

    /** Fetch/cache a specific deal context locally */
    public getDeal(ticketId: string): Deal {
        if (!this.activeDeals.has(ticketId)) {
            const deal = new Deal(
                ticketId,
                this.api,
                this.ws,
                this.live,
                this.dm,
                this.config.rpcUrl!,
                this.keypair,
                this.config.privateMode === true,
                this.config.strictOpaquePerMode !== false
            );
            this.activeDeals.set(ticketId, deal);
        }
        return this.activeDeals.get(ticketId)!;
    }

    /** Promote fresh per-offer privacy wallets once a matched ticket ID is known. */
    public promoteOfferWalletsToTicket(offerId: string, ticketId: string): void {
        this.live.promoteOfferScopedWalletsToTicket(offerId, ticketId);
    }

    // --- Offers Namespace ---

    public readonly offers = {
        /** Fetch available public offerings */
        list: (params?: { asset?: string; mode?: string; status?: string }): Promise<OfferData[]> => {
            return this.api.listOffers(params);
        },

        /** Fetch offers owned by the authenticated wallet. */
        mine: (params?: { status?: string }): Promise<OfferData[]> => {
            return this.api.listMyOffers(params);
        },

        /** Fetch one offer, including its matched ticket if it has already been accepted. */
        get: (offerId: string): Promise<OfferData> => {
            return this.api.getOffer(offerId);
        },

        /** Wait for one of this wallet's offers to become a live matched deal. */
        waitForMatch: async (offerId: string, options: Omit<WaitForMatchedDealOptions, 'offerId'> = {}): Promise<Deal> => {
            return this.waitForMatchedDeal({
                offerId,
                timeoutMs: options.timeoutMs,
                pollIntervalMs: options.pollIntervalMs,
            });
        },

        /** Broadcast an offer */
        create: async (params: OfferCreationParams): Promise<OfferData> => {
            const offerId = await this.live.createOffer({
                asset: params.asset,
                side: params.mode,
                amount: params.amount,
                price: params.price,
                collateral: params.collateral,
            });

            return {
                id: offerId,
                asset: params.asset,
                amount: params.amount,
                price: params.price,
                mode: params.mode,
                status: 'active',
                collateral: params.collateral,
                rollupMode: params.rollupMode || (this.config.privateMode ? 'PER' : 'ER'),
            };
        },

        /** Cancel one of this wallet's offers. */
        cancel: async (offerId: string): Promise<OfferData> => {
            return this.api.cancelOffer(offerId);
        },

        /** 
         * Accept an offer to spawn a Deal. 
         * Returns the Deal object ready for event subscription.
         */
        accept: async (offerId: string): Promise<Deal> => {
            const ticketId = await this.live.acceptOffer(offerId);
            this.live.subscribeToTicket(ticketId);
            return this.getDeal(ticketId);
        }
    };

    // --- Agents Namespace ---

    public readonly agents = {
        /**
         * Look up any agent's full reputation profile by wallet address.
         * Works for your own wallet or any other registered agent.
         *
         * @example
         * ```ts
         * const profile = await client.agents.profile('Gk7v...');
         * console.log(profile.tier);        // 'elite'
         * console.log(profile.trustSummary); // 'Flawless trading history.'
         * ```
         */
        profile: (wallet: string): Promise<AgentProfile> => {
            return this.api.getAgentProfile(wallet);
        },

        /**
         * Get your own profile (derived from the wallet key used to initialize the SDK).
         *
         * @example
         * ```ts
         * const me = await client.agents.me();
         * console.log(me.reputationScore); // 85
         * ```
         */
        me: (): Promise<AgentProfile> => {
            return this.api.getAgentProfile(this.keypair.publicKey.toBase58());
        },

        /**
         * Configure a webhook URL for receiving push notifications (deal events, messages, reputation changes).
         * Requires Ed25519 wallet signature for authentication.
         * Pass null to remove the webhook.
         *
         * @returns WebhookConfig including your HMAC secret for verifying payloads.
         */
        configureWebhook: (webhookUrl: string | null, signaturePayload: {
            message: string;
            signature: string;
            publicKey: string;
        }, options?: {
            events?: WebhookEventName[] | null;
        }): Promise<WebhookConfig> => {
            return this.api.configureWebhook(webhookUrl, signaturePayload, options);
        }
    };

    // --- One-Liner Trade Methods ---

    /**
     * Execute a complete purchase in ONE call for the simpler ER / public-terms path.
     * Handles: accept → negotiate → escrow → deposit → delivery → payment → release.
     *
     * @example
     * ```ts
     * const result = await client.quickBuy({
     *     offerId: 'abc-123',
     *     maxPrice: 0.5,
     *     collateral: 0.1,
     * });
     * if (result.success) console.log('Trade complete!');
     * ```
     */
    public async quickBuy(options: QuickBuyOptions): Promise<QuickBuyResult> {
        if (this.config.privateMode && this.config.strictOpaquePerMode !== false) {
            throw new AgentOTCError(
                "quickBuy() is not available in strict opaque PER mode. Use the private rollup negotiation and signed release flow instead."
            );
        }
        const timeout = options.phaseTimeoutMs ?? 120000;
        let deal: Deal | undefined;

        try {
            // 1. Connect if not already
            if (!this.liveConnected) await this.connect();

            // 2. Accept the offer
            deal = await this.offers.accept(options.offerId);
            options.onDealCreated?.(deal);

            // 3. Listen for phase changes
            if (options.onPhaseChange) {
                deal.on('phase_changed', options.onPhaseChange);
            }

            // 4. Agree to terms
            await deal.sendMessage(
                `@middleman I agree to purchase at ${options.maxPrice} SOL. Collateral: ${options.collateral} SOL each side.`
            );

            // 5. Wait for escrow creation
            await deal.waitForPhase([DealPhase.ESCROW_CREATED, DealPhase.AWAITING_DEPOSITS], { timeoutMs: timeout });
            if (deal['escrowAddress']) options.onEscrowReady?.(deal['escrowAddress']);

            // 6. Deposit collateral
            const collateralTx = await deal.depositToEscrow(options.collateral, 'buyer');

            // 7. Wait for delivery phase
            await deal.waitForPhase(DealPhase.DELIVERY, { timeoutMs: timeout });

            // 8. Deposit payment
            const paymentTx = await deal.depositToEscrow(options.maxPrice, 'buyer');

            // 9. Confirm delivery and wait for completion
            await deal.confirmDelivery();
            await deal.waitForPhase(DealPhase.COMPLETED, { timeoutMs: timeout });

            return { success: true, deal, collateralTx, paymentTx };

        } catch (error: any) {
            return {
                success: false,
                deal,
                error: error.message || String(error),
            };
        }
    }

    // --- Static Factory Methods ---

    /**
     * Register a brand-new agent on the AgentOTC platform.
     * 
     * This is the FIRST thing a new agent must call. It does NOT require
     * an API key — the API key is RETURNED by this method.
     *
     * ⚠️ The returned `apiKey` is shown ONCE. If you lose it, you cannot recover it.
     *
     * @example
     * ```ts
     * import { AgentOTC } from '@agentotc/sdk';
     * import { Keypair } from '@solana/web3.js';
     *
     * const wallet = Keypair.generate();
     * 
     * const result = await AgentOTC.register({
     *     walletPrivateKey: bs58.encode(wallet.secretKey),
     *     environment: 'devnet'
     * });
     * 
     * console.log(result.apiKey); // 'mk_abc123...' ← SAVE THIS!
     * 
     * // Now use the key to create a fully authenticated client:
     * const client = new AgentOTC({
     *     apiKey: result.apiKey!,
     *     walletPrivateKey: bs58.encode(wallet.secretKey),
     *     environment: 'devnet'
     * });
     * await client.connect();
     * ```
     */
    public static async register(opts: {
        walletPrivateKey: string;
        environment?: 'devnet' | 'mainnet' | 'localnet';
        apiUrl?: string;
    }): Promise<RegistrationResult> {
        const keypair = Keypair.fromSecretKey(bs58.decode(opts.walletPrivateKey));
        const wallet = keypair.publicKey.toBase58();

        // Resolve the API URL from environment defaults
        const envDefaults: Record<string, string> = {
            devnet: 'https://otc.yourdomain.com',
            mainnet: 'https://api.meridian.com',
            localnet: 'http://localhost:3000'
        };
        const apiUrl = opts.apiUrl || envDefaults[opts.environment || 'devnet'];

        if (!apiUrl) {
            throw new AgentOTCError('Cannot determine API URL. Provide apiUrl or a valid environment.');
        }

        return ApiClient.register(apiUrl, wallet);
    }

    /** Configure automatic private release approvals on the live PER path. */
    public setAutoApprovalPolicy(policy: AutoApprovalPolicy | null): void {
        this.live.setAutoApprovalPolicy(policy as any);
    }

    /** Publish this agent's encryption key once so counterparties can deliver over E2E DM. */
    public async publishEncryptionKey(): Promise<string> {
        return this.dm.publishEncryptionKey();
    }

    /** Expose the currently active ticket on the live PER client. */
    public getCurrentTicketId(): string | null {
        return this.live.getCurrentTicketId();
    }

    /** Wait until a matched deal exists, optionally filtering to a specific offer ID. */
    public async waitForMatchedDeal(options: WaitForMatchedDealOptions = {}): Promise<Deal> {
        const timeoutMs = options.timeoutMs ?? 180_000;
        const pollIntervalMs = options.pollIntervalMs ?? 2_000;
        const deadline = Date.now() + timeoutMs;

        if (options.offerId) {
            while (Date.now() < deadline) {
                const offer = await this.api.getOffer(options.offerId);
                if (offer.ticket?.id) {
                    this.live.subscribeToTicket(offer.ticket.id);
                    return this.noteMatchedDeal(offer.ticket.id);
                }
                await this.sleep(pollIntervalMs);
            }
            throw new TimeoutError(`Waiting for offer ${options.offerId} to match timed out.`, timeoutMs, 'deal_matched');
        }

        return new Promise<Deal>((resolve, reject) => {
            let timeoutId: NodeJS.Timeout | null = null;

            const cleanup = () => {
                this.removeListener('deal_matched', listener);
                if (timeoutId) clearTimeout(timeoutId);
            };

            const listener = (deal: Deal) => {
                cleanup();
                resolve(deal);
            };

            this.on('deal_matched', listener);
            timeoutId = setTimeout(() => {
                cleanup();
                reject(new TimeoutError('Waiting for a matched deal timed out.', timeoutMs, 'deal_matched'));
            }, timeoutMs);
        });
    }

    private noteMatchedDeal(ticketId: string): Deal {
        const deal = this.getDeal(ticketId);
        if (!this.matchedDeals.has(ticketId)) {
            this.matchedDeals.add(ticketId);
            this.emit('deal_matched', deal);
        }
        return deal;
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
}
