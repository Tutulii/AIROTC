/**
 * Meridian OTC Guard - policy preflight for seller balance-readiness checks.
 *
 * This guard is intentionally narrower than custody or escrow enforcement.
 * It validates policy bounds before the downstream wallet-observation checks:
 * 1. Chain Lock (Only Solana execution permitted).
 * 2. Spend Limit (Max 5 SOL / $100 equivalent per atomic swap).
 * 3. Token Allowlist (Only supported SVM assets).
 */

import { logger } from "../utils/logger";
import { UMBRA_SUPPORTED_MINTS } from "./umbraService";

// Fixed limit: max 5 native units (arbitrary safeguard threshold for demo)
const MAX_SPEND_LIMIT = 5.0;

const SUPPORTED_ASSET_ALIASES: Record<string, string> = {
    SOL: UMBRA_SUPPORTED_MINTS.wSOL,
    WSOL: UMBRA_SUPPORTED_MINTS.wSOL,
    USDC: UMBRA_SUPPORTED_MINTS.USDC,
    USDT: UMBRA_SUPPORTED_MINTS.USDT,
    UMBRA: UMBRA_SUPPORTED_MINTS.UMBRA,
};

export class MeridianOtcGuard {
    static isSportSyntheticAsset(asset?: string | null): boolean {
        return Boolean(asset?.trim().toUpperCase().startsWith("TXLINE:"));
    }

    static normalizeSupportedAsset(asset?: string | null): string | null {
        if (!asset) return null;
        const trimmed = asset.trim();
        if (!trimmed) return null;

        const upper = trimmed.toUpperCase();
        return SUPPORTED_ASSET_ALIASES[upper] || trimmed;
    }

    /**
     * Checks an agreement payload against hard preflight policies.
     * Throws instantly if the policy is breached, stopping the balance-readiness pipeline.
     */
    static verifyOrThrow(agreement: any) {
        logger.info("policy_guard_evaluating", {
            message: "Meridian OTC Guard is assessing the negotiated transaction...",
            amount: agreement.price
        });

        // 1. SPEND LIMIT POLICY
        if (agreement.price > MAX_SPEND_LIMIT) {
            logger.error("policy_guard_rejected", {
                reason: "Spend Limit Exceeded. Agent attempted a transaction larger than Vault threshold.",
                limit: MAX_SPEND_LIMIT,
                requested: agreement.price
            });
            throw new Error(`[Meridian Guard] Policy Violation: Spend Limit Exceeded. Max: ${MAX_SPEND_LIMIT}, Requested: ${agreement.price}`);
        }

        // 2. CHAIN LOCK POLICY (Only Solana)
        // The downstream readiness checks may read broader data sources, but
        // this OTC settlement stack is only mapped for Solana execution.
        if (agreement.chain && agreement.chain !== "solana") {
            logger.error("policy_guard_rejected", {
                reason: "Chain Lock Violation. Escrow is tightly bound to Solana SVM.",
                requested_chain: agreement.chain
            });
            throw new Error(`[Meridian Guard] Policy Violation: Chain Lock. Authorized for 'solana' only.`);
        }

        // 3. ALLOWLIST POLICY
        // Make sure the requested asset is known in our high-tier registry
        const allowedMints = Object.values(UMBRA_SUPPORTED_MINTS) as string[];
        const normalizedBuyerMint = this.normalizeSupportedAsset(agreement.buyerMint);
        const sellerMintInput = agreement.sellerMint || agreement.assetMint || agreement.asset_type;
        const isSportSynthetic =
            agreement.rollupMode === "SPORT" && this.isSportSyntheticAsset(sellerMintInput);
        const normalizedSellerMint = isSportSynthetic
            ? UMBRA_SUPPORTED_MINTS.wSOL
            : this.normalizeSupportedAsset(sellerMintInput);

        if (
            !normalizedBuyerMint ||
            !normalizedSellerMint ||
            !allowedMints.includes(normalizedBuyerMint) ||
            !allowedMints.includes(normalizedSellerMint)
        ) {
            logger.error("policy_guard_unknown_asset", {
                buyerMint: agreement.buyerMint,
                sellerMint: agreement.sellerMint,
                normalizedBuyerMint,
                normalizedSellerMint,
                rollupMode: agreement.rollupMode,
            });
            throw new Error(`[Meridian Guard] Policy Violation: Unsupported Asset. The requested token mint is not on the Allowlist.`);
        }

        logger.info("policy_guard_approved", {
            message: "Trade bounds verified. Passing to seller balance-readiness checks."
        });

        return true;
    }
}
