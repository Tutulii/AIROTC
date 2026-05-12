import { ticketStore } from "../store/ticketStore";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function runTest() {
    console.log("=== STEP 1: Create Ticket ===");
    await ticketStore.createTicket({
        id: "TEST_TICKET_99",
        buyer: "Buyer99Wallet",
        seller: "Seller99Wallet"
    });
    console.log("Ticket created.");

    console.log("\n=== STEP 2: Fetch Ticket ===");
    const fetched1 = await ticketStore.getTicket("TEST_TICKET_99");
    console.log(fetched1);

    console.log("\n=== STEP 3: Update Ticket ===");
    await ticketStore.updateTicketMemory("TEST_TICKET_99", {
        sender: "Buyer99Wallet",
        content: "deal at 99 sol",
        timestamp: Date.now()
    });

    console.log("\n=== STEP 4: Fetch Again (Validate Persistence) ===");
    const fetched2 = await ticketStore.getTicket("TEST_TICKET_99");
    console.log(fetched2);

    if (fetched2?.last_proposed_price === 99) {
        console.log("\n✅ SUCCESS: Persistence and Updates work!");
    } else {
        console.error("\n❌ ERROR: Persistence failed.");
    }

    await prisma.$disconnect();
}

runTest().catch(console.error);
