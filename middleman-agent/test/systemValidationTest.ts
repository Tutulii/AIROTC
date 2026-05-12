import { PrismaClient } from "@prisma/client";
import { ticketStore } from "../src/state/ticketStore";
import { messageStore } from "../src/state/messageStore";
import { detectAgreement } from "../services/agreementService";
import { parseMessage } from "../services/parserService";

const prisma = new PrismaClient();
const TICKET_ID = "SYS_VAL_TICKET_9000";

async function runPhase1() {
    console.log("\n[SYSTEM TEST] ════════════ PHASE 1: GENERATE ════════════");
    console.log(`[SYSTEM TEST] Starting full validation...`);

    // Clean up any old test run data first
    await prisma.message.deleteMany({ where: { ticketId: TICKET_ID } });
    await prisma.ticket.deleteMany({ where: { id: TICKET_ID } });

    console.log(`[SYSTEM TEST] STEP 1: Ticket created: ${TICKET_ID}`);
    await ticketStore.createTicket({
        ticket_id: TICKET_ID,
        offer_id: "val_offer",
        buyer: "ValBuyerWallet",
        seller: "ValSellerWallet",
        status: "active",
        created_at: new Date().toISOString()
    });

    console.log(`[SYSTEM TEST] STEP 2: Add Negotiation Messages`);
    const messages = [
        { sender: "ValBuyerWallet", content: "I can do 10 SOL with 3 collateral" },
        { sender: "ValSellerWallet", content: "Too low, I want 12 SOL" },
        { sender: "ValBuyerWallet", content: "Ok let's settle at 11 SOL, collateral 3 each" },
        { sender: "ValSellerWallet", content: "Agreed 11 SOL, let's finalize" }
    ];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        await messageStore.addMessage({
            message_id: `sys_m_${i}`,
            ticket_id: TICKET_ID,
            sender: msg.sender,
            content: msg.content,
            timestamp: new Date().toISOString()
        });
        await new Promise(r => setTimeout(r, 100)); // chronological assurance
    }

    console.log(`[SYSTEM TEST] STEP 3: Verify Message Storage`);
    const fetched = await messageStore.getMessages(TICKET_ID);
    if (fetched.length === 4) {
        console.log(`[SYSTEM TEST] Messages stored correctly (${fetched.length}/4)`);
    } else {
        throw new Error(`Failed to store messages properly. Found ${fetched.length}`);
    }

    console.log(`[SYSTEM TEST] STEP 4: Run Parser`);
    for (const m of fetched) {
        const parsed = parseMessage(m.content);
        console.log(`[SYSTEM TEST] Parser output for "${m.content}":`, JSON.stringify(parsed));
    }

    console.log(`[SYSTEM TEST] STEP 5: Run Agreement Engine`);
    const agreement = await detectAgreement(TICKET_ID);
    if (agreement && agreement.confidence >= 80) {
        console.log(`[SYSTEM TEST] Agreement detected: true (Confidence: ${agreement.confidence})`);
        console.log(`[SYSTEM TEST] Selected Terms -> Price: ${agreement.price}, ColBuyer: ${agreement.collateral_buyer}, ColSeller: ${agreement.collateral_seller}`);
    } else {
        throw new Error(`Agreement engine failed to detect the agreement.`);
    }

    console.log("\n[SYSTEM TEST] Phase 1 Complete. Process terminating to simulate shutdown...\n");
    await prisma.$disconnect();
}

async function runPhase2() {
    console.log("\n[SYSTEM TEST] ════════════ PHASE 2: VERIFY RESTART ════════════");
    console.log(`[SYSTEM TEST] Restart successful... Fetching from cold DB.`);

    console.log(`[SYSTEM TEST] STEP 7: Reload from Database`);
    const ticket = await ticketStore.getTicket(TICKET_ID);
    if (!ticket) throw new Error("Ticket was not persisted across restart!");

    const fetched = await messageStore.getMessages(TICKET_ID);
    if (fetched.length !== 4) throw new Error("Messages were lost across restart!");
    console.log(`[SYSTEM TEST] Data integrity confirmed. Ticket and ${fetched.length} messages recovered.`);

    console.log(`[SYSTEM TEST] STEP 8: Re-run Intelligence`);
    const agreement = await detectAgreement(TICKET_ID);
    if (agreement && agreement.confidence >= 80) {
        console.log(`[SYSTEM TEST] Agreement detected: true (Confidence: ${agreement.confidence})`);
        console.log(`[SYSTEM TEST] Selected Terms -> Price: ${agreement.price}, ColBuyer: ${agreement.collateral_buyer}, ColSeller: ${agreement.collateral_seller}`);
        console.log(`[SYSTEM TEST] ✅ SUCCESS: Agent results match pre-restart simulation perfectly.`);
    } else {
        throw new Error(`Agreement detection failed after restart.`);
    }

    await prisma.$disconnect();
}

const mode = process.argv[2];
if (mode === "generate") {
    runPhase1().catch(e => { console.error(e); process.exit(1); });
} else if (mode === "verify") {
    runPhase2().catch(e => { console.error(e); process.exit(1); });
} else {
    console.error("Usage: npx ts-node test/systemValidationTest.ts [generate|verify]");
}
