/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  MagicBlock Session Manager                                        ║
 * ║                                                                    ║
 * ║  Singleton that owns the MeridianClient instance and exposes       ║
 * ║  lifecycle methods consumable by listeners and services.            ║
 * ║                                                                    ║
 * ║  This is the "ignition key" that wires the MagicBlock engine       ║
 * ║  into the live agent deal flow.                                    ║
 * ║                                                                    ║
 * ║  Usage:                                                            ║
 * ║    import { magicBlockSessions } from './magicBlockSessionManager'; ║
 * ║    await magicBlockSessions.openForDeal(ticketId, dealPda, agents); ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { MeridianClient, type NegotiatedTerms } from "../sdk/meridianClient";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";
import type { RollupMode } from "../types/ticket";
import type { AttestedEscrowIntent, PrivateHandoffProofState } from "../types/dealPipeline";

// Re-export for consumers
export type { NegotiatedTerms } from "../sdk/meridianClient";

// ══════════════════════════════════════════════════════════════════════
// SINGLETON
// ══════════════════════════════════════════════════════════════════════

let _erClient: MeridianClient | null = null;
let _perClient: MeridianClient | null = null;
let _initialized = false;

function isStrictOpaquePerModeEnabled(): boolean {
    return (process.env.PER_STRICT_OPAQUE_MODE || "true").toLowerCase() !== "false";
}

/**
 * Initialize the MagicBlock session manager.
 * Must be called once at startup with the payer keypair.
 *
 * @param privateMode — true = Intel TDX (PER), false = public ER
 */
export function initMagicBlockSessions(
    payer: Keypair
): void {
    if (_initialized) {
        logger.warn("magicblock_sessions_already_initialized");
        return;
    }

    const connection = getConnection();

    _erClient = new MeridianClient({
        privateMode: false,
        connection,
        payer,
    });

    _perClient = new MeridianClient({
        privateMode: true,
        connection,
        payer,
    });

    _initialized = true;

    logger.info("magicblock_session_manager_initialized", {
        routes: ["ER", "PER"],
    });
}

/**
 * Returns the MeridianClient instance.
 * Throws if not initialized.
 */
function getClient(mode: RollupMode): MeridianClient {
    const client = mode === "PER" ? _perClient : _erClient;
    if (!client) {
        throw new Error(
            "MagicBlock session manager not initialized. " +
            "Call initMagicBlockSessions() at startup."
        );
    }
    return client;
}

// ══════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════

/**
 * Opens a MagicBlock negotiation session for a deal.
 *
 * Call this AFTER the deal PDA has been created on Solana L1.
 * The Deal PDA is delegated to the ER/PER validator for sub-100ms
 * state updates during the negotiation phase.
 *
 * @param ticketId — The deal ticket identifier
 * @param dealPdaBase58 — The deal PDA address (base58 string from on-chain creation)
 * @param agents — Wallet pubkeys (base58) of buyer and seller
 */
export async function openSessionForDeal(
    ticketId: string,
    dealPdaBase58: string,
    agents: string[],
    rollupMode: RollupMode = "ER"
): Promise<{ success: boolean; error?: string }> {
    try {
        const client = getClient(rollupMode);
        const dealPda = new PublicKey(dealPdaBase58);

        logger.info("magicblock_opening_session_for_deal", {
            ticketId,
            dealPda: dealPdaBase58,
            agents,
            rollupMode,
        });

        const result = await client.openSession(ticketId, dealPda, agents);

        logger.info("magicblock_session_opened", {
            ticketId,
            validator: result.validator,
            isPrivate: result.isPrivate,
            delegationSignature: result.delegationSignature,
        });

        return { success: true };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        logger.error(
            "magicblock_session_open_failed",
            { ticketId, dealPda: dealPdaBase58 },
            error instanceof Error ? error : new Error(errorMsg)
        );

        // Non-fatal: the deal can still proceed on L1 without MagicBlock speed
        return { success: false, error: errorMsg };
    }
}

export async function openSessionForTicket(
    ticketId: string,
    agents: string[],
    rollupMode: Exclude<RollupMode, "NONE">
): Promise<{ success: boolean; error?: string }> {
    try {
        const client = getClient(rollupMode);

        logger.info("magicblock_opening_session_for_ticket", {
            ticketId,
            agents,
            rollupMode,
        });

        await client.openSession(ticketId, undefined, agents);
        return { success: true };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(
            "magicblock_ticket_session_open_failed",
            { ticketId, agents, rollupMode },
            error instanceof Error ? error : new Error(errorMsg)
        );
        return { success: false, error: errorMsg };
    }
}

/**
 * Stores the agreed negotiation terms in the active session.
 * Called when both agents reach consensus during negotiation.
 */
export function storeAgreedTerms(
    ticketId: string,
    terms: NegotiatedTerms,
    rollupMode: RollupMode = "ER"
): void {
    try {
        if (rollupMode === "PER" && isStrictOpaquePerModeEnabled()) {
            throw new Error(
                `per_strict_opaque_mode_violation:set_session_terms_disabled:${ticketId}`
            );
        }
        const client = getClient(rollupMode);
        client.setSessionTerms(ticketId, terms);
    } catch (error) {
        logger.warn("magicblock_store_terms_failed", {
            ticketId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/**
 * Closes a MagicBlock session and commits state back to L1.
 * For PER sessions, state was hardware-shielded by Intel TDX TEE.
 *
 * @param ticketId — The deal ticket identifier
 * @param terms — Optional negotiated terms override
 */
export async function closeSessionForDeal(
    ticketId: string,
    terms?: NegotiatedTerms
): Promise<{ success: boolean; teeSealedState?: string | null; error?: string }> {
    try {
        const client = _perClient?.getSession(ticketId)
            ? getClient("PER")
            : _erClient?.getSession(ticketId)
                ? getClient("ER")
                : null;

        if (!client) {
            logger.info("magicblock_session_close_skipped", { ticketId, reason: "no_active_session" });
            return { success: true, teeSealedState: null };
        }

        logger.info("magicblock_closing_session_for_deal", { ticketId });

        const result = await client.closeSession(ticketId, terms);

        logger.info("magicblock_session_closed", {
            ticketId,
            commitSignature: result.commitSignature,
            l1Signature: result.l1TransactionSignature,
            teeSealedStateLength: result.teeSealedState?.length ?? 0,
            sessionDurationMs: result.sessionDurationMs,
        });

        return {
            success: true,
            teeSealedState: result.teeSealedState,
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        logger.error(
            "magicblock_session_close_failed",
            { ticketId },
            error instanceof Error ? error : new Error(errorMsg)
        );

        return { success: false, error: errorMsg };
    }
}

export async function fetchCommittedTermsForTicket(ticketId: string): Promise<{
    agreedPriceLamports: bigint;
    agreedAsset: string;
    buyerCollateralLamports: bigint;
    sellerCollateralLamports: bigint;
    status: string;
    sessionPda: string;
}> {
    if (_perClient?.getSession(ticketId) && isStrictOpaquePerModeEnabled()) {
        throw new Error(
            `per_strict_opaque_mode_violation:fetch_committed_terms_disabled:${ticketId}`
        );
    }

    const client = _perClient?.getSession(ticketId)
        ? getClient("PER")
        : _erClient?.getSession(ticketId)
            ? getClient("ER")
            : getClient("ER");

    const committed = await client.fetchCommittedTerms(ticketId);
    return {
        agreedPriceLamports: committed.agreedPriceLamports,
        agreedAsset: committed.agreedAsset,
        buyerCollateralLamports: committed.buyerCollateralLamports,
        sellerCollateralLamports: committed.sellerCollateralLamports,
        status: committed.status,
        sessionPda: committed.sessionPda.toBase58(),
    };
}

export async function fetchLiveTermsForTicket(ticketId: string): Promise<{
    agreedPriceLamports: bigint;
    agreedAsset: string;
    buyerCollateralLamports: bigint;
    sellerCollateralLamports: bigint;
    status: string;
    sessionPda: string;
}> {
    if (_perClient?.getSession(ticketId) && isStrictOpaquePerModeEnabled()) {
        throw new Error(
            `per_strict_opaque_mode_violation:fetch_live_terms_disabled:${ticketId}`
        );
    }

    const client = _perClient?.getSession(ticketId)
        ? getClient("PER")
        : _erClient?.getSession(ticketId)
            ? getClient("ER")
            : getClient("ER");

    const live = await client.fetchLiveTerms(ticketId);
    return {
        agreedPriceLamports: live.agreedPriceLamports,
        agreedAsset: live.agreedAsset,
        buyerCollateralLamports: live.buyerCollateralLamports,
        sellerCollateralLamports: live.sellerCollateralLamports,
        status: live.status,
        sessionPda: live.sessionPda.toBase58(),
    };
}

export async function finalizePrivateTicket(ticketId: string): Promise<string | null> {
    if (!_perClient?.getSession(ticketId)) return null;
    return _perClient.finalizePERSession(ticketId);
}

export async function recordPrivateHandoffProofForTicket(
    ticketId: string,
    intent: AttestedEscrowIntent
): Promise<string> {
    return getClient("PER").recordPrivateHandoffProof(ticketId, intent);
}

export async function fetchLivePrivateHandoffProofForTicket(
    ticketId: string
): Promise<PrivateHandoffProofState> {
    return getClient("PER").fetchLivePrivateHandoffProof(ticketId);
}

export async function fetchCommittedPrivateHandoffProofForTicket(
    ticketId: string
): Promise<PrivateHandoffProofState> {
    if (_perClient?.getSession(ticketId)) {
        return _perClient.fetchCommittedPrivateHandoffProof(ticketId);
    }
    return getClient("ER").fetchCommittedPrivateHandoffProof(ticketId);
}

export async function reconcilePersistedRollupSessions(): Promise<void> {
    await Promise.all([
        _erClient?.reconcilePersistedSessions(),
        _perClient?.reconcilePersistedSessions(),
    ]);
}

export async function resendSessionReady(ticketId: string, agentId: string): Promise<boolean> {
    if (_perClient?.getSession(ticketId)) {
        return _perClient.resendSessionReadyForAgent(ticketId, agentId);
    }

    if (_erClient?.getSession(ticketId)) {
        return _erClient.resendSessionReadyForAgent(ticketId, agentId);
    }

    return false;
}

export function completeTicketSession(ticketId: string): void {
    _erClient?.completeSession(ticketId);
    _perClient?.completeSession(ticketId);
}

/**
 * Force-closes a timed-out session. No TEE state capture.
 */
export async function forceCloseSession(ticketId: string): Promise<void> {
    try {
        const client = _perClient?.getSession(ticketId)
            ? getClient("PER")
            : getClient("ER");
        await client.forceCloseSession(ticketId);
    } catch (error) {
        logger.warn("magicblock_force_close_failed", {
            ticketId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/**
 * Returns whether the session manager has been initialized.
 */
export function isInitialized(): boolean {
    return _initialized;
}

export const magicBlockSessions = {
    init: initMagicBlockSessions,
    openForDeal: openSessionForDeal,
    openForTicket: openSessionForTicket,
    storeTerms: storeAgreedTerms,
    closeForDeal: closeSessionForDeal,
    fetchLiveTerms: fetchLiveTermsForTicket,
    fetchCommittedTerms: fetchCommittedTermsForTicket,
    recordPrivateHandoffProof: recordPrivateHandoffProofForTicket,
    fetchLivePrivateHandoffProof: fetchLivePrivateHandoffProofForTicket,
    fetchCommittedPrivateHandoffProof: fetchCommittedPrivateHandoffProofForTicket,
    finalizePrivateTicket,
    reconcilePersistedSessions: reconcilePersistedRollupSessions,
    resendReady: resendSessionReady,
    completeTicketSession,
    forceClose: forceCloseSession,
    isInitialized,
};
