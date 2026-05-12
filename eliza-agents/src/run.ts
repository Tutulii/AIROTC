/**
 * AIR OTC — ElizaOS Agent Trade Harness (Dual-Mode: ER + PER)
 * 
 * Two fully configured ElizaOS agents with:
 *   - Character-driven personality
 *   - Plugin with actions, providers, evaluators, services
 *   - State composition via providers
 *   - Post-response evaluation via evaluators
 *   - Persistent OTC connection service
 * 
 * Usage:
 *   npx ts-node src/run.ts              # ER mode (default)
 *   npx ts-node src/run.ts --per        # PER private mode
 */

import dotenv from "dotenv";
import path from "path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { AgentRuntime, logger } from "./elizaos-core";
import type { Memory, Content } from "./elizaos-core";
import { createAlphaTrader } from "./characters/alphaTrader";
import { createBravoDealer } from "./characters/bravoDealer";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════

const PLATFORM_REST = process.env.PLATFORM_REST_URL || "http://localhost:8080";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";
const TRADE_ASSET = process.env.TRADE_ASSET || "API_KEY";
const TRADE_PRICE = parseFloat(process.env.TRADE_PRICE || "0.002");
const TRADE_COLLATERAL = parseFloat(process.env.TRADE_COLLATERAL || "0.001");

const isPER = process.argv.includes("--per");
const ROLLUP_MODE = isPER ? "PER" as const : "ER" as const;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function loadKeypair(envKey?: string): Keypair {
  if (envKey) {
    try { return Keypair.fromSecretKey(bs58.decode(envKey)); }
    catch { /* generate fresh */ }
  }
  return Keypair.generate();
}

function makeMessage(text: string, userId?: string, roomId?: string): Memory {
  return {
    content: { text } as Content,
    userId: userId || "system",
    roomId: roomId || "trade-room",
    createdAt: Date.now(),
  };
}

// ═══════════════════════════════════════
// MAIN
// ═══════════════════════════════════════

async function main() {
  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  AIR OTC — ELIZAOS AGENT TRADE HARNESS                      ║");
  console.log("║  Real @elizaos/core API • Actions + Providers + Evaluators   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const modeLabel = ROLLUP_MODE === "PER"
    ? "🔐 PER (Private Ephemeral Rollup — Intel TDX)"
    : "⚡ ER (Ephemeral Rollup — Public Fast-Path)";
  console.log(`  Mode:   ${modeLabel}`);
  console.log(`  Asset:  ${TRADE_ASSET} | Price: ${TRADE_PRICE} SOL | Collateral: ${TRADE_COLLATERAL} SOL`);
  console.log(`  Server: ${PLATFORM_REST}\n`);

  // ═══════════════════════════════════════
  // PHASE 0: CREATE AGENTS
  // ═══════════════════════════════════════
  console.log("━━━ PHASE 0: CREATE ELIZAOS AGENTS ━━━\n");

  const alphaKeypair = loadKeypair(process.env.ALPHA_PRIVATE_KEY);
  const bravoKeypair = loadKeypair(process.env.BRAVO_PRIVATE_KEY);

  const alphaCharacter = createAlphaTrader({
    walletAddress: alphaKeypair.publicKey.toBase58(),
    privateKey: bs58.encode(alphaKeypair.secretKey),
    platformRestUrl: PLATFORM_REST,
    bridgeSecret: BRIDGE_SECRET,
    rollupMode: ROLLUP_MODE,
    targetPrice: TRADE_PRICE,
    maxPrice: TRADE_PRICE * 1.2,
    collateral: TRADE_COLLATERAL,
    tradeAsset: TRADE_ASSET,
  });

  const bravoCharacter = createBravoDealer({
    walletAddress: bravoKeypair.publicKey.toBase58(),
    privateKey: bs58.encode(bravoKeypair.secretKey),
    platformRestUrl: PLATFORM_REST,
    bridgeSecret: BRIDGE_SECRET,
    rollupMode: ROLLUP_MODE,
    askingPrice: TRADE_PRICE,
    minPrice: TRADE_PRICE * 0.75,
    collateral: TRADE_COLLATERAL,
    tradeAsset: TRADE_ASSET,
  });

  const alpha = new AgentRuntime(alphaCharacter);
  const bravo = new AgentRuntime(bravoCharacter);

  // Initialize — starts services (OtcConnectionService), registers all components
  await alpha.initialize();
  await bravo.initialize();

  console.log(`  AlphaTrader (buyer):  ${alphaKeypair.publicKey.toBase58()}`);
  console.log(`  BravoDealer (seller): ${bravoKeypair.publicKey.toBase58()}\n`);

  // ═══════════════════════════════════════
  // PHASE 1: REGISTER
  // ═══════════════════════════════════════
  console.log("━━━ PHASE 1: REGISTER ON PLATFORM ━━━\n");

  const msg = makeMessage("register on the OTC platform");

  const regAlpha = await alpha.executeAction("REGISTER_ON_PLATFORM", msg);
  console.log(`  AlphaTrader: ${regAlpha.text}`);

  const regBravo = await bravo.executeAction("REGISTER_ON_PLATFORM", msg);
  console.log(`  BravoDealer: ${regBravo.text}\n`);

  if (!regAlpha.success || !regBravo.success) {
    console.error("❌ Registration failed. Is middleman-agent running on port 8080?");
    await alpha.shutdown();
    await bravo.shutdown();
    process.exit(1);
  }

  // ═══════════════════════════════════════
  // PHASE 2: POST & ACCEPT OFFER
  // ═══════════════════════════════════════
  console.log("━━━ PHASE 2: OFFER LIFECYCLE ━━━\n");

  const offerResult = await bravo.executeAction("POST_TRADE_OFFER", makeMessage("post a sell offer"));
  console.log(`  BravoDealer: ${offerResult.text}`);
  await sleep(2000);

  const acceptResult = await alpha.executeAction("ACCEPT_TRADE_OFFER", makeMessage("browse and accept"));
  console.log(`  AlphaTrader: ${acceptResult.text}`);

  if (!acceptResult.success) {
    console.error("❌ No matching offers found");
    await alpha.shutdown();
    await bravo.shutdown();
    process.exit(1);
  }

  // Sync ticketId to bravo
  const ticketId = alpha.getState("ticketId") as string;
  bravo.setState("ticketId", ticketId);
  console.log(`  🎫 Ticket: ${ticketId}\n`);
  await sleep(2000);

  // ═══════════════════════════════════════
  // PHASE 3: NEGOTIATE
  // ═══════════════════════════════════════
  console.log("━━━ PHASE 3: NEGOTIATE ━━━\n");

  // Compose state (runs providers — wallet, deal status)
  const alphaState = await alpha.composeState(makeMessage("negotiate"));
  logger.info(`AlphaTrader state composed`, { providers: alphaState.providers?.substring(0, 100) });

  const negAlpha = await alpha.executeAction("NEGOTIATE_DEAL", makeMessage("negotiate the price"), alphaState);
  console.log(`  AlphaTrader: ${negAlpha.text}`);

  // Run evaluator on negotiation result
  await alpha.evaluate(makeMessage(negAlpha.text || "negotiation done"), alphaState);

  await sleep(2000);

  const bravoState = await bravo.composeState(makeMessage("negotiate"));
  const negBravo = await bravo.executeAction("NEGOTIATE_DEAL", makeMessage("negotiate the price"), bravoState);
  console.log(`  BravoDealer: ${negBravo.text}`);
  await bravo.evaluate(makeMessage(negBravo.text || "negotiation done"), bravoState);
  console.log();
  await sleep(2000);

  // ═══════════════════════════════════════
  // PHASE 4: DEPOSITS
  // ═══════════════════════════════════════
  console.log("━━━ PHASE 4: DEPOSITS ━━━\n");

  const depAlpha = await alpha.executeAction("DEPOSIT_TO_ESCROW", makeMessage("deposit collateral"));
  console.log(`  AlphaTrader: ${depAlpha.text}`);
  await alpha.evaluate(makeMessage("deposited collateral"));
  await sleep(15000);

  const depBravo = await bravo.executeAction("DEPOSIT_TO_ESCROW", makeMessage("deposit collateral"));
  console.log(`  BravoDealer: ${depBravo.text}`);
  await bravo.evaluate(makeMessage("deposited collateral"));
  console.log();
  await sleep(15000);

  // ═══════════════════════════════════════
  // PHASE 5: DELIVERY & RELEASE
  // ═══════════════════════════════════════
  console.log("━━━ PHASE 5: DELIVERY & RELEASE ━━━\n");

  const delivery = await bravo.executeAction("DELIVER_ITEM", makeMessage("deliver the item"));
  console.log(`  BravoDealer: ${delivery.text}`);
  await bravo.evaluate(makeMessage("item delivered"));
  await sleep(5000);

  const release = await alpha.executeAction("RELEASE_FUNDS", makeMessage("release the funds"));
  console.log(`  AlphaTrader: ${release.text}`);
  await alpha.evaluate(makeMessage("funds released"));
  console.log();

  // ═══════════════════════════════════════
  // PHASE 6: VERIFICATION
  // ═══════════════════════════════════════
  console.log("━━━ PHASE 6: VERIFICATION ━━━\n");

  // Check milestones from evaluator
  const alphaMilestones = (alpha.getState("milestones") as string[]) || [];
  const bravoMilestones = (bravo.getState("milestones") as string[]) || [];

  console.log(`  AlphaTrader milestones: [${alphaMilestones.join(", ")}]`);
  console.log(`  BravoDealer milestones: [${bravoMilestones.join(", ")}]`);

  // Get deal status via provider
  const finalState = await alpha.composeState(makeMessage("final check"));
  console.log(`  Final state:\n${finalState.providers || "no provider data"}`);

  const completed = alpha.getState("dealCompleted") === true;

  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  if (completed) {
    if (ROLLUP_MODE === "PER") {
      console.log("║  ✅  FULL PER TRADE COMPLETED — ElizaOS Agents               ║");
      console.log("║  Private settlement via Intel TDX enclave                     ║");
    } else {
      console.log("║  ✅  FULL ER TRADE COMPLETED — ElizaOS Agents                 ║");
      console.log("║  Public fast-path settlement via MagicBlock                   ║");
    }
  } else {
    console.log("║  ⚠️  Trade did not fully complete                              ║");
    console.log("║  Check middleman-agent logs for pipeline details               ║");
  }
  console.log("║                                                               ║");
  console.log("║  Plugin: plugin-air-otc (7 actions, 2 providers, 1 evaluator) ║");
  console.log("║  Agents: AlphaTrader (buyer) + BravoDealer (seller)           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Shutdown services
  await alpha.shutdown();
  await bravo.shutdown();
  process.exit(0);
}

// ═══════════════════════════════════════

main().catch((err) => {
  console.error(`❌ Harness crashed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
