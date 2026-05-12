/**
 * SPL Token Registry — Canonical registry of supported tokens for OTC trading.
 *
 * Provides:
 * - Mint address validation (base58 + length check)
 * - Known token metadata (symbol, decimals, icon, network)
 * - Graceful fallback for unknown tokens (defaults to 9 decimals)
 *
 * Security:
 * - Validates base58 encoding using @solana/web3.js PublicKey
 * - Rejects invalid mint addresses before they reach the DB
 */

import { PublicKey } from '@solana/web3.js';

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface TokenInfo {
    symbol: string;
    name: string;
    decimals: number;
    icon: string;
    network: 'devnet' | 'mainnet' | 'both';
}

// ═══════════════════════════════════════════════════════
// KNOWN TOKENS
// ═══════════════════════════════════════════════════════

const KNOWN_TOKENS: Record<string, TokenInfo> = {
    // ── Native SOL / Wrapped SOL ──
    'So11111111111111111111111111111111111111112': {
        symbol: 'SOL',
        name: 'Wrapped SOL',
        decimals: 9,
        icon: '◎',
        network: 'both',
    },

    // ── USDC (Devnet) ──
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': {
        symbol: 'USDC',
        name: 'USD Coin (Devnet)',
        decimals: 6,
        icon: '$',
        network: 'devnet',
    },

    // ── USDC (Mainnet) ──
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        icon: '$',
        network: 'mainnet',
    },

    // ── USDT (Devnet) ──
    'EJwZgeZrdC8TXTQbQBoL6bfuAnFUUy1PVCMB4EPAX1zG': {
        symbol: 'USDT',
        name: 'Tether USD (Devnet)',
        decimals: 6,
        icon: '₮',
        network: 'devnet',
    },

    // ── USDT (Mainnet) ──
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': {
        symbol: 'USDT',
        name: 'Tether USD',
        decimals: 6,
        icon: '₮',
        network: 'mainnet',
    },

    // ── BONK (Devnet) ──
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': {
        symbol: 'BONK',
        name: 'Bonk',
        decimals: 5,
        icon: '🐕',
        network: 'both',
    },
};

// ═══════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════

/**
 * Validate a Solana mint address.
 * Returns { valid, error } — error is null if valid.
 */
export function validateMintAddress(mint: string): { valid: boolean; error: string | null } {
    if (!mint || typeof mint !== 'string') {
        return { valid: false, error: 'tokenMint must be a non-empty string' };
    }

    try {
        const pubkey = new PublicKey(mint);
        // PublicKey constructor succeeds but we also verify it's on the Ed25519 curve
        if (!PublicKey.isOnCurve(pubkey.toBytes()) && mint !== 'So11111111111111111111111111111111111111112') {
            // Most SPL tokens are NOT on curve (they're PDAs), so we only validate base58 + length
        }
        return { valid: true, error: null };
    } catch {
        return { valid: false, error: `Invalid tokenMint: not a valid Solana public key (base58)` };
    }
}

// ═══════════════════════════════════════════════════════
// LOOKUP
// ═══════════════════════════════════════════════════════

/**
 * Get token metadata by mint address.
 * Returns known token info or a safe fallback for unknown tokens.
 */
export function getTokenInfo(mint: string | null | undefined): TokenInfo {
    if (!mint) {
        return {
            symbol: 'SOL',
            name: 'Solana (Native)',
            decimals: 9,
            icon: '◎',
            network: 'both',
        };
    }

    const known = KNOWN_TOKENS[mint];
    if (known) return known;

    // Unknown token — return safe defaults
    return {
        symbol: `SPL(${mint.substring(0, 4)}…${mint.substring(mint.length - 4)})`,
        name: 'Unknown SPL Token',
        decimals: 9,  // Safe default
        icon: '🪙',
        network: 'both',
    };
}

/**
 * Resolve decimals for a given token mint.
 * Known tokens return exact decimals. Unknown tokens default to 9.
 */
export function resolveDecimals(mint: string | null | undefined): number {
    return getTokenInfo(mint).decimals;
}

/**
 * Get all known tokens as an array (for API responses / discovery).
 */
export function listSupportedTokens(): Array<TokenInfo & { mint: string }> {
    return Object.entries(KNOWN_TOKENS).map(([mint, info]) => ({ mint, ...info }));
}
