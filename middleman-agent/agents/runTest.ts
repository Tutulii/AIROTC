/**
 * E2E Test: Buyer + Seller vs Railway-hosted Middleman
 * 
 * Direct coordination — no Solana Memo needed.
 * Buyer creates offer via REST, seller joins the ticket directly.
 *
 * Usage:  npx ts-node agents/runTest.ts
 */

import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '../.env') });

import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { WsClient } from './shared/wsClient';
import { AgentConfig, WsMessage } from './shared/types';
import { loadWalletFromEnv } from '../src/utils/loadWallet';

// ── Config ──────────────────────────────────────────────
const RAILWAY_URL = process.env.RAILWAY_URL;
if (!RAILWAY_URL) {
    console.error('❌ Set RAILWAY_URL in .env');
    process.exit(1);
}

const API_URL = RAILWAY_URL;
const WS_URL = RAILWAY_URL.replace(/^https?/, 'wss');

const buyer = loadWalletFromEnv("BUYER_PRIVATE_KEY");
const seller = loadWalletFromEnv("SELLER_PRIVATE_KEY");

// Known wallet addresses — we MUST filter these out from escrow detection
const KNOWN_WALLETS = new Set([
    buyer.publicKey.toBase58(),
    seller.publicKey.toBase58(),
]);

console.log('═══════════════════════════════════════════════');
console.log('  Meridian OTC — E2E Agent Test (v2)');
console.log('═══════════════════════════════════════════════');
console.log(`  API  → ${API_URL}`);
console.log(`  WS   → ${WS_URL}`);
console.log(`  Buyer  → ${buyer.publicKey.toBase58().substring(0, 12)}...`);
console.log(`  Seller → ${seller.publicKey.toBase58().substring(0, 12)}...`);
console.log('═══════════════════════════════════════════════\n');

// ── Helpers ─────────────────────────────────────────────
function extractEscrowAddress(text: string): string | null {
    if (!text) return null;
    // Find ALL base58 addresses in the text
    const matches = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
    if (!matches) return null;
    // Return the FIRST address that is NOT a known wallet
    for (const addr of matches) {
        if (!KNOWN_WALLETS.has(addr)) {
            return addr;
        }
    }
    return null;
}

// ── State tracking ──────────────────────────────────────
let ticketId: string | null = null;
let escrowAddress: string | null = null;
let buyerCollateralSent = false;
let sellerCollateralSent = false;
let buyerPaymentSent = false;
let buyerPhase = 'INIT';
let sellerPhase = 'INIT';

function logB(msg: string) { console.log(`  [BUYER]  ${msg}`); }
function logS(msg: string) { console.log(`  [SELLER] ${msg}`); }
function logT(msg: string) { console.log(`  [TEST]   ${msg}`); }

// ── Escrow address handler (shared) ─────────────────────
function handleEscrowDetection(addr: string, role: 'buyer' | 'seller', client: WsClient, tid: string) {
    escrowAddress = addr;
    logT(`🔑 ESCROW PDA DETECTED: ${addr} (from ${role})`);

    if (role === 'buyer' && !buyerCollateralSent) {
        buyerCollateralSent = true;
        buyerPhase = 'DEPOSIT_SENT';
        client.send({
            version: "1.0", timestamp: Date.now(),
            agent_id: buyer.publicKey.toBase58(),
            type: 'deposit_confirmed', ticket_id: tid, role: 'buyer'
        });
        client.send({
            version: "1.0", timestamp: Date.now(),
            agent_id: buyer.publicKey.toBase58(),
            type: "message", ticket_id: tid,
            content: "Buyer collateral sent. Confirming deposit."
        });
        buyerPhase = 'WAIT_DELIVERY';
        logB('✅ Collateral deposit confirmed');
    }

    if (role === 'seller' && !sellerCollateralSent) {
        sellerCollateralSent = true;
        sellerPhase = 'DEPOSIT_SENT';
        client.send({
            version: "1.0", timestamp: Date.now(),
            agent_id: seller.publicKey.toBase58(),
            type: 'deposit_confirmed', ticket_id: tid, role: 'seller'
        });
        sellerPhase = 'WAIT_DELIVERY';
        logS('✅ Collateral deposit confirmed');
    }
}

// ══════════════════════════════════════════════════════════
//  Create offer via REST
// ══════════════════════════════════════════════════════════
async function createOffer(): Promise<string> {
    logT('Creating offer via REST API...');
    const res = await axios.post(`${API_URL}/v1/offers`, {
        type: "buy",
        asset: "SOL",
        price: 0.1,
        collateral: 0.02,
        buyerPublicKey: buyer.publicKey.toBase58()
    });
    const tid = res.data?.ticketId;
    logT(`✅ Offer created. Ticket: ${tid}`);
    return tid;
}

// ══════════════════════════════════════════════════════════
//  BUYER WebSocket handler
// ══════════════════════════════════════════════════════════
function connectBuyer(tid: string): WsClient {
    const config: AgentConfig = { keypair: buyer, apiUrl: API_URL, wsUrl: WS_URL, role: 'BUYER' };
    const client = new WsClient(config);

    client.on('authenticated', () => {
        logB('Authenticated. Sending buy intent...');
        buyerPhase = 'OFFER_SENT';
        client.send({
            version: "1.0", timestamp: Date.now(),
            agent_id: buyer.publicKey.toBase58(),
            type: "message", ticket_id: tid,
            content: "I want to buy SOL at 0.1 SOL price, with 0.02 SOL collateral from both sides."
        });
    });

    client.on('message', (msg: WsMessage) => {
        const content = msg.content || (msg as any).payload?.content || "";
        const phase = (msg as any).phase || (msg as any).to_phase || (msg as any).payload?.to_phase || "";
        const lc = typeof content === 'string' ? content.toLowerCase() : '';
        const contentPreview = typeof content === 'string' ? content.substring(0, 120) : '?';

        logB(`[${buyerPhase}] phase=${phase} → ${contentPreview}`);

        // ── KEY FIX: Only detect escrow address when phase=escrow_created ──
        if (phase === 'escrow_created' && !buyerCollateralSent) {
            // Try structured field first
            const addr = (msg as any).escrowAddress || (msg as any).dealId || (msg as any).payload?.dealId || extractEscrowAddress(content);
            if (addr) {
                handleEscrowDetection(addr, 'buyer', client, tid);
            }
        }

        // ── Detect delivery phase ──
        if (buyerCollateralSent && !buyerPaymentSent && buyerPhase === 'WAIT_DELIVERY') {
            const isDelivery = phase === 'delivery' ||
                lc.includes('all deposits received') ||
                lc.includes('delivery phase') ||
                lc.includes('escrow is locked');

            if (isDelivery) {
                logB('📦 Delivery phase detected!');
                buyerPaymentSent = true;
                buyerPhase = 'FUNDS_RELEASED';

                setTimeout(() => {
                    client.send({
                        version: "1.0", timestamp: Date.now(),
                        agent_id: buyer.publicKey.toBase58(),
                        type: "message", ticket_id: tid,
                        content: "@middleman I received the credentials. You can release the funds now."
                    });
                    buyerPhase = 'COMPLETED';
                    logB('🏁 DEAL COMPLETE');
                }, 3000);
            }
        }
    });

    client.on('server_error', (msg: any) => logB(`⚠ ${msg.error || 'unknown'}`));
    client.connect();
    return client;
}

// ══════════════════════════════════════════════════════════
//  SELLER WebSocket handler
// ══════════════════════════════════════════════════════════
function connectSeller(tid: string): WsClient {
    const config: AgentConfig = { keypair: seller, apiUrl: API_URL, wsUrl: WS_URL, role: 'SELLER' };
    const client = new WsClient(config);

    client.on('authenticated', () => {
        logS('Authenticated. Subscribing to ticket...');
        sellerPhase = 'JOINING';

        // Subscribe to ticket
        client.send({
            version: "1.0", timestamp: Date.now(),
            agent_id: seller.publicKey.toBase58(),
            type: "status", ticket_id: tid
        });

        // Accept terms after 2s
        setTimeout(() => {
            logS('Sending acceptance...');
            client.send({
                version: "1.0", timestamp: Date.now(),
                agent_id: seller.publicKey.toBase58(),
                type: "message", ticket_id: tid,
                content: "@middleman I accept the terms. I will sell SOL at 0.1 with 0.02 collateral."
            });
            sellerPhase = 'AGREED';
        }, 2000);
    });

    client.on('message', (msg: WsMessage) => {
        const content = msg.content || (msg as any).payload?.content || "";
        const phase = (msg as any).phase || (msg as any).to_phase || (msg as any).payload?.to_phase || "";
        const lc = typeof content === 'string' ? content.toLowerCase() : '';
        const contentPreview = typeof content === 'string' ? content.substring(0, 120) : '?';

        logS(`[${sellerPhase}] phase=${phase} → ${contentPreview}`);

        // ── KEY FIX: Only detect escrow address when phase=escrow_created ──
        if (phase === 'escrow_created' && !sellerCollateralSent) {
            const addr = (msg as any).escrowAddress || (msg as any).dealId || (msg as any).payload?.dealId || extractEscrowAddress(content);
            if (addr) {
                handleEscrowDetection(addr, 'seller', client, tid);
            }
        }

        // ── Detect delivery/completion ──
        if (sellerCollateralSent && sellerPhase === 'WAIT_DELIVERY') {
            const isDelivery = phase === 'delivery' ||
                lc.includes('all deposits received') ||
                lc.includes('delivery phase');

            if (isDelivery) {
                logS('📦 Delivery phase! Sending credentials...');
                sellerPhase = 'DELIVERED';
            }

            if (phase === 'completed' || lc.includes('deal complete') || lc.includes('funds released')) {
                logS('🏁 PAYOUT RECEIVED — DEAL COMPLETE');
                sellerPhase = 'COMPLETED';
            }
        }
    });

    client.on('server_error', (msg: any) => logS(`⚠ ${msg.error || 'unknown'}`));
    client.connect();
    return client;
}

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════
async function main() {
    try {
        ticketId = await createOffer();

        logT('Connecting Seller...');
        const sellerClient = connectSeller(ticketId);

        setTimeout(() => {
            logT('Connecting Buyer...');
            connectBuyer(ticketId!);
        }, 3000);

        // Status reporter every 15s
        const statusInterval = setInterval(() => {
            logT(`📊 Status — Buyer: ${buyerPhase} | Seller: ${sellerPhase} | Escrow: ${escrowAddress || 'pending'}`);
            if (buyerPhase === 'COMPLETED' && sellerPhase === 'COMPLETED') {
                logT('🎉 BOTH AGENTS COMPLETED SUCCESSFULLY');
                clearInterval(statusInterval);
                process.exit(0);
            }
        }, 15_000);

        // Timeout after 120s
        setTimeout(() => {
            logT(`⏰ Test timeout (120s). Buyer: ${buyerPhase} | Seller: ${sellerPhase}`);
            process.exit(1);
        }, 120_000);

    } catch (e: any) {
        console.error('❌ Test failed:', e.message);
        process.exit(1);
    }
}

main();
