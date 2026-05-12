/**
 * Hybrid Intent Classifier
 *
 * Combines DETERMINISTIC regex parser (fast, safe) with LLM reasoning
 * (flexible, smart) to produce a final trusted decision.
 *
 * Decision hierarchy:
 *   1. Strong parser signal → trust parser, skip LLM
 *   2. Weak parser signal   → call LLM, merge results (hybrid)
 *   3. No parser signal     → use LLM only
 *   4. Safety filter        → reject low-confidence LLM results
 *
 * PURE DECISION LAYER — no execution, no mutations, no events.
 */

import { ticketStore } from "../../store/ticketStore";
import { parseMessage, calculateAgreementScore, ParsedResult } from "../parserService";
import { analyzeNegotiation, LLMResult } from "./llmService";

// ==========================================
// TYPES
// ==========================================

export type IntentType = "negotiate" | "agree" | "confirm" | "cancel" | "unknown";

export type IntentResult = {
  final_intent: IntentType;
  confidence: number; // 0–100
  source: "parser" | "llm" | "hybrid";
  terms?: {
    price?: number;
    collateral_buyer?: number;
    collateral_seller?: number;
  };
  reasoning?: string;
};

// ==========================================
// SAFE FALLBACK
// ==========================================

const FALLBACK_RESULT: IntentResult = {
  final_intent: "unknown",
  confidence: 0,
  source: "parser",
};

// ==========================================
// PARSER ANALYSIS
// ==========================================

interface ParserSignal {
  intent: IntentType;
  confidence: number;
  price: number | null;
  collateral_buyer: number | null;
  collateral_seller: number | null;
  hasBothParties: boolean;
  agreementScore: number;
}

function analyzeWithParser(messages: { sender: string; content: string }[]): ParserSignal {
  if (messages.length === 0) {
    return {
      intent: "unknown",
      confidence: 0,
      price: null,
      collateral_buyer: null,
      collateral_seller: null,
      hasBothParties: false,
      agreementScore: 0,
    };
  }

  // Track per-party signals
  const senders = new Set<string>();
  let latestPrice: number | null = null;
  let latestColBuyer: number | null = null;
  let latestColSeller: number | null = null;

  let partyPrices: Record<string, number> = {};
  let strongSignals = 0;
  let cancelSignals = 0;

  const allContents: string[] = [];

  for (const msg of messages) {
    senders.add(msg.sender);
    allContents.push(msg.content);

    const parsed = parseMessage(msg.content);

    // Track latest terms
    if (parsed.price !== null) {
      latestPrice = parsed.price;
      partyPrices[msg.sender] = parsed.price;
    }
    if (parsed.collateral_buyer !== null) latestColBuyer = parsed.collateral_buyer;
    if (parsed.collateral_seller !== null) latestColSeller = parsed.collateral_seller;

    // Count strong agreement signals
    if (parsed.agreement_score >= 40) strongSignals++;

    // Detect cancel intent
    const lower = msg.content.toLowerCase();
    if (lower.includes("cancel") || lower.includes("abort") || lower.includes("forget it") || lower.includes("no deal")) {
      cancelSignals++;
    }
  }

  const hasBothParties = senders.size >= 2;
  const agreementScore = calculateAgreementScore(allContents);

  // Check price convergence
  const priceValues = Object.values(partyPrices);
  const pricesConverged = priceValues.length >= 2
    ? priceValues.every(p => p === priceValues[0])
    : priceValues.length === 1;

  // DETERMINE INTENT
  let intent: IntentType = "unknown";
  let confidence = 0;

  if (cancelSignals > 0) {
    // Cancel detected
    intent = "cancel";
    confidence = Math.min(90, 60 + cancelSignals * 15);
  } else if (
    hasBothParties &&
    pricesConverged &&
    latestPrice !== null &&
    latestColBuyer !== null &&
    latestColSeller !== null &&
    strongSignals >= 2 &&
    agreementScore >= 60
  ) {
    // STRONG CONFIRM: both parties, matching terms, strong signals
    intent = "confirm";
    confidence = Math.min(100, 85 + Math.floor(agreementScore / 10));
  } else if (
    hasBothParties &&
    strongSignals >= 1 &&
    latestPrice !== null &&
    agreementScore >= 40
  ) {
    // AGREE: one party confirmed, terms exist
    intent = "agree";
    confidence = Math.min(85, 50 + agreementScore / 2);
  } else if (latestPrice !== null || latestColBuyer !== null) {
    // NEGOTIATE: terms mentioned but no agreement yet
    intent = "negotiate";
    confidence = Math.min(70, 30 + (latestPrice ? 20 : 0) + (latestColBuyer ? 10 : 0));
  }

  return {
    intent,
    confidence,
    price: latestPrice,
    collateral_buyer: latestColBuyer,
    collateral_seller: latestColSeller,
    hasBothParties,
    agreementScore,
  };
}

// ==========================================
// TERM MERGE (parser priority)
// ==========================================

function mergeTerms(
  parser: ParserSignal,
  llm: LLMResult
): IntentResult["terms"] | undefined {
  const terms: IntentResult["terms"] = {};

  // Prefer parser values (deterministic), fill gaps with LLM
  terms.price = parser.price ?? llm.extracted_terms?.price;
  terms.collateral_buyer = parser.collateral_buyer ?? llm.extracted_terms?.collateral_buyer;
  terms.collateral_seller = parser.collateral_seller ?? llm.extracted_terms?.collateral_seller;

  // Only return terms if at least one value exists
  if (terms.price || terms.collateral_buyer || terms.collateral_seller) {
    return terms;
  }
  return undefined;
}

// ==========================================
// MAIN FUNCTION
// ==========================================

/**
 * Classify the intent for a negotiation ticket.
 *
 * PURE DECISION LAYER — no execution, no mutations, no events.
 *
 * @param ticketId - The ticket to analyze
 * @returns Structured intent result with confidence and source
 */
export async function classifyIntent(ticketId: string): Promise<IntentResult> {
  console.log(`[IntentClassifier] Ticket: ${ticketId}`);

  // ── Edge case: missing ticket ──
  const ticket = await ticketStore.getTicket(ticketId);
  if (!ticket) {
    console.log(`[IntentClassifier] Ticket not found: ${ticketId}`);
    return FALLBACK_RESULT;
  }

  // ── Get last 10-20 messages ──
  const history = ticket.negotiation_history || [];
  const recentMessages = history.slice(-15).map((h: any) => ({
    sender: h.sender,
    content: h.message,
  }));

  if (recentMessages.length === 0) {
    console.log(`[IntentClassifier] No messages in ticket: ${ticketId}`);
    return FALLBACK_RESULT;
  }

  // ══════════════════════════════════════
  // STEP 1: RUN PARSER (always runs)
  // ══════════════════════════════════════
  const parserResult = analyzeWithParser(recentMessages);

  console.log(`[IntentClassifier] Parser Result:`, JSON.stringify({
    intent: parserResult.intent,
    confidence: parserResult.confidence,
    price: parserResult.price,
    collateral_buyer: parserResult.collateral_buyer,
    collateral_seller: parserResult.collateral_seller,
    agreementScore: parserResult.agreementScore,
    hasBothParties: parserResult.hasBothParties,
  }));

  // ══════════════════════════════════════
  // DECISION: STRONG PARSER SIGNAL (≥80)
  // Skip LLM entirely — parser is confident
  // ══════════════════════════════════════
  if (parserResult.confidence >= 80) {
    const result: IntentResult = {
      final_intent: parserResult.intent,
      confidence: parserResult.confidence,
      source: "parser",
      terms: {
        price: parserResult.price ?? undefined,
        collateral_buyer: parserResult.collateral_buyer ?? undefined,
        collateral_seller: parserResult.collateral_seller ?? undefined,
      },
      reasoning: `Parser high confidence (${parserResult.confidence}). Agreement score: ${parserResult.agreementScore}. LLM not needed.`,
    };

    // Clean undefined terms
    if (!result.terms?.price && !result.terms?.collateral_buyer && !result.terms?.collateral_seller) {
      delete result.terms;
    }

    console.log(`[IntentClassifier] Final Decision:`, JSON.stringify(result));
    return result;
  }

  // ══════════════════════════════════════
  // DECISION: WEAK/UNCERTAIN (40-79) → CALL LLM
  // ══════════════════════════════════════
  let llmResult: LLMResult | null = null;

  if (parserResult.confidence >= 40 || parserResult.confidence === 0) {
    console.log(`[IntentClassifier] Parser uncertain (${parserResult.confidence}). Calling LLM...`);

    try {
      const formattedMessages = recentMessages.map((m: any) => `${m.sender}: ${m.content}`);
      llmResult = await analyzeNegotiation(formattedMessages);

      console.log(`[IntentClassifier] LLM Result:`, JSON.stringify({
        intent: llmResult.intent,
        confidence: llmResult.confidence,
        extracted_terms: llmResult.extracted_terms,
        reasoning: llmResult.reasoning,
      }));
    } catch (error: any) {
      console.error(`[IntentClassifier] LLM failed: ${error.message}`);
      // LLM failure — fall through to parser-only result
    }
  }

  // ══════════════════════════════════════
  // STEP 4: SAFETY FILTER
  // If LLM confidence < 60, force unknown
  // ══════════════════════════════════════
  if (llmResult && llmResult.confidence < 60 && parserResult.confidence < 40) {
    const result: IntentResult = {
      final_intent: "unknown",
      confidence: Math.max(parserResult.confidence, llmResult.confidence),
      source: "hybrid",
      reasoning: `LLM confidence too low (${llmResult.confidence}) and parser weak (${parserResult.confidence}). Safety filter applied.`,
    };
    console.log(`[IntentClassifier] Final Decision:`, JSON.stringify(result));
    return result;
  }

  // ══════════════════════════════════════
  // STEP 2: WEAK/UNCERTAIN → HYBRID MERGE
  // Parser has some signal, LLM provides second opinion
  // ══════════════════════════════════════
  if (parserResult.confidence >= 40 && llmResult) {
    let finalIntent: IntentType;
    let finalConfidence: number;

    if (parserResult.intent === llmResult.intent) {
      // AGREEMENT: both sources agree → boost confidence
      finalIntent = parserResult.intent;
      finalConfidence = Math.min(100, Math.round(
        (parserResult.confidence * 0.6 + llmResult.confidence * 0.4)
      ));
    } else {
      // DISAGREEMENT: reduce confidence, prefer parser
      finalIntent = parserResult.intent;
      finalConfidence = Math.round(
        (parserResult.confidence * 0.7 + llmResult.confidence * 0.3) * 0.8
      );
    }

    const terms = mergeTerms(parserResult, llmResult);

    const result: IntentResult = {
      final_intent: finalIntent,
      confidence: finalConfidence,
      source: "hybrid",
      terms,
      reasoning: `Hybrid: Parser=${parserResult.intent}(${parserResult.confidence}), LLM=${llmResult.intent}(${llmResult.confidence}). ${
        parserResult.intent === llmResult.intent ? "Sources agree." : "Sources disagree — trusting parser."
      }`,
    };

    console.log(`[IntentClassifier] Final Decision:`, JSON.stringify(result));
    return result;
  }

  // ══════════════════════════════════════
  // STEP 3: NO PARSER SIGNAL → LLM ONLY
  // Parser returned nothing useful
  // ══════════════════════════════════════
  if (llmResult && llmResult.confidence >= 60) {
    const terms: IntentResult["terms"] = {};
    if (llmResult.extracted_terms?.price) terms.price = llmResult.extracted_terms.price;
    if (llmResult.extracted_terms?.collateral_buyer) terms.collateral_buyer = llmResult.extracted_terms.collateral_buyer;
    if (llmResult.extracted_terms?.collateral_seller) terms.collateral_seller = llmResult.extracted_terms.collateral_seller;

    const result: IntentResult = {
      final_intent: llmResult.intent as IntentType,
      confidence: llmResult.confidence,
      source: "llm",
      terms: Object.keys(terms).length > 0 ? terms : undefined,
      reasoning: `LLM only: Parser had no signal. LLM=${llmResult.intent}(${llmResult.confidence}). ${llmResult.reasoning}`,
    };

    console.log(`[IntentClassifier] Final Decision:`, JSON.stringify(result));
    return result;
  }

  // ══════════════════════════════════════
  // FALLBACK: Nothing worked
  // ══════════════════════════════════════
  const parserTerms: IntentResult["terms"] = {};
  if (parserResult.price) parserTerms.price = parserResult.price;
  if (parserResult.collateral_buyer) parserTerms.collateral_buyer = parserResult.collateral_buyer;
  if (parserResult.collateral_seller) parserTerms.collateral_seller = parserResult.collateral_seller;

  const result: IntentResult = {
    final_intent: parserResult.intent !== "unknown" ? parserResult.intent : "unknown",
    confidence: parserResult.confidence,
    source: "parser",
    terms: Object.keys(parserTerms).length > 0 ? parserTerms : undefined,
    reasoning: `Fallback: Parser=${parserResult.intent}(${parserResult.confidence}). LLM unavailable or too weak.`,
  };

  console.log(`[IntentClassifier] Final Decision:`, JSON.stringify(result));
  return result;
}

// ==========================================
// TEST FUNCTION
// ==========================================

async function testIntentClassifier() {
  console.log("\n═══════════════════════════════════════");
  console.log("  Intent Classifier — Test Run");
  console.log("═══════════════════════════════════════\n");

  // Set up a test ticket with negotiation history
  await ticketStore.createTicket({
    id: "test-ticket-1",
    buyer: "BuyerAgent",
    seller: "SellerAgent",
  });

  // Simulate messages
  const messages = [
    { sender: "SellerAgent", content: "deal at 7 sol, both deposit 3" },
    { sender: "BuyerAgent", content: "can we do 6 sol?" },
    { sender: "SellerAgent", content: "ok 6 sol final, both deposit 3" },
    { sender: "BuyerAgent", content: "agreed, confirmed, let's do it" },
  ];

  for (const msg of messages) {
    await ticketStore.updateTicketMemory("test-ticket-1", {
      sender: msg.sender,
      content: msg.content,
      timestamp: Date.now(),
    });
  }

  // Test 1: Strong agreement (should use parser only)
  console.log("\n--- Test 1: Strong Agreement (expect parser, confirm) ---");
  const result1 = await classifyIntent("test-ticket-1");
  console.log("Result:", result1);

  // Test 2: Weak signal (should use hybrid)
  await ticketStore.createTicket({
    id: "test-ticket-2",
    buyer: "BuyerB",
    seller: "SellerB",
  });
  await ticketStore.updateTicketMemory("test-ticket-2", {
    sender: "SellerB",
    content: "I have a dataset, maybe around 5 sol",
    timestamp: Date.now(),
  });
  await ticketStore.updateTicketMemory("test-ticket-2", {
    sender: "BuyerB",
    content: "sounds interesting, let me think about it",
    timestamp: Date.now(),
  });

  console.log("\n--- Test 2: Weak Signal (expect hybrid/llm) ---");
  const result2 = await classifyIntent("test-ticket-2");
  console.log("Result:", result2);

  // Test 3: Missing ticket
  console.log("\n--- Test 3: Missing Ticket (expect fallback) ---");
  const result3 = await classifyIntent("nonexistent-ticket");
  console.log("Result:", result3);

  console.log("\n═══════════════════════════════════════");
  console.log("  Tests Complete");
  console.log("═══════════════════════════════════════\n");
}

if (require.main === module) {
  testIntentClassifier().catch(console.error);
}
