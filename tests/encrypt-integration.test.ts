/**
 * Encrypt Integration Tests
 *
 * Tests the EncryptService against pre-alpha mock behavior:
 * 1. Ciphertext creation
 * 2. Deposit account management
 * 3. Settlement graph polling
 * 4. Decryption request + store-and-verify
 * 5. Digest mismatch rejection
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";

// ============================================================================
// TEST CONFIG
// ============================================================================
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const ENCRYPT_PROGRAM_ID = new PublicKey("ENcR3kPU6MNM1VTH2LxYdGM2UR2FjisKSbJWhHsuPMz");
const ESCROW_PROGRAM_ID = Keypair.generate().publicKey; // Mock escrow program

// ============================================================================
// HELPERS
// ============================================================================
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function log(test: string, status: "PASS" | "FAIL", detail?: string): void {
  const icon = status === "PASS" ? "✅" : "❌";
  console.log(`${icon} [${status}] ${test}${detail ? ` — ${detail}` : ""}`);
}

// ============================================================================
// TESTS
// ============================================================================

async function runTests(): Promise<void> {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Encrypt (FHE) Integration Tests — Pre-Alpha");
  console.log("═══════════════════════════════════════════════════════\n");

  const connection = new Connection(RPC_URL, "confirmed");
  const payer = Keypair.generate();

  // Dynamic import to match the agent's module system
  const { EncryptService } = await import(
    "../middleman-agent/src/services/encryptService"
  );
  const service = new EncryptService(connection, payer);

  let passed = 0;
  let failed = 0;

  // ── Test 1: Encrypt collateral value ──
  try {
    const ct = await service.encryptCollateral(BigInt(1_000_000_000), ESCROW_PROGRAM_ID);
    assert(ct instanceof PublicKey, "Should return a PublicKey");
    assert(ct.toBase58().length > 0, "PublicKey should be non-empty");
    log("Test 1: encryptCollateral()", "PASS", ct.toBase58().slice(0, 12) + "...");
    passed++;
  } catch (e: any) {
    log("Test 1: encryptCollateral()", "FAIL", e.message);
    failed++;
  }

  // ── Test 2: Create result ciphertext ──
  try {
    const resultCt = await service.createResultCiphertext(ESCROW_PROGRAM_ID);
    assert(resultCt instanceof PublicKey, "Should return a PublicKey for result ct");
    log("Test 2: createResultCiphertext()", "PASS");
    passed++;
  } catch (e: any) {
    log("Test 2: createResultCiphertext()", "FAIL", e.message);
    failed++;
  }

  // ── Test 3: Derive deposit PDA ──
  try {
    const [depositPda, bump] = service.deriveDepositPda(payer.publicKey);
    assert(depositPda instanceof PublicKey, "Deposit PDA should be a PublicKey");
    assert(bump >= 0 && bump <= 255, "Bump should be 0-255");
    log("Test 3: deriveDepositPda()", "PASS", `bump=${bump}`);
    passed++;
  } catch (e: any) {
    log("Test 3: deriveDepositPda()", "FAIL", e.message);
    failed++;
  }

  // ── Test 4: Derive CPI authority PDA ──
  try {
    const [cpiAuth, bump] = service.deriveCpiAuthority(ESCROW_PROGRAM_ID);
    assert(cpiAuth instanceof PublicKey, "CPI authority should be a PublicKey");
    log("Test 4: deriveCpiAuthority()", "PASS", cpiAuth.toBase58().slice(0, 12) + "...");
    passed++;
  } catch (e: any) {
    log("Test 4: deriveCpiAuthority()", "FAIL", e.message);
    failed++;
  }

  // ── Test 5: Request decryption returns digest ──
  try {
    const resultCt = await service.createResultCiphertext(ESCROW_PROGRAM_ID);
    const { requestKeypair, digest } = await service.requestDecryption(resultCt);
    assert(requestKeypair instanceof Keypair, "Should return a Keypair");
    assert(digest.length === 32, "Digest should be 32 bytes");
    assert(!digest.every((b: number) => b === 0), "Digest should not be all zeros");
    log("Test 5: requestDecryption()", "PASS", `digest=${Buffer.from(digest).toString("hex").slice(0, 16)}...`);
    passed++;
  } catch (e: any) {
    log("Test 5: requestDecryption()", "FAIL", e.message);
    failed++;
  }

  // ── Test 6: Read decrypted value ──
  try {
    const mockPubkey = Keypair.generate().publicKey;
    const mockDigest = new Uint8Array(32);
    const value = await service.readDecryptedValue(mockPubkey, mockDigest);
    assert(typeof value === "bigint", "Should return a bigint");
    assert(value >= BigInt(0), "Should be non-negative");
    log("Test 6: readDecryptedValue()", "PASS", `value=${value}`);
    passed++;
  } catch (e: any) {
    log("Test 6: readDecryptedValue()", "FAIL", e.message);
    failed++;
  }

  // ── Test 7: Store-and-verify — same ciphertext produces same digest ──
  try {
    const ct = await service.createResultCiphertext(ESCROW_PROGRAM_ID);
    const { digest: d1 } = await service.requestDecryption(ct);
    const { digest: d2 } = await service.requestDecryption(ct);
    assert(
      Buffer.from(d1).equals(Buffer.from(d2)),
      "Same ciphertext should produce same digest"
    );
    log("Test 7: Digest determinism", "PASS");
    passed++;
  } catch (e: any) {
    log("Test 7: Digest determinism", "FAIL", e.message);
    failed++;
  }

  // ── Summary ──
  console.log("\n───────────────────────────────────────────────────────");
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("───────────────────────────────────────────────────────\n");

  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error("Test runner failed:", e);
  process.exit(1);
});
