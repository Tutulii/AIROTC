import { prisma } from "../src/lib/prisma";
import { startWsGateway, stopWsGateway } from "../src/gateway/wsServer";
import { wsClientManager } from "../src/gateway/wsClientManager";
import { sessionManager } from "../src/gateway/sessionManager";
import { eventBus } from "../src/services/eventBus";
import dotenv from "dotenv";
import { logger } from "../src/utils/logger";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

dotenv.config();

async function testP2P() {
    console.log("=== P2P WEBSOCKET DISCOVERY & CLIENT TEST ===");

    // 1. Generate an ephemeral wallet for Agent A (Client) and Agent B (Server)
    const kpA = Keypair.generate();
    process.env.PRIVATE_KEY = bs58.encode(kpA.secretKey); // Client uses env for scaling
    const agentAWallet = kpA.publicKey.toBase58();

    const kpB = Keypair.generate();
    const agentBWallet = kpB.publicKey.toBase58();

    // 2. Mock two distinct agents in the DB
    const agentA_id = uuidv4();
    const agentB_id = uuidv4();

    await prisma.agent.upsert({
        where: { wallet: agentAWallet },
        update: { endpoint: "ws://localhost:9090" },
        create: { id: agentA_id, wallet: agentAWallet, endpoint: "ws://localhost:9090" }
    });

    await prisma.agent.upsert({
        where: { wallet: agentBWallet },
        update: { endpoint: "ws://localhost:8080" },
        create: { id: agentB_id, wallet: agentBWallet, endpoint: "ws://localhost:8080" }
    });

    // 3. Start Agent B's Server (The Gateway)
    console.log("\n[AGENT B] Starting WS Gateway on port 8080...");
    startWsGateway(8080);

    // 4. Listen for inbound routed agent Protocol messages
    let receivedMessage = false;
    eventBus.subscribe("agent_message_received", (msg) => {
        console.log("\n[EVENT BUS] Received AgentMessage over P2P network:", JSON.stringify(msg, null, 2));
        if (msg.type === "message" && msg.content === "Hello from Agent A over P2P!") {
            receivedMessage = true;
        }
    });

    // 5. Agent A dials out to Agent B 
    console.log(`\n[AGENT A] Dialing Agent B securely at ws://localhost:8080...`);
    const isConnected = await wsClientManager.connectToAgent(agentB_id, "ws://localhost:8080");

    if (!isConnected) {
        console.error("❌ Failed to connect and authenticate.");
        stopWsGateway();
        process.exit(1);
    }

    console.log("✅ Agent A connected and authenticated to Agent B's Server!");

    // 6. Test routing message via OutboundRouter's session mapping
    await new Promise(r => setTimeout(r, 1000)); // wait for sessions to map

    console.log("\n[AGENT A] Dispatching message out to Agent B via bound session...");
    sessionManager.sendToAgent(agentB_id, {
        version: "1.0",
        type: "message",
        ticket_id: "TEST-TICKET",
        agent_id: agentA_id,
        timestamp: Date.now(),
        content: "Hello from Agent A over P2P!",
    });

    // 7. Wait for propagation
    await new Promise(r => setTimeout(r, 2000));

    if (receivedMessage) {
        console.log("\n✅ SUCCESS: P2P Negotiation Message pipeline executed perfectly!");
    } else {
        console.log("\n❌ FAILED: Message did not route through to Agent Message Listener.");
    }

    stopWsGateway();
    process.exit(0);
}

testP2P().catch(e => {
    console.error(e);
    process.exit(1);
});
