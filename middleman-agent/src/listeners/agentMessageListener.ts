/**
 * Agent Message Listener — Real Interaction Entry Point
 *
 * Listens for authenticated, structurally validated `agent_message_received` events
 * from the WebSocket Gateway and routes them into the core middleman brain pipeline.
 */

import { eventBus } from "../services/eventBus";
import { AgentMessage } from "../protocol/agentProtocol";
import { logger } from "../utils/logger";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { ticketStore } from "../state/ticketStore";
import { walletRegistry } from "../state/walletRegistry";
import { negotiationStore } from "../state/negotiationStore";
import { SYSTEM_PAUSED } from "../api/health";
import { sessionManager } from "../gateway/sessionManager";
import type { RollupMode } from "../types/ticket";
import { magicBlockSessions } from "../services/magicBlockSessionManager";
import { releaseApprovalService } from "../services/releaseApprovalService";
import { confidentialFundingService } from "../services/confidentialFundingService";
import { recordUmbraParticipantSubmission } from "../services/umbraSettlementV2";
import { pipelineStateStore } from "../state/pipelineStateStore";

function mergeRollupModes(a: RollupMode, b: RollupMode): RollupMode {
    if (a === "PER" || b === "PER") return "PER";
    if (a === "ER" || b === "ER") return "ER";
    if (a === "SPORT" || b === "SPORT") return "SPORT";
    return "NONE";
}

function looksLikeSensitiveRollupTerms(content: string): boolean {
    const normalized = content.toLowerCase();
    const hasNumericValue = /\d/.test(normalized);
    const hasSensitiveKeyword = /(price|collateral|asset|lamport|sol|usdc|mint)/i.test(normalized);
    return hasNumericValue && hasSensitiveKeyword;
}

function isPerStrictOpaqueModeEnabled(): boolean {
    return (process.env.PER_STRICT_OPAQUE_MODE || "true").toLowerCase() !== "false";
}

export function initAgentMessageListener(): void {
    eventBus.subscribe("agent_message_received", async (payload: AgentMessage) => {
        try {
            const { type, agent_id, timestamp, ticket_id } = payload;

            // LEVEL 5: Emergency kill switch — block new deals when paused
            if (SYSTEM_PAUSED && (type as string) !== "status") {
                logger.warn("system_paused_rejecting", { agent_id, type });
                eventBus.publish("middleman_response", {
                    ticket_id: ticket_id || "system",
                    content: "⚠️ System is temporarily paused for maintenance. Active deals continue, new deals are blocked.",
                    phase: "system",
                    timestamp: new Date().toISOString()
                });
                return;
            }

            if (type === "ROLLUP_CONSENSUS_REACHED") {
                eventBus.publish("rollup_consensus_reached", {
                    ticketId: ticket_id,
                    agentId: agent_id,
                    commitSignature: (payload as any).commitSignature,
                });
                logger.info("rollup_consensus_signal_received", {
                    ticket_id,
                    agent_id,
                    commitSignature: (payload as any).commitSignature || "none",
                });
                return;
            }

            if (type === "PER_PRIVATE_HANDOFF_READY") {
                eventBus.publish("private_handoff_bundle_ready", {
                    ticketId: ticket_id,
                    agentId: agent_id,
                    bundle: (payload as any).bundle,
                });
                logger.info("per_private_handoff_bundle_received", {
                    ticket_id,
                    agent_id,
                    sessionPda: (payload as any).bundle?.sessionPda,
                    termsHash: (payload as any).bundle?.termsHash,
                });
                return;
            }

            if (type === "CONFIDENTIAL_FUNDING_SUBMITTED") {
                eventBus.publish("confidential_funding_submitted", {
                    ticketId: ticket_id,
                    agentId: agent_id,
                    requestId: (payload as any).requestId,
                    transactionSignatures: (payload as any).transactionSignatures || [],
                });
                logger.info("confidential_funding_submission_received", {
                    ticket_id,
                    agent_id,
                    requestId: (payload as any).requestId,
                    signatureCount: ((payload as any).transactionSignatures || []).length,
                });
                return;
            }

            if (type === "UMBRA_SETTLEMENT_SUBMITTED") {
                const result = await recordUmbraParticipantSubmission({
                    settlementId: (payload as any).settlementId,
                    role: (payload as any).role,
                    phase: (payload as any).phase,
                    txSignature: (payload as any).txSignature,
                    amountLamports: (payload as any).amountLamports,
                    finalWallet: (payload as any).finalWallet,
                });
                const stage =
                    result.settlementPhase === "COMPLETED"
                        ? "umbra_lifecycle_completed"
                        : "umbra_lifecycle_pending";
                await pipelineStateStore.markStage(ticket_id, stage, "confirmed", {
                    settlementId: (payload as any).settlementId,
                    role: (payload as any).role,
                    phase: (payload as any).phase,
                    settlementPhase: result.settlementPhase,
                    participantPhase: result.participantPhase,
                });
                const ticket = await ticketStore.getTicket(ticket_id).catch(() => null);
                eventBus.publish("deal_pipeline_stage_changed", {
                    ticketId: ticket_id,
                    stage,
                    status: "confirmed",
                    route: "CONFIDENTIAL_ESCROW",
                    executionPolicy: "CONFIDENTIAL",
                    settlementPolicy: "STEALTH",
                    negotiationSource: ticket?.rollup_mode === "ER" ? "ER" : "PER",
                });
                if (result.settlementPhase === "COMPLETED") {
                    eventBus.publish("deal_executed", {
                        ticket_id,
                        status: "completed",
                    });
                }
                eventBus.publish("umbra_settlement_submission_processed", {
                    ticketId: ticket_id,
                    agentId: agent_id,
                    settlementId: (payload as any).settlementId,
                    role: (payload as any).role,
                    phase: (payload as any).phase,
                    settlementPhase: result.settlementPhase,
                    participantPhase: result.participantPhase,
                });
                logger.info("umbra_settlement_submission_processed", {
                    ticket_id,
                    agent_id,
                    settlementId: (payload as any).settlementId,
                    role: (payload as any).role,
                    phase: (payload as any).phase,
                    settlementPhase: result.settlementPhase,
                    participantPhase: result.participantPhase,
                });
                return;
            }

            if (
                type === "RELEASE_APPROVAL_RESPONSE" ||
                type === "RELEASE_APPROVAL_REVOKE" ||
                type === "RELEASE_DISPUTE_OPEN"
            ) {
                await releaseApprovalService.processAgentResponse(payload as any);
                logger.info("release_approval_protocol_message_processed", {
                    ticket_id,
                    agent_id,
                    type,
                    requestId: (payload as any).requestId,
                });
                return;
            }

            logger.info("routing_agent_message", {
                type,
                agent_id,
                ticket_id: ticket_id || "none"
            });

            // 1. Initial Offer — Creates a new ticket
            if (type === "offer") {
                const requestedRollupMode = sessionManager.getRequestedRollupModeByAgent(agent_id);
                if (requestedRollupMode === "PER" && isPerStrictOpaqueModeEnabled()) {
                    logger.warn("per_plaintext_offer_bootstrap_blocked", {
                        agent_id,
                        requestedRollupMode,
                    });
                    eventBus.publish("middleman_response", {
                        ticket_id: ticket_id || "rollup_bootstrap",
                        content: "Strict PER mode does not allow bootstrapping deals from plaintext WebSocket offers. Create or accept a PER marketplace offer first, then finalize private terms with submitRollupTerms() and finalizeRollupConsensus().",
                        phase: "rollup_negotiation",
                        timestamp: new Date().toISOString(),
                    });
                    return;
                }

                const newTicketId = payload.ticket_id || `TCK-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

                // For an offer, the creator is the buyer initially. Note: we wait for counter-parties to join.
                eventBus.publish("offer_detected", {
                    offer_id: `OFF-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
                    type: "sell", // Assume sell offer by default, can be derived later
                    creator: agent_id,
                    content: `Price: ${payload.price}, ColBuyer: ${payload.collateral_buyer}, ColSeller: ${payload.collateral_seller}`,
                    timestamp: new Date(timestamp).toISOString()
                });

                // Initialize ticket in DB. In reality, a "match" is needed, but for OTC we can create a pending ticket
                // and let a second party join. If it's a direct offer, we just track it.
                await ticketStore.createTicket({
                    ticket_id: newTicketId,
                    offer_id: "",
                    buyer: agent_id,
                    seller: "pending", // To be filled by the other party
                    status: "active",
                    rollup_mode: requestedRollupMode,
                    created_at: new Date(timestamp).toISOString()
                });

                eventBus.publish("middleman_response", {
                    ticket_id: newTicketId,
                    content: `Offer received from ${agent_id}. Ticket created: ${newTicketId}. Waiting for counter-party.`,
                    phase: "negotiation",
                    timestamp: new Date().toISOString()
                });

                const mappedAgent = await walletRegistry.getOrCreateAgent(agent_id);

                // Seed the initial terms into the NLP engine!
                await negotiationStore.addNegotiationStep(newTicketId, {
                    price: (payload as any).price,
                    collateral_buyer: (payload as any).collateral_buyer,
                    collateral_seller: (payload as any).collateral_seller,
                    agreement_signal: false,
                    agreement_score: 10
                }, mappedAgent.id, "Initial terms offered.");

                return;
            }

            // 2. All other message types require an existing ticket
            if (!ticket_id) {
                logger.warn("missing_ticket_id", { agent_id, type });
                return;
            }

            // Automatically join the ticket if the seller slot is pending
            const ticket = await ticketStore.getTicket(ticket_id);

            if (ticket?.rollup_mode && ticket.rollup_mode !== "NONE" && type === "status") {
                await magicBlockSessions.resendReady(ticket_id, agent_id).catch((error: any) => {
                    logger.warn("rollup_ready_resend_failed", {
                        ticket_id,
                        agent_id,
                        error: error?.message || String(error),
                    });
                });
                await confidentialFundingService.resendPendingRequests(ticket_id, agent_id).catch((error: any) => {
                    logger.warn("confidential_funding_resend_failed", {
                        ticket_id,
                        agent_id,
                        error: error?.message || String(error),
                    });
                });
                await releaseApprovalService.resendPendingRequests(ticket_id, agent_id).catch((error: any) => {
                    logger.warn("release_approval_resend_failed", {
                        ticket_id,
                        agent_id,
                        error: error?.message || String(error),
                    });
                });
            }

            // Resolve the internal UUID back to the wallet pubkey for comparison
            // ticket.buyer / ticket.seller are wallet pubkeys, but agent_id is an internal UUID
            const agentRecord = await walletRegistry.getAgentById(agent_id);
            const agentWallet = agentRecord?.wallet || agent_id;

            if (ticket && ticket.seller === "pending" && ticket.buyer !== agentWallet) {
                const buyerAgent = await walletRegistry.getOrCreateAgent(ticket.buyer);
                const buyerRequestedMode = sessionManager.getRequestedRollupModeByAgent(buyerAgent.id);
                const sellerRequestedMode = sessionManager.getRequestedRollupModeByAgent(agent_id);
                const rollupMode = mergeRollupModes(
                    ticket.rollup_mode || "NONE",
                    mergeRollupModes(buyerRequestedMode, sellerRequestedMode)
                );

                await ticketStore.createTicket({
                    ticket_id: ticket.ticket_id,
                    offer_id: ticket.offer_id,
                    buyer: ticket.buyer,
                    seller: agentWallet, // counter-party joined using wallet pubkey
                    status: "active",
                    rollup_mode: rollupMode,
                    created_at: ticket.created_at
                });

                eventBus.publish("middleman_response", {
                    ticket_id: ticket_id,
                    content: `Agent ${agentWallet.substring(0, 8)}... has joined the negotiation.`,
                    phase: "negotiation",
                    timestamp: new Date().toISOString()
                });

                logger.info("seller_joined_ticket", { ticket_id, agent_id, wallet: agentWallet });

                if (rollupMode === "ER" || rollupMode === "PER") {
                    eventBus.publish("negotiation_ready", {
                        ticketId: ticket.ticket_id,
                        buyer: ticket.buyer,
                        seller: agentWallet,
                        rollupMode,
                    });
                    logger.info("rollup_negotiation_ready", {
                        ticket_id,
                        buyer: ticket.buyer,
                        seller: agentWallet,
                        rollupMode,
                    });
                }
            }

            if (
                ticket &&
                ticket.rollup_mode === "PER" &&
                isPerStrictOpaqueModeEnabled() &&
                (type === "counter" || type === "accept") &&
                (payload as any).metadata?.transport !== "rollup"
            ) {
                logger.warn("per_plaintext_negotiation_message_blocked", {
                    ticket_id,
                    rollupMode: ticket.rollup_mode,
                    type,
                    agent_id,
                });
                eventBus.publish("middleman_response", {
                    ticket_id,
                    content: "PER term negotiation must happen through the rollup SDK methods. Plain counter/accept messages are disabled in strict private mode.",
                    phase: "rollup_negotiation",
                    timestamp: new Date().toISOString(),
                });
                return;
            }

            if (
                ticket &&
                ticket.rollup_mode &&
                ticket.rollup_mode !== "NONE" &&
                ((type === "counter" || type === "accept") && (payload as any).metadata?.transport === "rollup")
            ) {
                logger.info("rollup_transport_terms_ignored", {
                    ticket_id,
                    rollupMode: ticket.rollup_mode,
                    type,
                    agent_id,
                });
                return;
            }

            if (
                ticket &&
                ticket.rollup_mode &&
                ticket.rollup_mode !== "NONE" &&
                type === "message" &&
                typeof (payload as any).content === "string" &&
                looksLikeSensitiveRollupTerms((payload as any).content)
            ) {
                logger.warn("rollup_sensitive_plaintext_message_blocked", {
                    ticket_id,
                    rollupMode: ticket.rollup_mode,
                    agent_id,
                });
                eventBus.publish("middleman_response", {
                    ticket_id,
                    content: "Sensitive negotiation terms are blocked from plain chat during rollup sessions. Use the rollup session methods instead.",
                    phase: "rollup_negotiation",
                    timestamp: new Date().toISOString(),
                });
                return;
            }

            // 3. Route specific types into the primary AI pipeline
            if (type === "message" || type === "counter" || type === "accept" || type === "dispute") {

                let contentStr = "";
                if (type === "message" || type === "dispute") {
                    contentStr = (payload as any).content;
                } else if (type === "counter") {
                    contentStr = `I counter with price: ${(payload as any).price}`;
                } else if (type === "accept") {
                    contentStr = "I accept the deal.";
                }

                eventBus.publish("message_received", {
                    message_id: `msg-${uuidv4()}`,
                    ticket_id: ticket_id,
                    sender: agent_id,
                    senderWallet: agentWallet,
                    content: contentStr,
                    timestamp: new Date(timestamp).toISOString()
                });
            }

        } catch (e: any) {
            logger.error("agent_message_routing_error", {}, e);
        }
    });

    logger.info("agent_message_listener_initialized");
}
