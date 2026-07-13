/**
 * Offer Validator — Input validation for offer creation and updates.
 *
 * Validates:
 * - Required fields (asset, price, amount, collateral, mode)
 * - SPL token mint address (optional, base58 check)
 * - Numeric bounds (positive, non-zero, finite)
 * - Mode enum ("buy" | "sell")
 */

import { validateMintAddress, resolveDecimals } from './tokenRegistry';
import { PublicKey } from '@solana/web3.js';

interface ValidationResult {
    valid: boolean;
    error?: string;
    /** Resolved decimals for the token (9 for SOL, 6 for USDC, etc.) */
    tokenDecimals?: number;
}

export function validateCreateOffer(body: any): ValidationResult {
    const {
        asset,
        price,
        amount,
        collateral,
        mode,
        tokenMint,
        rollupMode,
        privateMode,
        settlementWallet,
        rewardWallet,
        fundingWallet,
        fixtureId,
        marketType,
        selection,
    } = body;

    // ── Asset ──
    if (!asset || typeof asset !== 'string' || asset.trim() === '') {
        return { valid: false, error: 'asset is required and must be a non-empty string' };
    }

    if (asset.length > 200) {
        return { valid: false, error: 'asset must be 200 characters or less' };
    }

    // ── Price ──
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        return { valid: false, error: 'price is required and must be a finite number > 0' };
    }

    // ── Amount ──
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        return { valid: false, error: 'amount is required and must be a finite number > 0' };
    }

    // ── Mode ──
    if (mode !== 'buy' && mode !== 'sell') {
        return { valid: false, error: 'mode must be either "buy" or "sell"' };
    }

    if (rollupMode !== undefined && rollupMode !== 'ER' && rollupMode !== 'PER' && rollupMode !== 'NONE' && rollupMode !== 'SPORT') {
        return { valid: false, error: 'rollupMode must be "NONE", "ER", "PER", or "SPORT"' };
    }

    if (privateMode !== undefined && typeof privateMode !== 'boolean') {
        return { valid: false, error: 'privateMode must be a boolean when provided' };
    }

    const isSportMode = rollupMode === 'SPORT';

    // ── Collateral ──
    if (!isSportMode && (typeof collateral !== 'number' || !Number.isFinite(collateral) || collateral < 0)) {
        return { valid: false, error: 'collateral is required and must be a finite number >= 0' };
    }
    if (isSportMode && collateral !== undefined && collateral !== null) {
        if (typeof collateral !== 'number' || !Number.isFinite(collateral) || collateral < 0) {
            return { valid: false, error: 'collateral must be a finite number >= 0 when provided' };
        }
    }

    if (rollupMode === 'SPORT') {
        if (!fixtureId || typeof fixtureId !== 'string' || fixtureId.trim() === '') {
            return { valid: false, error: 'fixtureId is required for SPORT offers' };
        }
        if (fixtureId.length > 100) {
            return { valid: false, error: 'fixtureId must be 100 characters or less' };
        }
        if (!selection || typeof selection !== 'string' || selection.trim() === '') {
            return { valid: false, error: 'selection is required for SPORT offers' };
        }
    }

    if (marketType !== undefined && marketType !== null) {
        if (typeof marketType !== 'string' || marketType.length > 160) {
            return { valid: false, error: 'marketType must be a string of 160 characters or less when provided' };
        }
    }

    if (selection !== undefined && selection !== null) {
        if (typeof selection !== 'string' || selection.length > 100) {
            return { valid: false, error: 'selection must be a string of 100 characters or less when provided' };
        }
    }

    if (settlementWallet !== undefined && settlementWallet !== null) {
        if (typeof settlementWallet !== 'string') {
            return { valid: false, error: 'settlementWallet must be a base58 Solana address when provided' };
        }
        try {
            new PublicKey(settlementWallet);
        } catch {
            return { valid: false, error: 'settlementWallet must be a valid base58 Solana address' };
        }
    }

    if (rewardWallet !== undefined && rewardWallet !== null) {
        if (typeof rewardWallet !== 'string') {
            return { valid: false, error: 'rewardWallet must be a base58 Solana address when provided' };
        }
        try {
            new PublicKey(rewardWallet);
        } catch {
            return { valid: false, error: 'rewardWallet must be a valid base58 Solana address' };
        }
    }

    if (fundingWallet !== undefined && fundingWallet !== null) {
        if (typeof fundingWallet !== 'string') {
            return { valid: false, error: 'fundingWallet must be a base58 Solana address when provided' };
        }
        try {
            new PublicKey(fundingWallet);
        } catch {
            return { valid: false, error: 'fundingWallet must be a valid base58 Solana address' };
        }
    }

    // ── Token Mint (Optional) ──
    let tokenDecimals = 9; // Default: native SOL
    if (tokenMint !== undefined && tokenMint !== null) {
        if (typeof tokenMint !== 'string') {
            return { valid: false, error: 'tokenMint must be a string (Solana mint address) or null' };
        }

        const mintValidation = validateMintAddress(tokenMint);
        if (!mintValidation.valid) {
            return { valid: false, error: mintValidation.error! };
        }

        tokenDecimals = resolveDecimals(tokenMint);
    }

    return { valid: true, tokenDecimals };
}
