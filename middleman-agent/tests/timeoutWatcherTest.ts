import { prisma } from "../src/lib/prisma";
import { startDealTimeoutWatcher } from "../src/services/dealTimeoutWatcher";

async function runTests() {
  console.log("\n=== 🧪 TIMEOUT WATCHER TESTS ===");

  // Setup: Clean existing specific states
  await prisma.deal.deleteMany({
    where: { ticketId: { startsWith: "mock-ticket-timeout-" } }
  });

  // Mock wallets
  const buyerId = "mock-buyer-timeout";
  const sellerId = "mock-seller-timeout";
  const middlemanId = "mock-middleman-timeout";

  // Upsert agents so DB foreign keys pass
  await prisma.agent.upsert({
    where: { wallet: "mockbuywallet" },
    update: {},
    create: { id: buyerId, wallet: "mockbuywallet" }
  });
  await prisma.agent.upsert({
    where: { wallet: "mocksellwallet" },
    update: {},
    create: { id: sellerId, wallet: "mocksellwallet" }
  });
  await prisma.agent.upsert({
    where: { wallet: "mockmidwallet" },
    update: {},
    create: { id: middlemanId, wallet: "mockmidwallet" }
  });

  const now = Date.now();
  const pastTimeout = new Date(now - 86400000); // 1 day ago

  console.log("\n[TEST 1] Testing basic locally created deal (No funds locked) expiration");

  // Create Tickets first
  for (let i = 1; i <= 2; i++) {
    await prisma.ticket.upsert({
      where: { id: `mock-ticket-timeout-${i}` },
      update: {},
      create: {
        id: `mock-ticket-timeout-${i}`,
        buyerId,
        sellerId,
        status: "open"
      }
    });
  }

  const deal1 = await prisma.deal.create({
    data: {
      id: "mock-deal-1",
      ticketId: "mock-ticket-timeout-1",
      buyerId,
      sellerId,
      middlemanId,
      price: 1,
      collateralBuyer: 1,
      collateralSeller: 1,
      status: "created",
      timeout: pastTimeout,
      isProcessing: false,
    }
  });

  console.log("\n[TEST 2] Testing Zombie Deal Simulation (Execution fails, flag stuck prevention)");

  const deal2 = await prisma.deal.create({
    data: {
      id: "mock-deal-2",
      ticketId: "mock-ticket-timeout-2",
      buyerId,
      sellerId,
      middlemanId,
      dealIdOnChain: "MockInvalidAddressThatWillFailOnChain",
      price: 1,
      collateralBuyer: 1,
      collateralSeller: 1,
      status: "collateral_locked", // Force refund attempt
      timeout: pastTimeout,
      isProcessing: false,
    }
  });

  // Boot Watcher asynchronously
  console.log("\n[RUNNING] Starting watcher cycle artificially...");
  
  // We don't start the infinite loop, we just import and run runWatcherCycle
  // Unfortunately `runWatcherCycle` is not exported, so we just run startDealTimeoutWatcher() and let it tick once?
  // Actually, I can just require the unexported function for testing:
  const dealWatcher = require("../src/services/dealTimeoutWatcher");
  await dealWatcher.runWatcherCycle();

  console.log("\n[ASSERTIONS]");

  const dbDeal1 = await prisma.deal.findUnique({ where: { id: deal1.id } });
  if (dbDeal1?.status === "expired" && !dbDeal1?.isProcessing) {
    console.log("✅ TEST 1 PASSED: Created deal cleanly expired without on-chain execution! isProcessing cleared.");
  } else {
    console.error("❌ TEST 1 FAILED:", dbDeal1);
  }

  const dbDeal2 = await prisma.deal.findUnique({ where: { id: deal2.id } });
  if (dbDeal2?.status === "timeout_failed" && !dbDeal2?.isProcessing) {
    console.log("✅ TEST 2 PASSED: Zombie deal trapped execution fail and safely backed out to timeout_failed.");
  } else {
    console.error("❌ TEST 2 FAILED:", dbDeal2);
  }

  process.exit(0);
}

runTests().catch(console.error);
