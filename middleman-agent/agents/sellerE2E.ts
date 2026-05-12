import { Keypair, Connection, SystemProgram, PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet, BN } from '@coral-xyz/anchor';
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

function getAnchorProgram(keypair: Keypair, connection: Connection) {
    const idlPath = path.join(__dirname, "../../escrow/target/idl/escrow.json");
    if (!fs.existsSync(idlPath)) {
        throw new Error("IDL not found at " + idlPath);
    }
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
    const wallet = new Wallet(keypair);
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    const programIdStr = process.env.PROGRAM_ID || (idl as any).metadata?.address || (idl as any).address;
    if (!programIdStr) throw new Error("Missing program ID in IDL or ENV");
    const programId = new PublicKey(programIdStr);
    (idl as any).address = programIdStr;
    const program = new Program(idl as any, provider);
    return { program, wallet, programId };
}

function deriveConfigPda(programId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
    return pda;
}

class SellerE2EAgent extends AgentStateMachine<SellerState> {
    private currentTicketId: string | null = null;
    public client: WsClient;

    constructor() {
        super(SellerState.INIT, 'SELLER_E2E');
        this.client = new WsClient(config);

        this.client.on('authenticated', () => {
            this.startPollingTicket();
        });

        this.client.on('message', async (msg: WsMessage) => {
            try {
                await this.handleIncomingMessage(msg, this.client);
            } catch (err: any) {
                this.logError(err.message || 'Unknown error handling message');
            }
        });
    }

    public async connect() {
        this.client.connect();
    }

    private startPollingTicket() {
        this.logActivity(`Connected! Attempting to find local ticket...`);
        this.transition(SellerState.WAIT_OFFER);

        const interval = setInterval(() => {
            if (this.state !== SellerState.WAIT_OFFER) {
                clearInterval(interval);
                return;
            }

            try {
                const ticketId = fs.readFileSync(path.join(__dirname, 'latest_ticket.txt'), 'utf8').trim();
                if (ticketId) {
                    this.currentTicketId = ticketId;
                    this.logActivity(`Offer received. Found Ticket: ${ticketId}. Joining...`);
                    clearInterval(interval);

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
                            content: "Agree"
                        });
                        this.logActivity(`Sent Explicit Acceptance message`);
                        this.transition(SellerState.AGREED);
                        this.transition(SellerState.WAIT_FINAL_CONFIRM);
                    }, 2000);
                }
            } catch (e) {
                // Waiting for file
            }
        }, 1000);
    }

    public async handleIncomingMessage(msg: WsMessage, client: WsClient): Promise<void> {
        console.log(`[SELLER_E2E] RAW INCOMING MSG:`, JSON.stringify(msg));
        const eventType = msg.event_type || msg.type;
        const content = msg.content || (msg.payload && msg.payload.content) || "";

        if (this.state === SellerState.WAIT_FINAL_CONFIRM) {
            if (eventType === 'message' || eventType === 'middleman_response' || eventType === 'middleman_message') {
                if (isFinalConfirmation(content)) {
                    this.logActivity("Waiting for final confirmation -> Received!");
                    this.transition(SellerState.WAIT_ESCROW);
                }
            }
        }

        if (this.state === SellerState.WAIT_ESCROW) {
            if (eventType === 'escrow_created' || eventType === 'deal_created' || eventType === 'deal_executed') {
                const pdaStr = msg.escrowAddress || msg.dealId || msg.payload?.dealId || msg.payload?.escrowAddress || msg.deal_id || msg.payload?.deal_id;
                let dealPdaRaw = pdaStr;

                // If PDA not in payload directly, try to extract from content
                if (!dealPdaRaw || dealPdaRaw === 'unknown') {
                    const match = content.match(/PDA:[\\s*`]*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
                    if (match && match[1]) {
                        dealPdaRaw = match[1];
                    }
                }

                if (!dealPdaRaw || dealPdaRaw === 'unknown') {
                    this.logActivity("Escrow created but could not parse PDA! Waiting for clear instruction.");
                    return;
                }

                this.transition(SellerState.WAIT_ESCROW);
                this.logActivity(`Escrow detected! PDA: ${dealPdaRaw}`);

                try {
                    const { program, programId, wallet } = getAnchorProgram(seller, connection);
                    const dealPda = new PublicKey(dealPdaRaw);
                    const configPda = deriveConfigPda(programId);

                    this.logActivity(`Executing lockCollateral on-chain...`);
                    const tx1 = await program.methods.lockCollateral()
                        .accounts({
                            deal: dealPda, user: wallet.publicKey, config: configPda,
                            systemProgram: SystemProgram.programId,
                        })
                        .signers([seller]).rpc();
                    this.logActivity(`✅ lockCollateral tx: ${tx1}`);

                    // Complete Deposit
                    this.transition(SellerState.DEPOSIT_SENT);

                    // Confirm deposit to agent
                    client.send({
                        version: "1.0",
                        timestamp: Date.now(),
                        agent_id: seller.publicKey.toBase58(),
                        type: 'deposit_confirmed',
                        role: 'seller'
                    });

                    this.logActivity(`Deposit sent`);
                    this.transition(SellerState.COMPLETED);
                    this.logActivity("Seller Execution Cycle Complete! 🎉");

                } catch (err: any) {
                    this.logError("On-chain execution failed: " + err.message);
                }
            }
        }
    }
}

// Start Agent
const agent = new SellerE2EAgent();
agent.connect();
