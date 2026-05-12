import { ticketStore } from "../src/state/ticketStore";
import { negotiationStore } from "../src/state/negotiationStore";
import { detectAgreement } from "../services/agreementService";

async function runTests() {
    console.log("=== AgentOTC Negotiation Store PostgreSQL Verification ===");

    const ticketId = "TKT-NEG-001";

    // 1. Initialize Dummy Agent Wallets and Ticket
    await ticketStore.createTicket({
        ticket_id: ticketId,
        buyer: "BuyerWalletXYZ",
        seller: "SellerWalletABC",
        status: "active"
    } as any);

    console.log(`\n[Test 1] Initializing Postgres Ticket Strategy -> Success`);

    // 2. Insert Chronological Mock NLP Parse State
    await negotiationStore.addNegotiationStep(ticketId, { price: null, collateral_buyer: null, collateral_seller: null, agreement_signal: false } as any, "BuyerWalletXYZ", "Can you do 5 sol?");
    await negotiationStore.addNegotiationStep(ticketId, { price: 5, collateral_buyer: null, collateral_seller: null, agreement_signal: false } as any, "BuyerWalletXYZ", "I will buy for 5 sol.");
    await negotiationStore.addNegotiationStep(ticketId, { price: 8, collateral_buyer: 1, collateral_seller: 1, agreement_signal: false } as any, "SellerWalletABC", "Too low. 8 sol with 1 sol collateral each.");

    console.log(`[Test 2] Writing NLP vectors to Prisma relational rows...`);

    // 3. Verify Memory Engine Reconstruction
    const signals1 = await negotiationStore.getLatestSignals(ticketId);
    console.log("\n[Trace 1] Negotiation state mid-flight:");
    console.log(`Price converged: ${signals1.price_converged} | Both Parties: ${signals1.both_parties_present}`);

    // 4. Converge with Final Agreement
    await negotiationStore.addNegotiationStep(ticketId, { price: 8, collateral_buyer: 1, collateral_seller: 1, agreement_signal: true } as any, "BuyerWalletXYZ", "Fine, agreed. 8 sol with 1 collateral.");
    console.log(`\n[Test 3] Inserting Agreement Confirmed NLP Vectors`);

    const signals2 = await negotiationStore.getLatestSignals(ticketId);
    console.log("\n[Trace 2] Negotiation state post-agreement:");
    console.log(`Score: ${signals2.agreement_score} | Price Converged: ${signals2.price_converged}`);

    // 5. Test Global Agreement Engine hook
    console.log(`\n[Test 4] Dispatching Global detectAgreement Engine...`);
    const finalResult = await detectAgreement(ticketId);

    if (finalResult && finalResult.confidence >= 80) {
        console.log(`\n✅ FULL SYSTEM PASSED - Agent inferred deterministic execution bounds via strictly postgres data streams.`);
        console.log(finalResult);
    } else {
        console.error(`\n❌ FAILED - Agent could not parse its own logic across PostgreSQL rows.`);
        console.log(`Confidence returned as: ${finalResult?.confidence || 0}`);
    }
}

runTests().catch(console.error);
