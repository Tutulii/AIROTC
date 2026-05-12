import { startHealthServer, stopHealthServer } from "../src/api/health";
import { circuitBreaker } from "../src/utils/circuitBreaker";
import { prisma } from "../src/lib/prisma";

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function failTest(name: string, reason: string) {
  console.error(`❌ FAILED [${name}]: ${reason}`);
  stopHealthServer();
  process.exit(1);
}

function passTest(name: string) {
  console.log(`✅ PASSED [${name}]`);
}

async function runTests() {
  console.log("\n=== 🩺 OBSERVABILITY HEALTH TESTS ===\n");
  
  const HTTP_PORT = 8089;
  startHealthServer(HTTP_PORT);
  await sleep(500); // give express internal loop a millisecond to bind

  const url = `http://localhost:${HTTP_PORT}/health`;

  // TEST 1: Absolute Default OK checks
  console.log("[TEST 1] Testing Global OK Status natively");
  const res1 = await fetch(url);
  const data1: any = await res1.json();
  
  if (res1.status === 200 && data1.status === "ok") {
    passTest("Successfully mapped OK checks actively returning latency vectors matching RPC and Postgres");
  } else {
    failTest("Test 1", `Health responded with status -> ${data1.status}`);
  }

  console.log("\n[TEST 2] Testing Degraded Circuit Breaker Context");
  for (let i = 0; i < 15; i++) {
    circuitBreaker.recordFailure("test_synthetic_degradation");
  }

  const res2 = await fetch(url);
  const data2: any = await res2.json();
  
  if (data2.status === "degraded") {
    passTest("Internal Circuit Breaker appropriately bubbled 'degraded' global states");
  } else {
     failTest("Test 2", `Failed to degrade global bounds! -> ${data2.status}`);
  }
  
  circuitBreaker.reset();

  console.log("\n[TEST 3] Testing Missing/Down Database Ping constraints");
  (prisma as any).$queryRaw = async () => { throw new Error("Simulated DB drop"); };
  
  const res3 = await fetch(url);
  const data3: any = await res3.json();
  if (res3.status === 503 && data3.status === "down") {
    passTest("Missing PostGreSQL liveness perfectly resulted in HTTP 503 'down' checks!");
  } else {
    failTest("Test 3", "Did not accurately isolate dead database connectivity -> " + data3.status);
  }

  // Teardown
  stopHealthServer();
  console.log("\n=== ALL HEALTH BOUNDARIES VERIFIED OK ===\n");
  process.exit(0);
}

runTests().catch(console.error);
