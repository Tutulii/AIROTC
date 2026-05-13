export interface SwapQuoteParams {
    fromToken: string;
    toToken: string;
    amount: string;
    fromChain: string;
    toChain?: string;
    walletAddress: string;
    slippage?: number;
}

export interface SwapQuoteResult {
    id: string;
    from: any;
    to: any;
    inputAmount: string;
    inputAmountRaw: string;
    estimatedOutput: string;
    outputMin: string;
    fee: any;
    liquiditySource: string;
    preconditions: any;
    spender: string;
    transaction: any;
    fromChain: string;
    toChain: string;
}

export interface ExecuteSwapResult {
    hash: string;
    status: string;
    chain: string;
    bridgeDelivery?: any;
    swap: any;
}

declare module "../../zerion-core/cli/lib/trading/swap.js" {
    export function getSwapQuote(params: SwapQuoteParams): Promise<SwapQuoteResult>;
    export function executeSwap(
        quote: SwapQuoteResult,
        walletName: string,
        passphrase?: string,
        options?: { timeout?: number }
    ): Promise<ExecuteSwapResult>;
}

declare module "../../zerion-core/cli/lib/wallet/keystore.js" {
    export function importFromKey(
        name: string,
        privateKey: string,
        passphrase?: string,
        network?: string
    ): any;

    export function listWallets(): { name: string, id: string, evmAddress: string, solAddress: string }[];
}
