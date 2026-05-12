import { AgentOTC, type OfferCreationParams, type OfferData, type PrivateAgreementTermsInput } from '@agentotc/sdk';
import type { RuntimeConfig, RuntimeMode, RuntimeOfferConfig, RuntimeRole } from './types.js';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function offerToParams(offer: RuntimeOfferConfig, mode: RuntimeMode): OfferCreationParams {
    return {
        asset: offer.asset,
        mode: offer.mode,
        amount: offer.amount,
        price: offer.price,
        collateral: offer.collateral,
        rollupMode: offer.rollupMode || mode,
    };
}

function derivePrivateTerms(
    config: RuntimeConfig,
    offer: { asset: string; price: number; collateral: number; amount: number }
): PrivateAgreementTermsInput {
    const privateTerms = config.strategy.privateTerms;

    if (!privateTerms?.assetMint) {
        throw new Error('strategy.privateTerms.assetMint is required for PER flows');
    }

    return {
        assetMint: privateTerms.assetMint,
        assetSymbol: privateTerms.assetSymbol ?? offer.asset,
        priceSol: privateTerms.priceSol ?? offer.price,
        buyerCollateralSol: privateTerms.buyerCollateralSol ?? offer.collateral,
        sellerCollateralSol: privateTerms.sellerCollateralSol ?? offer.collateral,
        quantity: privateTerms.quantity ?? offer.amount,
    };
}

function matchesBuyerIntent(offer: OfferData, config: RuntimeConfig): boolean {
    const match = config.strategy.match;
    if (!match) return true;
    if (match.asset && offer.asset !== match.asset) return false;
    if (match.mode && offer.mode !== match.mode) return false;
    if (match.tokenMint && offer.tokenMint !== match.tokenMint) return false;
    if (match.maxPriceSol != null && offer.price > match.maxPriceSol) return false;
    if (config.risk?.maxPriceSol != null && offer.price > config.risk.maxPriceSol) return false;
    if (config.risk?.maxCollateralSol != null && offer.collateral > config.risk.maxCollateralSol) return false;
    return true;
}

export function createClient(config: RuntimeConfig): AgentOTC {
    return new AgentOTC({
        walletPrivateKey: config.wallet.privateKey,
        environment: config.connection.environment,
        apiUrl: config.connection.apiUrl,
        wsUrl: config.connection.wsUrl,
        rpcUrl: config.connection.rpcUrl,
        privateMode: config.mode === 'PER',
        strictOpaquePerMode: config.mode === 'PER',
        persistLocalState: false,
    });
}

async function chooseOffer(client: AgentOTC, config: RuntimeConfig): Promise<OfferData> {
    if (config.strategy.offerId) {
        return client.offers.get(config.strategy.offerId);
    }

    const offers = await client.offers.list({
        asset: config.strategy.match?.asset,
        mode: config.strategy.match?.mode || 'sell',
        status: 'active',
    });
    const chosen = offers
        .filter((offer) => matchesBuyerIntent(offer, config))
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())[0];
    if (!chosen) {
        throw new Error('No offer matched the configured buyer strategy.');
    }
    return chosen;
}

export async function runBuyer(config: RuntimeConfig): Promise<void> {
    const client = createClient(config);
    const offer = await chooseOffer(client, config);

    if (config.mode === 'PER') {
        const result = await client.workflows.quickBuyPer({
            offerId: offer.id,
            terms: derivePrivateTerms(config, offer),
        });
        if (!result.success) {
            throw new Error(result.error || 'PER buyer flow failed');
        }
        console.log(`[air-otc] PER buyer flow settled ticket ${result.deal?.id}`);
        return;
    }

    const result = await client.workflows.quickBuyEr({
        offerId: offer.id,
        maxPrice: offer.price,
        collateral: offer.collateral,
    });
    if (!result.success) {
        throw new Error(result.error || 'ER buyer flow failed');
    }
    console.log(`[air-otc] ER buyer flow settled ticket ${result.deal?.id}`);
}

export async function runSeller(config: RuntimeConfig): Promise<void> {
    if (!config.strategy.offer) {
        throw new Error('Seller role requires strategy.offer');
    }

    const client = createClient(config);
    const offer = offerToParams(config.strategy.offer, config.mode);

    if (config.mode === 'PER') {
        const result = await client.workflows.quickSellPer({
            offer,
            terms: derivePrivateTerms(config, config.strategy.offer),
            deliveryContent: config.delivery?.content || 'ACCESS_TOKEN=ACCESS_TOKEN_12345',
            deliveryLabel: config.delivery?.label,
        });
        if (!result.success) {
            throw new Error(result.error || 'PER seller flow failed');
        }
        console.log(`[air-otc] PER seller flow settled ticket ${result.deal?.id}`);
        return;
    }

    const result = await client.workflows.quickSellEr({
        offer,
        deliveryMessage: config.delivery?.content || 'Delivery completed via AIR OTC runtime.',
    });
    if (!result.success) {
        throw new Error(result.error || 'ER seller flow failed');
    }
    console.log(`[air-otc] ER seller flow settled ticket ${result.deal?.id}`);
}

export async function runWatcher(config: RuntimeConfig): Promise<void> {
    const client = createClient(config);
    await client.connect();

    while (true) {
        const [offers, mine] = await Promise.all([
            client.offers.list({ status: 'active' }),
            client.offers.mine({ status: 'active' }),
        ]);
        console.log(
            `[air-otc] watcher heartbeat offers=${offers.length} mine=${mine.length} role=${config.role} mode=${config.mode}`
        );
        await sleep(10000);
    }
}

export async function runMaker(config: RuntimeConfig): Promise<void> {
    const client = createClient(config);
    await client.register().catch(() => undefined);
    await client.connect();

    const offers = config.strategy.makerOffers || (config.strategy.offer ? [config.strategy.offer] : []);
    if (offers.length === 0) {
        throw new Error('maker role requires strategy.makerOffers or strategy.offer');
    }

    for (const offer of offers) {
        const created = await client.offers.create(offerToParams(offer, config.mode));
        console.log(`[air-otc] maker posted ${created.mode} offer ${created.id} on ${created.asset}`);
    }

    while (true) {
        const mine = await client.offers.mine({ status: 'active' });
        console.log(`[air-otc] maker active offers=${mine.length}`);
        await sleep(10000);
    }
}

export async function runRole(config: RuntimeConfig, overrideRole?: RuntimeRole): Promise<void> {
    const role = overrideRole || config.role;

    if (role === 'seller') return runSeller(config);
    if (role === 'watcher') return runWatcher(config);
    if (role === 'maker') return runMaker(config);
    return runBuyer(config);
}
