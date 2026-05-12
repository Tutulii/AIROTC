import { Router, Request, Response } from 'express';

const router = Router();

/* ─── In-Memory Price Cache ─── */
interface PriceEntry {
    price: number;
    change24h: number;
    source: string;
    updatedAt: number;
}

const priceCache: Map<string, PriceEntry> = new Map();
const CACHE_TTL = 60_000; // 1 minute
const PYTH_IDS: Record<string, string> = {
    SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
};

const COINGECKO_IDS: Record<string, string> = {
    SOL: 'solana',
    BTC: 'bitcoin',
    ETH: 'ethereum',
    USDC: 'usd-coin',
    USDT: 'tether',
};

/* ─── Pyth Price Feed ─── */
async function fetchFromPyth(symbol: string): Promise<PriceEntry | null> {
    const pythId = PYTH_IDS[symbol];
    if (!pythId) return null;

    try {
        const res = await fetch(
            `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${pythId}`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (!res.ok) return null;

        const data = await res.json();
        const parsed = data.parsed?.[0];
        if (!parsed?.price) return null;

        const price = Number(parsed.price.price) * Math.pow(10, parsed.price.expo);
        return {
            price,
            change24h: 0,
            source: 'pyth',
            updatedAt: Date.now(),
        };
    } catch {
        return null;
    }
}

/* ─── CoinGecko Fallback ─── */
async function fetchFromCoinGecko(symbol: string): Promise<PriceEntry | null> {
    const cgId = COINGECKO_IDS[symbol];
    if (!cgId) return null;

    try {
        const res = await fetch(
            `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_change=true`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (!res.ok) return null;

        const data = await res.json();
        const entry = data[cgId];
        if (!entry?.usd) return null;

        return {
            price: entry.usd,
            change24h: entry.usd_24h_change ?? 0,
            source: 'coingecko',
            updatedAt: Date.now(),
        };
    } catch {
        return null;
    }
}

/* ─── Resolve Price (Pyth → CoinGecko → Cache) ─── */
async function resolvePrice(symbol: string): Promise<PriceEntry | null> {
    const upper = symbol.toUpperCase();

    // 1. Check cache
    const cached = priceCache.get(upper);
    if (cached && Date.now() - cached.updatedAt < CACHE_TTL) {
        return cached;
    }

    // 2. Try Pyth first
    let entry = await fetchFromPyth(upper);

    // 3. Fallback to CoinGecko
    if (!entry) {
        entry = await fetchFromCoinGecko(upper);
    }

    // 4. Cache and return
    if (entry) {
        priceCache.set(upper, entry);
        return entry;
    }

    // Stablecoins always $1
    if (upper === 'USDC' || upper === 'USDT') {
        const stable: PriceEntry = { price: 1.0, change24h: 0, source: 'static', updatedAt: Date.now() };
        priceCache.set(upper, stable);
        return stable;
    }

    return cached ?? null;
}

/* ─── Routes ─── */

/**
 * @swagger
 * /v1/prices:
 *   get:
 *     tags: [Prices]
 *     summary: Get all supported asset prices
 *     description: Returns live prices from Pyth Network with CoinGecko fallback. Cached for 60s.
 *     responses:
 *       200:
 *         description: Current prices for all supported assets
 */
router.get('/', async (_req: Request, res: Response) => {
    const symbols = ['SOL', 'BTC', 'ETH', 'USDC', 'USDT'];
    const results: Record<string, PriceEntry> = {};

    await Promise.all(
        symbols.map(async (sym) => {
            const entry = await resolvePrice(sym);
            if (entry) results[sym] = entry;
        })
    );

    res.json({
        success: true,
        data: results,
        meta: {
            sources: ['pyth', 'coingecko', 'static'],
            cacheTtlMs: CACHE_TTL,
            timestamp: Date.now(),
        },
    });
});

/**
 * @swagger
 * /v1/prices/{symbol}:
 *   get:
 *     tags: [Prices]
 *     summary: Get price for a specific asset
 *     parameters:
 *       - in: path
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *           enum: [SOL, BTC, ETH, USDC, USDT]
 *     responses:
 *       200:
 *         description: Current price data
 *       404:
 *         description: Unknown symbol
 */
router.get('/:symbol', async (req: Request, res: Response) => {
    const symbol = (req.params.symbol as string).toUpperCase();
    const entry = await resolvePrice(symbol);

    if (!entry) {
        res.status(404).json({ success: false, error: `Unknown symbol: ${symbol}` });
        return;
    }

    res.json({
        success: true,
        data: { symbol, ...entry },
    });
});

export default router;
export { resolvePrice, priceCache };
