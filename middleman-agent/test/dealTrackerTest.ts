import { dealTracker } from "../src/state/dealTracker";
import { executionStore } from "../src/state/executionStore";
import { ticketStore } from "../src/state/ticketStore";
import { PrismaClient } from "@prisma/client";
import * as process from "process";

const prisma = new PrismaClient();
const TICKET_ID = "TRACKER_TEST_100";

async function runGenerativeTest() {
    console.log("\n[SYSTEM TEST] --- PHASE 1: GENERATE AUDIT LOG ---");
    await prisma.transaction.deleteMany({ where: { dealId: TICKET_ID } });
    await prisma.deal.deleteMany({ where: { id: TICKET_ID } });

    await ticketStore.createTicket({
        ticket_id: TICKET_ID,
        offer_id: "none",
        buyer: "FakeBuyer",
        seller: "FakeSeller",
        status: "active",
        created_at: new Date().toISOString()
    });

    console.log("[TEST] Step 1: Init Deal (like ExecutionService)");
    await dealTracker.initDeal({
        ticketId: TICKET_ID,
        buyerId: "FakeBuyer",
        sellerId: "FakeSeller",
        middlemanId: "FakeMiddleman",
        price: 5.5,
        collateralBuyer: 1,
        collateralSeller: 1,
        timeout: new Date(Date.now() + 86400000)
    });

    console.log("[TEST] Step 2: Trigger Transactions (like ExecutionService)");
    await executionStore.beginExecution(TICKET_ID, "create_deal");
    await executionStore.markSuccess(TICKET_ID, "create_deal", "sig_create_abc");
    await dealTracker.storeOnChainId(TICKET_ID, "PdaAccountBase58Text");
    await dealTracker.updateStatus(TICKET_ID, "created");

    await executionStore.beginExecution(TICKET_ID, "release_funds");
    await executionStore.markFailed(TICKET_ID, "release_funds"); // simulate failure
    await dealTracker.updateStatus(TICKET_ID, "failed", "Simulated error during release");

    console.log("\n[TEST] Step 3: Local Reconstruction Fetch");
    const deal = await dealTracker.getDealByTicket(TICKET_ID);

    if (!deal) throw new Error("Missing deal record -> FAIL");
    console.log(`[DEAL RESULTS] Status: ${deal.status}, Price: ${deal.price}, Tx Count: ${deal.transactions.length}`);

    if (deal.status !== "failed") throw new Error(`Status mismatch -> FAIL. Expected failed, got ${deal.status}`);
    if (deal.transactions.length !== 2) throw new Error("No transaction linkage -> FAIL");

    console.log("✅ SUCCESS: Phase 1 Generative Traceability Passed.");
    await prisma.$disconnect();
}

async function runReconstructionTest() {
    console.log("\n[SYSTEM TEST] --- PHASE 2: RECONSTRUCT POST RESTART ---");

    const deal = await dealTracker.getDealByTicket(TICKET_ID);
    if (!deal) throw new Error("Missing deal record post restart -> FAIL");

    console.log(`[DEAL EXTRACT] Status=${deal.status}, Price=${deal.price}, TxCount=${deal.transactions.length}`);

    if (deal.status !== "failed") throw new Error("State drift after restart -> FAIL");
    if (deal.transactions.length !== 2) throw new Error("Lost transactional history -> FAIL");
    if (!deal.transactions.some(tx => tx.type === "release_funds" && tx.status === "failed")) {
        throw new Error("Missing precise failure transaction log");
    }

    console.log("✅ SUCCESS: Restart Preserved State. Full Audit History Traced Deterministically.");
    await prisma.$disconnect();
}

const mode = process.argv[2];
if (mode === "generate") {
    runGenerativeTest().catch(console.error);
} else if (mode === "reconstruct") {
    runReconstructionTest().catch(console.error);
} else {
    console.log("Valid arguments: [generate|reconstruct]");
}
