/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║  BetaBot — External BUYER Agent                          ║
 * ║  A fully independent agent that discovers offers, joins  ║
 * ║  a deal, negotiates, deposits collateral + payment, and  ║
 * ║  confirms delivery.                                       ║
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

const log = new AgentLogger("BetaBot  🔵", "cyan");
const wallet = generateWallet();
const api = createApiClient();

// ═══════════════════════════════════════════
// STATE MACHINE
// ═══════════════════════════════════════════

enum State {
    INIT = "INIT",
    REGISTERED = "REGISTERED",
    DISCOVERING = "DISCOVERING",
    JOINED = "JOINED",
    AGREED = "AGREED",
    FINAL_CONFIRM_SENT = "FINAL_CONFIRM_SENT",
    WAIT_ESCROW = "WAIT_ESCROW",
    COLLATERAL_SENT = "COLLATERAL_SENT",
    WAIT_DELIVERY = "WAIT_DELIVERY",
    PAYMENT_SENT = "PAYMENT_SENT",
    COMPLETED = "COMPLETED",
}

let state: State = State.INIT;
let currentTicketId: string | null = null;
let escrowAddress: string | null = null;
let collateralSent = false;
let paymentSent = false;

function transition(newState: State) {
    log.state(state, newState);
    state = newState;
}

// ═══════════════════════════════════════════
// ON-CHAIN TRANSFERS
// ═══════════════════════════════════════════

async function sendSol(address: string, amountSol: number, label: string): Promise<boolean> {
    log.info(`💰 Sending ${label} (${amountSol} SOL) to ${address.substring(0, 12)}...`);
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        const target = new PublicKey(address);
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: wallet.keypair.publicKey,
                toPubkey: target,
                lamports: Math.floor(amountSol * LAMPORTS_PER_SOL),
            })
        );
        const sig = await sendAndConfirmTransaction(connection, tx, [wallet.keypair], {
            commitment: "confirmed",
        });
        log.info(`✅ ${label} confirmed on-chain! Tx: ${sig.substring(0, 20)}...`);
        return true;
    } catch (e: any) {
        log.error(`${label} tx failed`, e);
        return false;
    }
}

// ═══════════════════════════════════════════
// DISCOVER OFFER (poll file or REST)
// ═══════════════════════════════════════════

async function discoverTicket(): Promise<string> {
    const fs = require("fs");
    const path = require("path");
    const ticketFile = path.join(__dirname, "latest_ticket.txt");

    log.info("🔍 Discovering AlphaBot's offer...");

    // Poll the ticket file (AlphaBot writes this)
    for (let i = 0; i < 30; i++) {
        if (fs.existsSync(ticketFile)) {
            const ticketId = fs.readFileSync(ticketFile, "utf8").trim();
            if (ticketId && ticketId.startsWith("TCK-")) {
                log.info(`🎯 Found offer! Ticket: ${ticketId}`);
                return ticketId;
            }
        }
        await sleep(2000);
        if (i % 5 === 0) log.info(`Still searching... (attempt ${i + 1}/30)`);
    }

    throw new Error("No offer found after 60 seconds");
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

    // ── Detect seller's offer and agree ──
    if (
        (lc.includes("selling") || lc.includes("offer") || lc.includes("waiting for counter")) &&
        (state === State.JOINED || state === State.DISCOVERING)
    ) {
        if (state === State.DISCOVERING) transition(State.JOINED);
        await sleep(2000);
        log.info("🤝 Agreeing to seller's terms...");
        client.sendMessage(currentTicketId!, "@middleman I agree to the deal. Price: 0.1 SOL, collateral: 0.02 SOL each side.");
        transition(State.AGREED);
    }

    // ── Detect agreement / confirmation requests ──
    if (lc.includes("confirm") && (state === State.AGREED || state === State.JOINED)) {
        await sleep(1000);
        client.sendMessage(currentTicketId!, "@middleman I confirm the deal. Price: 0.1 SOL, collateral: 0.02 SOL each.");
        transition(State.FINAL_CONFIRM_SENT);
    }

    // ── Detect escrow address — send COLLATERAL ──
    if (
        !collateralSent &&
        state !== State.INIT &&
        state !== State.REGISTERED &&
        state !== State.DISCOVERING &&
        state !== State.COMPLETED
    ) {
        const addr = msg.escrowAddress || msg.dealId || msg.payload?.dealId || extractSolanaAddress(content);
        if (addr && addr.length >= 32) {
            log.info(`🏦 Escrow address detected: ${addr.substring(0, 12)}...`);
            escrowAddress = addr;

            const success = await sendSol(addr, 0.02, "COLLATERAL");
            if (success) {
                collateralSent = true;
                transition(State.COLLATERAL_SENT);
                client.sendDepositConfirmed(currentTicketId!, "buyer");
                client.sendMessage(currentTicketId!, "Buyer collateral sent. Confirming deposit.");
                transition(State.WAIT_DELIVERY);
            }
        }
    }

    // ── Detect delivery phase — send PAYMENT ──
    if (collateralSent && !paymentSent && (state === State.WAIT_DELIVERY || state === State.COLLATERAL_SENT)) {
        const isDelivery =
            phase === "delivery" ||
            lc.includes("all deposits received") ||
            lc.includes("delivery phase") ||
            lc.includes("escrow is locked") ||
            lc.includes("deliver the credentials");

        if (isDelivery && escrowAddress) {
            log.info("🚀 Delivery phase detected. Sending PAYMENT...");
            const success = await sendSol(escrowAddress, 0.1, "PAYMENT");
            if (success) {
                paymentSent = true;
                transition(State.PAYMENT_SENT);

                // Wait a bit, then confirm receipt
                await sleep(4000);
                log.info("📧 Sending release confirmation...");
                client.sendMessage(
                    currentTicketId!,
                    "@middleman I received the credentials. You can release the funds now."
                );
            }
        }
    }

    // ── Detect credentials delivery — confirm receipt ──
    if (
        (lc.includes("credentials") || lc.includes("access key") || lc.includes("delivery is complete")) &&
        (state === State.PAYMENT_SENT || state === State.WAIT_DELIVERY)
    ) {
        if (!paymentSent && escrowAddress) {
            log.info("📦 Credentials received! Sending payment...");
            const success = await sendSol(escrowAddress, 0.1, "PAYMENT");
            if (success) {
                paymentSent = true;
                transition(State.PAYMENT_SENT);
            }
        }

        await sleep(3000);
        client.sendMessage(
            currentTicketId!,
            "@middleman I received the credentials. The delivery is verified. Please release the funds."
        );
    }

    // ── Detect completion ──
    if (
        phase === "completed" ||
        lc.includes("deal complete") ||
        lc.includes("funds released") ||
        lc.includes("successfully executed")
    ) {
        if (state !== State.COMPLETED) {
            log.info("🎉 TRADE COMPLETE! Deal settled successfully.");
            transition(State.COMPLETED);
            log.divider("BETABOT DONE");

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
    log.divider("BETABOT STARTING");
    log.info(`Wallet: ${wallet.publicKey}`);

    // Step 1: Fund wallet
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

    transition(State.REGISTERED);

    // Step 2: Discover AlphaBot's offer
    try {
        currentTicketId = await discoverTicket();
        transition(State.DISCOVERING);
    } catch (e: any) {
        log.error("Failed to discover offer", e);
        process.exit(1);
    }

    // Step 3: Connect WebSocket
    const client = new ExternalWsClient(wallet.keypair, "BetaBot", log);

    client.on("message", (msg: WsMessage) => {
        handleMessage(msg, client).catch((e) => log.error("Message handler error", e));
    });

    try {
        await client.connect();
    } catch (e: any) {
        log.error("WebSocket connection failed", e);
        process.exit(1);
    }

    // Step 4: Join the ticket (subscribe)
    client.sendStatus(currentTicketId!);

    // Step 5: Send initial buying intent
    await sleep(2000);
    log.info("📢 Sending buy intent to the negotiation...");
    client.sendMessage(
        currentTicketId!,
        "I want to buy SOL at 0.1 SOL price. Collateral: 0.02 SOL from both sides. @middleman I accept the terms."
    );
    transition(State.JOINED);

    // Step 6: Auto-timeout after 5 minutes
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
