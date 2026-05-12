/**
 * NLP Command Flow Test (Level 3 - Async Async/Await GenAI)
 *
 * Tests the NLP-based middleman intelligence:
 *   1. NLP keyword intent detection (OpenAI GenAI)
 *   2. Always-on brain analysis (auto-agreement + @middleman mentions)
 *   3. Deal phase transitions via NLP actions
 *   4. Permission and phase validation
 */

import { analyzeMiddlemanMention } from "../core/commandParser";
import { analyzeMessage, NegotiationSignals } from "../core/middlemanBrain";
import { dealPhaseManager } from "../core/dealPhaseManager";
import { DealTerms } from "../core/outboundMessenger";

let passed = 0;
let failed = 0;

function assert(test: string, condition: boolean, detail?: string): void {
  if (condition) { console.log(`  ✅ ${test}`); passed++; }
  else { console.log(`  ❌ ${test}${detail ? ` — ${detail}` : ""}`); failed++; }
}

function section(title: string): void {
  console.log(`\n═══ ${title} ═══`);
}

async function runTests() {
  // ==========================================
  // TEST 1: NLP Intent Detection (Natural Language)
  // ==========================================

  section("TEST 1: NLP Natural Language Intent Detection");

  // Execute/Start deal — various natural phrasings
  const r1 = await analyzeMiddlemanMention("hey @middleman we agreed, lets go", "Buyer", "T1");
  assert("'lets go' → EXECUTE_DEAL", r1.intent === "EXECUTE_DEAL");

  const r2 = await analyzeMiddlemanMention("@middleman we've completed negotiation, proceed", "Buyer", "T1");
  assert("'proceed' → EXECUTE_DEAL", r2.intent === "EXECUTE_DEAL");

  const r3 = await analyzeMiddlemanMention("@middleman do it, create the escrow", "Buyer", "T1");
  assert("'do it, create the escrow' → EXECUTE_DEAL", r3.intent === "EXECUTE_DEAL");

  // Release funds — buyer confirms receipt
  const r4 = await analyzeMiddlemanMention("@middleman everything good, I received the credentials", "Buyer", "T1");
  assert("'everything good, received' → RELEASE_FUNDS", r4.intent === "RELEASE_FUNDS");

  const r5 = await analyzeMiddlemanMention("@middleman got it, all good, verified", "Buyer", "T1");
  assert("'got it, all good, verified' → RELEASE_FUNDS", r5.intent === "RELEASE_FUNDS");

  // Cancel — wants to walk away
  const r6 = await analyzeMiddlemanMention("hey @middleman seller is wanting too much, can't agree, don't want this", "Buyer", "T1");
  assert("'cant agree, dont want' → CANCEL_DEAL", r6.intent === "CANCEL_DEAL");

  const r7 = await analyzeMiddlemanMention("@middleman forget it, not interested anymore", "Buyer", "T1");
  assert("'forget it, not interested' → CANCEL_DEAL", r7.intent === "CANCEL_DEAL");

  // Dispute — something wrong
  const r8 = await analyzeMiddlemanMention("@middleman the credentials don't work, this is fake", "Buyer", "T1");
  assert("'dont work, fake' → DISPUTE", r8.intent === "DISPUTE");

  const r9 = await analyzeMiddlemanMention("@middleman I didn't receive anything, this is a scam", "Buyer", "T1");
  assert("'didnt receive, scam' → DISPUTE", r9.intent === "DISPUTE");

  // Status check
  const r10 = await analyzeMiddlemanMention("@middleman where are we at? any update?", "Buyer", "T1");
  assert("'where are we, update' → CHECK_STATUS", r10.intent === "CHECK_STATUS");

  // No mention — regular chat
  const r11 = await analyzeMiddlemanMention("deal at 5 sol, collateral 2", "Buyer", "T1");
  assert("No @middleman → NONE", r11.intent === "NONE" && !r11.has_mention);

  // General mention with no clear intent
  const r12 = await analyzeMiddlemanMention("@middleman hello are you there?", "Buyer", "T1");
  assert("Unclear @middleman mention → GENERAL", r12.intent === "GENERAL");

  // ==========================================
  // TEST 2: Auto-Agreement Detection (Brain)
  // ==========================================

  section("TEST 2: Auto-Agreement Detection");

  dealPhaseManager.initDeal("T_AUTO", "Buyer", "Seller");

  // Low signals — should OBSERVE
  const lowSignals: NegotiationSignals = {
    price: 5, collateral_buyer: 2, collateral_seller: 2,
    agreement_score: 20, both_parties_present: false,
    price_converged: false, message_count: 1, last_sender: "Buyer",
  };
  const d1 = await analyzeMessage("deal at 5 sol", "Buyer", "T_AUTO", lowSignals);
  assert("Low signals → OBSERVE", d1.action === "OBSERVE");

  // Medium signals — still not enough
  const medSignals: NegotiationSignals = {
    price: 5, collateral_buyer: 2, collateral_seller: 2,
    agreement_score: 50, both_parties_present: true,
    price_converged: false, message_count: 3, last_sender: "Seller",
  };
  const d2 = await analyzeMessage("ok 5 sol sounds fair", "Seller", "T_AUTO", medSignals);
  assert("Medium signals, price not converged → OBSERVE", d2.action === "OBSERVE");

  // High signals — auto-agreement!
  const highSignals: NegotiationSignals = {
    price: 7, collateral_buyer: 2.5, collateral_seller: 2.5,
    agreement_score: 95, both_parties_present: true,
    price_converged: true, message_count: 5, last_sender: "Seller",
  };
  const d3 = await analyzeMessage("agreed, 7 sol final", "Seller", "T_AUTO", highSignals);
  assert("High signals → CREATE_ESCROW", d3.action === "CREATE_ESCROW");
  assert("Auto-triggered", d3.trigger === "auto_agreement");
  assert("Has terms", d3.terms?.price === 7 && d3.terms?.collateral_buyer === 2.5);

  // ==========================================
  // TEST 3: @middleman Mention → Brain → Phase Manager
  // ==========================================

  section("TEST 3: Full Brain → Phase Manager Flow");

  dealPhaseManager.initDeal("T_FLOW", "Buyer", "Seller");

  // Buyer mentions middleman wanting to start
  const flowSignals: NegotiationSignals = {
    price: 5, collateral_buyer: 2, collateral_seller: 2,
    agreement_score: 60, both_parties_present: true,
    price_converged: true, message_count: 4, last_sender: "Buyer",
  };
  const d4 = await analyzeMessage(
    "hey @middleman we agreed on everything, go ahead and create the escrow",
    "Buyer", "T_FLOW", flowSignals
  );
  assert("Mention detected → CREATE_ESCROW", d4.action === "CREATE_ESCROW");
  assert("Triggered by mention", d4.trigger === "mention");

  // Feed into phase manager
  const terms: DealTerms = { price: 5, collateral_buyer: 2, collateral_seller: 2 };
  const r13 = await dealPhaseManager.handleAction("CREATE_ESCROW", "T_FLOW", "Buyer", terms);
  assert("Phase manager accepts CREATE_ESCROW", r13.success);
  assert("Phase → escrow_created", dealPhaseManager.getPhase("T_FLOW") === "escrow_created");

  // Advance to delivery
  await dealPhaseManager.advanceToAwaitingDeposits("T_FLOW");
  await dealPhaseManager.recordDeposit("T_FLOW", "buyer");
  await dealPhaseManager.recordDeposit("T_FLOW", "seller");
  assert("Phase → delivery after deposits", dealPhaseManager.getPhase("T_FLOW") === "delivery");

  // Buyer confirms receipt via natural language
  const d5 = await analyzeMessage(
    "@middleman I got the credentials, everything looks good, release the payment",
    "Buyer", "T_FLOW", flowSignals
  );
  assert("Natural language → RELEASE_FUNDS", d5.action === "RELEASE_FUNDS");

  const r14 = await dealPhaseManager.handleAction("RELEASE_FUNDS", "T_FLOW", "Buyer");
  assert("Release succeeds", r14.success);
  assert("Phase → completed", dealPhaseManager.getPhase("T_FLOW") === "completed");

  // ==========================================
  // TEST 4: Permission & Phase Guards
  // ==========================================

  section("TEST 4: Permission & Phase Guards");

  dealPhaseManager.initDeal("T_GUARD", "Buyer", "Seller");

  // Seller tries to release in negotiation — brain catches it
  const d6 = await analyzeMessage("@middleman release it all", "Seller", "T_GUARD", lowSignals);
  assert("Brain catches invalid release → RESPOND_GENERAL", d6.action === "RESPOND_GENERAL");

  // Start deal, then try double start
  await dealPhaseManager.handleAction("CREATE_ESCROW", "T_GUARD", "Buyer", terms);
  const r16 = await dealPhaseManager.handleAction("CREATE_ESCROW", "T_GUARD", "Buyer", terms);
  assert("Double create → fails", !r16.success);

  // ==========================================
  // TEST 5: Dispute via Natural Language
  // ==========================================

  section("TEST 5: Dispute & Cancel via NLP");

  dealPhaseManager.initDeal("T_DISP", "Buyer", "Seller");
  await dealPhaseManager.handleAction("CREATE_ESCROW", "T_DISP", "Buyer", terms);

  const d7 = await analyzeMessage(
    "@middleman this is wrong, the seller gave me fake credentials, dispute!",
    "Buyer", "T_DISP", flowSignals
  );
  assert("NLP detects DISPUTE intent", d7.action === "DISPUTE");

  const r17 = await dealPhaseManager.handleAction("DISPUTE", "T_DISP", "Buyer");
  assert("Dispute succeeds", r17.success);
  assert("Phase → disputed", dealPhaseManager.getPhase("T_DISP") === "disputed");

  // Cancel via natural language
  dealPhaseManager.initDeal("T_CANC", "Buyer", "Seller");
  const d8 = await analyzeMessage(
    "@middleman forget it, I don't want this deal, not interested",
    "Buyer", "T_CANC", lowSignals
  );
  assert("NLP detects CANCEL intent", d8.action === "CANCEL_DEAL");

  const r18 = await dealPhaseManager.handleAction("CANCEL_DEAL", "T_CANC", "Buyer");
  assert("Cancel succeeds", r18.success);
  assert("Phase → cancelled", dealPhaseManager.getPhase("T_CANC") === "cancelled");

  // ==========================================
  // TEST 6: No @middleman = Pure Observation
  // ==========================================

  section("TEST 6: Silent Observation");

  dealPhaseManager.initDeal("T_SILENT", "Buyer", "Seller");

  const d9 = await analyzeMessage("offer 5 sol, collateral 2", "Buyer", "T_SILENT", lowSignals);
  assert("Regular msg → OBSERVE", d9.action === "OBSERVE");

  const d10 = await analyzeMessage("too low, 7 sol", "Seller", "T_SILENT", lowSignals);
  assert("Counter-offer → OBSERVE", d10.action === "OBSERVE");

  // ==========================================
  // SUMMARY
  // ==========================================

  console.log(`\n╔═══════════════════════════════════════════╗`);
  console.log(`║  Results: ${passed} passed, ${failed} failed${" ".repeat(Math.max(0, 20 - String(passed).length - String(failed).length))}║`);
  console.log(`╚═══════════════════════════════════════════╝`);
  console.log(failed === 0 ? "\n✅ ALL TESTS PASSED\n" : "\n❌ SOME TESTS FAILED\n");

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
