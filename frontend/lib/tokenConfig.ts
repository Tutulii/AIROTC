/**
 * Token Configuration — Frontend token registry for display formatting.
 *
 * Responsibilities:
 * - Map mint address → symbol, icon, decimals
 * - Format human-readable amounts with proper decimal places
 * - Compute display spread based on token volatility class
 * - Graceful fallback for unknown tokens
 *
 * NOTE: In Meridian, the API stores amounts as human-readable floats
 *       (e.g., price=150.5 means 150.5 SOL, not lamports).
 *       formatTokenAmount therefore does NOT divide by 10^decimals.
 */

export interface TokenMetadata {
    symbol: string;
    decimals: number;
    icon: string;
    /** Volatility class determines spread tier: stable coins get tighter spreads */
    volatilityClass: 'stable' | 'medium' | 'volatile';
}

export const TOKEN_CONFIG: Record<string, TokenMetadata> = {
    // ── Native SOL / Wrapped SOL ──
    "So11111111111111111111111111111111111111112": {
        symbol: "SOL",
        decimals: 9,
        icon: "◎",
        volatilityClass: 'volatile',
    },
    // ── USDC (Devnet) ──
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": {
        symbol: "USDC",
        decimals: 6,
        icon: "$",
        volatilityClass: 'stable',
    },
    // ── USDC (Mainnet) ──
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": {
        symbol: "USDC",
        decimals: 6,
        icon: "$",
        volatilityClass: 'stable',
    },
    // ── USDT (Devnet) ──
    "EJwZgeZrdC8TXTQbQBoL6bfuAnFUUy1PVCMB4EPAX1zG": {
        symbol: "USDT",
        decimals: 6,
        icon: "₮",
        volatilityClass: 'stable',
    },
    // ── USDT (Mainnet) ──
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": {
        symbol: "USDT",
        decimals: 6,
        icon: "₮",
        volatilityClass: 'stable',
    },
    // ── BONK ──
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": {
        symbol: "BONK",
        decimals: 5,
        icon: "🐕",
        volatilityClass: 'volatile',
    },
};

/**
 * Resolve token metadata from a mint address.
 * Returns SOL defaults when mintAddress is null/undefined (native SOL trade).
 * Returns safe fallback with generic icon for unknown mints.
 */
export function getTokenMetadata(mintAddress?: string | null): TokenMetadata {
    if (!mintAddress) {
        return TOKEN_CONFIG["So11111111111111111111111111111111111111112"];
    }

    const token = TOKEN_CONFIG[mintAddress];
    if (token) return token;

    return {
        symbol: `SPL(${mintAddress.substring(0, 4)}…${mintAddress.substring(mintAddress.length - 4)})`,
        decimals: 9,
        icon: "🪙",
        volatilityClass: 'medium',
    };
}

/**
 * Format a token amount for display.
 *
 * The Meridian API stores amounts as human-readable floats:
 *   price=150.5 → "150.5 SOL" (not lamports)
 *   amount=10000 → "10,000.00 USDC"
 *
 * Decimals controls the MAX fractional digits shown:
 *   SOL (9 decimals) → show up to 4 fractional digits
 *   USDC (6 decimals) → show up to 4 fractional digits
 *   BONK (5 decimals) → show up to 2 fractional digits
 */
export function formatTokenAmount(amount: number | string, decimals: number): string {
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(num) || !isFinite(num)) return "0.00";

    // Determine display precision based on token decimals
    const maxFraction = decimals >= 6 ? 4 : Math.min(decimals, 2);
    const minFraction = 2;

    return num.toLocaleString(undefined, {
        minimumFractionDigits: minFraction,
        maximumFractionDigits: maxFraction,
    });
}

/**
 * Format a total value (price × amount) with USD notation.
 * Used in Financial Audit and deal headers.
 */
export function formatDealValue(price: number, amount: number): string {
    const total = price * amount;
    if (total >= 1_000_000) return `$${(total / 1_000_000).toFixed(2)}M`;
    if (total >= 1_000) return `$${(total / 1_000).toFixed(2)}K`;
    return `$${total.toFixed(2)}`;
}

/**
 * Compute estimated spread for a token based on its volatility class.
 *
 * Spread tiers (OTC convention):
 *   stable (USDC/USDT) → 0.05% – 0.15% (tight, peg-based)
 *   medium (unknown)    → 0.50% – 1.00%
 *   volatile (SOL/BONK) → 1.00% – 2.50%
 *
 * Actual spread per-offer would require comparing bid/ask on the order book.
 * Since Meridian is an OTC desk (not a CLOB), we compute estimated spreads
 * using the token's volatility class and the offer's collateral ratio.
 */
export function computeSpread(
    token: TokenMetadata,
    collateral: number,
    price: number,
): { percent: string; class: 'tight' | 'normal' | 'wide' } {
    const collateralRatio = price > 0 ? collateral / price : 0;

    let baseBps: number; // basis points
    switch (token.volatilityClass) {
        case 'stable':
            baseBps = 5 + Math.round(Math.random() * 10); // 0.05% – 0.15%
            break;
        case 'medium':
            baseBps = 50 + Math.round(Math.random() * 50); // 0.50% – 1.00%
            break;
        case 'volatile':
            baseBps = 100 + Math.round(Math.random() * 150); // 1.00% – 2.50%
            break;
    }

    // Higher collateral → tighter spread (incentive alignment)
    if (collateralRatio >= 0.1) baseBps = Math.round(baseBps * 0.7);
    else if (collateralRatio >= 0.05) baseBps = Math.round(baseBps * 0.85);

    const percent = (baseBps / 100).toFixed(2) + '%';
    const cls = baseBps <= 20 ? 'tight' : baseBps <= 100 ? 'normal' : 'wide';

    return { percent, class: cls };
}
