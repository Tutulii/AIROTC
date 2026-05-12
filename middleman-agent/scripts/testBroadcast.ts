/**
 * Sprint 2A — Intent Broadcast Test
 *
 * Standalone script that broadcasts one trade intent as a Solana Memo
 * transaction on devnet and prints the tx signature + Explorer URL.
 *
 * Usage:
 *   npx ts-node scripts/testBroadcast.ts
 */

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { broadcastIntent } from "../src/services/intentBroadcaster";

const DIVIDER = "═".repeat(60);

async function main(): Promise<void> {
    console.log(`\n${DIVIDER}`);
    console.log("  AgentOTC Sprint 2A — Intent Broadcast Test");
    console.log(`${DIVIDER}\n`);

    // ── 1. Load wallet ────────────────────────────────────────────
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        console.error("❌ Missing PRIVATE_KEY in .env");
        process.exit(1);
    }

    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    console.log(`  Wallet: ${wallet.publicKey.toBase58()}`);

    // ── 2. Connect to devnet ──────────────────────────────────────
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");
    console.log(`  RPC:    ${rpcUrl}`);

    // ── 3. Check balance, airdrop if needed ───────────────────────
    let balance = await connection.getBalance(wallet.publicKey);
    let balanceSol = balance / LAMPORTS_PER_SOL;
    console.log(`  Balance: ${balanceSol} SOL`);

    if (balanceSol < 0.01) {
        console.log("  ⚡ Requesting airdrop (1 SOL)...");
        const sig = await connection.requestAirdrop(
            wallet.publicKey,
            1 * LAMPORTS_PER_SOL
        );
        await connection.confirmTransaction(sig, "confirmed");
        balance = await connection.getBalance(wallet.publicKey);
        balanceSol = balance / LAMPORTS_PER_SOL;
        console.log(`  New balance: ${balanceSol} SOL`);
    }

    // ── 4. Broadcast a sample buy intent ──────────────────────────
    console.log("\n  Broadcasting sample BUY intent...\n");

    const agentEndpoint = process.env.AGENT_ENDPOINT || "ws://localhost:8080";

    const result = await broadcastIntent(connection, wallet, {
        side: "buy",
        asset: "SOL",
        minPrice: 4.5,
        maxPrice: 5.5,
        quantity: 10,
        agentEndpoint,
        ttlMinutes: 60,
    });

    // ── 5. Print results ──────────────────────────────────────────
    console.log(`\n${"─".repeat(60)}`);

    if (result.success) {
        console.log(`  ✅ Broadcast SUCCESS`);
        console.log(`  TX Signature: ${result.txSignature}`);
        console.log(`  Explorer URL: ${result.explorerUrl}`);
        console.log(`\n  👆 Open that URL in your browser.`);
        console.log(`     Look for "protocol": "agentotc-v1" in the Memo data.`);
    } else {
        console.log(`  ❌ Broadcast FAILED: ${result.error}`);
    }

    console.log(`\n${DIVIDER}\n`);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
