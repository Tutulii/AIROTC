import { executionStore } from "../src/state/executionStore";
import { PrismaClient } from "@prisma/client";

import { ticketStore } from "../src/state/ticketStore";

const prisma = new PrismaClient();
const TEST_TICKET_ID = "EXEC_TEST_MUTEX_01";

async function runMutexTest() {
    console.log("\n[SYSTEM TEST] --- Running In-Memory Verification ---");

    await prisma.transaction.deleteMany({ where: { dealId: TEST_TICKET_ID } });
    await prisma.deal.deleteMany({ where: { id: TEST_TICKET_ID } });

    // Satisfy FK constraints by ensuring the ticket exists
    await ticketStore.createTicket({
        ticket_id: TEST_TICKET_ID,
        offer_id: "exec_test",
        buyer: "ExecBuyerWait",
        seller: "ExecSellerWait",
        status: "active",
        created_at: new Date().toISOString()
    });

    console.log(`[TEST] Step 1: Triggering safe execution for create_deal...`);
    const lock1 = await executionStore.beginExecution(TEST_TICKET_ID, "create_deal");
    if (!lock1) throw new Error("Expected to acquire lock1, got denied.");

    const txCheck = await prisma.transaction.findFirst({ where: { dealId: TEST_TICKET_ID } });
    if (!txCheck) throw new Error("Transaction row not found in database.");

    await executionStore.markSuccess(TEST_TICKET_ID, "create_deal", "dummy_sig_123");

    console.log(`[TEST] Step 2: Triggering duplicate execution...`);
    const lock2 = await executionStore.beginExecution(TEST_TICKET_ID, "create_deal");
    if (lock2) throw new Error("Expected duplicate lock to be denied, but it succeeded!");

    console.log("[TEST] ✅ SUCCESS: Duplicate execution was correctly blocked using DB mutex.");
    await prisma.$disconnect();
}

async function runRestartTest() {
    console.log("\n[SYSTEM TEST] --- Running Restart Verification ---");

    console.log(`[TEST] Restart: Triggering execution...`);
    const lock = await executionStore.beginExecution(TEST_TICKET_ID, "create_deal");
    if (lock) throw new Error("Expected restart lock check to be denied safely, but it ran execution again!");

    console.log("[TEST] ✅ SUCCESS: Restart persisted state perfectly! Execution remains blocked!");
    await prisma.$disconnect();
}

const mode = process.argv[2];
if (mode === "mutex") {
    runMutexTest().catch(e => { console.error(e); process.exit(1); });
} else if (mode === "restart") {
    runRestartTest().catch(e => { console.error(e); process.exit(1); });
} else {
    console.log("Usage: node test/executionStoreTest.ts [mutex|restart]");
}
