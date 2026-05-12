/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║  AlphaBot — External SELLER Agent                        ║
 * ║  A fully independent agent that registers, posts a SELL  ║
 * ║  offer, negotiates, deposits collateral, and delivers.   ║
 * ╚═══════════════════════════════════════════════════════════╝
 *
 * This agent is 100% standalone — it imports NOTHING from the
 * middleman-agent codebase. It talks to AIR OTC purely through
 * the public REST API (port 8080) and WebSocket gateway.
 */

import {
    Keypair,
    Connection,
    Transaction,
    SystemProgram,
    PublicKey,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
    AgentLogger,
    ExternalWsClient,
    createApiClient,
    generateWallet,
    sleep,
    extractSolanaAddress,
    extractTicketId,
    SOLANA_RPC,
    WsMessage,
} from "./shared";

// ═══════════════════════════════════════════
// AGENT IDENTITY
// ═══════════════════════════════════════════

const log = new AgentLogger("AlphaBot 🟠", "yellow");
const wallet = generateWallet();
const api = createApiClient();

// ═══════════════════════════════════════════
// STATE MACHINE
// ═══════════════════════════════════════════

enum State {
    INIT = "INIT",
    REGISTERED = "REGISTERED",
    OFFER_POSTED = "OFFER_POSTED",
    BUYER_JOINED = "BUYER_JOINED",
    AGREED = "AGREED",
    WAIT_ESCROW = "WAIT_ESCROW",
    DEPOSIT_SENT = "DEPOSIT_SENT",
    WAIT_DELIVERY = "WAIT_DELIVERY",
    DELIVERED = "DELIVERED",
    COMPLETED = "COMPLETED",
}

let state: State = State.INIT;
let currentTicketId: string | null = null;
let escrowAddress: string | null = null;
let collateralSent = false;

function transition(newState: State) {
    log.state(state, newState);
    state = newState;
}

// ═══════════════════════════════════════════
// CORE LOGIC
// ═══════════════════════════════════════════

async function postSellOffer(): Promise<string> {
    log.info("📢 Posting SELL offer to AIR OTC marketplace...");

    const res = await api.post("/v1/offers", {
        type: "sell",
        asset: "SOL",
        price: 0.1,
        collateral: 0.02,
        buyerPublicKey: wallet.publicKey, // API field name (reused for seller too)
    });

    const ticketId = res.data.ticketId;
    log.info(`✅ Offer posted! Ticket: ${ticketId}`, {
        offerId: res.data.offerId,
        price: "0.1 SOL",
        collateral: "0.02 SOL",
    });

    return ticketId;
}

async function sendCollateral(address: string) {
    if (collateralSent) return;
    collateralSent = true;

    log.info(`💰 Sending COLLATERAL (0.02 SOL) to escrow: ${address.substring(0, 12)}...`);
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        const target = new PublicKey(address);
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: wallet.keypair.publicKey,
                toPubkey: target,
                lamports: Math.floor(0.02 * LAMPORTS_PER_SOL),
            })
        );
        const sig = await sendAndConfirmTransaction(connection, tx, [wallet.keypair], {
            commitment: "confirmed",
        });
        log.info(`✅ Collateral confirmed on-chain! Tx: ${sig.substring(0, 20)}...`);
    } catch (e: any) {
        log.error("Collateral tx failed", e);
        collateralSent = false;
    }
}

// ═══════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════

async function handleMessage(msg: WsMessage, client: ExternalWsClient) {
    const eventType = msg.event_type || msg.type;
    const content = msg.content || msg.payload?.content || "";
    const phase = msg.phase || msg.to_phase || msg.payload?.to_phase || "";
    const lc = typeof content === "string" ? content.toLowerCase() : "";

    log.info(`📩 [${eventType}] phase=${phase} | ${typeof content === "string" ? content.substring(0, 100) : "?"}...`);

    // ── Detect buyer joining ──
    if (lc.includes("has joined") || lc.includes("deal matched")) {
        if (state === State.OFFER_POSTED) {
            transition(State.BUYER_JOINED);

            // Agree immediately
            await sleep(2000);
            log.info("🤝 Accepting the deal terms...");
            client.sendMessage(currentTicketId!, "@middleman I accept the terms. Price: 0.1 SOL, collateral: 0.02 SOL each side.");
            transition(State.AGREED);
        }
    }

    // ── Detect agreement confirmation from middleman ──
    if (lc.includes("confirm") || lc.includes("agree") || lc.includes("proceed")) {
        if (state === State.BUYER_JOINED || state === State.AGREED) {
            if (state !== State.AGREED) transition(State.AGREED);
            // Send final confirmation
            await sleep(1000);
            client.sendMessage(currentTicketId!, "@middleman I confirm the deal. Let's proceed to escrow.");
            transition(State.WAIT_ESCROW);
        }
    }

    // ── Detect escrow address — send collateral ──
    if (
        !collateralSent &&
        state !== State.INIT &&
        state !== State.REGISTERED &&
        state !== State.OFFER_POSTED &&
        state !== State.COMPLETED
    ) {
        const addr = msg.escrowAddress || msg.dealId || msg.payload?.dealId || extractSolanaAddress(content);
        if (addr && addr.length >= 32) {
            log.info(`🏦 Escrow address detected: ${addr.substring(0, 12)}...`);
            escrowAddress = addr;
            transition(State.DEPOSIT_SENT);
            await sendCollateral(addr);

            client.sendDepositConfirmed(currentTicketId!, "seller");
            client.sendMessage(currentTicketId!, "Seller collateral sent. Deposit confirmed.");
            transition(State.WAIT_DELIVERY);
        }
    }

    // ── Detect delivery phase ──
    if (state === State.WAIT_DELIVERY || state === State.DEPOSIT_SENT) {
        const isDelivery =
            phase === "delivery" ||
            lc.includes("all deposits received") ||
            lc.includes("delivery phase") ||
            lc.includes("escrow is locked") ||
            lc.includes("deliver the credentials");

        if (isDelivery) {
            log.info("📦 Delivery phase started. Sending credentials...");
            transition(State.DELIVERED);

            await sleep(2000);
            client.sendMessage(
                currentTicketId!,
                "Here are the credentials for the Premium AI Dataset: Access Key = AID-7X9Z-PREMIUM-2026. The delivery is complete."
            );
            log.info("✅ Credentials delivered to buyer.");
        }
    }

    // ── Detect completion ──
    if (
        phase === "completed" ||
        lc.includes("deal complete") ||
        lc.includes("funds released") ||
        lc.includes("successfully executed")
    ) {
        if (state !== State.COMPLETED) {
            log.info("🎉 TRADE COMPLETE! Payout received.");
            transition(State.COMPLETED);
            log.divider("ALPHABOT DONE");

            // Keep alive for a bit, then exit
            await sleep(5000);
            client.disconnect();
            process.exit(0);
        }
    }
}

// ═══════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════

async function main() {
    log.divider("ALPHABOT STARTING");
    log.info(`Wallet: ${wallet.publicKey}`);

    // Step 1: Fund wallet on devnet
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        log.info("Requesting devnet airdrop...");
        const sig = await connection.requestAirdrop(wallet.keypair.publicKey, 2 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig, "confirmed");
        const balance = await connection.getBalance(wallet.keypair.publicKey);
        log.info(`Wallet funded: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    } catch (e: any) {
        log.warn(`Airdrop failed (may already have balance): ${e.message}`);
    }

    // Step 2: Register via REST
    try {
        const res = await api.post("/v1/offers", {
            type: "sell",
            asset: "SOL",
            price: 0.1,
            collateral: 0.02,
            buyerPublicKey: wallet.publicKey,
        });
        currentTicketId = res.data.ticketId;
        transition(State.REGISTERED);
        log.info(`Registered and offer posted. Ticket: ${currentTicketId}`);
        transition(State.OFFER_POSTED);
    } catch (e: any) {
        log.error("Failed to register/post offer", e);
        process.exit(1);
    }

    // Step 3: Connect WebSocket
    const client = new ExternalWsClient(wallet.keypair, "AlphaBot", log);

    client.on("message", (msg: WsMessage) => {
        handleMessage(msg, client).catch((e) => log.error("Message handler error", e));
    });

    try {
        await client.connect();
    } catch (e: any) {
        log.error("WebSocket connection failed", e);
        process.exit(1);
    }

    // Step 4: Subscribe to our ticket
    client.sendStatus(currentTicketId!);
    client.sendMessage(
        currentTicketId!,
        "I'm selling SOL at 0.1 SOL price. Collateral: 0.02 SOL each side. Looking for a buyer."
    );

    // Write ticket ID to file so BetaBot can discover it
    const fs = require("fs");
    const path = require("path");
    const ticketFile = path.join(__dirname, "latest_ticket.txt");
    fs.writeFileSync(ticketFile, currentTicketId!, "utf8");
    log.info(`Ticket ID written to ${ticketFile}`);

    // Step 5: Auto-timeout after 5 minutes
    setTimeout(() => {
        if (state !== State.COMPLETED) {
            log.warn("Timeout reached (5 min). Shutting down.");
            client.disconnect();
            process.exit(1);
        }
    }, 300000);
}

main().catch((e) => {
    log.error("Fatal error", e);
    process.exit(1);
});
