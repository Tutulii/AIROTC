/**
 * Example Seller Agent — Uses ONLY the MeridianClient SDK.
 *
 * Usage:
 *   SELLER_PRIVATE_KEY=<base58-key> npx ts-node agents/sdk/example-seller.ts
 *
 * This agent:
 *   1. Registers with the platform
 *   2. Connects via WebSocket
 *   3. Polls for buy offers → clicks "Quick Buy" (acceptOffer)
 *   4. Both agents land in the same ticket on the middleman
 *   5. Sends agreement → middleman creates escrow
 *   6. Sends collateral → delivers credentials → deal completes
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'path';
import { MeridianClient } from './MeridianClient';

dotenv.config({ path: path.join(__dirname, '../../.env') });

// ─── Load keypair ───────────────────────────────────────
const secret = process.env.SELLER_PRIVATE_KEY;
if (!secret) { console.error('Set SELLER_PRIVATE_KEY env var'); process.exit(1); }
const keypair = Keypair.fromSecretKey(bs58.decode(secret));
console.log(`[SELLER-SDK] Wallet: ${keypair.publicKey.toBase58()}`);
const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const isPrivateMode = process.env.PRIVATE_MODE === 'true';

// ─── Create client ──────────────────────────────────────
const client = new MeridianClient({
    apiUrl: process.env.OBSERVATORY_URL || process.env.API_URL || 'http://localhost:8080',
    wsUrl: process.env.WS_URL || 'ws://localhost:8080',
    keypair,
    rpcUrl,
    privateMode: isPrivateMode,
    persistLocalState: false,
});

let escrowAddress: string | null = null;
let depositSent = false;
let ticketId: string | null = null;
let rollupTermsSubmitted = false;
let deliverySent = false;
const DEMO_TERMS = {
    assetMint: 'SOL',
    priceSol: 0.1,
    buyerCollateralSol: 0.02,
    sellerCollateralSol: 0.02,
};

function logDetailedError(prefix: string, err: any): void {
    console.error(`${prefix}: ${err?.message || 'unknown error'}`);
    if (err?.cause) {
        console.error(`${prefix} cause:`, err.cause);
    }
    if (Array.isArray(err?.logs) && err.logs.length > 0) {
        console.error(`${prefix} logs:\n${err.logs.join('\n')}`);
    }
    if (err?.stack) {
        console.error(err.stack);
    } else if (err) {
        console.error(err);
    }
}

async function ensureDevnetBalance(minSol: number): Promise<void> {
    const connection = new Connection(rpcUrl, 'confirmed');
    const balance = await connection.getBalance(keypair.publicKey);
    const currentSol = balance / LAMPORTS_PER_SOL;
    if (currentSol >= minSol) return;
    if (!rpcUrl.includes('devnet')) {
        throw new Error(`Seller wallet has ${currentSol.toFixed(4)} SOL; ${minSol} SOL required.`);
    }

    const lamportsNeeded = Math.ceil((minSol - currentSol + 0.02) * LAMPORTS_PER_SOL);
    try {
        const signature = await connection.requestAirdrop(keypair.publicKey, lamportsNeeded);
        const latest = await connection.getLatestBlockhash();
        await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
        console.log(`[SELLER-SDK] Devnet balance topped up`);
    } catch (e: any) {
        throw new Error(`Seller wallet has ${currentSol.toFixed(4)} SOL and devnet airdrop failed: ${e.message}`);
    }
}

function maybeSendPrivateDelivery(activeTicket: string | null, phase: string): void {
    if (!ticketId || !activeTicket || deliverySent) return;
    const shouldDeliverPrivately = phase === 'awaiting_buyer_release_confirmation';
    const shouldDeliverPublicly = !isPrivateMode && phase === 'delivery';
    if (!shouldDeliverPrivately && !shouldDeliverPublicly) return;

    deliverySent = true;
    client.sendMessage(activeTicket, 'Delivery: ACCESS_TOKEN_12345');
    console.log(`[SELLER-SDK] Credentials delivered`);
}

async function main() {
    await ensureDevnetBalance(0.05);

    // 1. Register
    await client.register();

    // 2. Connect to WebSocket (for real-time deal events)
    await client.connect();

    client.setAutoApprovalPolicy({
        allowedAssets: ['SOL'],
        maxPrice: 1,
        maxCollateral: 1,
    });

    // 3. Find a buy offer and accept it ("Quick Buy" — creates matched ticket)
    console.log(`[SELLER-SDK] Scanning for buy offers...`);
    ticketId = await findAndAcceptOffer();
    console.log(`[SELLER-SDK] Joined ticket: ${ticketId}`);

    // 4. Subscribe to deal events via WebSocket
    client.subscribeToTicket(ticketId);

    // 5. Price/collateral terms go through the rollup session, not plaintext chat.

    // 6. Listen for escrow address
    client.on('escrow_address', async (address: string) => {
        escrowAddress = address;
        console.log(`[SELLER-SDK] Escrow detected: ${address}`);
    });

    client.on('rollup_session_ready', async () => {
        if (rollupTermsSubmitted) return;
        rollupTermsSubmitted = true;
        try {
            const activeTicket = client.getCurrentTicketId() || ticketId!;
            await client.completePrivateAgreement(activeTicket, DEMO_TERMS);
            console.log(`[SELLER-SDK] Agreement submitted and finalized`);
        } catch (e: any) {
            logDetailedError('[SELLER-SDK] Rollup negotiation failed', e);
        }
    });

    client.on('confidential_funding_request', async (request: any) => {
        const activeTicket = client.getCurrentTicketId() || ticketId;
        if (request.ticketId !== activeTicket) {
            console.log(`[SELLER-SDK] Ignoring funding request for unrelated ticket ${request.ticketId}`);
            return;
        }
        try {
            await client.autoFundPrivateDeal(request.ticketId, { timeoutMs: 30_000 });
            console.log(`[SELLER-SDK] Confidential funding submitted`);
        } catch (e: any) {
            logDetailedError('[SELLER-SDK] Confidential funding failed', e);
        }
    });

    // 7. Handle deal lifecycle
    client.on('message', async (content: string, phase: string) => {
        console.log(`[SELLER-SDK] [${phase}] ${content.substring(0, 120)}`);
        const activeTicket = client.getCurrentTicketId() || ticketId;

        // Send collateral when escrow is ready
        if (!isPrivateMode && escrowAddress && !depositSent && phase === 'awaiting_deposits') {
            depositSent = true;
            try {
                const tx = await client.sendDeposit(escrowAddress, 0.02);
                console.log(`[SELLER-SDK] Collateral sent: ${tx}`);
                await client.confirmDeposit(ticketId!, 'seller');
            } catch (e: any) {
                console.error(`[SELLER-SDK] Deposit failed: ${e.message}`);
            }
        }

        maybeSendPrivateDelivery(activeTicket, phase);
    });

    client.on('phase_changed', (update: any) => {
        const activeTicket = client.getCurrentTicketId() || ticketId;
        console.log(`[SELLER-SDK] Phase → ${update.phase}`);
        maybeSendPrivateDelivery(activeTicket, update.phase);
    });

    client.on('deal_complete', (tid: string) => {
        console.log(`[SELLER-SDK] ✅ DEAL COMPLETE: ${tid}`);
        setTimeout(() => process.exit(0), 2000);
    });
}

async function findAndAcceptOffer(): Promise<string> {
    for (let i = 0; i < 30; i++) {
        const offers = await client.getOffers({ side: 'buy' });
        const active = offers.filter((o: any) => o.status === 'active');
        if (active.length > 0) {
            const offer = active
                .slice()
                .sort((a: any, b: any) => {
                    const aTs = Number(String(a.id || '').split('offer-')[1] || 0);
                    const bTs = Number(String(b.id || '').split('offer-')[1] || 0);
                    return bTs - aTs;
                })[0];
            console.log(`[SELLER-SDK] Found offer: ${offer.id} (${offer.amount} ${offer.asset} @ ${offer.price})`);
            // Accept the offer → forward bridge creates matched ticket on middleman
            const apiTicketId = await client.acceptOffer(offer.id);
            return apiTicketId;
        }
        console.log(`[SELLER-SDK] No offers yet... (${i + 1}/30)`);
        await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error('No offers found after 90 seconds');
}

main().catch(err => {
    logDetailedError('[SELLER-SDK] Fatal', err);
    process.exit(1);
});
