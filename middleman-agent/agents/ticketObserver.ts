import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { WsClient } from './shared/wsClient';
import { AgentConfig, WsMessage } from './shared/types';

dotenv.config({ path: path.join(__dirname, '../.env') });

const API_URL = process.env.API_URL || 'http://localhost:8080';
const WS_URL = process.env.WS_URL || 'ws://localhost:3001';

// We just generate a fresh ephemeral keypair for the observer
const observerWallet = Keypair.generate();

const config: AgentConfig = {
    keypair: observerWallet,
    apiUrl: API_URL,
    wsUrl: WS_URL,
    role: 'OBSERVER'
};

class TicketObserver {
    private targetTicketId: string | null = null;
    public client: WsClient;
    private joined: boolean = false;

    constructor() {
        this.client = new WsClient(config);

        this.client.on('authenticated', () => {
            this.startPollingTicket();
        });

        this.client.on('message', (msg: WsMessage) => {
            this.handleMessage(msg);
        });
    }

    public connect() {
        console.log("[\x1b[36mOBSERVER\x1b[0m] Starting Ticket Observer...");
        this.client.connect();
    }

    private startPollingTicket() {
        console.log("[\x1b[36mOBSERVER\x1b[0m] Waiting for a ticket to observe (checking latest_ticket.txt)...");

        const interval = setInterval(() => {
            if (this.joined) {
                clearInterval(interval);
                return;
            }

            try {
                const ticketPath = path.join(__dirname, 'latest_ticket.txt');
                if (fs.existsSync(ticketPath)) {
                    const ticketId = fs.readFileSync(ticketPath, 'utf8').trim();
                    if (ticketId && ticketId !== this.targetTicketId) {
                        this.targetTicketId = ticketId;
                        console.log(`\n======================================================`);
                        console.log(`[\x1b[36mOBSERVER\x1b[0m] Found new ticket: \x1b[33m${ticketId}\x1b[0m`);
                        console.log(`[\x1b[36mOBSERVER\x1b[0m] Subscribing to live events stream...`);
                        console.log(`======================================================\n`);
                        
                        this.joined = true;
                        clearInterval(interval);

                        // Send status message to join the room
                        this.client.send({
                            version: "1.0",
                            timestamp: Date.now(),
                            agent_id: observerWallet.publicKey.toBase58(),
                            type: "status",
                            ticket_id: ticketId
                        });

                        // Optionally, if the latest_ticket.txt gets deleted, we reset
                        this.watchTicketFile();
                    }
                }
            } catch (e) {
                // Ignore file read errors while waiting
            }
        }, 1000);
    }

    private watchTicketFile() {
        const interval = setInterval(() => {
            try {
                const ticketPath = path.join(__dirname, 'latest_ticket.txt');
                if (!fs.existsSync(ticketPath)) {
                    console.log(`\n[\x1b[36mOBSERVER\x1b[0m] latest_ticket.txt was reset. Waiting for next ticket...`);
                    this.joined = false;
                    this.targetTicketId = null;
                    clearInterval(interval);
                    this.startPollingTicket();
                } else {
                    const ticketId = fs.readFileSync(ticketPath, 'utf8').trim();
                    if (ticketId && ticketId !== this.targetTicketId) {
                        this.joined = false;
                        clearInterval(interval);
                        this.startPollingTicket();
                    }
                }
            } catch (e) {}
        }, 2000);
    }

    private handleMessage(msg: WsMessage) {
        const eventType = msg.event_type || msg.type;
        const phase = msg.phase || msg.payload?.phase || "";
        const sender = msg.sender || msg.agent_id || "System";
        let content = msg.content || (msg.payload && msg.payload.content) || "";
        
        // Skip ping/pong or internal sync messages uninteresting to the observer
        if (eventType === 'ping' || eventType === 'pong') return;
        
        const timestamp = new Date().toLocaleTimeString();
        let logString = `[\x1b[90m${timestamp}\x1b[0m] `;

        switch(eventType) {
            case 'message':
                logString += `[\x1b[34mParty Message\x1b[0m] ${content}`;
                break;
            case 'middleman_response':
                logString += `[\x1b[35mMiddleman AI\x1b[0m] ${content}`;
                if (phase) logString += `  \x1b[90m[Phase: ${phase}]\x1b[0m`;
                break;
            case 'deal_created':
            case 'escrow_created':
                const dealPda = msg.escrowAddress || msg.dealId || msg.payload?.dealId || msg.payload?.escrowAddress || 'unknown';
                logString += `[\x1b[32mEscrow Created\x1b[0m] On-Chain PDA → \x1b[33m${dealPda}\x1b[0m`;
                break;
            case 'phase_changed':
                const from = msg.from_phase || msg.payload?.from_phase || "?";
                const to = msg.to_phase || msg.payload?.to_phase || "?";
                logString += `[\x1b[36mPhase Shift\x1b[0m] \x1b[90m${from}\x1b[0m → \x1b[36m${to}\x1b[0m`;
                break;
            case 'deposit_confirmed':
                const role = msg.role || msg.payload?.role || sender;
                logString += `[\x1b[32mDeposit Checked\x1b[0m] ${role} has confirmed on-chain deposit.`;
                break;
            case 'deal_executed':
                const status = msg.status || msg.payload?.status || "executed";
                logString += `[\x1b[32mExecution Event\x1b[0m] Deal is now: \x1b[1m${status}\x1b[0m`;
                break;
            case 'status':
                logString += `[\x1b[90mRoom Status\x1b[0m] Active phase: ${phase || "unknown"}`;
                break;
            case 'error':
                logString += `[\x1b[31mPlatform Error\x1b[0m] ${msg.message || content || JSON.stringify(msg)}`;
                break;
            default:
                if (content) {
                    logString += `[\x1b[37m${eventType}\x1b[0m] ${content}`;
                } else {
                    logString += `[\x1b[37m${eventType}\x1b[0m] ${JSON.stringify(msg)}`;
                }
        }

        console.log(logString);
    }
}

// Start
const observer = new TicketObserver();
observer.connect();
