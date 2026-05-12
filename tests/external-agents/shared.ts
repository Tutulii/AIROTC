/**
 * shared.ts — Common utilities for external test agents
 *
 * Provides:
 *  - Fresh Solana wallet generation
 *  - WebSocket client with Ed25519 challenge-response auth
 *  - HTTP helpers for REST API calls
 *  - Colored logging
 */

import { Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import WebSocket from "ws";
import nacl from "tweetnacl";
import bs58 from "bs58";
import axios, { AxiosInstance } from "axios";
import { EventEmitter } from "events";

// ═══════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════

export const MIDDLEMAN_REST = process.env.MIDDLEMAN_URL || "http://localhost:8080";
export const MIDDLEMAN_WS = process.env.MIDDLEMAN_WS || "ws://localhost:8080";
export const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";

// ═══════════════════════════════════════════
// COLORED LOGGER
// ═══════════════════════════════════════════

export class AgentLogger {
    private name: string;
    private color: string;

    constructor(name: string, color: "green" | "blue" | "yellow" | "cyan" | "magenta") {
        this.name = name;
        const colors: Record<string, string> = {
            green: "\x1b[32m",
            blue: "\x1b[34m",
            yellow: "\x1b[33m",
            cyan: "\x1b[36m",
            magenta: "\x1b[35m",
        };
        this.color = colors[color] || "\x1b[0m";
    }

    info(msg: string, data?: any) {
        const ts = new Date().toISOString().split("T")[1].split(".")[0];
        const extra = data ? ` ${JSON.stringify(data)}` : "";
        console.log(`${this.color}[${ts}] [${this.name}]${extra ? " " : ""}\x1b[0m ${msg}${extra}`);
    }

    warn(msg: string, data?: any) {
        const ts = new Date().toISOString().split("T")[1].split(".")[0];
        console.log(`\x1b[33m[${ts}] [${this.name}] ⚠️ ${msg}\x1b[0m`, data || "");
    }

    error(msg: string, err?: any) {
        const ts = new Date().toISOString().split("T")[1].split(".")[0];
        console.error(`\x1b[31m[${ts}] [${this.name}] ❌ ${msg}\x1b[0m`, err?.message || err || "");
    }

    state(from: string, to: string) {
        this.info(`State: ${from} → \x1b[1m${to}\x1b[0m`);
    }

    divider(label?: string) {
        console.log(`${this.color}${"─".repeat(50)}${label ? ` ${label} ` : ""}${"─".repeat(10)}\x1b[0m`);
    }
}

// ═══════════════════════════════════════════
// WALLET UTILS
// ═══════════════════════════════════════════

export function generateWallet(): { keypair: Keypair; publicKey: string; secretKeyBase58: string } {
    const keypair = Keypair.generate();
    return {
        keypair,
        publicKey: keypair.publicKey.toBase58(),
        secretKeyBase58: bs58.encode(keypair.secretKey),
    };
}

export async function fundWallet(publicKey: string, log: AgentLogger, amountSol: number = 2): Promise<boolean> {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        log.info(`Requesting ${amountSol} SOL airdrop to ${publicKey.substring(0, 12)}...`);
        const sig = await connection.requestAirdrop(
            new Keypair().publicKey, // Dummy — we parse the real one below
            amountSol * LAMPORTS_PER_SOL
        );
        // Actually use the correct key
        const realSig = await connection.requestAirdrop(
            Keypair.fromSecretKey(bs58.decode(publicKey)).publicKey || new (require("@solana/web3.js").PublicKey)(publicKey),
            amountSol * LAMPORTS_PER_SOL
        );
        await connection.confirmTransaction(realSig, "confirmed");
        const balance = await connection.getBalance(new (require("@solana/web3.js").PublicKey)(publicKey));
        log.info(`Airdrop confirmed. Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        return true;
    } catch (e: any) {
        log.warn(`Airdrop failed (expected on rate-limited devnet): ${e.message}`);
        return false;
    }
}

export async function getBalance(publicKey: string): Promise<number> {
    const connection = new Connection(SOLANA_RPC, "confirmed");
    const { PublicKey } = require("@solana/web3.js");
    const balance = await connection.getBalance(new PublicKey(publicKey));
    return balance / LAMPORTS_PER_SOL;
}

// ═══════════════════════════════════════════
// AUTH: Ed25519 Challenge-Response
// ═══════════════════════════════════════════

function signChallenge(keypair: Keypair, challenge: string): string {
    const messageBytes = new TextEncoder().encode(challenge);
    const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
    return bs58.encode(signature);
}

// ═══════════════════════════════════════════
// WEBSOCKET CLIENT (mirrors agents/shared/wsClient.ts)
// ═══════════════════════════════════════════

export interface WsMessage {
    type: string;
    event_type?: string;
    content?: string;
    ticket_id?: string;
    phase?: string;
    challenge?: string;
    agent_id?: string;
    escrowAddress?: string;
    dealId?: string;
    payload?: any;
    to_phase?: string;
    error?: string;
    details?: string;
    [key: string]: any;
}

export class ExternalWsClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private keypair: Keypair;
    private name: string;
    private log: AgentLogger;
    private _authenticated = false;
    private reconnectAttempts = 0;
    private maxReconnects = 5;

    constructor(keypair: Keypair, name: string, log: AgentLogger) {
        super();
        this.keypair = keypair;
        this.name = name;
        this.log = log;
    }

    get authenticated(): boolean {
        return this._authenticated;
    }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.log.info(`Connecting to WebSocket: ${MIDDLEMAN_WS}`);

            this.ws = new WebSocket(MIDDLEMAN_WS);

            const timeout = setTimeout(() => {
                reject(new Error("WebSocket connection timeout (15s)"));
            }, 15000);

            this.ws.on("open", () => {
                this.log.info("WebSocket connected. Waiting for auth challenge...");
                this.reconnectAttempts = 0;
            });

            this.ws.on("message", (data: WebSocket.RawData) => {
                try {
                    const msg: WsMessage = JSON.parse(data.toString());

                    // Handle auth challenge
                    if (msg.type === "auth_challenge" || msg.challenge) {
                        const challenge = msg.challenge || msg.payload?.challenge;
                        if (challenge) {
                            this.log.info("Auth challenge received. Signing...");
                            const response = {
                                type: "auth_response",
                                wallet: this.keypair.publicKey.toBase58(),
                                signature: signChallenge(this.keypair, challenge),
                                challenge,
                            };
                            this.send(response);
                        }
                    }
                    // Handle auth success
                    else if (msg.type === "auth_success") {
                        this._authenticated = true;
                        this.log.info(`✅ Authenticated! Agent ID: ${msg.agent_id}`);
                        clearTimeout(timeout);
                        this.emit("authenticated", msg);
                        resolve();
                    }
                    // Handle auth failure
                    else if (msg.type === "auth_failed") {
                        this.log.error(`Auth failed: ${msg.reason}`);
                        clearTimeout(timeout);
                        reject(new Error(`Auth failed: ${msg.reason}`));
                    }
                    // Handle server errors
                    else if (msg.type === "error") {
                        this.log.warn(`Server error: ${msg.error || msg.details}`);
                        this.emit("server_error", msg);
                    }
                    // Normal messages
                    else {
                        this.emit("message", msg);
                    }
                } catch (e: any) {
                    this.log.error("Failed to parse WS message", e);
                }
            });

            this.ws.on("close", (code, reason) => {
                this._authenticated = false;
                const reasonStr = reason?.toString() || "";
                this.log.warn(`WebSocket closed (code=${code}, reason="${reasonStr}")`);

                if (this.reconnectAttempts < this.maxReconnects) {
                    this.reconnectAttempts++;
                    const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
                    this.log.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
                    setTimeout(() => this.connect().catch(() => {}), delay);
                }
            });

            this.ws.on("error", (err: any) => {
                if (err.code === "ECONNREFUSED") {
                    this.log.warn("Server not reachable, will retry...");
                } else {
                    this.log.error("WS Error", err);
                }
            });
        });
    }

    send(msg: any) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        } else {
            this.log.warn("Cannot send — WebSocket not open");
        }
    }

    sendMessage(ticketId: string, content: string) {
        this.send({
            version: "1.0",
            timestamp: Date.now(),
            agent_id: this.keypair.publicKey.toBase58(),
            type: "message",
            ticket_id: ticketId,
            content,
        });
    }

    sendStatus(ticketId: string) {
        this.send({
            version: "1.0",
            timestamp: Date.now(),
            agent_id: this.keypair.publicKey.toBase58(),
            type: "status",
            ticket_id: ticketId,
        });
    }

    sendDepositConfirmed(ticketId: string, role: "buyer" | "seller") {
        this.send({
            version: "1.0",
            timestamp: Date.now(),
            agent_id: this.keypair.publicKey.toBase58(),
            type: "deposit_confirmed",
            ticket_id: ticketId,
            role,
        });
    }

    disconnect() {
        this.maxReconnects = 0; // prevent reconnection
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// ═══════════════════════════════════════════
// HTTP API CLIENT
// ═══════════════════════════════════════════

export function createApiClient(): AxiosInstance {
    return axios.create({
        baseURL: MIDDLEMAN_REST,
        timeout: 15000,
        headers: { "Content-Type": "application/json" },
    });
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export function extractSolanaAddress(text: string): string | null {
    if (!text) return null;
    const m =
        text.match(/`([1-9A-HJ-NP-Za-km-z]{32,44})`/) ||
        text.match(/\*\*([1-9A-HJ-NP-Za-km-z]{32,44})\*\*/) ||
        text.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    return m ? m[1] : null;
}

export function extractTicketId(text: string): string | null {
    if (!text) return null;
    const m = text.match(/TCK-[A-Z0-9]+/);
    return m ? m[0] : null;
}
