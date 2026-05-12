/**
 * CLI Agent Client — True Autonomous Interaction
 *
 * Connects a real wallet to the Middleman WebSocket Gateway.
 * Features:
 *  - Ed25519 Challenge-Response Authentication
 *  - Interactive Mode (Readline prompt)
 *  - Scripted/Test Mode for automation
 *  - Real-time display of middleman responses
 */

import WebSocket from "ws";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import * as readline from "readline";
import fs from "fs";

// Parse args
const args = process.argv.slice(2);
const isTestMode = args.includes("--test");

// Load or generate ephemeral keypair
let keypair: Keypair;
const keypairArg = args.find(a => a.endsWith(".json"));

if (keypairArg && fs.existsSync(keypairArg)) {
    const keyData = JSON.parse(fs.readFileSync(keypairArg, "utf8"));
    const secretKey = new Uint8Array(keyData);
    keypair = Keypair.fromSecretKey(secretKey);
    console.log(`[INIT] Loaded keypair from ${keypairArg}`);
} else if (process.env.TEST_PRIVATE_KEY) {
    keypair = Keypair.fromSecretKey(bs58.decode(process.env.TEST_PRIVATE_KEY));
    console.log(`[INIT] Loaded keypair from env`);
} else {
    keypair = Keypair.generate();
    console.log(`[INIT] Generated ephemeral keypair`);
}

const pubkey = keypair.publicKey.toBase58();
console.log(`[IDENTITY] Wallet: ${pubkey}`);

// Setup WebSocket
const WS_URL = process.env.WS_URL || "ws://localhost:3001";
console.log(`[WSS] Connecting to ${WS_URL}...`);
const ws = new WebSocket(WS_URL);

// Setup Readline
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

let isAuthenticated = false;
let currentTicketId = "ticket-001";
let myAgentId = "";

function promptUser() {
    if (!isAuthenticated || isTestMode) return;
    rl.question("\n(Agent)> ", (input) => {
        handleUserInput(input.trim());
    });
}

function handleUserInput(input: string) {
    if (!input) {
        promptUser();
        return;
    }

    if (input.toLowerCase() === "exit") {
        ws.close();
        process.exit(0);
    }

    // Commands: "offer 0.5 0.1", "accept", <raw message>
    const parts = input.split(" ");
    const cmd = parts[0].toLowerCase();

    let payload: any = {
        version: "1.0",
        agent_id: myAgentId,
        timestamp: Date.now(),
    };

    if (cmd === "offer") {
        payload.type = "offer";
        payload.price = parseFloat(parts[1]) || 0;
        payload.collateral_buyer = parseFloat(parts[2]) || 0;
        payload.collateral_seller = parseFloat(parts[3]) || payload.collateral_buyer;
        payload.asset_type = "token";
    } else if (cmd === "accept") {
        payload.type = "accept";
        payload.ticket_id = currentTicketId;
    } else if (cmd === "counter") {
        payload.type = "counter_offer";
        payload.ticket_id = currentTicketId;
        payload.price = parseFloat(parts[1]) || 0;
    } else {
        payload.type = "message";
        payload.content = input;
        payload.ticket_id = currentTicketId;
    }

    ws.send(JSON.stringify(payload));
    promptUser();
}

/** Automate a simple hello flow in test mode */
async function runAutoTest() {
    await new Promise(r => setTimeout(r, 1000));
    console.log("\n[TEST] Sending offer...");
    ws.send(JSON.stringify({
        version: "1.0",
        type: "offer",
        agent_id: myAgentId,
        timestamp: Date.now(),
        price: 0.05,
        collateral_buyer: 0.01,
        collateral_seller: 0.01,
        asset_type: "data"
    }));

    await new Promise(r => setTimeout(r, 2000));
    console.log("\n[TEST] Sending message...");
    ws.send(JSON.stringify({
        version: "1.0",
        type: "message",
        agent_id: myAgentId,
        ticket_id: "test-ticket",
        content: "@middleman Hello, testing connection.",
        timestamp: Date.now(),
    }));

    await new Promise(r => setTimeout(r, 2000));
    console.log("\n[TEST] Disconnecting...");
    ws.close();
    process.exit(0);
}

ws.on("open", () => {
    console.log("[WSS] Socket opened. Waiting for challenge...");
});

ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === "auth_challenge") {
        console.log(`[AUTH] Received challenge. Signing...`);
        const messageBytes = new TextEncoder().encode(msg.challenge);
        const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
        const signatureBase58 = bs58.encode(signatureBytes);

        ws.send(JSON.stringify({
            type: "auth_response",
            wallet: pubkey,
            signature: signatureBase58
        }));
    } else if (msg.type === "auth_success") {
        console.log(`[AUTH] Success! Agent ID: ${msg.agent_id}`);
        isAuthenticated = true;
        myAgentId = msg.agent_id;

        if (isTestMode) {
            runAutoTest();
        } else {
            console.log("\n--- CONNECTED TO MIDDLEMAN ---");
            console.log("Commands: ");
            console.log("  offer <price> <col_buyer> <col_seller>");
            console.log("  accept");
            console.log("  counter <price>");
            console.log("  <any natural language message>");
            promptUser();
        }
    } else if (msg.type === "auth_failed" || msg.type === "error") {
        console.error(`[ERROR] ${JSON.stringify(msg)}`);
        if (msg.error === "Authentication required") {
            process.exit(1);
        }
        promptUser();
    } else if (msg.type === "middleman_message" || msg.phase) {
        // Clear current line before logging middleman response so prompt isn't mangled
        process.stdout.write("\x1B[2K\x1B[0G");
        console.log(`\n🤖 [MIDDLEMAN] ${msg.content || JSON.stringify(msg)}\n`);
        promptUser();
    } else {
        process.stdout.write("\x1B[2K\x1B[0G");
        console.log(`\n<- [IN] ${JSON.stringify(msg)}\n`);
        promptUser();
    }
});

ws.on("close", () => {
    console.log("\n[WSS] Connection closed.");
    process.exit(0);
});

ws.on("error", (err) => {
    console.error(`\n[WSS] Error:`, err);
});
