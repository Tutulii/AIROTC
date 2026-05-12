import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { WsClient } from './shared/wsClient';
import { AgentConfig } from './shared/types';
import bs58 from 'bs58';

dotenv.config({ path: path.join(__dirname, '../.env') });

function loadWalletFromEnv(envKey: string): Keypair {
    const rawKey = process.env[envKey];
    if (!rawKey) throw new Error(`${envKey} missing`);
    return Keypair.fromSecretKey(bs58.decode(rawKey));
}

const API_URL = process.env.API_URL || 'http://localhost:8080';
const WS_URL = process.env.WS_URL || 'ws://localhost:3001';

const buyerWallet = loadWalletFromEnv("BUYER_PRIVATE_KEY");
const sellerWallet = loadWalletFromEnv("SELLER_PRIVATE_KEY");

const conversation = [
    { role: 'Buyer', text: "Hey, I’m looking to buy 1 SOL OTC. What price are you offering?" },
    { role: 'Seller', text: "Hi, I can sell 1 SOL at 0.25." },
    { role: 'Buyer', text: "0.25 feels a bit high given current market conditions. I was thinking closer to 0.18." },
    { role: 'Seller', text: "0.18 is too low for me. I can maybe come down slightly, but not that much." },
    { role: 'Buyer', text: "Fair enough. What’s the lowest you’re willing to go?" },
    { role: 'Seller', text: "I could do 0.23 if we move quickly." },
    { role: 'Buyer', text: "Hmm, still a bit above what I’m comfortable with. Market liquidity is decent right now, so I don’t see the premium." },
    { role: 'Seller', text: "True, but I’m offering instant settlement and secured escrow. That has value." },
    { role: 'Buyer', text: "That’s a fair point. Would you meet me at 0.2?" },
    { role: 'Seller', text: "0.2 is borderline, but if collateral terms are fair, I might consider it." },
    { role: 'Buyer', text: "Yes, standard collateral works for me. No issues there." },
    { role: 'Seller', text: "Alright, but I’d want quick execution. No delays." },
    { role: 'Buyer', text: "Agreed. I’m ready to proceed immediately." },
    { role: 'Seller', text: "Okay, I can accept 0.2 under those conditions." },
    { role: 'Buyer', text: "Great, 0.2 works for me as well." },
    { role: 'Seller', text: "Just to confirm, 1 SOL at 0.2 with standard escrow and collateral?" },
    { role: 'Buyer', text: "Yes, confirmed." },
    { role: 'Seller', text: "Alright, I agree to the deal." },
    { role: 'Buyer', text: "Deal confirmed. Proceed to escrow." }
];

async function runConv() {
    console.log("🚀 Initializing Scripted OTC Environment...");
    
    // Create new offer via API to get Ticket ID
    const offerRes = await fetch(`${API_URL}/v1/offers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            amount: 1,
            price: 0.25, // Initial
            collateral: 0.05,
            asset: "SOL",
            buyerPublicKey: buyerWallet.publicKey.toBase58()
        })
    });
    const offerData: any = await offerRes.json();
    const ticketId = offerData.ticketId;
    console.log(`\n🎟️ Created Ticket: \x1b[33m${ticketId}\x1b[0m\n`);

    const buyerClient = new WsClient({ keypair: buyerWallet, apiUrl: API_URL, wsUrl: WS_URL, role: 'BUYER' });
    const sellerClient = new WsClient({ keypair: sellerWallet, apiUrl: API_URL, wsUrl: WS_URL, role: 'SELLER' });

    await new Promise(r => {
        let authCount = 0;
        buyerClient.on('authenticated', () => { authCount++; if (authCount===2) r(true); });
        sellerClient.on('authenticated', () => { authCount++; if (authCount===2) r(true); });
        buyerClient.connect();
        sellerClient.connect();
    });

    console.log("🔗 Both agents connected safely.\n");

    // Both status join
    buyerClient.send({ version: "1.0", timestamp: Date.now(), agent_id: buyerWallet.publicKey.toBase58(), type: "status", ticket_id: ticketId });
    sellerClient.send({ version: "1.0", timestamp: Date.now(), agent_id: sellerWallet.publicKey.toBase58(), type: "status", ticket_id: ticketId });
    await new Promise(r => setTimeout(r, 2000));

    // Also spin up a listener to log middleman actions
    buyerClient.on('message', (msg) => {
        const type = msg.event_type || msg.type;
        if (type === 'middleman_response') {
            console.log(`\n\x1b[35m[AI JUDGE]\x1b[0m \x1b[90m[${msg.phase || 'none'}]\x1b[0m ${msg.content}\n`);
        } else if (type === 'deal_created' || type === 'escrow_created') {
            console.log(`\n\x1b[32m[ESCROW PDA]\x1b[0m \x1b[1m\x1b[33m${msg.escrowAddress || msg.dealId}\x1b[0m\n`);
        } else if (type === 'phase_changed') {
            console.log(`\n\x1b[36m[PHASE SHIFT]\x1b[0m ${msg.from_phase} \x1b[90m->\x1b[0m ${msg.to_phase}\n`);
        }
    });

    console.log("==========================================");
    console.log("🎬 STARTING CONVERSATION");
    console.log("==========================================\n");

    for (let c of conversation) {
        const color = c.role === 'Buyer' ? '\x1b[34m' : '\x1b[32m';
        const client = c.role === 'Buyer' ? buyerClient : sellerClient;
        const wallet = c.role === 'Buyer' ? buyerWallet : sellerWallet;

        console.log(`${color}[${c.role}]\x1b[0m ${c.text}`);
        
        client.send({
            version: "1.0",
            timestamp: Date.now(),
            agent_id: wallet.publicKey.toBase58(),
            type: "message",
            ticket_id: ticketId,
            content: c.text
        });

        // Let the middleman think and digest
        await new Promise(r => setTimeout(r, 3000));
    }
    
    console.log("\n==========================================");
    console.log("⏳ END OF CONVERSATION — WAITING FOR TRANSACTIONS");
    console.log("==========================================\n");

    // Hold process open
    await new Promise(r => setTimeout(r, 20000));
    console.log("✅ Simulation complete.");
    process.exit(0);
}

runConv();
