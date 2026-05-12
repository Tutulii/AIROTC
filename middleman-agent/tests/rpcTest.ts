import { withRetry } from "../src/utils/retry";
import { rpcManager } from "../src/utils/rpcManager";

async function runTests() {
  console.log("=== TEST 1: Sticky Failure Test & Rotation ===");
  // Force variables to make tests fast
  (rpcManager as any).WINDOW_MS = 10000;
  (rpcManager as any).FAIL_THRESHOLD = 3;

  try {
    const result = await withRetry(async () => {
      const current = rpcManager.getCurrentIndex();
      console.log(`[TEST] Executing on RPC index: ${current}`);
      if (current === 0) {
        throw new Error("RPC 0 fetch error timeout!");
      } else if (current === 1) {
        console.log("[TEST] RPC 1 is healthy!");
        return "SUCCESS_ON_BACKUP_1";
      }
    }, { label: "sticky_test_1" });
    
    console.log(`[TEST 1 PASSED] End result = ${result}`);
  } catch (e: any) {
    console.error(`[TEST 1 FAILED] ${e.message}`);
  }

  console.log("\n=== TEST 2: Recovery Test ===");
  console.log("[TEST] Mutating primary windowStart to simulate 10s passed...");
  (rpcManager as any).failureRecords[0].windowStart = Date.now() - 11000;

  // The next time anyone calls getConnection(), it should conditionally recover.
  rpcManager.getConnection();
  const recoveredIndex = rpcManager.getCurrentIndex();
  
  if (recoveredIndex === 0) {
    console.log("[TEST 2 PASSED] System successfully recovered back to Primary RPC 0!");
  } else {
    console.error(`[TEST 2 FAILED] Still stuck on RPC ${recoveredIndex}`);
  }
}

runTests().catch(console.error);
