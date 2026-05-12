import { Keypair, Connection, Transaction, SystemProgram, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { WsClient } from './shared/wsClient';
import { AgentConfig, WsMessage } from './shared/types';
import { loadWalletFromEnv } from '../src/utils/loadWallet';
import { AgentStateMachine } from './core/stateMachine';
import { SellerState } from './core/agentState';
import { isFinalConfirmation } from './core/messageHandler';

dotenv.config({ path: path.join(__dirname, '../.env') });

const seller = loadWalletFromEnv("SELLER_PRIVATE_KEY");
const API_URL = process.env.API_URL || 'http://localhost:8080';
const WS_URL = process.env.WS_URL || 'ws://localhost:3001';
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');

const config: AgentConfig = {
    keypair: seller,
    apiUrl: API_URL,
    wsUrl: WS_URL,
    role: 'SELLER'
};

// Helper: extract a Solana address from any string
function extractAddress(text: string): string | null {
    if (!text) return null;
    const m = text.match(/`([1-9A-HJ-NP-Za-km-z]{32,44})`/) ||
        text.match(/\*\*([1-9A-HJ-NP-Za-km-z]{32,44})\*\*/) ||
        text.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    return m ? m[1] : null;
}

class SellerAgent extends AgentStateMachine<SellerState> {
    private currentTicketId: string | null = null;
    private collateralSent = false;
    public client: WsClient;

    constructor() {
        super(SellerState.INIT, 'SELLER');
        this.client = new WsClient(config);

        this.client.on('authenticated', () => {
            // Only start Memo polling on the FIRST connection.
            // On reconnection, re-subscribe to the existing ticket.
            if (this.client.isReconnection && this.currentTicketId) {
                this.logActivity(`Reconnected. Re-subscribing to ticket ${this.currentTicketId}`);
                this.client.send({
                    version: "1.0",
                    timestamp: Date.now(),
                    agent_id: seller.publicKey.toBase58(),
                    type: "status",
                    ticket_id: this.currentTicketId
                });
            } else {
                this.startPollingTicket();
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

    private startPollingTicket() {
        this.logActivity(`Connected! Attempting to find ticket via Solana Memo scanning...`);
        this.transition(SellerState.WAIT_OFFER);

        const memoProgram = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
        const subId = connection.onLogs("all", (logs) => {
            if (this.state !== SellerState.WAIT_OFFER) {
                connection.removeOnLogsListener(subId);
                return;
            }

            if (!logs.logs.some(l => l.includes(memoProgram.toBase58()))) return;

            for (const line of logs.logs) {
                const match = line.match(/Memo \(len \d+\): (.+)/);
                if (match) {
                    try {
                        const raw = match[1];
                        const content = JSON.parse(raw);
                        const parsed = typeof content === "string" ? JSON.parse(content) : content;

                        if (parsed.protocol === "agentotc-v1" && parsed.side === "buy" && parsed.agentEndpoint && parsed.agentEndpoint.startsWith("TCK-")) {
                            const ticketId = parsed.agentEndpoint;
                            this.currentTicketId = ticketId;
                            this.logActivity(`Offer received via Memo. Found Ticket: ${ticketId}. Joining...`);
                            connection.removeOnLogsListener(subId);

                            this.client.send({
                                version: "1.0",
                                timestamp: Date.now(),
                                agent_id: seller.publicKey.toBase58(),
                                type: "status",
                                ticket_id: ticketId
                            });

                            this.transition(SellerState.OFFER_RECEIVED);

                            // Agree to terms immediately
                            setTimeout(() => {
                                this.client.send({
                                    version: "1.0",
                                    timestamp: Date.now(),
                                    agent_id: seller.publicKey.toBase58(),
                                    type: "message",
                                    ticket_id: ticketId,
                                    content: "@middleman I accept the terms."
                                });
                                this.logActivity(`Sent Explicit Acceptance message`);
                                this.transition(SellerState.AGREED);
                                this.transition(SellerState.WAIT_FINAL_CONFIRM);
                            }, 2000);
                        }
                    } catch (e) {
                        // ignore malformed memo JSON
                    }
                }
            }
        }, "confirmed");
    }

    private async sendCollateral(address: string) {
        if (this.collateralSent) return;
        this.collateralSent = true;

        this.logActivity(`>>> SENDING COLLATERAL (0.02 SOL) to ${address}`);
        try {
            const target = new PublicKey(address);
            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: seller.publicKey,
                    toPubkey: target,
                    lamports: Math.floor(0.02 * 1e9),
                })
            );
            const sig = await sendAndConfirmTransaction(connection, tx, [seller], { commitment: "confirmed" });
            this.logActivity(`Collateral confirmed on-chain! Tx: ${sig}`);
        } catch (e: any) {
            this.logError(`Collateral tx failed: ${e.message}`);
            this.collateralSent = false; // allow retry
        }
    }

    public async handleIncomingMessage(msg: WsMessage, client: WsClient): Promise<void> {
        const eventType = msg.event_type || msg.type;
        const content = msg.content || (msg.payload && msg.payload.content) || "";
        const phase = (msg as any).phase || (msg as any).to_phase || (msg as any).payload?.to_phase || "";
        const lc = typeof content === 'string' ? content.toLowerCase() : '';

        // === DEBUG: Log EVERY message so we can trace exactly what arrives ===
        this.logActivity(`[DBG] state=${this.state} event=${eventType} phase=${phase} content=${typeof content === 'string' ? content.substring(0, 80) : '?'}...`);

        // Show middleman responses
        if (eventType === 'middleman_response' || eventType === 'middleman_message') {
            this.logActivity(`MIDDLEMAN: ${content}`);
        }

        // ── STEP 1: Wait for final confirmation from buyer ──
        if (this.state === SellerState.WAIT_FINAL_CONFIRM) {
            if (isFinalConfirmation(content)) {
                this.logActivity("Waiting for final confirmation -> Received!");
                this.transition(SellerState.WAIT_ESCROW);
            }
        }

        // ── STEP 2: Detect escrow address and send COLLATERAL (0.02 SOL) ──
        // Trigger: ANY message containing a Solana address while we haven't sent collateral yet
        // State guard: we must be past the negotiation phase
        if (!this.collateralSent &&
            this.state !== SellerState.INIT &&
            this.state !== SellerState.WAIT_OFFER &&
            this.state !== SellerState.OFFER_RECEIVED &&
            this.state !== SellerState.COMPLETED) {

            // Try structured field first, then regex from content
            const addr = msg.escrowAddress || msg.dealId || msg.payload?.dealId || extractAddress(content);

            if (addr) {
                this.logActivity(`[DEPOSIT TRIGGER] Found address: ${addr} (event=${eventType}, phase=${phase})`);
                await this.sendCollateral(addr);
                this.transition(SellerState.DEPOSIT_SENT);

                client.send({
                    version: "1.0",
                    timestamp: Date.now(),
                    agent_id: seller.publicKey.toBase58(),
                    type: 'deposit_confirmed',
                    ticket_id: this.currentTicketId,
                    role: 'seller'
                });

                this.logActivity(`Deposit sent to network`);
                this.transition(SellerState.WAIT_DELIVERY);
            }
        }

        // ── STEP 3: Wait for delivery / completion ──
        // NOTE: outboundRouter wraps ALL events as type="middleman_message"
        // so we check the `phase` field directly
        if (this.state === SellerState.WAIT_DELIVERY) {
            const msgPhase = (msg as any).phase || (msg as any).to_phase || (msg as any).payload?.to_phase || "";
            const isDelivery = msgPhase === 'delivery' ||
                lc.includes("all deposits received") ||
                lc.includes("delivery phase") ||
                lc.includes("escrow is locked") ||
                lc.includes("deliver the credentials");

            if (isDelivery) {
                this.logActivity("Delivery phase started. Sending credentials via DM...");
                this.transition(SellerState.FUNDS_RELEASED);
                setTimeout(() => {
                    this.logActivity("Credentials delivered, waiting for buyer release...");
                }, 1000);
            }

            const isCompleted = msgPhase === 'completed' ||
                lc.includes("deal complete") ||
                lc.includes("funds released") ||
                lc.includes("successfully executed");

            if (isCompleted) {
                this.logActivity("Payout received from Escrow!");
                this.transition(SellerState.COMPLETED);
            }
        }
    }
}

// Start Agent
const agent = new SellerAgent();
agent.connect();
