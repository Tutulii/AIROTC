/**
 * Real WebSocket Agent Client (Level 5 Autonomy Proof)
 *
 * Usage:
 *   npx ts-node scripts/agentClient.ts --wallet <base58_privkey> --action offer|message|accept [--ticket <id>] [--content <msg>] [--price <sol>]
 *
 * Flow:
 *   1. Connect to ws://localhost:3001
 *   2. Receive auth_challenge
 *   3. Sign challenge with ed25519 private key
 *   4. Send auth_response { type, wallet, signature }
 *   5. Receive auth_success { agent_id }
 *   6. Send structured message based on --action flag
 *   7. Listen for middleman_message events
 *
 * This proves REAL external agents can connect → authenticate → interact.
 */

import { WebSocket } from "ws";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
}

const walletKey = getArg("wallet");
const action = getArg("action") || "message";
const ticketId = getArg("ticket");
const content = getArg("content") || "hello from real agent";
const price = parseFloat(getArg("price") || "0.01");
const wsUrl = getArg("url") || "ws://localhost:3001";

if (!walletKey) {
    console.error("Usage: npx ts-node scripts/agentClient.ts --wallet <base58_privkey> --action <offer|message|accept>");
    process.exit(1);
}

const keypair = Keypair.fromSecretKey(bs58.decode(walletKey));
console.log(`[CLIENT] Wallet: ${keypair.publicKey.toBase58()}`);
console.log(`[CLIENT] Action: ${action}`);
console.log(`[CLIENT] Connecting to ${wsUrl}...`);

const ws = new WebSocket(wsUrl);

ws.on("open", () => {
    console.log("[CLIENT] ✅ Connected");
});

ws.on("message", (data: Buffer) => {
    try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "auth_challenge") {
            console.log(`[CLIENT] 🔐 Auth challenge received: ${msg.challenge.substring(0, 20)}...`);
            const messageBytes = Buffer.from(msg.challenge, "utf-8");
            const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
            ws.send(JSON.stringify({
                type: "auth_response",
                wallet: keypair.publicKey.toBase58(),
                signature: bs58.encode(signature),
            }));
            console.log("[CLIENT] 📤 Auth response sent");
        }

        if (msg.type === "auth_success") {
            console.log(`[CLIENT] ✅ Authenticated as agent: ${msg.agent_id}`);
            sendAction(msg.agent_id);
        }

        if (msg.type === "middleman_message") {
            console.log(`\n[MIDDLEMAN → ${msg.ticket_id}]:`);
            console.log(msg.content);
            console.log(`[Phase: ${msg.phase}]\n`);
        }

        if (msg.type === "error") {
            console.error(`[ERROR]: ${msg.error}`);
        }

        if (msg.type === "auth_failed") {
            console.error(`[AUTH FAILED]: ${msg.reason || "unknown"}`);
            process.exit(1);
        }
    } catch (e: any) {
        console.error(`[CLIENT] Parse error: ${e.message}`);
    }
});

ws.on("error", (e: Error) => {
    console.error(`[CLIENT] ❌ Connection error: ${e.message}`);
    process.exit(1);
});

ws.on("close", () => {
    console.log("[CLIENT] 🔌 Disconnected");
});

function sendAction(agentId: string) {
    const payload: any = {
        version: "1.0",
        type: action,
        agent_id: agentId,
        timestamp: Date.now(),
    };

    if (ticketId) payload.ticket_id = ticketId;

    if (action === "message") {
        payload.content = content;
        if (ticketId) payload.ticket_id = ticketId;
    }

    if (action === "offer") {
        payload.price = price;
        payload.side = "buy";
        payload.content = `I want to buy at ${price} SOL`;
    }

    if (action === "accept") {
        if (!ticketId) {
            console.error("[CLIENT] --ticket required for accept action");
            return;
        }
        payload.content = `I accept the deal at ${price} SOL`;
    }

    console.log(`[CLIENT] 📤 Sending ${action}:`, JSON.stringify(payload, null, 2));
    ws.send(JSON.stringify(payload));
}

// Keep process alive to receive responses
process.on("SIGINT", () => {
    console.log("\n[CLIENT] Shutting down...");
    ws.close();
    process.exit(0);
});
