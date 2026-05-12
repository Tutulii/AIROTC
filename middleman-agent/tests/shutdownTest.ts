import { shutdownManager } from "../src/utils/shutdownManager";

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Override process exit securely for test assertions
let exitCodeTriggered: number | null = null;
const originalExit = process.exit;
(process as any).exit = (code: number) => {
  exitCodeTriggered = code;
  throw new Error("MOCKED_EXIT_TRIGGER");
};

async function runTests() {
  console.log("\n=== 🛑 GRACEFUL SHUTDOWN TESTS ===\n");

  console.log("[TEST 1] Standard Wait For Drain");
  shutdownManager.resetForTesting();
  
  // Start 3 inflights
  shutdownManager.startExecution();
  shutdownManager.startExecution();
  shutdownManager.startExecution();

  let drainResolved = false;
  shutdownManager.beginShutdown();
  
  // New work should reject
  try {
    shutdownManager.startExecution();
    console.error("❌ TEST 1 FAILED: Allowed new work while shutting down.");
  } catch(e: any) {
    if (e.message.includes("System shutting down")) {
      console.log("✅ New executions safely blocked.");
    }
  }

  // Await the shutdown drain hook concurrently
  const drainPromise = shutdownManager.waitForDrain({ timeoutMs: 5000 }).then(() => {
    drainResolved = true;
  });

  // Slowly release inflight operations over time
  await sleep(150);
  shutdownManager.endExecution();
  await sleep(150);
  shutdownManager.endExecution();
  await sleep(150);
  shutdownManager.endExecution();

  await drainPromise;

  if (drainResolved && shutdownManager.getActiveExecutions() === 0) {
    console.log("✅ TEST 1 PASSED: Process waited correctly until all operations drained.\n");
  } else {
    console.error("❌ TEST 1 FAILED: Did not drain normally.\n");
  }

  // ============================================

  console.log("[TEST 2] Immediate Zero Drain Exit");
  shutdownManager.resetForTesting();
  shutdownManager.beginShutdown();

  const startT2 = Date.now();
  await shutdownManager.waitForDrain({ timeoutMs: 5000 });
  const spanT2 = Date.now() - startT2;

  if (spanT2 < 100) {
    console.log("✅ TEST 2 PASSED: Bypassed drain immediately since zero transactions active.\n");
  } else {
    console.error("❌ TEST 2 FAILED: Halted unnecessarily during empty cycle.\n");
  }

  // ============================================

  console.log("[TEST 3] Counter Protection (No negative active executions)");
  shutdownManager.resetForTesting();
  shutdownManager.endExecution();
  shutdownManager.endExecution();

  if (shutdownManager.getActiveExecutions() === 0) {
    console.log("✅ TEST 3 PASSED: Floor clamped natively to zero.\n");
  } else {
    console.error("❌ TEST 3 FAILED: Negative counters leaked.\n");
  }

  // ============================================
  
  console.log("[TEST 4] Hanging Execution (Max Timeout)");
  shutdownManager.resetForTesting();
  shutdownManager.startExecution(); // Start an execution but NEVER end it
  shutdownManager.beginShutdown();

  let timeoutThrown = false;
  try {
     // A short 2.5sec wait (we don't want to wait full 30s locally)
     await shutdownManager.waitForDrain({ timeoutMs: 2500 });
  } catch (error: any) {
     if (error.message === "MOCKED_EXIT_TRIGGER" && exitCodeTriggered === 1) {
       timeoutThrown = true;
     }
  }

  if (timeoutThrown) {
    console.log("✅ TEST 4 PASSED: Hard exit constraint aborted loop violently when stuck.\n");
  } else {
    console.error("❌ TEST 4 FAILED: Hanging execution did not terminate processing!\n");
  }

  console.log("\n=== ALL TESTS COMPLETED ===");
  originalExit(0);
}

runTests().catch(console.error);
