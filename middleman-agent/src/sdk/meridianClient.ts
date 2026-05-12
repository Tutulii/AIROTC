/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  Meridian OTC Client SDK                                           ║
 * ║                                                                    ║
 * ║  Split-lifecycle API for agent negotiation sessions.               ║
 * ║  Routes to MagicBlock ER (public) or PER (private) based on the    ║
 * ║  privateMode flag. Exposes separate open/close methods so the      ║
 * ║  agent negotiation loop can execute between delegation and         ║
 * ║  undelegation.                                                     ║
 * ║                                                                    ║
 * ║  SDK:    @magicblock-labs/ephemeral-rollups-sdk v0.11.1            ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";

import {
    NegotiationRollupService,
    type SessionOpenResult,
    type SessionCloseResult,
    type NegotiationSession,
    type NegotiatedTerms,
} from "../services/negotiationRollupService";
import { logger } from "../utils/logger";
import type { AttestedEscrowIntent, PrivateHandoffProofState } from "../types/dealPipeline";

export type { NegotiatedTerms } from "../services/negotiationRollupService";

// ══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════

export interface MeridianClientConfig {
    /** true = PER (Institutional Dark Pool), false = ER (Public Fast-Path) */
    privateMode: boolean;
    /** Solana RPC connection for base layer transactions */
    connection: Connection;
    /** Keypair used for signing delegation and permission transactions */
    payer: Keypair;
}

// ══════════════════════════════════════════════════════════════════════
// CLIENT
// ══════════════════════════════════════════════════════════════════════

export class MeridianClient {
    private readonly isPrivate: boolean;
    private readonly rollupService: NegotiationRollupService;

    constructor(config: MeridianClientConfig) {
        this.isPrivate = config.privateMode;
        this.rollupService = new NegotiationRollupService(
            config.connection,
            config.payer,
            config.privateMode ? "PER" : "ER"
        );

        logger.info("meridian_client_initialized", {
            route: this.isPrivate
                ? "PER (Private Ephemeral Rollup — Intel TDX Enclave)"
                : "ER (Ephemeral Rollup — Public Fast-Path)",
        });
    }

    private isStrictOpaquePerMode(): boolean {
        return this.isPrivate && (process.env.PER_STRICT_OPAQUE_MODE || "true").toLowerCase() !== "false";
    }

    // ════════════════════════════════════════════════════════════════════
    // SESSION LIFECYCLE
    // ════════════════════════════════════════════════════════════════════

    /**
     * Opens a negotiation session by delegating the Deal PDA to the
     * appropriate MagicBlock validator (ER or PER based on privateMode).
     *
     * After this call, the returned ConnectionMagicRouter must be used
     * for all agent negotiation transactions (sub-100ms state updates).
     *
     * @param ticketId — Unique deal ticket identifier
     * @param dealPda  — The on-chain Deal PDA (must already exist via create_deal)
     * @param agents   — Public keys (base58) of the two negotiating agents
     * @returns SessionOpenResult containing the erConnection for agent use
     */
    async openSession(
        ticketId: string,
        dealPda: PublicKey | undefined,
        agents: string[]
    ): Promise<SessionOpenResult> {
        if (this.isPrivate) {
            if (agents.length < 2) throw new Error("Requires at least two agents for PER session");
            const buyer = new PublicKey(agents[0]);
            const seller = new PublicKey(agents[1]);
            return await this.rollupService.openPERSession(ticketId, dealPda, buyer, seller);
        } else {
            return await this.rollupService.openERSession(ticketId, dealPda, agents);
        }
    }

    /**
     * Closes a negotiation session after both agents reach consensus.
     *
     * Commits the finalized state and undelegates the Deal PDA back to
     * Solana L1. For PER sessions, also generates FHE ciphertext via
     * the Encrypt handoff using the provided or stored negotiated terms.
     *
     * @param ticketId — The ticket whose session to close
     * @param terms    — Optional negotiated terms for FHE encryption (PER only).
     *                   If not provided, uses terms stored via setSessionTerms().
     * @returns SessionCloseResult with L1 signature and optional FHE ciphertext
     */
    async closeSession(
        ticketId: string,
        terms?: NegotiatedTerms
    ): Promise<SessionCloseResult> {
        const session = this.rollupService.getSession(ticketId);
        if (!session) {
            throw new Error(
                `Cannot close session: no active session found for ticket ${ticketId}`
            );
        }

        if (session.isPrivate) {
            return await this.rollupService.closePERSession(ticketId);
        } else {
            return await this.rollupService.closeERSession(ticketId);
        }
    }

    // ════════════════════════════════════════════════════════════════════
    // SESSION QUERIES
    // ════════════════════════════════════════════════════════════════════

    /**
     * Returns the MagicBlock ConnectionMagicRouter for an active session.
     * Agent loops use this instead of the base Connection for sub-100ms
     * state updates through the ER/PER validator.
     */
    getSessionConnection(ticketId: string): ConnectionMagicRouter | null {
        return this.rollupService.getSessionConnection(ticketId);
    }

    /**
     * Returns the active session metadata.
     */
    getSession(ticketId: string): NegotiationSession | null {
        return this.rollupService.getSession(ticketId);
    }

    completeSession(ticketId: string): void {
        this.rollupService.completeSession(ticketId);
    }

    /**
     * Checks if a PER session's TEE auth token is still valid.
     */
    isSessionAuthValid(ticketId: string): boolean {
        return this.rollupService.isSessionAuthValid(ticketId);
    }

    /**
     * Stores the agreed negotiation terms in the session.
     * Called by the agent negotiation loop when both agents confirm.
     * For PER, the backend now pulls the live TEE state and encrypts it before
     * the session is redacted and finalized back to L1.
     */
    setSessionTerms(ticketId: string, terms: NegotiatedTerms): void {
        if (this.isStrictOpaquePerMode()) {
            throw new Error(
                `per_strict_opaque_mode_violation:set_session_terms_disabled:${ticketId}`
            );
        }
        this.rollupService.setSessionTerms(ticketId, terms);
    }

    /**
     * Force-closes an expired session.
     * Commits pending state and undelegates without FHE handoff.
     */
    async forceCloseSession(ticketId: string): Promise<void> {
        return this.rollupService.forceCloseSession(ticketId);
    }

    async fetchCommittedTerms(ticketId: string): Promise<{
        sessionPda: PublicKey;
        agreedPriceLamports: bigint;
        agreedAsset: string;
        buyerCollateralLamports: bigint;
        sellerCollateralLamports: bigint;
        status: string;
    }> {
        if (this.isStrictOpaquePerMode()) {
            throw new Error(
                `per_strict_opaque_mode_violation:fetch_committed_terms_disabled:${ticketId}`
            );
        }
        return this.rollupService.fetchCommittedTerms(ticketId);
    }

    async fetchLiveTerms(ticketId: string): Promise<{
        sessionPda: PublicKey;
        agreedPriceLamports: bigint;
        agreedAsset: string;
        buyerCollateralLamports: bigint;
        sellerCollateralLamports: bigint;
        status: string;
    }> {
        if (this.isStrictOpaquePerMode()) {
            throw new Error(
                `per_strict_opaque_mode_violation:fetch_live_terms_disabled:${ticketId}`
            );
        }
        return this.rollupService.fetchLiveTerms(ticketId);
    }

    async recordPrivateHandoffProof(
        ticketId: string,
        intent: AttestedEscrowIntent
    ): Promise<string> {
        return this.rollupService.recordPrivateHandoffProof(ticketId, intent);
    }

    async fetchLivePrivateHandoffProof(ticketId: string): Promise<PrivateHandoffProofState> {
        return this.rollupService.fetchLivePrivateHandoffProof(ticketId);
    }

    async fetchCommittedPrivateHandoffProof(ticketId: string): Promise<PrivateHandoffProofState> {
        return this.rollupService.fetchCommittedPrivateHandoffProof(ticketId);
    }

    async finalizePERSession(ticketId: string): Promise<string> {
        return this.rollupService.finalizePERSession(ticketId);
    }

    async reconcilePersistedSessions(): Promise<void> {
        return this.rollupService.reconcilePersistedSessions();
    }

    async resendSessionReadyForAgent(ticketId: string, agentId: string): Promise<boolean> {
        return this.rollupService.resendSessionReadyForAgent(ticketId, agentId);
    }
}
