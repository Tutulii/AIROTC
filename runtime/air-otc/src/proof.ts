import { AgentOTC } from '@agentotc/sdk';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
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

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
}

export async function runPerPairProof(): Promise<void> {
    const apiUrl = process.env.AIR_OTC_API_URL || 'http://localhost:3000';
    const wsUrl = process.env.AIR_OTC_WS_URL || 'ws://localhost:8080';
    const rpcUrl = process.env.AIR_OTC_RPC_URL || 'https://api.devnet.solana.com';
    const buyerKey = requiredEnv('AIR_OTC_PROOF_BUYER_KEY');
    const sellerKey = requiredEnv('AIR_OTC_PROOF_SELLER_KEY');
    const assetMint = process.env.AIR_OTC_PROOF_ASSET_MINT || 'So11111111111111111111111111111111111111112';
    const assetSymbol = process.env.AIR_OTC_PROOF_ASSET || 'SOL';
    const amount = Number(process.env.AIR_OTC_PROOF_AMOUNT || '1');
    const price = Number(process.env.AIR_OTC_PROOF_PRICE || '0.1');
    const collateral = Number(process.env.AIR_OTC_PROOF_COLLATERAL || '0.02');
    const deliveryContent = process.env.AIR_OTC_PROOF_DELIVERY || 'ACCESS_TOKEN=ACCESS_TOKEN_12345';
    const offerReady = deferred<string>();

    const seller = new AgentOTC({
        walletPrivateKey: sellerKey,
        apiUrl,
        wsUrl,
        rpcUrl,
        privateMode: true,
        strictOpaquePerMode: true,
        persistLocalState: false,
    });
    const buyer = new AgentOTC({
        walletPrivateKey: buyerKey,
        apiUrl,
        wsUrl,
        rpcUrl,
        privateMode: true,
        strictOpaquePerMode: true,
        persistLocalState: false,
    });

    await seller.register().catch(() => undefined);
    await seller.connect();
    await seller.publishEncryptionKey().catch(() => undefined);

    await buyer.register().catch(() => undefined);
    await buyer.connect();
    await buyer.publishEncryptionKey().catch(() => undefined);

    const sellerPromise = seller.workflows
        .quickSellPer({
            offer: {
                asset: 'SOL',
                mode: 'sell',
                amount,
                price,
                collateral,
                rollupMode: 'PER',
            },
            terms: {
                assetMint,
                assetSymbol,
                priceSol: price,
                buyerCollateralSol: collateral,
                sellerCollateralSol: collateral,
                quantity: amount,
            },
            deliveryContent,
            deliveryLabel: 'AIR OTC runtime proof delivery',
            matchTimeoutMs: 240000,
            onOfferCreated: (offer) => {
                console.log(`[air-otc] seller posted PER proof offer ${offer.id}`);
                offerReady.resolve(offer.id);
            },
        })
        .then((result) => {
            if (!result.success) {
                throw new Error(`Seller proof failed: ${result.error}`);
            }
            return result;
        })
        .catch((error) => {
            offerReady.reject(error);
            throw error;
        });

    const offerId = await withTimeout(offerReady.promise, 120_000, 'Waiting for seller proof offer');

    const buyerPromise = buyer.workflows.quickBuyPer({
        offerId,
        terms: {
            assetMint,
            assetSymbol,
            priceSol: price,
            buyerCollateralSol: collateral,
            sellerCollateralSol: collateral,
            quantity: amount,
        },
        settlementTimeoutMs: 240000,
    });

    const [sellerResult, buyerResult] = await Promise.all([sellerPromise, buyerPromise]);
    if (!buyerResult.success) {
        throw new Error(`Buyer proof failed: ${buyerResult.error}`);
    }

    console.log(
        `[air-otc] PER pair proof settled buyer=${buyerResult.deal?.id} seller=${sellerResult.deal?.id}`
    );
}
