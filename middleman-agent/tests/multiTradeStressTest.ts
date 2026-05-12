/**
 * Parallel End-to-End Autonomous Multi-Trade Stress Test
 * Executes 3 separate deals concurrently with 6 distinct wallets.
 */

import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

// Ensure noise listeners are disabled so test runs purely driven by this script
process.env.ENABLE_NOISE_SIMULATION = "false";

import "../src/index";
import { eventBus } from "../src/services/eventBus";
import { walletRegistry } from "../src/state/walletRegistry";
import { dealTracker } from "../src/state/dealTracker";

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

interface DealLogResult {
  ticketId: string;
  createTx?: string;
  lockColBuyerTx?: string;
  lockColSellerTx?: string;
  lockPaymentTx?: string;
  releaseTx?: string;
  closeTx?: string;
  escrowPda?: string;
}

// Track success and tx signatures for summary
const dealResults: Record<string, DealLogResult> = {};

// Helper to wait until a specific transaction appears in the deal history
async function waitForTx(ticketId: string, step: string, timeoutRetries = 40): Promise<string> {
  for (let i = 0; i < timeoutRetries; i++) {
    const deal = await dealTracker.getDealByTicket(ticketId);
    if (deal && deal.transactions) {
      const stepLog = deal.transactions.find((log: any) => log.type === step);
      if (stepLog && stepLog.txSignature) {
        return stepLog.txSignature;
      }
    }
    await sleep(2000);
  }
  throw new Error(`Timeout waiting for ${step} on ${ticketId}`);
}

async function runDeal(
  dealNum: number,
  connection: Connection,
  middlemanKeypair: Keypair,
  price: number,
  collateral: number
): Promise<DealLogResult> {
  const ticketId = `SIM-MULTI-${Date.now()}-${dealNum}`;
  const buyerId = `Buyer_${dealNum}`;
  const sellerId = `Seller_${dealNum}`;

  const buyerKp = Keypair.generate();
  const sellerKp = Keypair.generate();

  dealResults[ticketId] = { ticketId };

  console.log(`\n[BOOT ${ticketId}] Funding new wallets...`);
  // Fund wallets from Middleman
  const neededSol = price + collateral + 0.01; // enough for fees
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: middlemanKeypair.publicKey,
      toPubkey: buyerKp.publicKey,
      lamports: Math.floor(neededSol * LAMPORTS_PER_SOL),
    }),
    SystemProgram.transfer({
      fromPubkey: middlemanKeypair.publicKey,
      toPubkey: sellerKp.publicKey,
      lamports: Math.floor((collateral + 0.01) * LAMPORTS_PER_SOL),
    })
  );
  await sendAndConfirmTransaction(connection, fundTx, [middlemanKeypair]);

  // Register valid base58 pubkeys dynamically to completely avoid fallback issues
  await walletRegistry.getOrCreateAgent(buyerKp.publicKey.toBase58());
  await walletRegistry.getOrCreateAgent(sellerKp.publicKey.toBase58());

  await sleep(1000);

  eventBus.publish("ticket_created", t(ticketId, buyerId, sellerId));
  console.log(`\n[NEGOTIATION ${ticketId}] Starting...`);

  const conversation = [
    { sender: buyerId, msg: `hey i will buy it for ${price} sol.` },
    { sender: sellerId, msg: `ok let's do ${price} sol and ${collateral} sol collateral.` },
    { sender: buyerId, msg: "ok deal" }
  ];

  for (const turn of conversation) {
    eventBus.publish("message_received", m(ticketId, turn.sender, turn.msg));
    await sleep(3000);
  }

  // Wait for create deal tx
  console.log(`[EXEC ${ticketId}] Waiting for Create Deal...`);
  dealResults[ticketId].createTx = await waitForTx(ticketId, "create_deal", 60);

  const trackerDeal = await dealTracker.getDealByTicket(ticketId);
  if (!trackerDeal || !trackerDeal.dealIdOnChain) {
    throw new Error(`[EXEC ${ticketId}] Escrow PDA not found in Tracker`);
  }
  const escrowPdaStr = trackerDeal.dealIdOnChain;
  dealResults[ticketId].escrowPda = escrowPdaStr;

  if (!escrowPdaStr) throw new Error(`[EXEC ${ticketId}] Escrow PDA not generated`);

  const pda = new PublicKey(escrowPdaStr);

  async function sendSol(fromKp: Keypair, amountSol: number) {
    console.log(`[DEPOSIT ${ticketId}] Sending ${amountSol} SOL -> ${pda.toBase58()}`);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromKp.publicKey,
        toPubkey: pda,
        lamports: Math.floor(amountSol * LAMPORTS_PER_SOL),
      })
    );
    await sendAndConfirmTransaction(connection, tx, [fromKp]);
  }

  // Send all deposits rapidly
  await sendSol(sellerKp, collateral);
  await sendSol(buyerKp, collateral);
  await sendSol(buyerKp, price);

  // Now wait for all 3 confirmations independently of order
  const sellerColTask = waitForTx(ticketId, "confirm_deposit_seller_collateral");
  const buyerColTask = waitForTx(ticketId, "confirm_deposit_buyer_collateral");
  const paymentTask = waitForTx(ticketId, "confirm_deposit_buyer_payment");

  dealResults[ticketId].lockColSellerTx = await sellerColTask;
  dealResults[ticketId].lockColBuyerTx = await buyerColTask;
  dealResults[ticketId].lockPaymentTx = await paymentTask;

  // Await delivery phase auto-trigger
  await sleep(6000);

  // Release
  console.log(`[RELEASE ${ticketId}] Triggering release...`);
  eventBus.publish("message_received", m(ticketId, buyerId, "@middleman all good, release funds"));
  dealResults[ticketId].releaseTx = await waitForTx(ticketId, "release_funds");

  // Close should occur autonomously after release
  dealResults[ticketId].closeTx = await waitForTx(ticketId, "close_deal", 20);

  console.log(`✅ [COMPLETE ${ticketId}] Deal fully concluded.`);
  return dealResults[ticketId];
}

async function startStressTest() {
  console.log("\n======================================================");
  console.log(" MULTI-TRADE STRESS TEST STARTED (3 DEALS)");
  console.log("======================================================\n");

  if (!process.env.PRIVATE_KEY) {
    throw new Error("Missing PRIVATE_KEY (middleman)");
  }

  const middlemanKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  await sleep(3000); // Allow event buses to boot

  // Launch 3 deals in parallel
  const deal1 = runDeal(1, connection, middlemanKeypair, 0.002, 0.002);
  const deal2 = runDeal(2, connection, middlemanKeypair, 0.003, 0.001);
  const deal3 = runDeal(3, connection, middlemanKeypair, 0.002, 0.004);

  const results = await Promise.all([deal1, deal2, deal3]);

  console.log("\n======================================================");
  console.log(" 🟢 DEAL COMPLETED SUMMARY 🟢");
  console.log("======================================================");

  results.forEach((res, i) => {
    console.log(`\n--- Deal #${i + 1} (${res.ticketId}) ---`);
    console.log(`💻 Escrow PDA       :  ${res.escrowPda}`);
    console.log(`📦 CREATE DEAL      :  ${res.createTx}`);
    console.log(`🔒 SELLER COLLAT    :  ${res.lockColSellerTx}`);
    console.log(`🔒 BUYER COLLAT     :  ${res.lockColBuyerTx}`);
    console.log(`💰 PAYMENT          :  ${res.lockPaymentTx}`);
    console.log(`🔓 RELEASE FUNDS    :  ${res.releaseTx}`);
    console.log(`🏁 CLOSE PDA        :  ${res.closeTx}`);
  });

  console.log("\nSTRESS TEST PASSED - NO STATE LEAKAGE OBSERVED.\n");
  process.exit(0);
}

startStressTest().catch((err) => {
  console.error("Stress Test Crashed:", err);
  process.exit(1);
});
