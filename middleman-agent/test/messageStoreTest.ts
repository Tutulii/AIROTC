import { messageStore } from "../src/state/messageStore";
import { ticketStore } from "../src/state/ticketStore";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function runTest() {
    const TICKET_ID = "TICKET_MSG_TEST_99";

    console.log("=== STEP 1: Ensure Ticket Exists ===");
    await ticketStore.createTicket({
        ticket_id: TICKET_ID,
        offer_id: "none",
        buyer: "TestBuyerW",
        seller: "TestSellerW",
        status: "active",
        created_at: new Date().toISOString()
    });
    console.log("Ticket ensured in DB.");

    console.log("\n=== STEP 2: Add 5 Messages ===");
    const messages = [
        { sender: "TestBuyerW", content: "Hi, deal at 5 sol" },
        { sender: "TestSellerW", content: "Too low, 8 sol" },
        { sender: "TestBuyerW", content: "Meet at 6.5?" },
        { sender: "TestSellerW", content: "7 sol final" },
        { sender: "TestBuyerW", content: "agreed, confirmed" }
    ];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        await messageStore.addMessage({
            message_id: `m_${i}`,
            ticket_id: TICKET_ID,
            sender: msg.sender,
            content: msg.content,
            timestamp: new Date().toISOString()
        });
        // Add artificial delay to ensure distinct creation times
        await new Promise(r => setTimeout(r, 100));
    }
    console.log("Messages Added.");

    console.log("\n=== STEP 3: Fetch Messages ===");
    const fetched = await messageStore.getMessages(TICKET_ID);

    console.log(`Fetched ${fetched.length} messages.`);

    console.log("\n=== STEP 4: Verify Order & Content ===");
    let failed = false;
    for (let i = 0; i < messages.length; i++) {
        if (fetched[i].content !== messages[i].content) {
            console.error(`Mismatch at index ${i}: Expected ${messages[i].content}, got ${fetched[i].content}`);
            failed = true;
        }
    }

    if (!failed && fetched.length >= 5) {
        console.log("✅ SUCCESS: Messages persisted in exact chronological order!");
    } else {
        console.error("❌ FAILED: Persistence or ordering is incorrect.");
    }

    await prisma.$disconnect();
}

runTest().catch(console.error);
