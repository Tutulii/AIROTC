/**
 * Escrow Listener (Legacy Core Version)
 * 
 * Bridges the agreement detection engine to the Solana execution layer.
 * NOTE: The production version is at src/listeners/escrowListener.ts.
 * This version is kept for backward compatibility with legacy test pipelines.
 */

import { eventBus } from "../src/services/eventBus";
import { executeDeal, AgreementResult } from "../services/executionService";
import { logger } from "../src/utils/logger";

let escrowListenerActive = false;

export function initEscrowListener(): void {
    if (escrowListenerActive) {
        logger.info("escrow_listener_skip", { reason: "Already active" });
        return;
    }

    (eventBus.subscribe as any)("agreement_detected", async (payload: any) => {
        const listenerLog = logger.withContext({ ticket_id: payload.ticketId });
        listenerLog.info("escrow_agreement_detected", { price: payload.price, confidence: payload.confidence });

        const agreementResult: AgreementResult = {
            ticketId: payload.ticketId,
            price: payload.price,
            collateral_buyer: payload.collateral_buyer,
            collateral_seller: payload.collateral_seller,
            asset_type: payload.asset_type || "data",
            confidence: payload.confidence,
        };

        const result = await executeDeal(agreementResult);

        if (result.success) {
            listenerLog.info("escrow_deal_executed", { tx: result.tx });

            (eventBus.publish as any)("deal_executed", {
                ticket_id: payload.ticketId,
                status: "success",
                tx: result.tx,
            });
        } else {
            listenerLog.error("escrow_deal_failed", {}, new Error(result.error || "Unknown"));

            (eventBus.publish as any)("deal_executed", {
                ticket_id: payload.ticketId,
                status: "failed",
                error: result.error,
            });
        }
    });

    escrowListenerActive = true;
    logger.info("escrow_listener_initialized");
}
