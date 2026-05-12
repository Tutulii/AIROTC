/**
 * Privacy Service — Off-chain term hashing for ZK Privacy Mode
 *
 * Handles:
 * - Deterministic SHA-256 commitment of deal terms + cryptographic nonce
 * - Nonce generation (crypto.randomBytes, unique per deal)
 * - Hash verification (recompute + compare)
 * - Local persistence of plaintext terms + nonce (never stored on-chain)
 *
 * Security:
 * - Nonce is cryptographically random (32 bytes from Node's CSPRNG)
 * - Canonical payload format prevents ordering attacks
 * - Anti-replay: nonce uniqueness enforced per ticket via DB constraint
 */

import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";

// ==========================================
// TYPES
// ==========================================

export interface PrivacyTerms {
    price: number;
    collateral_buyer: number;
    collateral_seller: number;
    asset_type: string;
}

export interface PrivacyCommitment {
    termsHash: string;       // Hex-encoded SHA-256 hash
    termsHashBytes: Buffer;  // Raw 32-byte hash for on-chain
    nonce: string;           // Hex-encoded 32-byte nonce
    nonceBytes: Buffer;      // Raw 32-byte nonce for on-chain
}

export interface PrivacyStatus {
    isPrivacyMode: boolean;
    privacyProtocol: "UMBRA" | "MAGICBLOCK_PER" | "NONE";
    termsHash: string | null;
    termsRevealed: boolean;
    canReveal: boolean;
}

// ==========================================
// CORE FUNCTIONS
// ==========================================

/**
 * Generate a cryptographically secure 32-byte nonce.
 * Uses Node's CSPRNG — unique per deal to prevent replay.
 */
export function generateNonce(): Buffer {
    return crypto.randomBytes(32);
}

/**
 * Compute a deterministic SHA-256 hash of deal terms + nonce.
 *
 * Canonical format: "price:collateral_buyer:collateral_seller:asset_type:nonce_hex"
 *
 * This MUST match the on-chain format in reveal_and_verify_terms exactly,
 * otherwise the reveal will fail with TermsHashMismatch.
 */
export function computeTermsHash(terms: PrivacyTerms, nonce: Buffer): PrivacyCommitment {
    const nonceHex = nonce.toString("hex");

    // Canonical payload — matches the Anchor contract format exactly
    const payload = `${terms.price}:${terms.collateral_buyer}:${terms.collateral_seller}:${terms.asset_type}:${nonceHex}`;

    const hash = crypto.createHash("sha256").update(payload).digest();

    return {
        termsHash: hash.toString("hex"),
        termsHashBytes: hash,
        nonce: nonceHex,
        nonceBytes: nonce,
    };
}

/**
 * Verify a terms hash by recomputing from the revealed terms + nonce.
 * Returns true if the recomputed hash matches the expected hash.
 */
export function verifyTermsHash(
    terms: PrivacyTerms,
    nonceHex: string,
    expectedHashHex: string
): boolean {
    const nonce = Buffer.from(nonceHex, "hex");
    const commitment = computeTermsHash(terms, nonce);
    return commitment.termsHash === expectedHashHex;
}

// ==========================================
// PERSISTENCE (Local DB — Never On-Chain)
// ==========================================

/**
 * Store the plaintext terms + nonce locally for future reveal.
 * The nonce is unique per ticket — attempting to reuse a nonce will fail.
 */
export async function storePrivateTerms(
    ticketId: string,
    terms: PrivacyTerms,
    commitment: PrivacyCommitment
): Promise<void> {
    try {
        await prisma.deal.update({
            where: { id: ticketId },
            data: {
                tradeMode: "Privacy",
                termsHash: commitment.termsHash,
                termsNonce: commitment.nonce,
                termsRevealed: false,
            },
        });

        logger.info("privacy_terms_stored", {
            ticket_id: ticketId,
            terms_hash_preview: commitment.termsHash.substring(0, 16) + "...",
        });
    } catch (e) {
        logger.error("privacy_terms_store_failed", { ticket_id: ticketId }, e);
        throw e;
    }
}

/**
 * Retrieve stored private terms for a reveal operation.
 * Returns null if the ticket doesn't have privacy terms stored.
 */
export async function getPrivateTerms(ticketId: string): Promise<{
    termsHash: string;
    termsNonce: string;
    termsRevealed: boolean;
} | null> {
    try {
        const deal = await prisma.deal.findUnique({
            where: { id: ticketId },
            select: {
                tradeMode: true,
                termsHash: true,
                termsNonce: true,
                termsRevealed: true,
            },
        });

        if (!deal || deal.tradeMode !== "Privacy" || !deal.termsHash || !deal.termsNonce) {
            return null;
        }

        return {
            termsHash: deal.termsHash,
            termsNonce: deal.termsNonce,
            termsRevealed: deal.termsRevealed,
        };
    } catch (e) {
        logger.error("privacy_terms_fetch_failed", { ticket_id: ticketId }, e);
        return null;
    }
}

/**
 * Get the privacy status of a deal for API consumers.
 */
export async function getPrivacyStatus(ticketId: string): Promise<PrivacyStatus> {
    const deal = await prisma.deal.findUnique({
        where: { id: ticketId },
        select: {
            tradeMode: true,
            termsHash: true,
            termsRevealed: true,
            status: true,
        },
    });

    if (!deal) {
        return { isPrivacyMode: false, privacyProtocol: "NONE", termsHash: null, termsRevealed: false, canReveal: false };
    }

    const isPrivacy = deal.tradeMode === "Privacy";
    const isTerminal = ["agreed", "completed", "cancelled", "refunded"].includes(deal.status);

    return {
        isPrivacyMode: isPrivacy,
        privacyProtocol: isPrivacy
            ? (process.env.DEFAULT_PRIVACY_PROTOCOL === "MAGICBLOCK_PER" ? "MAGICBLOCK_PER" : "UMBRA")
            : "NONE",
        termsHash: isPrivacy ? deal.termsHash : null,
        termsRevealed: deal.termsRevealed,
        canReveal: isPrivacy && isTerminal && !deal.termsRevealed,
    };
}
