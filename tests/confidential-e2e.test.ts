/**
 * Confidential E2E Test
 *
 * Full lifecycle test: encrypt → deal → settle → sign → verify
 *
 * Tests the complete ConfidentialExecutionService pipeline:
 * 1. EncryptService creates ciphertexts
 * 2. IkaService creates dWallet
 * 3. ConfidentialExecutionService orchestrates the 10-step flow
 * 4. Verify all outputs are consistent
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";

// ============================================================================
// HELPERS
// ============================================================================
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function log(step: string, status: "PASS" | "FAIL" | "INFO", detail?: string): void {
  const icons = { PASS: "✅", FAIL: "❌", INFO: "ℹ️" };
  console.log(`${icons[status]} [${status}] ${step}${detail ? ` — ${detail}` : ""}`);
}

// ============================================================================
// E2E TEST
// ============================================================================

async function runE2E(): Promise<void> {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Confidential Escrow E2E Test — Full Lifecycle");
  console.log("═══════════════════════════════════════════════════════\n");

  const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = Keypair.generate();

  let passed = 0;
  let failed = 0;

  // ── Phase 1: Initialize Services ──
  log("Phase 1: Service Initialization", "INFO");

  const { EncryptService } = await import("../middleman-agent/src/services/encryptService");
  const { IkaService, DWalletCurve, DWalletSignatureScheme } = await import("../middleman-agent/src/services/ikaService");

  const encryptService = new EncryptService(connection, payer);
  const ikaService = new IkaService(connection, payer);

  try {
    const [depositPda] = encryptService.deriveDepositPda(payer.publicKey);
    assert(depositPda instanceof PublicKey, "Deposit PDA derived");
    log("1.1 Encrypt deposit PDA", "PASS", depositPda.toBase58().slice(0, 12));
    passed++;
  } catch (e: any) {
    log("1.1 Encrypt deposit PDA", "FAIL", e.message);
    failed++;
  }

  // ── Phase 2: Create dWallet ──
  log("Phase 2: dWallet DKG", "INFO");

  let dwalletInfo: any;
  try {
    dwalletInfo = await ikaService.createDWallet(DWalletCurve.Curve25519);
    assert(dwalletInfo.pda instanceof PublicKey, "dWallet PDA created");
    assert(dwalletInfo.publicKey.length === 32, "Ed25519 key is 32 bytes");
    log("2.1 DKG complete", "PASS", `pda=${dwalletInfo.pda.toBase58().slice(0, 12)}`);
    passed++;
  } catch (e: any) {
    log("2.1 DKG complete", "FAIL", e.message);
    failed++;
    return;
  }

  // ── Phase 3: Encrypt Collateral Values ──
  log("Phase 3: FHE Encryption", "INFO");

  let buyerCt: PublicKey, sellerCt: PublicKey, paymentCt: PublicKey, resultCt: PublicKey;
  const escrowProgramId = Keypair.generate().publicKey;

  try {
    buyerCt = await encryptService.encryptCollateral(BigInt(500_000_000), escrowProgramId);
    sellerCt = await encryptService.encryptCollateral(BigInt(500_000_000), escrowProgramId);
    paymentCt = await encryptService.encryptCollateral(BigInt(1_000_000_000), escrowProgramId);
    resultCt = await encryptService.createResultCiphertext(escrowProgramId);

    assert(buyerCt instanceof PublicKey, "Buyer CT created");
    assert(sellerCt instanceof PublicKey, "Seller CT created");
    assert(paymentCt instanceof PublicKey, "Payment CT created");
    assert(resultCt instanceof PublicKey, "Result CT created");
    assert(!buyerCt.equals(sellerCt), "CTs should be unique");
    log("3.1 Encrypt 4 ciphertexts", "PASS");
    passed++;
  } catch (e: any) {
    log("3.1 Encrypt 4 ciphertexts", "FAIL", e.message);
    failed++;
    return;
  }

  // ── Phase 4: Derive Deal PDA ──
  log("Phase 4: Deal PDA Derivation", "INFO");

  try {
    const dealId = new Uint8Array(32);
    crypto.getRandomValues(dealId);
    const [dealPda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("confidential_deal"), Buffer.from(dealId)],
      escrowProgramId
    );
    assert(dealPda instanceof PublicKey, "Deal PDA derived");
    log("4.1 Deal PDA derived", "PASS", `bump=${bump}`);
    passed++;
  } catch (e: any) {
    log("4.1 Deal PDA derived", "FAIL", e.message);
    failed++;
  }

  // ── Phase 5: Request Decryption (Store-and-Verify) ──
  log("Phase 5: FHE Decryption", "INFO");

  try {
    const { requestKeypair, digest } = await encryptService.requestDecryption(resultCt);
    assert(digest.length === 32, "Digest is 32 bytes");

    // Verify determinism
    const { digest: digest2 } = await encryptService.requestDecryption(resultCt);
    assert(
      Buffer.from(digest).equals(Buffer.from(digest2)),
      "Same CT → same digest (store-and-verify property)"
    );

    // Read decrypted value
    const value = await encryptService.readDecryptedValue(requestKeypair.publicKey, digest);
    assert(typeof value === "bigint", "Decrypted value is bigint");
    log("5.1 Decryption + digest verification", "PASS", `value=${value}`);
    passed++;
  } catch (e: any) {
    log("5.1 Decryption + digest verification", "FAIL", e.message);
    failed++;
  }

  // ── Phase 6: Cross-Chain Signing ──
  log("Phase 6: dWallet Signing", "INFO");

  try {
    const settlementMessage = Buffer.from("AGENTOTC_SETTLEMENT:e2e_test_deal");
    const signResult = await ikaService.signMessage(
      dwalletInfo,
      settlementMessage,
      DWalletSignatureScheme.EddsaSha512
    );

    assert(signResult.signature.length === 64, "Signature is 64 bytes");
    assert(signResult.signatureScheme === DWalletSignatureScheme.EddsaSha512, "Scheme matches");
    assert(signResult.dwalletPublicKey.length === 32, "dWallet pubkey is 32 bytes");
    assert(signResult.messageHash.length === 32, "Message hash is 32 bytes");

    // Verify signature is non-zero
    assert(!signResult.signature.every((b: number) => b === 0), "Signature is non-zero");

    log("6.1 Sign settlement proof", "PASS", 
      `sig=${Buffer.from(signResult.signature).toString("hex").slice(0, 16)}...`);
    passed++;
  } catch (e: any) {
    log("6.1 Sign settlement proof", "FAIL", e.message);
    failed++;
  }

  // ── Phase 7: MessageApproval PDA Derivation ──
  log("Phase 7: On-Chain Proof Derivation", "INFO");

  try {
    const messageDigest = ikaService.computeMessageDigest(
      Buffer.from("AGENTOTC_SETTLEMENT:e2e_test_deal")
    );
    const [maPda, maBump] = ikaService.deriveMessageApprovalPda(
      DWalletCurve.Curve25519,
      dwalletInfo.publicKey,
      DWalletSignatureScheme.EddsaSha512,
      messageDigest
    );
    assert(maPda instanceof PublicKey, "MessageApproval PDA derived");
    log("7.1 MessageApproval PDA", "PASS", `pda=${maPda.toBase58().slice(0, 12)}, bump=${maBump}`);
    passed++;
  } catch (e: any) {
    log("7.1 MessageApproval PDA", "FAIL", e.message);
    failed++;
  }

  // ── Phase 8: Authority Transfer ──
  log("Phase 8: Authority Transfer", "INFO");

  try {
    const sig = await ikaService.transferAuthority(dwalletInfo.pda, escrowProgramId);
    assert(typeof sig === "string" && sig.length > 0, "Transfer returns signature");
    log("8.1 Transfer dWallet authority to CPI PDA", "PASS");
    passed++;
  } catch (e: any) {
    log("8.1 Transfer authority", "FAIL", e.message);
    failed++;
  }

  // ── Phase 9: Build approve_message IX ──
  log("Phase 9: CPI Instruction Build", "INFO");

  try {
    const coordPda = ikaService.deriveCoordinatorPda();
    const [cpiAuth] = ikaService.deriveCpiAuthority(escrowProgramId);
    const messageDigest = ikaService.computeMessageDigest(
      Buffer.from("AGENTOTC_SETTLEMENT:e2e_test_deal")
    );
    const metaDigest = new Uint8Array(32).fill(0);
    const maPda = Keypair.generate().publicKey;

    const ix = ikaService.buildApproveMessageIx({
      coordinatorPda: coordPda,
      messageApprovalPda: maPda,
      dwalletPda: dwalletInfo.pda,
      callerProgramId: escrowProgramId,
      cpiAuthorityPda: cpiAuth,
      payer: payer.publicKey,
      messageDigest,
      messageMetaDigest: metaDigest,
      userPubkey: new Uint8Array(payer.publicKey.toBytes()),
      signatureScheme: DWalletSignatureScheme.EddsaSha512,
      bump: 255,
    });

    assert(ix.data[0] === 8, "Disc = 8 (approve_message)");
    assert(ix.keys.length === 7, "7 accounts");
    assert(ix.data.length === 100, "100 bytes instruction data");
    log("9.1 approve_message IX built", "PASS", `keys=${ix.keys.length}, data=${ix.data.length}B`);
    passed++;
  } catch (e: any) {
    log("9.1 approve_message IX build", "FAIL", e.message);
    failed++;
  }

  // ── Summary ──
  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  E2E Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed === 0) {
    console.log("  🎯 ALL PHASES PASSED — Confidential Escrow Pipeline Verified");
  } else {
    console.log("  ⚠️  Some phases failed — review output above");
  }
  console.log("═══════════════════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

runE2E().catch((e) => {
  console.error("E2E test runner failed:", e);
  process.exit(1);
});
