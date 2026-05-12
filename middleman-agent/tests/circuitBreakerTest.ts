import { circuitBreaker } from "../src/utils/circuitBreaker";

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log("\n=== ⚡ CIRCUIT BREAKER TESTS ===");

  // Reset safely
  circuitBreaker.reset();

  console.log("\n[TEST 1] Triggering OPEN State (6 failures out of 10)");
  for (let i = 0; i < 4; i++) {
    if (circuitBreaker.canExecute()) circuitBreaker.recordSuccess();
  }
  for (let i = 0; i < 6; i++) {
    if (circuitBreaker.canExecute()) circuitBreaker.recordFailure();
  }

  if (circuitBreaker.isOpen()) {
    console.log("✅ TEST 1 PASSED: Circuit Breaker successfully identified >50% failure rate and OPENED.");
  } else {
    console.error("❌ TEST 1 FAILED: Circuit Breaker did not open.");
  }

  console.log("\n[TEST 2] Concurrency Flood Protection (10 parallel requests while OPEN)");
  let blockedCount = 0;
  
  // Create 10 parallel promises that just attempt to execute
  const flood = Array.from({ length: 10 }).map(async () => {
    if (!circuitBreaker.canExecute()) {
      blockedCount++;
    }
  });
  
  await Promise.all(flood);

  if (blockedCount === 10) {
    console.log(`✅ TEST 2 PASSED: All ${blockedCount}/10 requests were instantly blocked safely.`);
  } else {
    console.error(`❌ TEST 2 FAILED: Only ${blockedCount}/10 requests blocked.`);
  }

  console.log("\n[TEST 3] Cooldown Period → HALF_OPEN Recovery");
  console.log("Mocking lastStateChange to bypass 30s wait natively...");
  (circuitBreaker as any).lastStateChange = Date.now() - 31000;

  // The very NEXT execution after 30s should transition to HALF_OPEN and allow exactly 1 request through
  const execute1 = circuitBreaker.canExecute(); 
  const execute2 = circuitBreaker.canExecute();

  if (execute1 === true && execute2 === false) {
    console.log("✅ TEST 3 PASSED: State transitioned to HALF_OPEN. Allowed exactly 1 recovery probe. Locked concurrent probes.");
  } else {
    console.error("❌ TEST 3 FAILED: State transition invalid.", { execute1, execute2 });
  }

  console.log("\n[TEST 4] HALF_OPEN → OPEN (Failed Recovery)");
  // Probe failed!
  circuitBreaker.recordFailure();

  if (circuitBreaker.isOpen()) {
    console.log("✅ TEST 4 PASSED: Recovery probe failed. Circuit Breaker instantly snapped back to OPEN.");
  } else {
    console.error("❌ TEST 4 FAILED: Did not snap back to OPEN.");
  }

  console.log("\n[TEST 5] HALF_OPEN → CLOSED (Successful Recovery)");
  (circuitBreaker as any).lastStateChange = Date.now() - 31000; // Reset timer for next probe
  circuitBreaker.canExecute(); // Transition to HALF_OPEN
  
  // Probe succeeds!
  circuitBreaker.recordSuccess();

  if (!circuitBreaker.isOpen() && circuitBreaker.canExecute() && (circuitBreaker as any).successes.length === 0) {
    console.log("✅ TEST 5 PASSED: Recovery probe succeeded. State fully CLOSED and counters wiped clean.");
  } else {
    console.error("❌ TEST 5 FAILED: Did not recover cleanly.", circuitBreaker);
  }

  process.exit(0);
}

runTests().catch(console.error);
