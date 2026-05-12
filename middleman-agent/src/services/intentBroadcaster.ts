/**
 * Intent Broadcaster (Sprint 2A)
 *
 * Broadcasts trade intents as Solana Memo transactions so other agents
 * can discover this agent's trading desires on-chain.
 *
 * Protocol: agentotc-v1
 * Transport: Solana Memo Program (MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr)
 *
 * PURE BROADCAST — writes to chain, no side effects on local state.
 *
 * @module intentBroadcaster
 */

import {
    Connection,
    PublicKey,
    Transaction,
    TransactionInstruction,
    sendAndConfirmTransaction,
    Keypair,
} from "@solana/web3.js";
import { logger } from "../utils/logger";

// ==========================================
// CONSTANTS
// ==========================================

/** Solana Memo Program v2 — immutable, permissionless, on every cluster */
const MEMO_PROGRAM_ID = new PublicKey(
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

/** Protocol prefix for filtering in the listener (Sprint 2B) */
const PROTOCOL_TAG = "agentotc-v1";

/**
 * Max payload size in bytes. Solana tx limit is 1232 bytes total.
 * 800 bytes for payload leaves safe headroom for tx overhead (signatures, headers).
 */
const MAX_PAYLOAD_BYTES = 800;

// ==========================================
// TYPES
// ==========================================

export interface MemoIntentPayload {
    protocol: string;
    side: "buy" | "sell";
    asset: string;
    minPrice: number;
    maxPrice: number;
    quantity: number;
    agentEndpoint: string;
    expiresAt: number; // Unix ms
}

export interface BroadcastResult {
    success: boolean;
    txSignature?: string;
    explorerUrl?: string;
    error?: string;
}

// ==========================================
// CORE FUNCTION
// ==========================================

/**
 * Broadcast a trade intent as a Solana Memo transaction.
 *
 * @param connection  Active Solana connection
 * @param wallet      Agent's keypair (signs the tx)
 * @param intent      The trade intent to broadcast
 * @returns           Transaction signature + Explorer URL
 */
export async function broadcastIntent(
    connection: Connection,
    wallet: Keypair,
    intent: {
        side: "buy" | "sell";
        asset: string;
        minPrice: number;
        maxPrice: number;
        quantity: number;
        agentEndpoint: string;
        ttlMinutes?: number;
    }
): Promise<BroadcastResult> {
    try {
        const ttl = intent.ttlMinutes || 60;
        const expiresAt = Date.now() + ttl * 60 * 1000;

        // Build the memo payload
        const memoPayload: MemoIntentPayload = {
            protocol: PROTOCOL_TAG,
            side: intent.side,
            asset: intent.asset,
            minPrice: intent.minPrice,
            maxPrice: intent.maxPrice,
            quantity: intent.quantity,
            agentEndpoint: intent.agentEndpoint,
            expiresAt,
        };

        const payload = JSON.stringify(memoPayload);

        // ── Payload size guard ──────────────────────────────────────────
        // Solana tx limit is 1232 bytes total. 800 bytes for the payload
        // leaves safe headroom for transaction overhead.
        if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
            throw new Error(
                `Intent payload too large: ${Buffer.byteLength(payload, "utf8")} bytes (max ${MAX_PAYLOAD_BYTES})`
            );
        }

        logger.info("intent_broadcast_sending", {
            side: intent.side,
            asset: intent.asset,
            price_range: `${intent.minPrice}-${intent.maxPrice}`,
            payload_bytes: Buffer.byteLength(payload, "utf8"),
        });

        // Build the Memo instruction
        const memoInstruction = new TransactionInstruction({
            keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: false }],
            programId: MEMO_PROGRAM_ID,
            data: Buffer.from(payload, "utf8"),
        });

        // Build and send the transaction
        const transaction = new Transaction().add(memoInstruction);

        const txSignature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [wallet],
            { commitment: "confirmed" }
        );

        const explorerUrl = `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;

        logger.info("intent_broadcast_success", {
            tx: txSignature,
            explorer: explorerUrl,
            side: intent.side,
            asset: intent.asset,
        });

        return {
            success: true,
            txSignature,
            explorerUrl,
        };
    } catch (error: any) {
        logger.error("intent_broadcast_failed", {}, error);
        return {
            success: false,
            error: error.message,
        };
    }
}

/** Re-export the memo program ID for use in the listener (Sprint 2B) */
export { MEMO_PROGRAM_ID, PROTOCOL_TAG };
