/**
 * Integration Engine
 *
 * The orchestration layer that connects:
 *   Incoming Message → Intent Classifier → Decision Engine → Controlled Output
 *
 * This is a READ → THINK → LOG system.
 * It DOES NOT execute deals. It DOES NOT mutate state. It DOES NOT emit events.
 *
 * Pipeline:
 *   1. Load ticket
 *   2. Classify intent (parser + LLM hybrid)
 *   3. Run decision engine
 *   4. Log structured decision
 *   5. Handle outcome (observe only)
 */

import { ticketStore } from "../store/ticketStore";
import { classifyIntent, IntentResult } from "../services/ai/intentClassifier";
import { decideNextAction, DecisionOutput } from "../services/ai/decisionEngine";
import { logger } from "../src/utils/logger";

// ==========================================
// MAIN HANDLER
// ==========================================

export async function handleIncomingMessageAI(ticketId: string): Promise<void> {
  const log = logger.withContext({ ticket_id: ticketId });
  log.info("integration_processing_start");

  const ticket = await ticketStore.getTicket(ticketId);
  if (!ticket) {
    log.warn("integration_ticket_not_found");
    return;
  }

  const messageCount = ticket.negotiation_history?.length || 0;
  log.debug("integration_ticket_loaded", { message_count: messageCount, buyer: ticket.buyer, seller: ticket.seller });

  if (messageCount === 0) {
    log.debug("integration_no_messages");
    return;
  }

  // STEP 2: CLASSIFY INTENT
  let intentResult: IntentResult;
  try {
    intentResult = await classifyIntent(ticketId);
  } catch (error: any) {
    log.error("integration_intent_failed", {}, error);
    return;
  }

  // STEP 3: DECISION ENGINE
  let decision: DecisionOutput;
  try {
    decision = decideNextAction({
      ticketId,
      intent: intentResult.final_intent,
      confidence: intentResult.confidence,
      terms: intentResult.terms,
    });
  } catch (error: any) {
    log.error("integration_decision_failed", {}, error);
    return;
  }

  // STEP 4: STRUCTURED LOGGING
  log.info("agent_decision", {
    intent: {
      final_intent: intentResult.final_intent,
      confidence: intentResult.confidence,
      source: intentResult.source,
      terms: intentResult.terms,
      reasoning: intentResult.reasoning,
    },
    decision: {
      action: decision.action,
      reason: decision.reason,
      ready_for_execution: decision.ready_for_execution,
      missing_fields: decision.missing_fields,
    },
  });

  // STEP 5: CONTROLLED BEHAVIOR (NO EXECUTION)
  if (decision.action === "wait") {
    log.debug("integration_waiting", { reason: decision.reason, missing_fields: decision.missing_fields });
    return;
  }

  if (decision.action === "suggest") {
    log.debug("integration_suggestion", { reason: decision.reason });
    return;
  }

  if (decision.action === "abort") {
    log.warn("integration_aborted", { reason: decision.reason });
    return;
  }

  if (decision.ready_for_execution) {
    log.info("integration_deal_ready_dry_run", {
      price: intentResult.terms?.price,
      collateral_buyer: intentResult.terms?.collateral_buyer,
      collateral_seller: intentResult.terms?.collateral_seller,
      confidence: intentResult.confidence,
      source: intentResult.source,
    });
    return;
  }

  log.warn("integration_unhandled_state", { action: decision.action });
}

// ==========================================
// TEST: FULL NEGOTIATION SIMULATION
// ==========================================

async function testIntegrationEngine() {
  logger.info("integration_test_start");

  const TICKET_ID = "INT_TEST_1";

  await ticketStore.createTicket({
    id: TICKET_ID,
    buyer: "BuyerAgent",
    seller: "SellerAgent",
  });

  logger.debug("integration_test_message", { step: 1, description: "Seller opens negotiation" });
  await ticketStore.updateTicketMemory(TICKET_ID, {
    sender: "SellerAgent",
    content: "deal at 10 sol, both deposit 3",
    timestamp: Date.now(),
  });
  await handleIncomingMessageAI(TICKET_ID);

  logger.debug("integration_test_message", { step: 2, description: "Buyer counter-offers" });
  await ticketStore.updateTicketMemory(TICKET_ID, {
    sender: "BuyerAgent",
    content: "ok 9 sol? both deposit 3",
    timestamp: Date.now(),
  });
  await handleIncomingMessageAI(TICKET_ID);

  logger.debug("integration_test_message", { step: 3, description: "Seller accepts" });
  await ticketStore.updateTicketMemory(TICKET_ID, {
    sender: "SellerAgent",
    content: "fine 9 sol final, both deposit 3",
    timestamp: Date.now(),
  });
  await handleIncomingMessageAI(TICKET_ID);

  logger.debug("integration_test_message", { step: 4, description: "Buyer confirms" });
  await ticketStore.updateTicketMemory(TICKET_ID, {
    sender: "BuyerAgent",
    content: "agreed, confirmed, let's do it",
    timestamp: Date.now(),
  });
  await handleIncomingMessageAI(TICKET_ID);

  logger.info("integration_test_complete");
}

if (require.main === module) {
  testIntegrationEngine().catch((err) => logger.error("integration_test_failed", {}, err));
}
