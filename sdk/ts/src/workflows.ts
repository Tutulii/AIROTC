import type { AgentOTC } from './client';
import { DealPhase, type AutoApprovalPolicy, type DirectMessage, type OfferCreationParams, type OfferData, type PrivateAgreementTermsInput, type QuickBuyOptions, type QuickBuyResult, type RollupTerms } from './types';
import type { Deal } from './deal';

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface WorkflowTimingOptions {
    timeoutMs?: number;
    matchTimeoutMs?: number;
    rollupTimeoutMs?: number;
    fundingTimeoutMs?: number;
    deliveryTimeoutMs?: number;
    settlementTimeoutMs?: number;
    umbraLifecycleTimeoutMs?: number;
    requireFullUmbraLifecycle?: boolean;
}

export interface QuickSellErOptions extends WorkflowTimingOptions {
    offer: OfferCreationParams;
    deliveryMessage: string;
    onOfferCreated?: (offer: OfferData) => void;
    onDealCreated?: (deal: Deal) => void;
    onPhaseChange?: (phase: string) => void;
}

export interface QuickBuyPerOptions extends WorkflowTimingOptions {
    offerId: string;
    terms: PrivateAgreementTermsInput | RollupTerms;
    autoPublishEncryptionKey?: boolean;
    autoApprovalPolicy?: AutoApprovalPolicy | false;
}

export interface QuickSellPerOptions extends WorkflowTimingOptions {
    offer: OfferCreationParams;
    terms: PrivateAgreementTermsInput | RollupTerms;
    deliveryContent: string;
    deliveryLabel?: string;
    autoPublishEncryptionKey?: boolean;
    autoApprovalPolicy?: AutoApprovalPolicy | false;
    onOfferCreated?: (offer: OfferData) => void;
    onDealCreated?: (deal: Deal) => void;
    onPhaseChange?: (phase: string) => void;
}

export interface SellerWorkflowResult {
    success: boolean;
    offer?: OfferData;
    deal?: Deal;
    collateralTx?: string;
    delivery?: DirectMessage;
    umbraLifecycle?: any;
    error?: string;
}

export interface PerWorkflowResult {
    success: boolean;
    deal?: Deal;
    delivery?: DirectMessage;
    umbraLifecycle?: any;
    error?: string;
}

export type BuyerWorkflowOptions =
    | ({ mode: 'ER' } & QuickBuyOptions)
    | ({ mode: 'PER' } & QuickBuyPerOptions);

export type SellerWorkflowOptions =
    | ({ mode: 'ER' } & QuickSellErOptions)
    | ({ mode: 'PER' } & QuickSellPerOptions);

export class AgentOTCWorkflows {
    constructor(private readonly client: AgentOTC) {}

    private withPerAssetLabel(
        terms: PrivateAgreementTermsInput | RollupTerms,
        assetLabel?: string
    ): PrivateAgreementTermsInput | RollupTerms {
        if (!assetLabel || !assetLabel.trim() || terms.assetSymbol) {
            return terms;
        }
        return {
            ...terms,
            assetSymbol: assetLabel,
        };
    }

    private extractPerPriceSol(
        terms: PrivateAgreementTermsInput | RollupTerms,
        fallbackPrice?: number
    ): number | undefined {
        if ('priceSol' in terms && typeof terms.priceSol === 'number') {
            return terms.priceSol;
        }

        if ('priceLamports' in terms) {
            const lamports = Number(terms.priceLamports);
            if (Number.isFinite(lamports)) {
                return lamports / LAMPORTS_PER_SOL;
            }
        }

        return fallbackPrice;
    }

    private extractPerMaxCollateral(
        terms: PrivateAgreementTermsInput | RollupTerms,
        fallbackCollateral?: number
    ): number | undefined {
        const values: number[] = [];

        if ('buyerCollateralSol' in terms && typeof terms.buyerCollateralSol === 'number') {
            values.push(terms.buyerCollateralSol);
        }
        if ('sellerCollateralSol' in terms && typeof terms.sellerCollateralSol === 'number') {
            values.push(terms.sellerCollateralSol);
        }
        if ('collateralBuyer' in terms && typeof terms.collateralBuyer === 'number') {
            values.push(terms.collateralBuyer);
        }
        if ('collateralSeller' in terms && typeof terms.collateralSeller === 'number') {
            values.push(terms.collateralSeller);
        }
        if (typeof fallbackCollateral === 'number') {
            values.push(fallbackCollateral);
        }

        if (values.length === 0) {
            return undefined;
        }

        return Math.max(...values);
    }

    private extractPerBuyerCollateralSol(
        terms: PrivateAgreementTermsInput | RollupTerms,
        fallbackCollateral?: number
    ): number | undefined {
        if ('buyerCollateralSol' in terms && typeof terms.buyerCollateralSol === 'number') {
            return terms.buyerCollateralSol;
        }
        if ('collateralBuyer' in terms && typeof terms.collateralBuyer === 'number') {
            return terms.collateralBuyer;
        }
        return fallbackCollateral;
    }

    private extractPerSellerCollateralSol(
        terms: PrivateAgreementTermsInput | RollupTerms,
        fallbackCollateral?: number
    ): number | undefined {
        if ('sellerCollateralSol' in terms && typeof terms.sellerCollateralSol === 'number') {
            return terms.sellerCollateralSol;
        }
        if ('collateralSeller' in terms && typeof terms.collateralSeller === 'number') {
            return terms.collateralSeller;
        }
        return fallbackCollateral;
    }

    private solToLamportsString(value: number | undefined): string | undefined {
        if (value === undefined) {
            return undefined;
        }
        const lamports = Math.round(value * LAMPORTS_PER_SOL);
        if (!Number.isSafeInteger(lamports) || lamports <= 0) {
            return undefined;
        }
        return String(lamports);
    }

    private resolvePerUmbraLifecycleAmountLamports(input: {
        terms: PrivateAgreementTermsInput | RollupTerms;
        role: 'buyer' | 'seller';
        fallbackPrice?: number;
        fallbackCollateral?: number;
    }): string | undefined {
        const envOverride = process.env.AIROTC_UMBRA_LIFECYCLE_AMOUNT_LAMPORTS;
        if (envOverride && /^[1-9]\d*$/.test(envOverride)) {
            return envOverride;
        }

        if (input.role === 'buyer') {
            return this.solToLamportsString(
                this.extractPerBuyerCollateralSol(input.terms, input.fallbackCollateral)
            );
        }

        const price = this.extractPerPriceSol(input.terms, input.fallbackPrice);
        const sellerCollateral = this.extractPerSellerCollateralSol(
            input.terms,
            input.fallbackCollateral
        );
        if (price === undefined || sellerCollateral === undefined) {
            return undefined;
        }
        return this.solToLamportsString(price + sellerCollateral);
    }

    private resolvePerAutoApprovalPolicy(input: {
        autoApprovalPolicy?: AutoApprovalPolicy | false;
        assetLabel?: string;
        terms: PrivateAgreementTermsInput | RollupTerms;
        fallbackPrice?: number;
        fallbackCollateral?: number;
    }): AutoApprovalPolicy | null {
        if (input.autoApprovalPolicy === false) {
            return null;
        }

        if (input.autoApprovalPolicy) {
            return input.autoApprovalPolicy;
        }

        const asset = input.assetLabel?.trim() || input.terms.assetSymbol?.trim();
        const maxPrice = this.extractPerPriceSol(input.terms, input.fallbackPrice);
        const maxCollateral = this.extractPerMaxCollateral(input.terms, input.fallbackCollateral);

        return {
            allowedAssets: asset ? [asset] : undefined,
            maxPrice,
            maxCollateral,
            requireStealthSettlement: true,
        };
    }

    private shouldRunFullUmbraLifecycle(options: WorkflowTimingOptions): boolean {
        return (
            options.requireFullUmbraLifecycle === true ||
            process.env.AIROTC_REQUIRE_FULL_UMBRA === 'true' ||
            process.env.UMBRA_SETTLEMENT_LIFECYCLE_MODE === 'FULL_UMBRA'
        );
    }

    private async maybeCompleteUmbraLifecycle(
        deal: Deal,
        options: WorkflowTimingOptions,
        amountLamports?: string
    ): Promise<any | undefined> {
        if (!this.shouldRunFullUmbraLifecycle(options)) {
            return undefined;
        }
        return deal.autoCompleteUmbraLifecycle({
            timeoutMs:
                options.umbraLifecycleTimeoutMs ??
                options.settlementTimeoutMs ??
                options.timeoutMs ??
                240_000,
            amountLamports,
        });
    }

    async quickBuyEr(options: QuickBuyOptions): Promise<QuickBuyResult> {
        await this.ensureReady();
        return this.client.quickBuy(options);
    }

    async quickSellEr(options: QuickSellErOptions): Promise<SellerWorkflowResult> {
        const timeoutMs = options.timeoutMs ?? 180_000;

        try {
            await this.ensureReady();
            const offer = await this.client.offers.create({
                ...options.offer,
                rollupMode: 'ER',
            });
            options.onOfferCreated?.(offer);
            const deal = await this.client.waitForMatchedDeal({
                offerId: offer.id,
                timeoutMs: options.matchTimeoutMs ?? timeoutMs,
            });
            options.onDealCreated?.(deal);

            if (options.onPhaseChange) {
                deal.on('phase_changed', options.onPhaseChange);
            }

            await deal.waitForPhase([DealPhase.ESCROW_CREATED, DealPhase.AWAITING_DEPOSITS], {
                timeoutMs,
            });
            const collateralTx = await deal.depositToEscrow(options.offer.collateral, 'seller');
            await deal.waitForPhase(DealPhase.DELIVERY, { timeoutMs });
            await deal.sendMessage(options.deliveryMessage);
            await deal.waitForPhase([DealPhase.COMPLETED, DealPhase.SETTLED], {
                timeoutMs: options.settlementTimeoutMs ?? timeoutMs,
            });

            return {
                success: true,
                offer,
                deal,
                collateralTx,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
            };
        }
    }

    async quickBuyPer(options: QuickBuyPerOptions): Promise<PerWorkflowResult> {
        try {
            await this.ensureReady();
            if (options.autoPublishEncryptionKey !== false) {
                await this.safePublishEncryptionKey();
            }

            const offer = await this.client.offers.get(options.offerId).catch(() => null);
            const autoApprovalPolicy = this.resolvePerAutoApprovalPolicy({
                autoApprovalPolicy: options.autoApprovalPolicy,
                assetLabel: offer?.asset,
                terms: options.terms,
                fallbackPrice: offer?.price,
                fallbackCollateral: offer?.collateral,
            });
            if (autoApprovalPolicy) {
                this.client.setAutoApprovalPolicy(autoApprovalPolicy);
            }
            const deal = await this.client.offers.accept(options.offerId);
            await deal.waitForRollupSessionReady(options.rollupTimeoutMs ?? options.timeoutMs ?? 180_000);
            await deal.completePrivateAgreement(
                this.withPerAssetLabel(options.terms, offer?.asset)
            );
            await deal.autoFundPrivateDeal({
                timeoutMs: options.fundingTimeoutMs ?? options.timeoutMs ?? 180_000,
            });
            const delivery = await deal.waitForEncryptedDelivery({
                timeoutMs: options.deliveryTimeoutMs ?? options.timeoutMs ?? 180_000,
            });
            await deal.confirmPrivateDelivery({
                timeoutMs: options.deliveryTimeoutMs ?? options.timeoutMs ?? 180_000,
            });
            await deal.waitForPhase([DealPhase.SETTLED, DealPhase.COMPLETED], {
                timeoutMs: options.settlementTimeoutMs ?? options.timeoutMs ?? 240_000,
            });
            const umbraLifecycle = await this.maybeCompleteUmbraLifecycle(
                deal,
                options,
                this.resolvePerUmbraLifecycleAmountLamports({
                    terms: options.terms,
                    role: 'buyer',
                    fallbackPrice: offer?.price,
                    fallbackCollateral: offer?.collateral,
                })
            );

            return {
                success: true,
                deal,
                delivery,
                umbraLifecycle,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
            };
        }
    }

    async quickSellPer(options: QuickSellPerOptions): Promise<SellerWorkflowResult> {
        try {
            await this.ensureReady();
            if (options.autoPublishEncryptionKey !== false) {
                await this.safePublishEncryptionKey();
            }

            const autoApprovalPolicy = this.resolvePerAutoApprovalPolicy({
                autoApprovalPolicy: options.autoApprovalPolicy,
                assetLabel: options.offer.asset,
                terms: options.terms,
                fallbackPrice: options.offer.price,
                fallbackCollateral: options.offer.collateral,
            });
            if (autoApprovalPolicy) {
                this.client.setAutoApprovalPolicy(autoApprovalPolicy);
            }
            const offer = await this.client.offers.create({
                ...options.offer,
                rollupMode: 'PER',
            });
            options.onOfferCreated?.(offer);
            const deal = await this.client.waitForMatchedDeal({
                offerId: offer.id,
                timeoutMs: options.matchTimeoutMs ?? options.timeoutMs ?? 240_000,
            });
            options.onDealCreated?.(deal);

            if (options.onPhaseChange) {
                deal.on('phase_changed', options.onPhaseChange);
            }

            await deal.waitForRollupSessionReady(options.rollupTimeoutMs ?? options.timeoutMs ?? 180_000);
            await deal.completePrivateAgreement(
                this.withPerAssetLabel(options.terms, options.offer.asset)
            );
            await deal.autoFundPrivateDeal({
                timeoutMs: options.fundingTimeoutMs ?? options.timeoutMs ?? 180_000,
            });
            const delivery = await deal.sendEncryptedDelivery(options.deliveryContent, {
                label: options.deliveryLabel || 'AIR OTC encrypted delivery',
            });
            await deal.waitForPhase([DealPhase.SETTLED, DealPhase.COMPLETED], {
                timeoutMs: options.settlementTimeoutMs ?? options.timeoutMs ?? 240_000,
            });
            const umbraLifecycle = await this.maybeCompleteUmbraLifecycle(
                deal,
                options,
                this.resolvePerUmbraLifecycleAmountLamports({
                    terms: options.terms,
                    role: 'seller',
                    fallbackPrice: options.offer.price,
                    fallbackCollateral: options.offer.collateral,
                })
            );

            return {
                success: true,
                offer,
                deal,
                delivery,
                umbraLifecycle,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
            };
        }
    }

    async runBuyerFlow(options: BuyerWorkflowOptions): Promise<QuickBuyResult | PerWorkflowResult> {
        if (options.mode === 'PER') {
            const { mode: _mode, ...perOptions } = options;
            return this.quickBuyPer(perOptions);
        }
        const { mode: _mode, ...erOptions } = options;
        return this.quickBuyEr(erOptions);
    }

    async runSellerFlow(options: SellerWorkflowOptions): Promise<SellerWorkflowResult> {
        if (options.mode === 'PER') {
            const { mode: _mode, ...perOptions } = options;
            return this.quickSellPer(perOptions);
        }
        const { mode: _mode, ...erOptions } = options;
        return this.quickSellEr(erOptions);
    }

    private async ensureReady(): Promise<void> {
        await this.client.register().catch(() => undefined);
        await this.client.connect();
    }

    private async safePublishEncryptionKey(): Promise<void> {
        await this.client.publishEncryptionKey().catch(() => undefined);
    }
}
