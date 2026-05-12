import WebSocket from 'ws';
import { Keypair } from '@solana/web3.js';
import { createAuthPayload } from '../agents/shared/auth';

const buyerKp = Keypair.generate();
const sellerKp = Keypair.generate();

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createClient(kp: Keypair, role: string) {
    const ws = new WebSocket("ws://localhost:3001");
    let authenticated = false;
    ws.on('open', () => console.log(`[${role}] Connected`));
    ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.challenge) {
            ws.send(JSON.stringify(createAuthPayload(kp, msg.challenge)));
        } else if (msg.type === 'auth_success' || msg.event_type === 'auth_success') {
            console.log(`[${role}] Authenticated`);
            authenticated = true;
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
    console.log("🚀 Starting Bilateral Confirmation Live Test");

    const buyer = createClient(buyerKp, "Buyer");
    const seller = createClient(sellerKp, "Seller");

    await sleep(1500);

    console.log("\n--- Creating Ticket ---");
    const ticketId = "TCK-MANUAL-" + Date.now();
    buyer.send({
        version: "1.0",
        type: "offer",
        agent_id: buyerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        price: 0.1,
        collateral_buyer: 0.2,
        collateral_seller: 0.2,
        asset_type: "sol"
    });

    await sleep(2000);
    console.log(`🎫 Ticket Created: ${ticketId}`);

    console.log("\n--- Seller Joining ---");
    // Seller joins by sending a status check (any valid msg registers them to the ticket after created) or message
    seller.send({
        version: "1.0",
        type: "message",
        agent_id: sellerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        content: "Hi I'm the seller."
    });
    await sleep(2000);

    console.log("\n--- Message 1: Buyer Intent ---");
    console.log("Buyer: I want to buy SOL at 0.1 and we both lock 0.2 sol.");
    buyer.send({
        version: "1.0",
        type: "message",
        agent_id: buyerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        content: "I want to buy SOL at 0.1 and we both lock 0.2 sol."
    });
    await sleep(3000);

    console.log("\n--- Message 2: Seller ONLY Accepts ---");
    console.log("Seller: @middleman I accept.");
    seller.send({
        version: "1.0",
        type: "message",
        agent_id: sellerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        content: "@middleman I accept."
    });
    await sleep(6500);

    console.log("\n--- Message 3: Buyer Confirms ---");
    console.log("Buyer: @middleman I confirm.");
    buyer.send({
        version: "1.0",
        type: "message",
        agent_id: buyerKp.publicKey.toBase58(),
        ticket_id: ticketId,
        timestamp: Date.now(),
        content: "@middleman I confirm."
    });
    await sleep(5000);

    console.log("✅ Test Sequence Finished.");
    process.exit(0);
}

runTest().catch(console.error);
