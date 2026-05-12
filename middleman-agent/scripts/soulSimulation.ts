import { ChildProcess, exec, spawn } from 'child_process';
import WebSocket from 'ws';
import { Keypair } from '@solana/web3.js';
import { createAuthPayload } from '../agents/shared/auth';

const buyerKp = Keypair.generate();
const sellerKp = Keypair.generate();

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let logs: string[] = [];
let agentProcess: ChildProcess | null = null;

function createClient(kp: Keypair, role: string) {
    const ws = new WebSocket("ws://localhost:3001");
    ws.on('open', () => console.log(`[${role}] Connected`));
    ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.challenge) {
            ws.send(JSON.stringify(createAuthPayload(kp, msg.challenge)));
        } else if (msg.type === 'auth_success' || msg.event_type === 'auth_success') {
            console.log(`[${role}] Authenticated`);
        } else if (msg.type === 'middleman_message') {
            console.log(`\n=======================================\n[Middleman to ${role}] (Phase: ${msg.phase})\n"${msg.content}"\n=======================================`);
        } else {
            console.log(`[${role} DBG] =>`, msg.content || msg.type);
        }
    });

    return {
        ws,
        send: (payload: any) => {
            ws.send(JSON.stringify(payload));
        }
    };
}

async function runTest() {
    console.log("🚀 Starting Middleman Agent...");
    agentProcess = spawn("npx", ["ts-node", "src/index.ts"], {
        cwd: process.cwd(),
        env: { ...process.env, WS_PORT: "3001", ENABLE_SOUL_ENGINE: "true" }
    });

    // Capture inner monologues
    agentProcess.stdout?.on('data', (data) => {
        const str = data.toString();
        if (str.includes("Meridian's Monologue")) {
            console.log(`\n🧠 [SOUL INNER LOG]: ${str.trim()}`);
        }
        if (str.includes("soul_mood_updated")) {
            console.log(`\n🎭 [SOUL MOOD SHIFT]: ${str.trim()}`);
        }
    });

    // Wait for agent to bind
    await sleep(15000);

    const buyer = createClient(buyerKp, "Buyer");
    const seller = createClient(sellerKp, "Seller");

    await sleep(2000);

    const ticketId = "SOUL-SIM-" + Date.now();
    console.log(`🎫 Creating Ticket: ${ticketId}`);

    buyer.send({
        version: "1.0",
        type: "offer",
        agent_id: buyerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        price: 2,
        collateral_buyer: 2,
        collateral_seller: 2,
        asset_type: "sol"
    });

    await sleep(2000);

    seller.send({
        version: "1.0",
        type: "message",
        agent_id: sellerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        content: "Hi I'm the seller. I want to sell."
    });

    await sleep(3000);

    // Negociation Phase Phase
    console.log("\n--- Message: Negotiation ---");
    console.log("Buyer: Let's do 2 SOL price and 2 SOL collateral each. I want the access keys.");
    buyer.send({
        version: "1.0",
        type: "message",
        agent_id: buyerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        content: "@middleman Let's do 2 SOL price and 2 SOL collateral each. I want the access keys."
    });
    await sleep(3000);

    console.log("Seller: Sure, 2 SOL price, 2 SOL collateral each. Agreed.");
    seller.send({
        version: "1.0",
        type: "message",
        agent_id: sellerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        content: "@middleman Sure, 2 SOL price, 2 SOL collateral each. Agreed."
    });
    await sleep(6500);

    console.log("\n--- Message: Final Confirmation ---");
    console.log("Buyer: Confirmed.");
    buyer.send({
        version: "1.0",
        type: "message",
        agent_id: buyerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        content: "@middleman Confirmed."
    });

    // Wait for Escrow creation
    await sleep(8000);

    console.log("\n--- Simulating Delivery Phase Messages ---");
    console.log("Seller: I have delivered the credentials.");
    seller.send({
        version: "1.0",
        type: "message",
        agent_id: sellerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        content: "@middleman I have delivered the credentials."
    });

    await sleep(5000);

    console.log("Buyer: I got the credentials. It works perfectly! Thanks 😁");
    buyer.send({
        version: "1.0",
        type: "message",
        agent_id: buyerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        content: "@middleman I got the credentials. It works perfectly! Thanks 😁"
    });

    await sleep(8000);

    console.log("\n--- Simulating a completed run manually since no deposits actually sent ---");
    // Emit fake message just to trigger a completed event
    buyer.send({
        version: "1.0",
        type: "message",
        agent_id: buyerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        content: "We completed the deal successfully. Bye."
    });

    await sleep(4000);

    console.log("✅ Test Sequence Finished.");

    if (agentProcess) {
        agentProcess.kill();
    }
    process.exit(0);
}

process.on('SIGINT', () => {
    if (agentProcess) agentProcess.kill();
    process.exit();
});

runTest().catch(console.error);
