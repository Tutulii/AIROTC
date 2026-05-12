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

class BuyerE2EAgent extends AgentStateMachine<BuyerState> {
    private currentTicketId: string | null = null;
    public client: WsClient;

    constructor() {
        super(BuyerState.INIT, 'BUYER_E2E');
        this.client = new WsClient(config);

        this.client.on('authenticated', async () => {
            await this.startOfferFlow();
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

            fs.writeFileSync(path.join(__dirname, 'latest_ticket.txt'), this.currentTicketId || '');

            this.client.send({
                version: "1.0",
                timestamp: Date.now(),
                agent_id: buyer.publicKey.toBase58(),
                type: "message",
                ticket_id: this.currentTicketId,
                content: "I want to buy SOL at 0.1 SOL price, with 0.02 SOL collateral from both sides."
            });
            this.transition(BuyerState.OFFER_SENT);

        } catch (e: any) {
            this.logError(`Failed to create offer: ${e.message}`);
        }
    }

    public async handleIncomingMessage(msg: WsMessage, client: WsClient): Promise<void> {
        console.log(`[BUYER_E2E] RAW INCOMING MSG:`, JSON.stringify(msg));
        const eventType = msg.event_type || msg.type;
        const content = msg.content || (msg.payload && msg.payload.content) || "";

        // Buyer waits for Seller's agreement
        if (this.state === BuyerState.OFFER_SENT || this.state === BuyerState.WAITING_SELLER) {
            if (eventType === 'message' || eventType === 'middleman_response' || eventType === 'middleman_message') {
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
                        content: "Deal confirmed. Proceed to escrow."
                    });

                    this.transition(BuyerState.FINAL_CONFIRM_SENT);
                } else if (content.includes("has joined")) {
                    this.transition(BuyerState.WAITING_SELLER);
                }
            }
        }

        // Wait for Escrow Creation
        if (this.state === BuyerState.FINAL_CONFIRM_SENT || this.state === BuyerState.WAIT_ESCROW) {
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

                this.transition(BuyerState.WAIT_ESCROW);
                this.logActivity(`Escrow detected! PDA: ${dealPdaRaw}`);

                try {
                    const { program, programId, wallet } = getAnchorProgram(buyer, connection);
                    const dealPda = new PublicKey(dealPdaRaw);
                    const configPda = deriveConfigPda(programId);

                    this.logActivity(`Executing lockCollateral on-chain...`);
                    const tx1 = await program.methods.lockCollateral()
                        .accounts({
                            deal: dealPda, user: wallet.publicKey, config: configPda,
                            systemProgram: SystemProgram.programId,
                        })
                        .signers([buyer]).rpc();
                    this.logActivity(`✅ lockCollateral tx: ${tx1}`);

                    this.logActivity(`Executing lockPayment on-chain...`);
                    const tx2 = await program.methods.lockPayment()
                        .accounts({
                            deal: dealPda, buyer: wallet.publicKey, config: configPda,
                            systemProgram: SystemProgram.programId,
                        })
                        .signers([buyer]).rpc();
                    this.logActivity(`✅ lockPayment tx: ${tx2}`);

                    // Complete Deposit
                    this.transition(BuyerState.DEPOSIT_SENT);

                    // Confirm deposit to agent
                    client.send({
                        version: "1.0",
                        timestamp: Date.now(),
                        agent_id: buyer.publicKey.toBase58(),
                        type: 'deposit_confirmed',
                        role: 'buyer'
                    });

                    client.send({
                        version: "1.0",
                        timestamp: Date.now(),
                        agent_id: buyer.publicKey.toBase58(),
                        type: "message",
                        ticket_id: this.currentTicketId,
                        content: "Funds sent. Confirming deposit."
                    });

                    // Complete
                    this.transition(BuyerState.COMPLETED);
                    this.logActivity("Buyer Execution Cycle Complete! 🎉");

                } catch (err: any) {
                    this.logError("On-chain execution failed: " + err.message);
                }
            }
        }
    }
}

// Start Agent
const agent = new BuyerE2EAgent();
agent.connect();
