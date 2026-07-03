/**
 * Observatory Bridge — Syncs middleman deal events to the api-server database.
 * 
 * Uses a lazy-sync pattern: When a phase_changed or deal_executed event fires
 * for a ticket we haven't synced yet, we look up the deal state from the
 * in-memory dealPhaseManager and resolve agent wallets from walletRegistry.
 */

import { eventBus } from "./eventBus";
import { logger } from "../utils/logger";
import { dealPhaseManager } from "../../core/dealPhaseManager";
import { walletRegistry } from "../state/walletRegistry";
import { PhaseChangedEvent } from "../types/events";
import crypto from "crypto";
import { ticketStore } from "../state/ticketStore";
import type { DealPipelineStage, PipelineStageStatus } from "../types/dealPipeline";

const OBSERVATORY_URL = process.env.OBSERVATORY_API_URL || "http://localhost:3000";
const TEST_BRIDGE_SECRET = "test-bridge-secret";

function resolveBridgeSecret(): string | null {
    const configured = process.env.BRIDGE_SECRET?.trim();
    if (configured) return configured;
    if (process.env.NODE_ENV === "test") return TEST_BRIDGE_SECRET;
    return null;
}

/** Fire-and-forget HTTP call to the api-server. Never throws. */
async function pushToObservatory(method: string, path: string, body?: any): Promise<any> {
    try {
        const bridgeSecret = resolveBridgeSecret();
        if (!bridgeSecret) {
            logger.error("observatory_bridge_auth_unconfigured", {
                path,
                method,
            });
            return null;
        }

        const bodyString = body ? JSON.stringify(body) : "";
        const timestamp = Date.now().toString();
        const payload = `${timestamp}:${method.toUpperCase()}:${path}:${bodyString}`;
        const signature = crypto.createHmac("sha256", bridgeSecret).update(payload).digest("hex");
        const opts: RequestInit = {
            method,
            headers: {
                "Content-Type": "application/json",
                "X-Bridge-Signature": signature,
                "X-Bridge-Timestamp": timestamp,
            },
        };
        if (body) opts.body = bodyString;

        const res = await fetch(`${OBSERVATORY_URL}${path}`, opts);
        const data: any = await res.json();

        if (!res.ok) {
            logger.debug("observatory_bridge_error", {
                path, status: res.status, error: data.error || "unknown"
            });
        }
        return data;
    } catch (err: any) {
        logger.debug("observatory_bridge_offline", {
            path, error: err.message
        });
        return null;
    }
}

// ─── MAP: middleman ticket_id → observatory IDs ───
const ticketMap = new Map<string, { offerId?: string; ticketId: string; source: "marketplace" | "mirrored" }>();

function mapPhaseToObservatoryStatus(phase: string): string {
    const phaseToStatus: Record<string, string> = {
        negotiation: "negotiating",
        rollup_negotiation: "negotiating",
        escrow_created: "negotiating",
        awaiting_deposits: "negotiating",
        delivery: "agreed",
        completed: "completed",
        settled: "completed",
        cancelled: "cancelled",
        disputed: "disputed",
    };

    return phaseToStatus[phase] || "negotiating";
}

function mapDealExecutionStatusToObservatoryStatus(status: string): string {
    const statusMap: Record<string, string> = {
        completed: "completed",
        settled: "completed",
        confidential_completed: "completed",
        settled_pending_session_close: "completed",
        cancelled: "cancelled",
        disputed: "disputed",
        created_awaiting_deposits: "negotiating",
    };

    return statusMap[status] || "negotiating";
}

function mapPipelineStageToObservatoryStatus(
    stage: DealPipelineStage,
    status: PipelineStageStatus
): string | null {
    if (status !== "confirmed") {
        return null;
    }

    if (stage === "settled") {
        return "completed";
    }

    if (
        stage === "awaiting_settlement_plan_approvals" ||
        stage === "awaiting_buyer_release_confirmation" ||
        stage === "seller_dispute_window" ||
        stage === "awaiting_release_approvals" ||
        stage === "release_authorized" ||
        stage === "release_signed" ||
        stage === "release_pending"
    ) {
        return "agreed";
    }

    if (
        stage === "received" ||
        stage === "verified" ||
        stage === "settlement_address_ready" ||
        stage === "stealth_settlement_ready" ||
        stage === "stealth_shielding" ||
        stage === "stealth_balances_verified" ||
        stage === "stealth_settling" ||
        stage === "stealth_claiming" ||
        stage === "route_selected" ||
        stage === "dispatching" ||
        stage === "encrypted" ||
        stage === "escrow_created"
    ) {
        return "negotiating";
    }

    if (stage === "failed") {
        return "disputed";
    }

    return null;
}

export function registerObservatoryTicketMapping(input: {
    middlemanTicketId: string;
    observatoryTicketId: string;
    observatoryOfferId?: string;
}): void {
    ticketMap.set(input.middlemanTicketId, {
        ticketId: input.observatoryTicketId,
        offerId: input.observatoryOfferId,
        source: "marketplace",
    });
}

export async function syncObservatoryTicketStatus(
    middlemanTicketId: string,
    status: string
): Promise<void> {
    const mapped = await ensureTicketSynced(middlemanTicketId);
    if (!mapped) {
        return;
    }

    await pushToObservatory("PATCH", `/v1/bridge/ticket/${mapped.ticketId}`, {
        status,
        phase: status,
        source: "manual_status_sync",
    });
}

/**
 * Look up deal info from in-memory state and resolve wallet addresses.
 * Create agent + offer + ticket in the Observatory if not already synced.
 */
async function ensureTicketSynced(middlemanTicketId: string): Promise<{ offerId?: string; ticketId: string } | null> {
    // Already synced?
    const existing = ticketMap.get(middlemanTicketId);
    if (existing) return existing;

    try {
        const existingTicket = await pushToObservatory("GET", `/v1/bridge/ticket/${middlemanTicketId}`);
        if (existingTicket?.data?.id) {
            const mapping = {
                ticketId: existingTicket.data.id as string,
                offerId: existingTicket.data.offerId as string | undefined,
                source: "marketplace" as const,
            };
            ticketMap.set(middlemanTicketId, mapping);
            return mapping;
        }

        // Get deal state from in-memory dealPhaseManager
        const deal = dealPhaseManager.getDeal(middlemanTicketId);
        if (!deal) {
            logger.debug("observatory_bridge_deal_not_found", { ticket_id: middlemanTicketId });
            return null;
        }

        // Resolve agent UUIDs back to wallet addresses
        let buyerWallet = deal.buyer;
        let sellerWallet = deal.seller;

        try {
            const buyerAgent = await walletRegistry.getAgentById(deal.buyer);
            if (buyerAgent?.wallet) buyerWallet = buyerAgent.wallet;
        } catch { /* use UUID as fallback */ }

        try {
            const sellerAgent = await walletRegistry.getAgentById(deal.seller);
            if (sellerAgent?.wallet) sellerWallet = sellerAgent.wallet;
        } catch { /* use UUID as fallback */ }

        let ticket: Awaited<ReturnType<typeof ticketStore.getTicket>> | null = null;
        try {
            ticket = await ticketStore.getTicket(middlemanTicketId);
        } catch (error: any) {
            logger.debug("observatory_bridge_ticket_context_unavailable", {
                ticket_id: middlemanTicketId,
                error: error?.message || "unknown",
            });
        }
        const asset = deal.terms?.asset_type || ticket?.agreed_terms?.asset_type || ticket?.tokenMint || "PRIVATE_ASSET";
        const price = deal.terms?.price ?? ticket?.agreed_terms?.price ?? 0;
        const collateral = deal.terms?.collateral_buyer ?? ticket?.agreed_terms?.collateral_buyer ?? 0;
        const amount = 0;
        const creatorWallet = sellerWallet;
        const mode = "sell";

        // Create offer in Observatory
        const offerResult = await pushToObservatory("POST", "/v1/bridge/offer", {
            creatorWallet,
            asset,
            price,
            amount,
            mode,
            collateral,
        });

        const obsOfferId = offerResult?.data?.id;
        if (!obsOfferId) {
            logger.debug("observatory_bridge_offer_failed", { ticket_id: middlemanTicketId });
            return null;
        }

        // Create ticket in Observatory
        const ticketResult = await pushToObservatory("POST", "/v1/bridge/ticket", {
            offerId: obsOfferId,
            buyer: buyerWallet,
            seller: sellerWallet,
            status: "negotiating",
        });

        const obsTicketId = ticketResult?.data?.id;
        if (!obsTicketId) {
            logger.debug("observatory_bridge_ticket_failed", { ticket_id: middlemanTicketId });
            return null;
        }

        const mapping = { offerId: obsOfferId, ticketId: obsTicketId, source: "mirrored" as const };
        ticketMap.set(middlemanTicketId, mapping);

        logger.info("observatory_bridge_synced", {
            middleman_ticket: middlemanTicketId,
            observatory_ticket: obsTicketId,
            buyer: buyerWallet.slice(0, 8),
            seller: sellerWallet.slice(0, 8),
        });

        return mapping;
    } catch (err: any) {
        logger.error("observatory_bridge_sync_error", { ticket_id: middlemanTicketId }, err);
        return null;
    }
}

export function initObservatoryBridge(): void {
    logger.info("observatory_bridge_initialized", {
        observatory_url: OBSERVATORY_URL,
    });

    // ── PHASE CHANGED: Lazy-sync ticket, then update status ──
    eventBus.subscribe("phase_changed", async (event: PhaseChangedEvent) => {
        const mapped = await ensureTicketSynced(event.ticket_id);
        if (!mapped) return;

        const newStatus = mapPhaseToObservatoryStatus(event.to_phase);
        const deal = dealPhaseManager.getDeal(event.ticket_id);
        await pushToObservatory("PATCH", `/v1/bridge/ticket/${mapped.ticketId}`, {
            status: newStatus,
            phase: event.to_phase,
            fromPhase: event.from_phase,
            source: "phase_changed",
            escrowPda: deal?.escrow_pda || undefined,
        });

        logger.info("observatory_bridge_phase_synced", {
            middleman_ticket: event.ticket_id,
            phase: event.to_phase,
            observatory_status: newStatus,
        });
    });

    // ── DEAL EXECUTED: Lazy-sync ticket, then final status ──
    eventBus.subscribe("deal_executed", async (payload) => {
        const mapped = await ensureTicketSynced(payload.ticket_id);
        if (!mapped) return;

        const newStatus = mapDealExecutionStatusToObservatoryStatus(payload.status);
        await pushToObservatory("PATCH", `/v1/bridge/ticket/${mapped.ticketId}`, {
            status: newStatus,
            phase: payload.status,
            source: "deal_executed",
        });

        logger.info("observatory_bridge_deal_synced", {
            middleman_ticket: payload.ticket_id,
            deal_status: payload.status,
            observatory_status: newStatus,
        });
    });

    eventBus.subscribe("deal_expiring", async (payload) => {
        const mapped = await ensureTicketSynced(payload.ticket_id);
        if (!mapped) return;

        const status = mapPhaseToObservatoryStatus(payload.phase);
        await pushToObservatory("PATCH", `/v1/bridge/ticket/${mapped.ticketId}`, {
            status,
            phase: payload.phase,
            source: "deal_expiring",
            expiresAt: payload.expires_at,
            msRemaining: payload.ms_remaining,
            warningThresholdMs: payload.warning_threshold_ms,
        });

        logger.info("observatory_bridge_expiring_synced", {
            middleman_ticket: payload.ticket_id,
            phase: payload.phase,
            ms_remaining: payload.ms_remaining,
        });
    });

    eventBus.subscribe("deal_pipeline_stage_changed", async (payload) => {
        const newStatus = mapPipelineStageToObservatoryStatus(payload.stage, payload.status);
        if (!newStatus) {
            return;
        }

        const mapped = await ensureTicketSynced(payload.ticketId);
        if (!mapped) return;

        const deal = dealPhaseManager.getDeal(payload.ticketId);
        await pushToObservatory("PATCH", `/v1/bridge/ticket/${mapped.ticketId}`, {
            status: newStatus,
            phase: payload.stage,
            source: "deal_pipeline_stage_changed",
            pipelineStatus: payload.status,
            escrowPda: deal?.escrow_pda || undefined,
        });

        logger.info("observatory_bridge_pipeline_synced", {
            middleman_ticket: payload.ticketId,
            pipeline_stage: payload.stage,
            pipeline_status: payload.status,
            observatory_status: newStatus,
        });
    });
}

export {
    mapDealExecutionStatusToObservatoryStatus,
    mapPhaseToObservatoryStatus,
    mapPipelineStageToObservatoryStatus,
};
