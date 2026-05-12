/**
 * Example Buyer Agent — Uses ONLY the MeridianClient SDK.
 *
 * Usage:
 *   BUYER_PRIVATE_KEY=<base58-key> npx ts-node agents/sdk/example-buyer.ts
 *
 * This agent:
 *   1. Registers with the platform
 *   2. Connects via WebSocket
 *   3. Creates a buy offer for 1 SOL at $0.1
 *   4. Watches for escrow → sends collateral + payment
 *   5. Confirms receipt → deal completes
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'path';
import { MeridianClient } from './MeridianClient';

dotenv.config({ path: path.join(__dirname, '../../.env') });

// ─── Load keypair ───────────────────────────────────────
const secret = process.env.BUYER_PRIVATE_KEY;
if (!secret) { console.error('Set BUYER_PRIVATE_KEY env var'); process.exit(1); }
const keypair = Keypair.fromSecretKey(bs58.decode(secret));
console.log(`[BUYER-SDK] Wallet: ${keypair.publicKey.toBase58()}`);
const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const isPrivateMode = process.env.PRIVATE_MODE === 'true';

// ─── Create client ──────────────────────────────────────
const client = new MeridianClient({
    apiUrl: process.env.API_URL || 'http://localhost:8080',
    wsUrl: process.env.WS_URL || 'ws://localhost:8080',
    keypair,
    rpcUrl,
    privateMode: isPrivateMode,
    persistLocalState: false,
});

let escrowAddress: string | null = null;
let depositSent = false;
let paymentSent = false;
let rollupTermsSubmitted = false;
let deliverySeen = false;
let receiptFlowStarted = false;
let dealCompleted = false;
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
        throw new Error(`Buyer wallet has ${currentSol.toFixed(4)} SOL; ${minSol} SOL required.`);
    }

    const lamportsNeeded = Math.ceil((minSol - currentSol + 0.02) * LAMPORTS_PER_SOL);
    try {
        const signature = await connection.requestAirdrop(keypair.publicKey, lamportsNeeded);
        const latest = await connection.getLatestBlockhash();
        await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
        console.log(`[BUYER-SDK] Devnet balance topped up`);
    } catch (e: any) {
        throw new Error(`Buyer wallet has ${currentSol.toFixed(4)} SOL and devnet airdrop failed: ${e.message}`);
    }
}

async function wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function startReceiptConfirmationLoop(ticketId: string): Promise<void> {
    if (receiptFlowStarted) return;
    receiptFlowStarted = true;

    for (let attempt = 1; attempt <= 5; attempt++) {
        if (dealCompleted) return;
        try {
            await client.confirmReceipt(ticketId);
            console.log(`[BUYER-SDK] Release confirmation attempt ${attempt}/5 sent`);
        } catch (e: any) {
            console.error(`[BUYER-SDK] Release confirmation attempt ${attempt} failed: ${e.message}`);
        }
        await wait(2500);
    }
}

async function main() {
    await ensureDevnetBalance(0.15);

    // 1. Register
    await client.register();

    // 2. Connect to WebSocket
    await client.connect();

    client.setAutoApprovalPolicy({
        allowedAssets: ['SOL'],
        maxPrice: 1,
        maxCollateral: 1,
    });

    // 3. Create buy offer
    const ticketId = await client.createOffer({
        asset: 'SOL',
        side: 'buy',
        amount: 1,
        price: 0.1,
        collateral: 0.02,
    });
    console.log(`[BUYER-SDK] Ticket: ${ticketId}`);

    // Subscribe to ticket events
    client.subscribeToTicket(ticketId);

    // 4. Listen for escrow address from middleman messages
    client.on('escrow_address', async (address: string) => {
        escrowAddress = address;
        console.log(`[BUYER-SDK] Escrow detected: ${address}`);
    });

    client.on('rollup_session_ready', async () => {
        if (rollupTermsSubmitted) return;
        rollupTermsSubmitted = true;
        try {
            const activeTicket = client.getCurrentTicketId() || ticketId;
            await client.completePrivateAgreement(activeTicket, DEMO_TERMS);
            console.log(`[BUYER-SDK] Agreement submitted and finalized`);
        } catch (e: any) {
            logDetailedError('[BUYER-SDK] Rollup negotiation failed', e);
        }
    });

    client.on('confidential_funding_request', async (request: any) => {
        const activeTicket = client.getCurrentTicketId() || ticketId;
        if (request.ticketId !== activeTicket) {
            console.log(`[BUYER-SDK] Ignoring funding request for unrelated ticket ${request.ticketId}`);
            return;
        }
        try {
            await client.autoFundPrivateDeal(request.ticketId, { timeoutMs: 30_000 });
            console.log(`[BUYER-SDK] Confidential funding submitted`);
        } catch (e: any) {
            logDetailedError('[BUYER-SDK] Confidential funding failed', e);
        }
    });

    client.on('release_approval_request', async (request: any) => {
        const activeTicket = client.getCurrentTicketId() || ticketId;
        if (request.ticketId !== activeTicket) {
            console.log(`[BUYER-SDK] Ignoring release request for unrelated ticket ${request.ticketId}`);
            return;
        }
        if (request.requestKind !== 'BUYER_RELEASE_CONFIRMATION') {
            return;
        }
        if (!deliverySeen) {
            console.log(`[BUYER-SDK] Waiting for delivery message before confirming private release`);
            return;
        }
        try {
            await client.confirmPrivateDelivery(request.ticketId, { timeoutMs: 30_000 });
            console.log(`[BUYER-SDK] Private delivery confirmed`);
        } catch (e: any) {
            logDetailedError('[BUYER-SDK] Private delivery confirmation failed', e);
        }
    });

    // 5. Handle deal lifecycle
    let agreementSent = false;
    client.on('message', async (content: string, phase: string) => {
        console.log(`[BUYER-SDK] [${phase}] ${content.substring(0, 120)}`);

        // Use the live ticket ID (auto-switches after match)
        const activeTicket = client.getCurrentTicketId() || ticketId;

        if (content.includes('Delivery:')) {
            deliverySeen = true;
            const pendingRelease = client.getReleaseRequest(activeTicket);
            if (pendingRelease?.requestKind === 'BUYER_RELEASE_CONFIRMATION') {
                try {
                    await client.confirmPrivateDelivery(activeTicket, { timeoutMs: 30_000 });
                    console.log(`[BUYER-SDK] Private delivery confirmed`);
                } catch (e: any) {
                    logDetailedError('[BUYER-SDK] Private delivery confirmation failed', e);
                }
            } else if (paymentSent) {
                void startReceiptConfirmationLoop(activeTicket);
            }
        }

        // Do not send price/collateral over chat; rollup_session_ready drives agreement.
        if (!agreementSent && content.includes('Deal matched')) {
            agreementSent = true;
            console.log(`[BUYER-SDK] Matched on ticket ${activeTicket}; waiting for rollup session`);
        }

        // Send collateral when escrow is ready and we haven't sent yet
        if (!isPrivateMode && escrowAddress && !depositSent && phase === 'awaiting_deposits') {
            depositSent = true;
            try {
                const tx = await client.sendDeposit(escrowAddress, 0.02);
                console.log(`[BUYER-SDK] Collateral sent: ${tx}`);
                await client.confirmDeposit(activeTicket, 'buyer');
            } catch (e: any) {
                console.error(`[BUYER-SDK] Deposit failed: ${e.message}`);
            }
        }

        // Send payment when delivery phase starts
        if (!isPrivateMode && escrowAddress && !paymentSent && phase === 'delivery') {
            paymentSent = true;
            try {
                const tx = await client.sendDeposit(escrowAddress, 0.10);
                console.log(`[BUYER-SDK] Payment sent: ${tx}`);
                if (deliverySeen) {
                    void startReceiptConfirmationLoop(activeTicket);
                } else {
                    console.log(`[BUYER-SDK] Waiting for seller delivery message before confirming receipt`);
                }
            } catch (e: any) {
                console.error(`[BUYER-SDK] Payment failed: ${e.message}`);
            }
        }
    });

    client.on('phase_changed', (update: any) => {
        console.log(`[BUYER-SDK] Phase → ${update.phase}`);
    });

    client.on('deal_complete', (tid: string) => {
        dealCompleted = true;
        console.log(`[BUYER-SDK] ✅ DEAL COMPLETE: ${tid}`);
        setTimeout(() => process.exit(0), 2000);
    });
}

main().catch(err => {
    logDetailedError('[BUYER-SDK] Fatal', err);
    process.exit(1);
});
