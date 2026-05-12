/**
 * Real End-to-End Autonomous Trade Integration Test
 * Follows the EXACT negotiation transcript provided by the user.
 * Demonstrates the full un-simulated execution over devnet featuring 
 * autonomous deposit detection and multi-party execution.
 */

import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

// Initialize the entire agent stack (eventBus, DB trackers, Brain, Chain Listeners)
import "../src/index";
import { eventBus } from "../src/services/eventBus";
import { walletRegistry } from "../src/state/walletRegistry";

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let msgIdCounter = 1;
function m(ticket_id: string, sender: string, content: string) {
  return { ticket_id, sender, content, message_id: `msg-${msgIdCounter++}`, timestamp: new Date().toISOString() };
}

function t(ticket_id: string, buyer: string, seller: string) {
  return { ticket_id, buyer, seller, offer_id: `off-${Date.now()}`, status: "pending" as any, created_at: new Date().toISOString() };
}

async function runAutonomousSimulation() {
  console.log("\n======================================================");
  console.log(" FULL AUTONOMOUS MULTI-PARTY SIMULATION");
  console.log("======================================================\n");

  const ticketId = "SIM-AUTO-" + Date.now();

  if (!process.env.PRIVATE_KEY) {
    throw new Error("Missing PRIVATE_KEY (middleman) in env variables!");
  }

  const middlemanKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
  const buyerKeypair = process.env.BUYER_PRIVATE_KEY ? Keypair.fromSecretKey(bs58.decode(process.env.BUYER_PRIVATE_KEY)) : Keypair.generate();
  const sellerKeypair = process.env.SELLER_PRIVATE_KEY ? Keypair.fromSecretKey(bs58.decode(process.env.SELLER_PRIVATE_KEY)) : Keypair.generate();

  const buyerId = buyerKeypair.publicKey.toBase58();
  const sellerId = sellerKeypair.publicKey.toBase58();
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  console.log(`[BOOT] Middleman Wallet: ${middlemanKeypair.publicKey.toBase58()}`);
  console.log(`[BOOT] Buyer Wallet: ${buyerKeypair.publicKey.toBase58()}`);
  console.log(`[BOOT] Seller Wallet: ${sellerKeypair.publicKey.toBase58()}`);

  try {
    console.log("[BOOT] Funding new buyer and seller wallets from middleman...");
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: middlemanKeypair.publicKey,
        toPubkey: buyerKeypair.publicKey,
        lamports: 0.004 * LAMPORTS_PER_SOL,
      }),
      SystemProgram.transfer({
        fromPubkey: middlemanKeypair.publicKey,
        toPubkey: sellerKeypair.publicKey,
        lamports: 0.003 * LAMPORTS_PER_SOL,
      })
    );
    await sendAndConfirmTransaction(connection, fundTx, [middlemanKeypair]);
    console.log("[BOOT] Wallets funded successfully.");
  } catch (err) {
    console.error(`[BOOT] Funding warning (might already have funds or middleman low): ${(err as Error).message}`);
  }

  // walletRegistry is already auto-registering based on env variables now
  // Wait to ensure they are registered correctly
  await sleep(1000);

  // Wait for the async RPC daemon boot
  console.log("\n[BOOT] Waiting for Agent daemon to spin up listeners...");
  await sleep(6000);

  eventBus.publish("ticket_created", t(ticketId, buyerId, sellerId));
  await sleep(1000);

  console.log("\n--- PHASE 1: NLP NEGOTIATION ---");

  const conversation = [
    { sender: buyerId, msg: "hey i have openai api i will sell it for 0.002sol." },
    { sender: sellerId, msg: "now way you are asking much." },
    { sender: buyerId, msg: "ok i also not intrested less than 0.002." },
    { sender: sellerId, msg: "i can toughly go to 0.0015 beacause i can get more apis for 0.002 s." },
    { sender: buyerId, msg: "then i am not going to proceed." },
    { sender: sellerId, msg: "i am offreing you last 0.0017 sol do it or close this ticket." },
    { sender: buyerId, msg: "ok i am not going to complete this deal if you have 0.0018 sol then i can." },
    { sender: sellerId, msg: "ok lets go further i am ready with 0.0018 sol and 0.001 sol collatreal." },
    { sender: buyerId, msg: "ok lets do it then" }
  ];

  let escrowPdaStr: string | null = null;
  let allDepositsReceived = false;
  let dealCompleted = false;

  // Intercept the Middleman's responses to dynamically catch the PDA address later
  eventBus.subscribe("middleman_response", (payload) => {
    if (payload.ticket_id === ticketId) {
      if (payload.phase === "awaiting_deposits" && /escrow address/i.test(payload.content)) {
        // Match the base58 address directly by removing markdown/backticks first
        const contentClean = payload.content.replace(/[*`]/g, "");
        const match = contentClean.match(/escrow address:\s*([A-Za-z0-9]{32,44})/i);
        if (match && match[1]) {
          escrowPdaStr = match[1];
          console.log(`\n🤖 [SYS-INTERCEPT] Escrow PDA detected: ${escrowPdaStr}`);
        }
      }
    }
  });

  eventBus.subscribe("phase_changed", (payload) => {
    if (payload.to_phase === "delivery") allDepositsReceived = true;
    if (payload.to_phase === "completed") dealCompleted = true;
  });

  for (const turn of conversation) {
    console.log(`[${turn.sender}]: ${turn.msg}`);
    eventBus.publish("message_received", m(ticketId, turn.sender, turn.msg));
    await sleep(4000);
  }

  console.log("\n--- PHASE 2: WAIT FOR CREATE_ESCROW tx ---");
  console.log("Agent Brain is confirming intent -> Expecting smart contract deployment...");

  for (let i = 0; i < 40; i++) {
    if (escrowPdaStr) break;
    await sleep(2000);
  }

  if (!escrowPdaStr) {
    console.error("❌ FAILED: Agent never initialized the escrow PDA.");
    process.exit(1);
  }

  console.log("\n--- PHASE 3: MANUAL DEPOSITS (Simulating human sending SOL) ---");
  const pda = new PublicKey(escrowPdaStr);

  async function sendSol(fromKp: Keypair, amountSol: number, label: string) {
    console.log(`[USER SIMULATION] ${label} is sending ${amountSol} SOL to ${pda.toBase58()}...`);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromKp.publicKey,
        toPubkey: pda,
        lamports: amountSol * LAMPORTS_PER_SOL,
      })
    );
    // Send standard tx
    const sig = await sendAndConfirmTransaction(connection, tx, [fromKp]);
    console.log(`   ✅ Sent! TX: ${sig}`);
  }

  // Send Collateral (Buyer)
  await sendSol(buyerKeypair, 0.001, "Buyer (Collateral)");
  await sleep(20000); // Wait for connection.onAccountChange + Agent tx execution

  // Send Collateral (Seller)
  await sendSol(sellerKeypair, 0.001, "Seller (Collateral)");
  await sleep(20000);

  // Send Payment (Buyer)
  await sendSol(buyerKeypair, 0.0018, "Buyer (Payment)");

  console.log("\n--- PHASE 4: WAIT FOR DEPOSIT CONFIRMATIONS ---");
  for (let i = 0; i < 30; i++) {
    if (allDepositsReceived) break;
    await sleep(2000);
  }

  // Wait a bit just for delivery transition if not fully handled
  await sleep(10000);

  console.log("\n--- PHASE 5: DELIVERY & RELEASE ---");
  console.log("[Seller]: *sends API key in DM*");

  const releaseMsg = "@middleman i received my items! release funds";
  console.log(`[Buyer]: ${releaseMsg}`);
  eventBus.publish("message_received", m(ticketId, buyerId, releaseMsg));

  for (let i = 0; i < 40; i++) {
    if (dealCompleted) break;
    await sleep(2000);
  }

  if (!dealCompleted) {
    console.error("❌ FAILED: Executable release phase did not complete.");
    process.exit(1);
  }

  console.log("\n======================================================");
  console.log(" ✅ FULL AUTONOMOUS SIMULATION COMPLETE ✅");
  console.log("======================================================\n");

  process.exit(0);
}

runAutonomousSimulation().catch((err) => {
  console.error("Simulation crashed:", err);
  process.exit(1);
});
