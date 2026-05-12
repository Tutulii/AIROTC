import { withRetry, isRetryableError } from "../src/utils/retry";

async function runTests() {
  console.log("=== TEST 1: Simulate RPC Timeout ===");
  let attempts1 = 0;
  try {
    await withRetry(async () => {
      attempts1++;
      if (attempts1 < 2) {
        throw new Error("RPC fetch error timeout");
      }
      return "SUCCESS 1";
    }, { label: "test1", ticketId: "T1" });
    console.log("Test 1 Passed: Retried and succeeded.\n");
  } catch (e: any) {
    console.error("Test 1 Failed: ", e);
  }

  console.log("=== TEST 2: Simulate permanent failure ===");
  let attempts2 = 0;
  try {
    await withRetry(async () => {
      attempts2++;
      throw new Error("network error econnrefused");
    }, { label: "test2", ticketId: "T2" });
  } catch (e: any) {
    if (attempts2 === 4 && e.message === "network error econnrefused") {
      console.log("Test 2 Passed: Retried 3 times then failed.\n");
    } else {
      console.error("Test 2 Failed randomly: ", attempts2, e);
    }
  }

  console.log("=== TEST 3: Simulate program error ===");
  let attempts3 = 0;
  try {
    await withRetry(async () => {
      attempts3++;
      throw new Error("custom program error: 0x1");
    }, { label: "test3", ticketId: "T3" });
  } catch (e: any) {
    if (attempts3 === 1) {
      console.log("Test 3 Passed: Did NOT retry program error.\n");
    } else {
      console.error("Test 3 Failed: Retried when it shouldn't have: ", attempts3);
    }
  }
}

runTests().catch(console.error);
