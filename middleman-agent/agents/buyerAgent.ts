import { Keypair, Connection, Transaction, SystemProgram, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { WsClient } from './shared/wsClient';
import { AgentConfig, WsMessage } from './shared/types';
import { broadcastIntent } from '../src/services/intentBroadcaster';
import { loadWalletFromEnv } from '../src/utils/loadWallet';
import { AgentStateMachine } from './core/stateMachine';
import { BuyerState } from './core/agentState';
import { isAgreement } from './core/messageHandler';

dotenv.config({ path: path.join(__dirname, '../.env') });

const buyer = loadWalletFromEnv("BUYER_PRIVATE_KEY");
const API_URL = process.env.API_URL || 'http://localhost:8080';
const WS_URL = process.env.WS_URL || 'ws://localhost:3001';
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');

const config: AgentConfig = {
    keypair: buyer,
    apiUrl: API_URL,
    wsUrl: WS_URL,
    role: 'BUYER'
};

// Helper: extract a Solana address from any string
function extractAddress(text: string): string | null {
    if (!text) return null;
    const m = text.match(/`([1-9A-HJ-NP-Za-km-z]{32,44})`/) ||
        text.match(/\*\*([1-9A-HJ-NP-Za-km-z]{32,44})\*\*/) ||
        text.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    return m ? m[1] : null;
}

class BuyerAgent extends AgentStateMachine<BuyerState> {
    private currentTicketId: string | null = null;
    private escrowAddress: string | null = null;
    private collateralSent = false;
    private paymentSent = false;
    public client: WsClient;

    constructor() {
        super(BuyerState.INIT, 'BUYER');
        this.client = new WsClient(config);

        this.client.on('authenticated', async () => {
            // Only start a fresh offer on the FIRST connection.
            // On reconnection, just re-subscribe to the existing ticket.
            if (this.client.isReconnection && this.currentTicketId) {
                this.logActivity(`Reconnected. Re-subscribing to ticket ${this.currentTicketId}`);
                this.client.send({
                    version: "1.0",
                    timestamp: Date.now(),
                    agent_id: buyer.publicKey.toBase58(),
                    type: "status",
                    ticket_id: this.currentTicketId
                });
            } else {
                await this.startOfferFlow();
            }
        });

        this.client.on('message', async (msg: WsMessage) => {
            try {
                await this.handleIncomingMessage(msg, this.client);
            } catch (err: any) {
                this.logError(err.message || 'Unknown error handling message');
            }
        });

        this.client.on('server_error', (msg: any) => {
            this.logError(`Server: ${msg.error || 'unknown'} — ${msg.details || ''}`);
        });
    }

    public async connect() {
        this.client.connect();
    }

    private async startOfferFlow() {
        try {
            this.logActivity(`Expected API: ${API_URL}/v1/offers`);
            const res = await axios.post(`${API_URL}/v1/offers`, {
                type: "buy",
                asset: "SOL",
                price: 0.1,
                collateral: 0.02,
                buyerPublicKey: buyer.publicKey.toBase58()
            });
            this.currentTicketId = res.data?.ticketId;
            this.logActivity(`Offer Created. Ticket ID: ${this.currentTicketId}`);

            await broadcastIntent(connection, buyer, {
                side: "buy",
                asset: "SOL",
                minPrice: 0.1,
                maxPrice: 0.1,
                quantity: 1,
                agentEndpoint: this.currentTicketId || ""
            });

            // If no seller joins within 30 seconds, re-broadcast intent
            setTimeout(async () => {
                if (this.state === BuyerState.OFFER_SENT) {
                    this.logActivity("No seller joined. Re-broadcasting intent...");
                    try {
                        await broadcastIntent(connection, buyer, {
                            side: "buy",
                            asset: "SOL",
                            minPrice: 0.1,
                            maxPrice: 0.1,
                            quantity: 1,
                            agentEndpoint: this.currentTicketId || ""
                        });
                    } catch (e: any) {
                        this.logActivity(`Re-broadcast failed: ${e.message}`);
                    }
                }
            }, 30000);

            this.client.send({
                version: "1.0",
                timestamp: Date.now(),
                agent_id: buyer.publicKey.toBase58(),
                type: "message",
                ticket_id: this.currentTicketId,
                content: "I want to buy SOL at 0.1 SOL price, with 0.02 SOL collateral from both sides."
            });
            if (this.state === BuyerState.INIT) {
                this.transition(BuyerState.OFFER_SENT);
            }

        } catch (e: any) {
            this.logError(`Failed to create offer: ${e.message}`);
        }
    }

    private async sendCollateral(address: string) {
        if (this.collateralSent) return;
        this.collateralSent = true;
        this.escrowAddress = address;

        this.logActivity(`>>> SENDING COLLATERAL (0.02 SOL) to ${address}`);
        try {
            const target = new PublicKey(address);
            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: buyer.publicKey,
                    toPubkey: target,
                    lamports: Math.floor(0.02 * 1e9),
                })
            );
            const sig = await sendAndConfirmTransaction(connection, tx, [buyer], { commitment: "confirmed" });
            this.logActivity(`Collateral confirmed on-chain! Tx: ${sig}`);
        } catch (e: any) {
            this.logError(`Collateral tx failed: ${e.message}`);
            this.collateralSent = false; // allow retry
        }
    }

    private async sendPayment(address: string) {
        if (this.paymentSent) return;
        this.paymentSent = true;

        this.logActivity(`>>> SENDING PAYMENT (0.10 SOL) to ${address}`);
        try {
            const target = new PublicKey(address);
            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: buyer.publicKey,
                    toPubkey: target,
                    lamports: Math.floor(0.10 * 1e9),
                })
            );
            const sig = await sendAndConfirmTransaction(connection, tx, [buyer], { commitment: "confirmed" });
            this.logActivity(`Payment confirmed on-chain! Tx: ${sig}`);
        } catch (e: any) {
            this.logError(`Payment tx failed: ${e.message}`);
            this.paymentSent = false; // allow retry
        }
    }

    public async handleIncomingMessage(msg: WsMessage, client: WsClient): Promise<void> {
        const eventType = msg.event_type || msg.type;
        const content = msg.content || (msg.payload && msg.payload.content) || "";
        const phase = (msg as any).phase || (msg as any).to_phase || (msg as any).payload?.to_phase || "";
        const lc = typeof content === 'string' ? content.toLowerCase() : '';

        // === DEBUG: Log EVERY message so we can trace exactly what arrives ===
        this.logActivity(`[DBG] state=${this.state} event=${eventType} phase=${phase} content=${typeof content === 'string' ? content.substring(0, 120) : '?'}`);

        // Show middleman responses
        if (eventType === 'middleman_response' || eventType === 'middleman_message') {
            this.logActivity(`MIDDLEMAN: ${content}`);
        }

        // ── STEP 1: Wait for seller agreement ──
        if (this.state === BuyerState.OFFER_SENT || this.state === BuyerState.WAITING_SELLER) {
            if (isAgreement(content)) {
                this.logActivity("Seller agreed");
                this.transition(BuyerState.SELLER_AGREED);
                this.logActivity("Sending final confirmation");
                client.send({
                    version: "1.0",
                    timestamp: Date.now(),
                    agent_id: buyer.publicKey.toBase58(),
                    type: "message",
                    ticket_id: this.currentTicketId,
                    content: "@middleman I confirm the deal. Price: 0.1 SOL, collateral: 0.02 SOL each."
                });
                this.transition(BuyerState.FINAL_CONFIRM_SENT);
            } else if (lc.includes("has joined")) {
                this.transition(BuyerState.WAITING_SELLER);
            }
        }

        // ── STEP 2: Detect escrow address and send COLLATERAL (0.02 SOL) ──
        // Trigger: ANY message that contains a Solana address while we haven't sent collateral yet
        // State guard: we must be past the initial negotiation phase
        if (!this.collateralSent &&
            this.state !== BuyerState.INIT &&
            this.state !== BuyerState.OFFER_SENT &&
            this.state !== BuyerState.COMPLETED) {

            // Try structured field first, then regex from content
            const addr = msg.escrowAddress || msg.dealId || msg.payload?.dealId || extractAddress(content);

            if (addr) {
                this.logActivity(`[DEPOSIT TRIGGER] Found address: ${addr} (event=${eventType}, phase=${phase})`);
                this.transition(BuyerState.WAIT_ESCROW);
                await this.sendCollateral(addr);
                this.transition(BuyerState.DEPOSIT_SENT);

                client.send({
                    version: "1.0",
                    timestamp: Date.now(),
                    agent_id: buyer.publicKey.toBase58(),
                    type: 'deposit_confirmed',
                    ticket_id: this.currentTicketId,
                    role: 'buyer'
                });
                client.send({
                    version: "1.0",
                    timestamp: Date.now(),
                    agent_id: buyer.publicKey.toBase58(),
                    type: "message",
                    ticket_id: this.currentTicketId,
                    content: "Buyer collateral sent. Confirming deposit."
                });
                this.transition(BuyerState.WAIT_DELIVERY);
            }
        }

        // ── STEP 3: Wait for phase → delivery, then send PAYMENT (0.10 SOL) ──
        // NOTE: outboundRouter wraps ALL events as type="middleman_message"
        // so we check the `phase` field directly, NOT eventType
        if (this.collateralSent && !this.paymentSent && this.state === BuyerState.WAIT_DELIVERY) {
            const msgPhase = (msg as any).phase || (msg as any).to_phase || (msg as any).payload?.to_phase || "";
            const isDeliveryPhase = (
                msgPhase === 'delivery' ||
                lc.includes("all deposits received") ||
                lc.includes("delivery phase") ||
                lc.includes("escrow is locked") ||
                lc.includes("deliver the credentials")
            );

            if (isDeliveryPhase && this.escrowAddress) {
                this.logActivity(`[PAYMENT TRIGGER] phase→delivery detected, sending payment`);
                await this.sendPayment(this.escrowAddress);
                this.transition(BuyerState.FUNDS_RELEASED);

                // After payment settles, send release command
                setTimeout(() => {
                    this.logActivity("Sending release command...");
                    client.send({
                        version: "1.0",
                        timestamp: Date.now(),
                        agent_id: buyer.publicKey.toBase58(),
                        type: "message",
                        ticket_id: this.currentTicketId,
                        content: "@middleman I received the credentials. You can release the funds now."
                    });
                    this.transition(BuyerState.COMPLETED);
                }, 4000);
            }
        }
    }
}

// Start Agent
const agent = new BuyerAgent();
agent.connect();
