export type RuntimeRole = 'buyer' | 'seller' | 'watcher' | 'maker';
export type RuntimeMode = 'ER' | 'PER';

export interface RuntimeConnectionConfig {
    environment?: 'devnet' | 'mainnet' | 'localnet';
    apiUrl: string;
    wsUrl: string;
    rpcUrl: string;
}

export interface RuntimeWalletConfig {
    privateKey: string;
}

export interface RuntimeRiskConfig {
    maxPriceSol?: number;
    maxCollateralSol?: number;
}

export interface RuntimeDeliveryConfig {
    content?: string;
    label?: string;
}

export interface RuntimeFundingConfig {
    auto?: boolean;
}

export interface RuntimePrivateTermsConfig {
    assetMint: string;
    assetSymbol?: string;
    priceSol?: number;
    buyerCollateralSol?: number;
    sellerCollateralSol?: number;
    quantity?: number;
}

export interface RuntimeOfferConfig {
    asset: string;
    mode: 'buy' | 'sell';
    amount: number;
    price: number;
    collateral: number;
    rollupMode?: RuntimeMode;
}

export interface RuntimeOfferMatchConfig {
    asset?: string;
    mode?: 'buy' | 'sell';
    tokenMint?: string;
    maxPriceSol?: number;
}

export interface RuntimeStrategyConfig {
    offerId?: string;
    offer?: RuntimeOfferConfig;
    makerOffers?: RuntimeOfferConfig[];
    match?: RuntimeOfferMatchConfig;
    privateTerms?: RuntimePrivateTermsConfig;
}

export interface RuntimeConfig {
    connection: RuntimeConnectionConfig;
    wallet: RuntimeWalletConfig;
    role: RuntimeRole;
    mode: RuntimeMode;
    strategy: RuntimeStrategyConfig;
    risk?: RuntimeRiskConfig;
    delivery?: RuntimeDeliveryConfig;
    funding?: RuntimeFundingConfig;
}

export interface ProofPairEnv {
    buyerKey: string;
    sellerKey: string;
}
