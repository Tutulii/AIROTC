/**
 * Ika (dWallet) Integration Tests
 *
 * Tests the IkaService against pre-alpha mock behavior:
 * 1. DKG — dWallet creation
 * 2. Authority transfer to program CPI PDA
 * 3. Approve message instruction building
 * 4. PDA derivation (dWallet, MessageApproval, GasDeposit, coordinator)
 * 5. Signing flow (presign + sign)
 * 6. Signature format verification (64 bytes)
 */

import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

// ============================================================================
// TEST CONFIG
// ============================================================================
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DWALLET_PROGRAM_ID = new PublicKey("87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY");

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
  console.log("  Ika (dWallet) Integration Tests — Pre-Alpha");
  console.log("═══════════════════════════════════════════════════════\n");

  const connection = new Connection(RPC_URL, "confirmed");
  const payer = Keypair.generate();

  const { IkaService, DWalletCurve, DWalletSignatureScheme } = await import(
    "../middleman-agent/src/services/ikaService"
  );
  const service = new IkaService(connection, payer);

  let passed = 0;
  let failed = 0;

  // ── Test 1: Create dWallet (DKG) ──
  try {
    const dwallet = await service.createDWallet(DWalletCurve.Curve25519);
    assert(dwallet.pda instanceof PublicKey, "dWallet PDA should be a PublicKey");
    assert(dwallet.publicKey.length === 32, "Ed25519 public key should be 32 bytes");
    assert(dwallet.curve === DWalletCurve.Curve25519, "Curve should be Curve25519");
    log("Test 1: createDWallet(Curve25519)", "PASS", dwallet.pda.toBase58().slice(0, 12) + "...");
    passed++;
  } catch (e: any) {
    log("Test 1: createDWallet(Curve25519)", "FAIL", e.message);
    failed++;
  }

  // ── Test 2: Create dWallet with Secp256k1 ──
  try {
    const dwallet = await service.createDWallet(DWalletCurve.Secp256k1);
    assert(dwallet.curve === DWalletCurve.Secp256k1, "Curve should be Secp256k1");
    log("Test 2: createDWallet(Secp256k1)", "PASS");
    passed++;
  } catch (e: any) {
    log("Test 2: createDWallet(Secp256k1)", "FAIL", e.message);
    failed++;
  }

  // ── Test 3: Derive CPI authority PDA ──
  try {
    const programId = Keypair.generate().publicKey;
    const [cpiAuth, bump] = service.deriveCpiAuthority(programId);
    assert(cpiAuth instanceof PublicKey, "CPI authority should be PublicKey");
    assert(bump >= 0 && bump <= 255, "Bump should be valid");

    // Verify determinism
    const [cpiAuth2] = service.deriveCpiAuthority(programId);
    assert(cpiAuth.equals(cpiAuth2), "Same program should derive same CPI PDA");
    log("Test 3: deriveCpiAuthority()", "PASS", `bump=${bump}`);
    passed++;
  } catch (e: any) {
    log("Test 3: deriveCpiAuthority()", "FAIL", e.message);
    failed++;
  }

  // ── Test 4: Derive dWallet PDA ──
  try {
    const publicKey = Keypair.generate().publicKey.toBytes();
    const [pda, bump] = service.deriveDWalletPda(DWalletCurve.Curve25519, publicKey);
    assert(pda instanceof PublicKey, "dWallet PDA should be PublicKey");

    // Verify determinism
    const [pda2] = service.deriveDWalletPda(DWalletCurve.Curve25519, publicKey);
    assert(pda.equals(pda2), "Same inputs should derive same PDA");

    // Different curve should give different PDA
    const [pda3] = service.deriveDWalletPda(DWalletCurve.Secp256k1, publicKey);
    assert(!pda.equals(pda3), "Different curve should give different PDA");

    log("Test 4: deriveDWalletPda()", "PASS", `bump=${bump}`);
    passed++;
  } catch (e: any) {
    log("Test 4: deriveDWalletPda()", "FAIL", e.message);
    failed++;
  }

  // ── Test 5: Derive MessageApproval PDA ──
  try {
    const publicKey = Keypair.generate().publicKey.toBytes();
    const messageDigest = new Uint8Array(32).fill(0x42);
    const [maPda, maBump] = service.deriveMessageApprovalPda(
      DWalletCurve.Curve25519,
      publicKey,
      DWalletSignatureScheme.EddsaSha512,
      messageDigest
    );
    assert(maPda instanceof PublicKey, "MA PDA should be PublicKey");
    log("Test 5: deriveMessageApprovalPda()", "PASS", `bump=${maBump}`);
    passed++;
  } catch (e: any) {
    log("Test 5: deriveMessageApprovalPda()", "FAIL", e.message);
    failed++;
  }

  // ── Test 6: Derive coordinator PDA ──
  try {
    const coordPda = service.deriveCoordinatorPda();
    assert(coordPda instanceof PublicKey, "Coordinator PDA should be PublicKey");
    log("Test 6: deriveCoordinatorPda()", "PASS", coordPda.toBase58().slice(0, 12) + "...");
    passed++;
  } catch (e: any) {
    log("Test 6: deriveCoordinatorPda()", "FAIL", e.message);
    failed++;
  }

  // ── Test 7: Transfer authority ──
  try {
    const dwallet = await service.createDWallet(DWalletCurve.Curve25519);
    const targetProgram = Keypair.generate().publicKey;
    const sig = await service.transferAuthority(dwallet.pda, targetProgram);
    assert(typeof sig === "string", "Should return transaction signature");
    assert(sig.length > 0, "Signature should be non-empty");
    log("Test 7: transferAuthority()", "PASS");
    passed++;
  } catch (e: any) {
    log("Test 7: transferAuthority()", "FAIL", e.message);
    failed++;
  }

  // ── Test 8: Build approve_message instruction ──
  try {
    const coordPda = service.deriveCoordinatorPda();
    const dwalletPda = Keypair.generate().publicKey;
    const callerProgram = Keypair.generate().publicKey;
    const [cpiAuth] = service.deriveCpiAuthority(callerProgram);
    const messageDigest = new Uint8Array(32).fill(0xAB);
    const metaDigest = new Uint8Array(32).fill(0);
    const userPubkey = payer.publicKey.toBytes();
    const maPda = Keypair.generate().publicKey;

    const ix = service.buildApproveMessageIx({
      coordinatorPda: coordPda,
      messageApprovalPda: maPda,
      dwalletPda,
      callerProgramId: callerProgram,
      cpiAuthorityPda: cpiAuth,
      payer: payer.publicKey,
      messageDigest,
      messageMetaDigest: metaDigest,
      userPubkey: new Uint8Array(userPubkey),
      signatureScheme: DWalletSignatureScheme.EddsaSha512,
      bump: 255,
    });

    assert(ix.programId.equals(DWALLET_PROGRAM_ID), "Program ID should be dWallet");
    assert(ix.keys.length === 7, "Should have 7 account keys");
    assert(ix.data[0] === 8, "Discriminator should be 8 (approve_message)");
    assert(ix.data.length === 100, "Data should be 100 bytes");
    assert(ix.data.readUInt16LE(98) === DWalletSignatureScheme.EddsaSha512, "Scheme should be EddsaSha512");
    log("Test 8: buildApproveMessageIx()", "PASS", `data_len=${ix.data.length}`);
    passed++;
  } catch (e: any) {
    log("Test 8: buildApproveMessageIx()", "FAIL", e.message);
    failed++;
  }

  // ── Test 9: Sign message ──
  try {
    const dwallet = await service.createDWallet(DWalletCurve.Curve25519);
    const message = Buffer.from("AGENTOTC_SETTLEMENT:test_deal_12345");
    const result = await service.signMessage(
      dwallet,
      message,
      DWalletSignatureScheme.EddsaSha512
    );
    assert(result.signature.length === 64, "Signature should be 64 bytes");
    assert(result.signatureScheme === DWalletSignatureScheme.EddsaSha512, "Scheme should match");
    assert(result.dwalletPublicKey.length === 32, "Public key should be 32 bytes");
    assert(result.messageHash.length === 32, "Message hash should be 32 bytes");
    log("Test 9: signMessage()", "PASS", `sig=${Buffer.from(result.signature).toString("hex").slice(0, 16)}...`);
    passed++;
  } catch (e: any) {
    log("Test 9: signMessage()", "FAIL", e.message);
    failed++;
  }

  // ── Test 10: Message digest computation ──
  try {
    const msg1 = Buffer.from("hello");
    const msg2 = Buffer.from("world");
    const d1 = service.computeMessageDigest(msg1);
    const d2 = service.computeMessageDigest(msg2);
    const d3 = service.computeMessageDigest(msg1);
    assert(d1.length === 32, "Digest should be 32 bytes");
    assert(!Buffer.from(d1).equals(Buffer.from(d2)), "Different messages should give different digests");
    assert(Buffer.from(d1).equals(Buffer.from(d3)), "Same message should give same digest");
    log("Test 10: computeMessageDigest()", "PASS");
    passed++;
  } catch (e: any) {
    log("Test 10: computeMessageDigest()", "FAIL", e.message);
    failed++;
  }

  // ── Test 11: Gas deposit PDA derivation ──
  try {
    const [gasPda, bump] = service.deriveGasDepositPda(payer.publicKey);
    assert(gasPda instanceof PublicKey, "Gas deposit PDA should be PublicKey");
    log("Test 11: deriveGasDepositPda()", "PASS", `bump=${bump}`);
    passed++;
  } catch (e: any) {
    log("Test 11: deriveGasDepositPda()", "FAIL", e.message);
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
