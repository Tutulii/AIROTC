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

export declare function getSwapQuote(params: SwapQuoteParams): Promise<SwapQuoteResult>;
export declare function executeSwap(
    quote: SwapQuoteResult,
    walletName: string,
    passphrase?: string,
    options?: { timeout?: number }
): Promise<ExecuteSwapResult>;
