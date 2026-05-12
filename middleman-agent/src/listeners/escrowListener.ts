/**
 * Escrow Listener
 *
 * Bridges agreement detection into the canonical downstream pipeline.
 * Subscribes to "agreement_detected" and hands the finalized terms to the
 * deal pipeline, which owns route selection and dispatch.
 *
 * By the time this listener runs, negotiation has already finished
 * on ER/PER and `agreement_detected` now represents finalized consensus.
 */

import { eventBus } from "../services/eventBus";
import { logger } from "../utils/logger";
import { dealPipeline } from "../services/dealPipeline";
import { privateEscrowIntentStore } from "../state/privateEscrowIntentStore";
import { confidentialFundingService } from "../services/confidentialFundingService";

let escrowListenerActive = false;

export function initEscrowListener(): void {
    if (escrowListenerActive) {
        logger.info("escrow_listener_skip", { reason: "Already active" });
        return;
    }

    eventBus.subscribe("agreement_detected", async (payload) => {
        const listenerLog = logger.withContext({ ticket_id: payload.ticketId });
        listenerLog.info("escrow_agreement_received", {
            price: payload.price,
            confidence: payload.confidence,
            source: "agreement_detected",
        });

        try {
            const outcome = await dealPipeline.buildNegotiationOutcome(payload);
            const result = await dealPipeline.start(outcome);

            if (!result.success) {
                listenerLog.error("deal_pipeline_failed", {}, new Error(result.error || "Unknown pipeline error"));
                return;
            }

            listenerLog.info("deal_pipeline_dispatched", {
                route: result.route,
                stage: result.stage,
                status: result.status,
                dealPda: result.dealPda || "n/a",
                txCount: result.txSignatures?.length || 0,
            });
        } catch (error: any) {
            listenerLog.error(
                "deal_pipeline_unhandled_error",
                {},
                error instanceof Error ? error : new Error(error?.message || String(error))
            );
            eventBus.publish("deal_executed", {
                ticket_id: payload.ticketId,
                status: "failed",
            });
        }
    });

    eventBus.subscribe("private_escrow_intent_ready", async (payload) => {
        const listenerLog = logger.withContext({ ticket_id: payload.ticketId, intentId: payload.intentId });
        listenerLog.info("private_escrow_intent_received", {
            source: "private_escrow_intent_ready",
            sessionPda: payload.sessionPda,
            termsHash: payload.termsHash,
            assetMint: payload.assetMint,
        });

        try {
            const intent = await privateEscrowIntentStore.getByIntentId(
                payload.ticketId,
                payload.intentId
            );

            if (!intent) {
                throw new Error(
                    `Private escrow intent ${payload.intentId} was not found for ticket ${payload.ticketId}`
                );
            }

            const result = await dealPipeline.startFromPrivateEscrowIntent(intent);
            if (!result.success) {
                listenerLog.error("deal_pipeline_failed", {}, new Error(result.error || "Unknown pipeline error"));
                return;
            }

            listenerLog.info("private_intent_pipeline_dispatched", {
                route: result.route,
                stage: result.stage,
                status: result.status,
                dealPda: result.dealPda || "n/a",
                txCount: result.txSignatures?.length || 0,
            });
        } catch (error: any) {
            listenerLog.error(
                "private_intent_pipeline_unhandled_error",
                {},
                error instanceof Error ? error : new Error(error?.message || String(error))
            );
            eventBus.publish("deal_executed", {
                ticket_id: payload.ticketId,
                status: "failed",
            });
        }
    });

    eventBus.subscribe("release_authorized", async (payload) => {
        const listenerLog = logger.withContext({ ticket_id: payload.ticketId, dealPda: payload.dealPda });
        listenerLog.info("release_authorized_received", {
            source: "release_authorized",
        });

        try {
            const result = await dealPipeline.continueConfidentialRelease(payload.ticketId);
            if (!result.success) {
                listenerLog.error("deal_pipeline_release_resume_failed", {}, new Error(result.error || "Unknown release resume error"));
                return;
            }

            listenerLog.info("deal_pipeline_release_resumed", {
                route: result.route,
                stage: result.stage,
                status: result.status,
                dealPda: result.dealPda || "n/a",
                txCount: result.txSignatures?.length || 0,
            });
        } catch (error: any) {
            listenerLog.error(
                "deal_pipeline_release_resume_unhandled_error",
                {},
                error instanceof Error ? error : new Error(error?.message || String(error))
            );
            eventBus.publish("deal_executed", {
                ticket_id: payload.ticketId,
                status: "failed",
            });
        }
    });

    eventBus.subscribe("confidential_funding_submitted", async (payload) => {
        const listenerLog = logger.withContext({ ticket_id: payload.ticketId, requestId: payload.requestId });
        listenerLog.info("confidential_funding_submission_received", {
            source: "confidential_funding_submitted",
            signatureCount: payload.transactionSignatures.length,
        });

        try {
            await confidentialFundingService.processAgentSubmission(payload);
        } catch (error: any) {
            listenerLog.error(
                "confidential_funding_submission_failed",
                {},
                error instanceof Error ? error : new Error(error?.message || String(error))
            );
        }
    });

    eventBus.subscribe("confidential_funding_completed", async (payload) => {
        const listenerLog = logger.withContext({ ticket_id: payload.ticketId, dealPda: payload.dealPda });
        listenerLog.info("confidential_funding_completed_received", {
            source: "confidential_funding_completed",
        });

        try {
            const result = await dealPipeline.continueConfidentialSettlementAfterFunding(payload.ticketId);
            if (!result.success) {
                listenerLog.error("deal_pipeline_funding_resume_failed", {}, new Error(result.error || "Unknown funding resume error"));
                return;
            }

            listenerLog.info("deal_pipeline_funding_resumed", {
                route: result.route,
                stage: result.stage,
                status: result.status,
                dealPda: result.dealPda || "n/a",
                txCount: result.txSignatures?.length || 0,
            });
        } catch (error: any) {
            listenerLog.error(
                "deal_pipeline_funding_resume_unhandled_error",
                {},
                error instanceof Error ? error : new Error(error?.message || String(error))
            );
            eventBus.publish("deal_executed", {
                ticket_id: payload.ticketId,
                status: "failed",
            });
        }
    });

    escrowListenerActive = true;
    logger.info("escrow_listener_initialized", { status: "listening" });
}
