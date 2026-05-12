import { AgentOTC } from './client';
import { Deal } from './deal';

export interface AutoBuyerConfig {
    targetAsset: string;
    maxPrice: number;
    maxCollateral: number;
    /** Polling interval for new offers in milliseconds. Default: 60000 (1 min) */
    pollIntervalMs?: number;
    onMatch?: (deal: Deal) => Promise<void>;
    onSuccess?: (deal: Deal) => Promise<void>;
    onError?: (error: any) => Promise<void>;
}

export class AutoBuyer {
    private client: AgentOTC;
    private running: boolean = false;
    private config!: AutoBuyerConfig;
    private activeDealIds: Set<string> = new Set();
    private currentPollTimeout?: NodeJS.Timeout;

    constructor(client: AgentOTC) {
        this.client = client;
    }

    public async start(config: AutoBuyerConfig): Promise<void> {
        this.config = Object.assign({ pollIntervalMs: 60000 }, config);
        this.running = true;

        if (!this.client['ws'].isConnected) {
            await this.client.connect();
        }

        this.pollLoop();
    }

    public stop(): void {
        this.running = false;
        if (this.currentPollTimeout) {
            clearTimeout(this.currentPollTimeout);
        }
    }

    private async pollLoop(): Promise<void> {
        if (!this.running) return;

        try {
            const offers = await this.client.offers.list({ mode: 'sell', status: 'active', asset: this.config.targetAsset });
            
            for (const offer of offers) {
                if (offer.price <= this.config.maxPrice && offer.collateral <= this.config.maxCollateral) {
                    await this.attemptPurchase(offer.id);
                }
            }
        } catch (e) {
             if (this.config.onError) await this.config.onError(e);
        }

        if (this.running) {
            this.currentPollTimeout = setTimeout(() => this.pollLoop(), this.config.pollIntervalMs);
        }
    }

    private async attemptPurchase(offerId: string): Promise<void> {
        try {
            const deal = await this.client.offers.accept(offerId);
            
            if (this.activeDealIds.has(deal.id)) return;
            this.activeDealIds.add(deal.id);

            if (this.config.onMatch) {
                await this.config.onMatch(deal);
            }

            // Full Auto Execute Deal Lifecycle Workflow
            
            // 1. Agree to terms natively
            await deal.sendMessage(`@middleman I agree to purchase ${this.config.targetAsset} at ${this.config.maxPrice} SOL.`);
            
            // 2. Wait for Escrow
            await deal.waitForPhase(['escrow_created', 'awaiting_deposits'], { timeoutMs: 120000 });
            
            // 3. Deposit collateral locally
            await deal.depositToEscrow(this.config.maxCollateral, 'buyer');
            
            // 4. Wait for Phase: delivery
            await deal.waitForPhase('delivery', { timeoutMs: 120000 });

            // 5. Send Payment
            await deal.depositToEscrow(this.config.maxPrice, 'buyer');

            // 6. Confirm receipt and completion
            await deal.confirmDelivery();
            await deal.waitForPhase('completed', { timeoutMs: 120000 });

            if (this.config.onSuccess) {
                await this.config.onSuccess(deal);
            }
        } catch (e: any) {
             if (this.config.onError) await this.config.onError(e);
        }
    }
}
