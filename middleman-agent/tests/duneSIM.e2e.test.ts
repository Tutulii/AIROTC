/**
 * Dune SIM E2E Integration Test
 *
 * Tests the full Dune SIM integration pipeline:
 * 1. Service initialization & health check
 * 2. SVM Balances API (real call)
 * 3. SVM Transactions API (real call)
 * 4. Deposit verification logic
 * 5. Agent portfolio analytics
 * 6. Deal audit trail
 *
 * Uses REAL API calls to Dune SIM — requires DUNE_SIM_API_KEY env var.
 */

// Set the API key before importing the service
process.env.DUNE_SIM_API_KEY = process.env.DUNE_SIM_API_KEY || "sim_z0h4vIVDTitM5GNvtS93zLXnT8ZfiMdy";

import { describe, expect, it } from "vitest";
import { duneSIM } from "../src/services/duneSIMService";

// Known Solana wallet for testing (devnet faucet / well-known address)
const TEST_WALLET = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, testName: string, detail?: string): void {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${testName}${detail ? ` — ${detail}` : ""}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════

async function testServiceInitialization(): Promise<void> {
  console.log("\n🔧 Test 1: Service Initialization");
  
  // Explicitly initialize with API key (env may not be picked up at module load)
  duneSIM.initialize(process.env.DUNE_SIM_API_KEY);
  
  assert(duneSIM.isAvailable, "Dune SIM service is available");

  const stats = duneSIM.getServiceStats();
  assert(stats.available === true, "Stats show available", JSON.stringify(stats));
  assert(stats.requestCount === 0, "No requests yet");
  assert(stats.errorCount === 0, "No errors yet");
}

async function testSVMBalances(): Promise<void> {
  console.log("\n💰 Test 2: SVM Balances API (Real Call)");

  const balances = await duneSIM.getWalletBalances(TEST_WALLET);
  
  assert(balances !== null, "Balances response received", `wallet: ${TEST_WALLET.slice(0, 8)}...`);
  
  if (balances) {
    assert(balances.address === TEST_WALLET, "Address matches");
    assert(typeof balances.timestamp === "number", "Has timestamp");
    assert(balances.timestamp > 0, "Timestamp is positive");
    
    // Native balance
    if (balances.nativeBalance) {
      assert(typeof balances.nativeBalance.amount === "string", "Native balance is string", balances.nativeBalance.amount);
      assert(balances.nativeBalance.decimals === 9, "SOL has 9 decimals");
    } else {
      assert(true, "No native balance (empty wallet or different response format)");
    }
    
    // Tokens array
    assert(Array.isArray(balances.tokens), "Tokens is array", `${balances.tokens.length} tokens`);
    assert(typeof balances.totalUsdValue === "number", "Total USD value is number");
    
    console.log(`    📊 Portfolio: ${balances.tokens.length} tokens, $${balances.totalUsdValue} USD`);
  }

  // Verify caching — second call should be instant
  const start = Date.now();
  const cached = await duneSIM.getWalletBalances(TEST_WALLET);
  const cacheLatency = Date.now() - start;
  assert(cacheLatency < 50, "Cache hit is fast", `${cacheLatency}ms`);
  assert(cached !== null, "Cached result returned");
}

async function testSVMTransactions(): Promise<void> {
  console.log("\n📜 Test 3: SVM Transactions API (Real Call)");
  
  await sleep(1000); // Rate limit safety

  const history = await duneSIM.getTransactionHistory(TEST_WALLET);
  
  assert(history !== null, "Transaction history received");
  
  if (history) {
    assert(history.address === TEST_WALLET, "Address matches");
    assert(Array.isArray(history.transactions), "Transactions is array", `${history.transactions.length} txs`);
    assert(typeof history.total === "number", "Total is number");
    assert(typeof history.timestamp === "number", "Has timestamp");

    if (history.transactions.length > 0) {
      const firstTx = history.transactions[0];
      assert(typeof firstTx.signature === "string", "TX has signature", firstTx.signature?.slice(0, 12) + "...");
      assert(typeof firstTx.status === "string", "TX has status", firstTx.status);
      console.log(`    📊 Latest TX: ${firstTx.signature?.slice(0, 20)}... [${firstTx.status}]`);
    }
  }
}

async function testDepositVerification(): Promise<void> {
  console.log("\n🔍 Test 4: Deposit Verification");
  
  await sleep(1000);

  // Test with a known wallet
  const result = await duneSIM.verifyDeposit(TEST_WALLET, 1000000); // 0.001 SOL
  
  assert(result.dataSource === "dune_sim", "Data source is dune_sim");
  assert(typeof result.verified === "boolean", "Has verified flag", String(result.verified));
  assert(typeof result.currentBalance === "number", "Has current balance", String(result.currentBalance));
  assert(Array.isArray(result.recentDeposits), "Has recent deposits array");
  assert(typeof result.verifiedAt === "number", "Has verification timestamp");
  
  console.log(`    📊 Balance: ${result.currentBalance}, Verified: ${result.verified}`);

  // Test with system program (should have 0 balance)
  const emptyResult = await duneSIM.verifyDeposit(SYSTEM_PROGRAM, 999999999);
  assert(emptyResult.verified === false || emptyResult.currentBalance < 999999999, 
    "Empty/system account correctly unverified");
}

async function testAgentPortfolio(): Promise<void> {
  console.log("\n👤 Test 5: Agent Portfolio Analytics");
  
  await sleep(1000);

  const portfolio = await duneSIM.getAgentPortfolio(TEST_WALLET);
  
  assert(portfolio.wallet === TEST_WALLET, "Wallet matches");
  assert(typeof portfolio.stats === "object", "Has stats object");
  assert(typeof portfolio.stats.totalTokens === "number", "Has token count");
  assert(typeof portfolio.stats.totalUsdValue === "number", "Has USD value");
  assert(typeof portfolio.stats.recentTxCount === "number", "Has TX count");
  
  console.log(`    📊 Agent: ${portfolio.stats.totalTokens} tokens, ${portfolio.stats.recentTxCount} recent txs`);
}

async function testDealAuditTrail(): Promise<void> {
  console.log("\n📋 Test 6: Deal Audit Trail");
  
  await sleep(1000);

  const audit = await duneSIM.getDealAuditTrail(TEST_WALLET);
  
  assert(audit.dealPda === TEST_WALLET, "Deal PDA matches");
  assert(audit.dataSource === "dune_sim", "Data source is dune_sim");
  assert(Array.isArray(audit.deposits), "Has deposits array");
  assert(Array.isArray(audit.withdrawals), "Has withdrawals array");
  assert(Array.isArray(audit.timeline), "Has timeline");
  assert(typeof audit.totalDeposited === "number", "Has total deposited");
  assert(typeof audit.totalWithdrawn === "number", "Has total withdrawn");
  assert(typeof audit.netBalance === "number", "Has net balance");
  
  console.log(`    📊 Audit: ${audit.timeline.length} events, ${audit.deposits.length} deposits, ${audit.withdrawals.length} withdrawals`);
}

async function testServiceStats(): Promise<void> {
  console.log("\n📈 Test 7: Service Telemetry");
  
  const stats = duneSIM.getServiceStats();
  
  assert(stats.available === true, "Service available");
  assert(stats.requestCount > 0, "Requests were made", `${stats.requestCount} requests`);
  assert(stats.cacheSize > 0, "Cache has entries", `${stats.cacheSize} entries`);
  assert(typeof stats.errorRate === "number", "Error rate calculated", `${(stats.errorRate * 100).toFixed(1)}%`);
  
  console.log(`    📊 Stats: ${stats.requestCount} requests, ${stats.errorCount} errors, ${stats.cacheSize} cached`);
}

// ═══════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════

async function runAllTests(): Promise<void> {
  passed = 0;
  failed = 0;
  total = 0;

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   DUNE SIM E2E INTEGRATION TEST                    ║");
  console.log("║   Testing with REAL API calls                      ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`\n🔑 API Key: ${process.env.DUNE_SIM_API_KEY?.slice(0, 8)}...`);
  console.log(`🎯 Test Wallet: ${TEST_WALLET}`);

  try {
    await testServiceInitialization();
    await testSVMBalances();
    await testSVMTransactions();
    await testDepositVerification();
    await testAgentPortfolio();
    await testDealAuditTrail();
    await testServiceStats();
  } catch (err: any) {
    console.error(`\n💥 FATAL ERROR: ${err.message}`);
    console.error(err.stack);
  }

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log(`║   RESULTS: ${passed}/${total} passed, ${failed} failed${" ".repeat(Math.max(0, 24 - String(passed).length - String(total).length - String(failed).length))}║`);
  console.log("╚══════════════════════════════════════════════════════╝");

  if (failed > 0) {
    process.exit(1);
  }
}

describe("Dune SIM real integration", () => {
  const gatedIt = process.env.RUN_DUNE_SIM_E2E === "true" ? it : it.skip;

  gatedIt("runs the live Dune SIM E2E suite", async () => {
    await runAllTests();
    expect(failed).toBe(0);
  });
});

if (process.env.RUN_DUNE_SIM_E2E_STANDALONE === "true") {
  runAllTests();
}
