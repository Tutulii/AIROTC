/**
 * AIR OTC — External Agent Test Harness (Dual-Mode: ER + PER)
 * 
 * Orchestrates two real autonomous AI agents through the full OTC lifecycle:
 *   Phase 0: Setup (keypairs, funding, health check)
 *   Phase 1: Registration (both agents register with platform)
 *   Phase 2: Offer Lifecycle (BravoBot posts sell, AlphaBot accepts)
 *   Phase 3: Autonomous Negotiation (ER: LLM chat | PER: SDK-based private)
 *   Phase 4: Deposits (SOL transfers to escrow PDA)
 *   Phase 5: Delivery & Release (item delivery + fund release)
 *   Phase 6: Verification (final status check)
 * 
 * Usage:
 *   npx ts-node src/run.ts --normal     # Normal Mode (public SOL escrow)
 *   npx ts-node src/run.ts              # ER mode (default)
 *   npx ts-node src/run.ts --per        # PER private mode
 */

import dotenv from "dotenv";
import path from "path";
import { Keypair, Connection, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { AlphaBot } from "./agents/alphaBot";
import { BravoBot } from "./agents/bravoBot";
import { initBrain } from "./lib/agentBrain";
import { loadKeypair } from "./lib/walletAuth";
import { log, logPhase, logSuccess, logError } from "./lib/logger";

// Load env from external-agents/.env, fallback to .env.example
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════

const PLATFORM_REST = process.env.PLATFORM_REST_URL || "http://localhost:8080";
const PLATFORM_WS = process.env.PLATFORM_WS_URL || "ws://localhost:8080";
const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const LLM_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "";
const LLM_BASE = process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1";
const LLM_MODEL = process.env.LLM_MODEL || "llama-3.3-70b-versatile";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";

const TRADE_ASSET = process.env.TRADE_ASSET || "API_KEY";
const TRADE_PRICE = parseFloat(process.env.TRADE_PRICE || "0.002");
const TRADE_COLLATERAL = parseFloat(process.env.TRADE_COLLATERAL || "0.001");

const isPER = process.argv.includes("--per");
const isNormal = process.argv.includes("--normal");
const ROLLUP_MODE = isPER ? "PER" as const : isNormal ? "NONE" as const : "ER" as const;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════
// MAIN
// ═══════════════════════════════════════

async function main() {
  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  AIR OTC — EXTERNAL AGENT TEST HARNESS                  ║");
  console.log("║  Two real AI agents executing autonomous OTC trades      ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const modeLabel = ROLLUP_MODE === "PER"
    ? "PER (Private Ephemeral Rollup — Intel TDX)"
    : ROLLUP_MODE === "NONE"
      ? "NORMAL (Public SOL escrow — no advanced providers)"
    : "ER (Ephemeral Rollup — Public Fast-Path)";
  log("Harness", `Mode: ${modeLabel}`, "bold");
  log("Harness", `Asset: ${TRADE_ASSET} | Price: ${TRADE_PRICE} SOL | Collateral: ${TRADE_COLLATERAL} SOL`, "bold");
  log("Harness", `Platform: ${PLATFORM_REST}`, "dim");
  log("Harness", `Solana: ${SOLANA_RPC}`, "dim");

  // ═══════════════════════════════════════
  // PHASE 0: SETUP
  // ═══════════════════════════════════════
  logPhase("PHASE 0: SETUP");

  // Initialize LLM brain
  if (LLM_KEY) {
    initBrain(LLM_KEY, LLM_BASE, LLM_MODEL);
    log("Harness", `LLM brain initialized: ${LLM_MODEL}`, "green");
  } else {
    log("Harness", "No LLM_API_KEY — agents will use deterministic fallback responses", "yellow");
  }

  // Load or generate keypairs
  const alphaKeypair = loadKeypair(process.env.ALPHA_PRIVATE_KEY);
  const bravoKeypair = loadKeypair(process.env.BRAVO_PRIVATE_KEY);

  log("Harness", `AlphaBot wallet: ${alphaKeypair.publicKey.toBase58()}`, "cyan");
  log("Harness", `BravoBot wallet: ${bravoKeypair.publicKey.toBase58()}`, "magenta");

  // Fund wallets if needed
  const connection = new Connection(SOLANA_RPC, "confirmed");
  await ensureFunded(connection, alphaKeypair, 0.01);
  await ensureFunded(connection, bravoKeypair, 0.01);

  // Health check
  try {
    const res = await fetch(`${PLATFORM_REST}/v1/agent/stats`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      log("Harness", "✅ Platform is healthy", "green");
    } else {
      logError(`Platform health check failed (${res.status})`);
      process.exit(1);
    }
  } catch (err: any) {
    logError(`Cannot reach platform at ${PLATFORM_REST}: ${err.message}`);
    log("Harness", "Make sure middleman-agent is running: cd middleman-agent && npm start", "yellow");
    process.exit(1);
  }

  // ═══════════════════════════════════════
  // CREATE AGENTS
  // ═══════════════════════════════════════

  const alpha = new AlphaBot({
    keypair: alphaKeypair,
    platformRestUrl: PLATFORM_REST,
    platformWsUrl: PLATFORM_WS,
    solanaRpcUrl: SOLANA_RPC,
    tradeAsset: TRADE_ASSET,
    targetPrice: TRADE_PRICE,
    maxPrice: TRADE_PRICE * 1.2,
    collateral: TRADE_COLLATERAL,
    rollupMode: ROLLUP_MODE,
    bridgeSecret: BRIDGE_SECRET,
  });

  const bravo = new BravoBot({
    keypair: bravoKeypair,
    platformRestUrl: PLATFORM_REST,
    platformWsUrl: PLATFORM_WS,
    solanaRpcUrl: SOLANA_RPC,
    tradeAsset: TRADE_ASSET,
    askingPrice: TRADE_PRICE,
    minPrice: TRADE_PRICE * 0.75,
    collateral: TRADE_COLLATERAL,
    rollupMode: ROLLUP_MODE,
    bridgeSecret: BRIDGE_SECRET,
  });

  // ═══════════════════════════════════════
  // PHASE 1: REGISTER
  // ═══════════════════════════════════════
  await alpha.register();
  await bravo.register();

  // ═══════════════════════════════════════
  // PHASE 2: OFFER LIFECYCLE
  // ═══════════════════════════════════════
  // BravoBot posts a sell offer first
  const offerId = await bravo.postSellOffer();
  await sleep(2000);

  // AlphaBot browses and accepts (quick buy)
  const ticketId = await alpha.browseAndAccept();

  if (!ticketId || ticketId.startsWith("PENDING-")) {
    logError("AlphaBot could not find/accept BravoBot's offer");
    process.exit(1);
  }

  log("Harness", `🎫 Active ticket: ${ticketId}`, "green");
  await sleep(2000);

  // ═══════════════════════════════════════
  // PHASE 3: NEGOTIATE
  // ═══════════════════════════════════════
  // AlphaBot starts negotiation
  await alpha.negotiate(ticketId);
  await sleep(2000);

  // BravoBot responds in the negotiation
  await bravo.negotiate(ticketId, alpha.getMessageHistory());
  await sleep(2000);

  // If no agreement yet, do another round from each side (Normal/ER only)
  if (ROLLUP_MODE !== "PER") {
    try {
      const status = await alpha["api"].getDealStatus(ticketId);
      if (status.phase === "negotiation") {
        log("Harness", "No agreement yet — running additional negotiation rounds...", "yellow");
        await alpha.negotiate(ticketId);
        await sleep(2000);
        await bravo.negotiate(ticketId, alpha.getMessageHistory());
        await sleep(2000);
      }
    } catch { /* deal may not exist in phase manager yet */ }
  }

  // ═══════════════════════════════════════
  // PHASE 4: DEPOSITS
  // ═══════════════════════════════════════
  // Both agents deposit SOL to escrow
  await alpha.deposit(ticketId);
  await sleep(15000); // Wait for on-chain confirmation
  await bravo.deposit(ticketId);
  await sleep(15000);

  // ═══════════════════════════════════════
  // PHASE 5: DELIVERY & RELEASE
  // ═══════════════════════════════════════
  await bravo.deliverItem(ticketId);
  await sleep(5000);
  await alpha.confirmAndRelease(ticketId);

  // ═══════════════════════════════════════
  // PHASE 6: VERIFICATION
  // ═══════════════════════════════════════
  logPhase("PHASE 6: VERIFICATION");

  try {
    const finalStatus = await alpha["api"].getDealStatus(ticketId);
    log("Harness", `Final phase: ${finalStatus.phase}`, finalStatus.phase === "completed" ? "green" : "yellow");
    log("Harness", `Escrow PDA: ${finalStatus.escrow_pda || "N/A"}`, "dim");
    log("Harness", `Payment locked: ${finalStatus.payment_locked}`, "dim");
    log("Harness", `Mode: ${ROLLUP_MODE}`, "dim");
  } catch (err: any) {
    log("Harness", `Could not get final status: ${err.message}`, "yellow");
  }

  // Check final balances
  const alphaBalance = await connection.getBalance(alphaKeypair.publicKey);
  const bravoBalance = await connection.getBalance(bravoKeypair.publicKey);
  log("Harness", `AlphaBot final balance: ${(alphaBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`, "cyan");
  log("Harness", `BravoBot final balance: ${(bravoBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`, "magenta");

  if (alpha.isDealCompleted) {
    console.log("\n");
    console.log("╔══════════════════════════════════════════════════════════╗");
    if (ROLLUP_MODE === "PER") {
      console.log("║  ✅  FULL PER TRADE COMPLETED SUCCESSFULLY              ║");
      console.log("║  Private settlement via Intel TDX enclave               ║");
    } else if (ROLLUP_MODE === "NONE") {
      console.log("║  ✅  FULL NORMAL MODE TRADE COMPLETED SUCCESSFULLY      ║");
      console.log("║  Public SOL escrow with no advanced providers           ║");
    } else {
      console.log("║  ✅  FULL ER TRADE COMPLETED SUCCESSFULLY               ║");
      console.log("║  Public fast-path settlement via MagicBlock              ║");
    }
    console.log("║  Both agents executed the entire OTC lifecycle           ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");
  } else {
    console.log("\n");
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║  ⚠️  Trade did not fully complete                       ║");
    console.log("║  Check middleman-agent logs for details                  ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");
  }

  process.exit(0);
}

// ═══════════════════════════════════════
// FUNDING UTILITY
// ═══════════════════════════════════════

async function ensureFunded(connection: Connection, keypair: Keypair, minSol: number) {
  const balance = await connection.getBalance(keypair.publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;

  if (balanceSol >= minSol) {
    log("Harness", `${keypair.publicKey.toBase58().substring(0, 8)}... has ${balanceSol.toFixed(4)} SOL ✓`, "dim");
    return;
  }

  // Try funder wallet first
  if (process.env.FUNDER_PRIVATE_KEY) {
    try {
      const funder = Keypair.fromSecretKey(bs58.decode(process.env.FUNDER_PRIVATE_KEY));
      const fundAmount = 0.01;
      log("Harness", `Funding ${keypair.publicKey.toBase58().substring(0, 8)}... with ${fundAmount} SOL from funder...`, "yellow");

      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: keypair.publicKey,
        lamports: Math.floor(fundAmount * LAMPORTS_PER_SOL),
      }));
      await sendAndConfirmTransaction(connection, tx, [funder]);
      log("Harness", "Funded ✓", "green");
      return;
    } catch (err: any) {
      log("Harness", `Funder transfer failed: ${err.message}`, "yellow");
    }
  }

  // Try devnet airdrop
  try {
    log("Harness", `Requesting devnet airdrop for ${keypair.publicKey.toBase58().substring(0, 8)}...`, "yellow");
    const sig = await connection.requestAirdrop(keypair.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
    log("Harness", "Airdrop received ✓", "green");
  } catch (err: any) {
    log("Harness", `Airdrop failed: ${err.message}. You may need to fund manually.`, "red");
  }
}

// ═══════════════════════════════════════
// EXECUTE
// ═══════════════════════════════════════

main().catch((err) => {
  logError(`Harness crashed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
