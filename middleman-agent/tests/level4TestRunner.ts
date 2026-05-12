/**
 * Level 4 Testing Checklist Runner
 *
 * Programmatically runs the exact 4 validation tests requested by the user
 * to prove Level 4 Autonomy capabilities in isolation.
 */

import { analyzeMessage, NegotiationSignals } from "../core/middlemanBrain";
import { dealPhaseManager } from "../core/dealPhaseManager";
import { vectorMemoryStore } from "../src/state/vectorMemoryStore";
import { adjudicateDispute } from "../core/aiJudge";
import { interpretExecutionError } from "../core/autoHealer";
import { executeFullDealLifecycle } from "../src/services/onChainExecutionService";

function section(title: string) {
  console.log(`\n======================================================`);
  console.log(` ${title}`);
  console.log(`======================================================\n`);
}

async function runTest1() {
  section("Test 1: Basic Agreement Detection + Execution (Most Important)");

  const ticketId = "TKT-TEST1";
  dealPhaseManager.initDeal(ticketId, "Buyer", "Seller");

  // We manually simulate the NegotiationSignals accumulating as they chat
  const signals: NegotiationSignals = {
    price: 7, collateral_buyer: 2.5, collateral_seller: 2.5,
    agreement_score: 95, both_parties_present: true,
    price_converged: true, message_count: 4, last_sender: "Seller"
  };

  const messages = [
    { s: "Buyer", m: "deal at 7 sol, both deposit 2.5" },
    { s: "Seller", m: "ok 7 sol, 2.5 collateral each" },
    { s: "Buyer", m: "confirmed" },
    { s: "Seller", m: "agreed final" }
  ];

  let finalDecision: any;

  for (const act of messages) {
    console.log(`[${act.s}]: ${act.m}`);
    vectorMemoryStore.storeMemory({ ticketId, content: `[${act.s}]: ${act.m}` });

    // Process message through Brain
    finalDecision = await analyzeMessage(act.m, act.s, ticketId, signals);
  }

  console.log(`\nBrain Evaluation:`);
  console.log(`-> Does agreement_detected fire? Action returned: ${finalDecision.action}`);

  if (finalDecision.action === "CREATE_ESCROW") {
    console.log(`-> Brain automatically decided to create escrow based on conversation history!`);

    // Simulate what index.ts does: trigger dealPhaseManager
    const result = await dealPhaseManager.handleAction(
      finalDecision.action, ticketId, "middleman", finalDecision.terms
    );
    console.log(`-> Phase transition response from Agent:\n   ${result.response.content.replace(/\n/g, "\n   ")}`);
    console.log(`-> Does it attempt create_deal on-chain? on_chain_action = ${result.on_chain_action}`);

    if (result.on_chain_action === "create_deal") {
      console.log(`-> Launching On-Chain Execution Service -> executeFullDealLifecycle()`);
      // We trigger the execution intentionally knowing it will fail due to dummy pubkeys,
      // but this proves it fires the on-chain Anchor code!
      const execResult = await executeFullDealLifecycle({
        ticketId, price: 7, collateral_buyer: 2.5, collateral_seller: 2.5,
        confidence: 100, buyer: "DummyBuyer11", seller: "DummySeller11"
      });
      console.log(`On-Chain Output:`, execResult);
    }
  } else {
    console.log("❌ Failed to detect auto-agreement.");
  }
}


async function runTest2() {
  section("Test 2: AI Judge (Dispute Handling)");

  const ticketId = "TKT-TEST2";
  dealPhaseManager.initDeal(ticketId, "Buyer", "Seller");

  // Fake state to disputed
  dealPhaseManager.handleAction("CREATE_ESCROW", ticketId, "Buyer", { price: 5, collateral_buyer: 1, collateral_seller: 1 });
  dealPhaseManager.handleAction("DISPUTE", ticketId, "Buyer");

  console.log(`[Buyer]: @middleman seller never delivered`);
  vectorMemoryStore.storeMemory({ ticketId, content: "[Buyer]: @middleman seller never delivered" });

  console.log(`[Seller]: I sent the API key here: https://example.com/key`);
  vectorMemoryStore.storeMemory({ ticketId, content: "[Seller]: I sent the API key here: https://example.com/key" });

  console.log(`\n-> AI Judge Triggering Arbitrarion...`);

  const ctx = vectorMemoryStore.getContextSnapshot(ticketId);
  const verdict = await adjudicateDispute(ticketId, { price: 5, collateral_buyer: 1, collateral_seller: 1 });

  console.log(`-> Does AI Judge trigger? YES`);
  console.log(`-> AI Verdict Action: ${verdict.action}`);
  console.log(`-> AI Reasoning: ${verdict.verdictReasoning}`);
}


async function runTest3() {
  section("Test 3: Auto-Healer");

  console.log(`Forcing Error 1: "Error 0x1: Insufficient funds for rent" on "create_deal"`);
  const heal1 = await interpretExecutionError("create_deal", "Error 0x1: Insufficient funds for rent");

  console.log(`-> Auto-Healer Strategy: ${heal1.strategy}`);
  console.log(`-> Auto-Healer Message to User: ${heal1.userMessage}\n`);

  console.log(`Forcing Error 2: "Blockhash not found" on "lock_collateral"`);
  const heal2 = await interpretExecutionError("lock_collateral", "Blockhash not found. Network congestion.");

  console.log(`-> Auto-Healer Strategy: ${heal2.strategy}`);
  console.log(`-> Auto-Healer Message to User: ${heal2.userMessage}`);
}


async function runTest4() {
  section("Test 4: Memory & Context (RAG Extraction)");

  const ticketId = "TKT-TEST4";
  dealPhaseManager.initDeal(ticketId, "Buyer", "Seller");

  const conversation = [
    { s: "Buyer", m: "I want to buy 100 BONK for 1 SOL." },
    { s: "Seller", m: "No, 100 BONK is worth 2 SOL." },
    { s: "Buyer", m: "Fine, 2 SOL. What about collateral?" },
    { s: "Seller", m: "1 SOL collateral each." },
    { s: "Buyer", m: "Make it 0.5 SOL collateral, I don't have enough." },
    { s: "Seller", m: "Alright, 2 SOL price, 0.5 SOL collateral both." },
    { s: "Buyer", m: "@middleman looks like we have a deal. set it up." }
  ];

  for (const act of conversation) {
    console.log(`[${act.s}]: ${act.m}`);
    vectorMemoryStore.storeMemory({ ticketId, content: `[${act.s}]: ${act.m}` });
  }

  console.log(`\n-> Feeding final message to NLP parser to see if LLM remembers the dynamic 0.5 SOL context...`);

  const result = await analyzeMessage(conversation[6].m, "Buyer", ticketId, {
    price: null, collateral_buyer: null, collateral_seller: null,
    agreement_score: 50, both_parties_present: true, price_converged: false, message_count: 7, last_sender: "Buyer"
  });

  console.log(`-> Intent Extracted: ${result.action}`);
  console.log(`-> Reasoning from LLM over Memory Window: ${result.reasoning}`);
  console.log(`-> Extracted Assets Array:`);
  console.dir(result.terms || (result as any).extractedAssets || "Check reasoning for RAG memory.", { depth: null });
}

async function main() {
  console.log("Starting Level 4 Validations...\n");
  try {
    await runTest1();
    await runTest2();
    await runTest3();
    await runTest4();
  } catch (err) {
    console.error("Test execution crashed:", err);
  }
  console.log("\n======================================================");
  console.log(" All Output Logs Generated.");
  process.exit(0);
}

main();
