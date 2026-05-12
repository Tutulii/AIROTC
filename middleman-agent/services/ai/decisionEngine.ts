/**
 * Decision Engine
 *
 * Converts intent classification → actionable decisions.
 * Decides WHAT to do, NOT how to do it.
 *
 * Pure deterministic function:
 *   - No async operations
 *   - No LLM calls
 *   - No execution
 *   - No event emission
 *   - No ticket mutation
 *
 * Decision flow:
 *   1. Confidence too low?     → wait
 *   2. Still negotiating?      → suggest
 *   3. Cancel signal?          → abort
 *   4. Agreement/confirm?      → check required fields
 *      4a. Fields missing?     → wait (with missing_fields)
 *      4b. All complete?       → prepare_execution ✅
 */

// ==========================================
// TYPES
// ==========================================

export type ActionType = "wait" | "suggest" | "prepare_execution" | "abort";

export type DecisionInput = {
  ticketId: string;
  intent: "negotiate" | "agree" | "confirm" | "cancel" | "unknown";
  confidence: number;
  terms?: {
    price?: number;
    collateral_buyer?: number;
    collateral_seller?: number;
  };
};

export type DecisionOutput = {
  action: ActionType;
  reason: string;
  ready_for_execution: boolean;
  missing_fields?: string[];
};

// ==========================================
// SAFE FALLBACK
// ==========================================

const INVALID_INPUT_RESULT: DecisionOutput = {
  action: "wait",
  reason: "Invalid input",
  ready_for_execution: false,
};

// ==========================================
// CORE DECISION FUNCTION
// ==========================================

/**
 * Decides the next action based on intent classification.
 *
 * PURE DETERMINISTIC — no async, no side effects, no randomness.
 *
 * @param input - Intent result from the classifier
 * @returns Structured action plan
 */
export function decideNextAction(input: DecisionInput): DecisionOutput {
  // ── LOGGING ──
  console.log(`[DecisionEngine] Ticket: ${input.ticketId}`);
  console.log(`[DecisionEngine] Input:`, JSON.stringify(input));

  // ── EDGE CASE: Invalid input ──
  if (!input || !input.ticketId || !input.intent) {
    console.log(`[DecisionEngine] Output:`, JSON.stringify(INVALID_INPUT_RESULT));
    return INVALID_INPUT_RESULT;
  }

  if (typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 100) {
    const result: DecisionOutput = {
      action: "wait",
      reason: "Invalid confidence value",
      ready_for_execution: false,
    };
    console.log(`[DecisionEngine] Output:`, JSON.stringify(result));
    return result;
  }

  let decision: DecisionOutput;

  // ══════════════════════════════════════
  // CASE 1: NOT ENOUGH CONFIDENCE
  // ══════════════════════════════════════
  if (input.confidence < 70) {
    decision = {
      action: "wait",
      reason: `Low confidence (${input.confidence}%). Need ≥70% to act.`,
      ready_for_execution: false,
    };
    console.log(`[DecisionEngine] Output:`, JSON.stringify(decision));
    return decision;
  }

  // ══════════════════════════════════════
  // CASE 2: NEGOTIATION ONGOING
  // ══════════════════════════════════════
  if (input.intent === "negotiate") {
    decision = {
      action: "suggest",
      reason: "Negotiation in progress. Parties have not reached agreement yet.",
      ready_for_execution: false,
    };
    console.log(`[DecisionEngine] Output:`, JSON.stringify(decision));
    return decision;
  }

  // ══════════════════════════════════════
  // CASE 3: CANCEL SIGNAL
  // ══════════════════════════════════════
  if (input.intent === "cancel") {
    decision = {
      action: "abort",
      reason: "Cancel signal detected. A party wants to abort the deal.",
      ready_for_execution: false,
    };
    console.log(`[DecisionEngine] Output:`, JSON.stringify(decision));
    return decision;
  }

  // ══════════════════════════════════════
  // CASE 4: AGREEMENT / CONFIRM (CRITICAL PATH)
  // ══════════════════════════════════════
  if (input.intent === "agree" || input.intent === "confirm") {
    // Check REQUIRED fields
    const missing: string[] = [];

    if (!input.terms?.price) missing.push("price");
    if (!input.terms?.collateral_buyer) missing.push("collateral_buyer");
    if (!input.terms?.collateral_seller) missing.push("collateral_seller");

    // 4a: MISSING DATA
    if (missing.length > 0) {
      decision = {
        action: "wait",
        reason: `Missing required deal terms: ${missing.join(", ")}. Cannot execute until all terms are present.`,
        ready_for_execution: false,
        missing_fields: missing,
      };
      console.log(`[DecisionEngine] Output:`, JSON.stringify(decision));
      return decision;
    }

    // 4b: ALL COMPLETE — READY TO EXECUTE
    decision = {
      action: "prepare_execution",
      reason: `Agreement confirmed with complete terms. Price: ${input.terms!.price} SOL, Collateral: ${input.terms!.collateral_buyer}/${input.terms!.collateral_seller} SOL.`,
      ready_for_execution: true,
    };
    console.log(`[DecisionEngine] Output:`, JSON.stringify(decision));
    return decision;
  }

  // ══════════════════════════════════════
  // CASE 5: UNKNOWN INTENT
  // ══════════════════════════════════════
  decision = {
    action: "wait",
    reason: `Unknown intent: "${input.intent}". Waiting for clearer signals.`,
    ready_for_execution: false,
  };
  console.log(`[DecisionEngine] Output:`, JSON.stringify(decision));
  return decision;
}

// ==========================================
// TEST FUNCTION
// ==========================================

function testDecisionEngine() {
  console.log("\n═══════════════════════════════════════");
  console.log("  Decision Engine — Test Run");
  console.log("═══════════════════════════════════════\n");

  // Test 1: Full agreement with all terms
  console.log("--- Test 1: Complete Agreement (expect prepare_execution) ---");
  const r1 = decideNextAction({
    ticketId: "test-1",
    intent: "confirm",
    confidence: 90,
    terms: { price: 5, collateral_buyer: 2, collateral_seller: 2 },
  });
  console.log("→", r1.action, r1.ready_for_execution ? "🟢 READY" : "🔴 NOT READY");

  // Test 2: Low confidence
  console.log("\n--- Test 2: Low Confidence (expect wait) ---");
  const r2 = decideNextAction({
    ticketId: "test-2",
    intent: "confirm",
    confidence: 50,
    terms: { price: 5, collateral_buyer: 2, collateral_seller: 2 },
  });
  console.log("→", r2.action, r2.ready_for_execution ? "🟢 READY" : "🔴 NOT READY");

  // Test 3: Missing collateral
  console.log("\n--- Test 3: Missing Collateral (expect wait + missing_fields) ---");
  const r3 = decideNextAction({
    ticketId: "test-3",
    intent: "confirm",
    confidence: 85,
    terms: { price: 5 },
  });
  console.log("→", r3.action, "missing:", r3.missing_fields);

  // Test 4: Cancel
  console.log("\n--- Test 4: Cancel Intent (expect abort) ---");
  const r4 = decideNextAction({
    ticketId: "test-4",
    intent: "cancel",
    confidence: 90,
  });
  console.log("→", r4.action);

  // Test 5: Negotiating
  console.log("\n--- Test 5: Negotiation (expect suggest) ---");
  const r5 = decideNextAction({
    ticketId: "test-5",
    intent: "negotiate",
    confidence: 75,
    terms: { price: 8 },
  });
  console.log("→", r5.action);

  // Test 6: Unknown intent
  console.log("\n--- Test 6: Unknown Intent (expect wait) ---");
  const r6 = decideNextAction({
    ticketId: "test-6",
    intent: "unknown",
    confidence: 80,
  });
  console.log("→", r6.action);

  // Test 7: Invalid input
  console.log("\n--- Test 7: Invalid Input (expect wait) ---");
  const r7 = decideNextAction({} as any);
  console.log("→", r7.action);

  console.log("\n═══════════════════════════════════════");
  console.log("  Tests Complete");
  console.log("═══════════════════════════════════════\n");

  // Summary
  const allCorrect =
    r1.action === "prepare_execution" && r1.ready_for_execution === true &&
    r2.action === "wait" && r2.ready_for_execution === false &&
    r3.action === "wait" && r3.missing_fields?.includes("collateral_buyer") &&
    r4.action === "abort" &&
    r5.action === "suggest" &&
    r6.action === "wait" &&
    r7.action === "wait";

  console.log(allCorrect ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED");
}

if (require.main === module) {
  testDecisionEngine();
}
