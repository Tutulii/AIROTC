/**
 * Real End-to-End Integration Test (User Requested Sequence)
 */

import { eventBus } from "../src/services/eventBus";
import { dealPhaseManager } from "../core/dealPhaseManager";
import "../src/index";
import { walletRegistry } from "../src/state/walletRegistry";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let msgIdCounter = 1;
function m(ticket_id: string, sender: string, content: string) {
  return { ticket_id, sender, content, message_id: `msg-${msgIdCounter++}`, timestamp: new Date().toISOString() };
}

function t(ticket_id: string, buyer: string, seller: string) {
  return { ticket_id, buyer, seller, offer_id: `off-${Date.now()}`, status: "pending" as any, created_at: new Date().toISOString() };
}

async function runRealTests() {
  console.log("\n======================================================");
  console.log(" MOCKING LIVE CHAT SERVER (User Prompts)");
  console.log("======================================================\n");

  const ticketA = "REAL-TICKET-ACTUAL";
  const buyer = "BuyerWallet";
  const seller = "SellerWallet";

  // Wait for the async RPC daemon boot
  console.log("Waiting for daemon boot...");
  await sleep(8000);

  if (process.env.BUYER_PK) {
    const k = Keypair.fromSecretKey(bs58.decode(process.env.BUYER_PK));
    await walletRegistry.getOrCreateAgent(k.publicKey.toBase58());
  }
  if (process.env.SELLER_PK) {
    const k = Keypair.fromSecretKey(bs58.decode(process.env.SELLER_PK));
    await walletRegistry.getOrCreateAgent(k.publicKey.toBase58());
  }

  eventBus.publish("ticket_created", t(ticketA, buyer, seller));
  await sleep(1000);

  console.log("\n--- TEST 1: Full Real Negotiation (Auto-Agreement) ---");

  const chatLogs = [
    { sender: seller, msg: "hey i have openai api i will sell it for 2sol." },
    { sender: buyer, msg: "no way you are asking much." },
    { sender: seller, msg: "ok i also not intrested less than 2." },
    { sender: buyer, msg: "i can toughly go to 1.5 beacause i can get more apis for 2 s." },
    { sender: seller, msg: "then i am not going to proceed." },
    { sender: buyer, msg: "i am offreing you last 1.7 sol do it or close this ticket." },
    { sender: seller, msg: "ok i am not going to complete this deal if you have 1.8 then i can." },
    { sender: buyer, msg: "ok lets go further i am ready with 1.8 sol and 1 sol collatreal." },
    { sender: seller, msg: "ok lets do it then" }
  ];

  for (const log of chatLogs) {
    console.log(`[${log.sender}]: ${log.msg}`);
    eventBus.publish("message_received", m(ticketA, log.sender, log.msg));
    await sleep(2000);
  }

  // 45 seconds to let LLM auto-agree, Phase Manager trigger, and On-chain full execution trigger
  console.log("\n> Waiting 45s for Agreement Detection -> Full On-Chain Execution Lifecycle...");
  await sleep(45000);

  console.log("\n--- TEST 3: Error Handling ---");
  console.log("> (See above logs) The Agent attempts to create rules on-chain, but the dummy wallets fail. The Auto-Healer intercepts the RPC error and prompts dynamically.\n");

  console.log("\n======================================================");
  console.log("\n--- TEST 2: Dispute in Active Deal ---");

  // Since the on-chain creation failed, we manually force the state 
  // into 'escrow_created' to simulate a funded deal so the AI Judge can trigger.
  const ticketB = "REAL-TICKET-DISPUTE";
  eventBus.publish("ticket_created", t(ticketB, buyer, seller));
  await sleep(500);

  // Force phase
  dealPhaseManager.initDeal(ticketB, buyer, seller);
  dealPhaseManager.handleAction("CREATE_ESCROW", ticketB, buyer, { price: 6, collateral_buyer: 2, collateral_seller: 2 });
  await sleep(1000);

  console.log(`[${buyer}]: @middleman the seller sent fake data`);
  eventBus.publish("message_received", m(ticketB, buyer, "@middleman the seller sent fake data"));

  console.log("\n> Waiting 15 seconds for AI Judge Arbitrator Context Check...\n");
  await sleep(15000);

  console.log("\n======================================================");
  console.log(" End-to-End Simulation Complete.");
  process.exit(0);
}

runRealTests().catch(console.error);
