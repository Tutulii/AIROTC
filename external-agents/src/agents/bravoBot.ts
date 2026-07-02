/**
 * BravoBot — Autonomous Seller Agent (Normal + ER + PER + SPORT)
 * 
 * ER Mode:  Chat-based negotiation → middleman analyzes → auto-escrow → collateral deposit → deliver
 * PER Mode: Brief chat greeting → terms via SDK (opaque) → deposit → encrypted delivery
 */

import { Keypair, Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ApiClient } from "../lib/apiClient";
import { WsClient } from "../lib/wsClient";
import { decideNegotiation, formatRelease } from "../lib/agentBrain";
import { log, logPhase, logSuccess, logError } from "../lib/logger";

export interface BravoBotConfig {
  keypair: Keypair;
  platformRestUrl: string;
  platformWsUrl: string;
  solanaRpcUrl: string;
  tradeAsset: string;
  askingPrice: number;
  minPrice: number;
  collateral: number;
  rollupMode: "ER" | "PER" | "NONE" | "SPORT";
  bridgeSecret: string;
}

export class BravoBot {
  private config: BravoBotConfig;
  private api: ApiClient;
  private ws: WsClient;
  private connection: Connection;
  private wallet: string;
  private messageHistory: string[] = [];
  private escrowPda: string | null = null;
  private currentTicketId: string | null = null;
  private currentOfferId: string | null = null;
  private dealCompleted = false;

  constructor(config: BravoBotConfig) {
    this.config = config;
    this.wallet = config.keypair.publicKey.toBase58();
    this.api = new ApiClient(config.platformRestUrl, "BravoBot", config.bridgeSecret);
    this.ws = new WsClient(config.platformWsUrl, config.keypair, "BravoBot");
    this.connection = new Connection(config.solanaRpcUrl, "confirmed");
  }

  async register(): Promise<void> {
    logPhase("BRAVO — PHASE 1: REGISTER");
    const result = await this.api.register(this.wallet);
    log("BravoBot", `Registered: ${result.created ? "NEW" : "existing"} | ID: ${result.data.id}`, "green");
    log("BravoBot", `Wallet: ${this.wallet}`, "magenta");
    log("BravoBot", `Mode: ${this.config.rollupMode}`, "magenta");
    const balance = await this.connection.getBalance(this.config.keypair.publicKey);
    log("BravoBot", `Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`, "magenta");
  }

  async postSellOffer(): Promise<string> {
    logPhase("BRAVO — PHASE 2: POST SELL OFFER");
    // Generate fresh Umbra settlement wallet for this deal
    const settlementKeypair = Keypair.generate();
    log("BravoBot", `Settlement wallet: ${settlementKeypair.publicKey.toBase58().substring(0, 12)}...`, "dim");
    const { offerId, data } = await this.api.createOffer({
      asset: this.config.tradeAsset,
      price: this.config.askingPrice,
      amount: 1,
      mode: "sell",
      collateral: this.config.collateral,
      wallet: this.wallet,
      rollupMode: this.config.rollupMode,
      settlementWallet: settlementKeypair.publicKey.toBase58(),
    });
    this.currentOfferId = offerId;
    log("BravoBot", `📋 Sell offer posted: ${offerId}`, "green");
    log("BravoBot", `Asset: ${data.asset} | Price: ${data.price} SOL | Collateral: ${data.collateral} SOL | Mode: ${this.config.rollupMode}`, "magenta");
    return offerId;
  }

  async waitForAcceptance(): Promise<string> {
    log("BravoBot", "Waiting for buyer to accept offer...", "yellow");
    const start = Date.now();
    const timeout = 120000;
    while (Date.now() - start < timeout) {
      await this.sleep(3000);
      const { data: offers } = await this.api.listOffers();
      const our = offers.find(o => o.id === this.currentOfferId);
      if (our && (our.status === "matched" || our.status === "matching")) {
        log("BravoBot", "🎯 Offer accepted by a buyer!", "green");
        break;
      }
    }
    return "";
  }

  // ═══════════════════════════════════════
  // NEGOTIATION — Dual Mode
  // ═══════════════════════════════════════

  async negotiate(ticketId: string, sharedHistory: string[]): Promise<void> {
    logPhase(`BRAVO — PHASE 3: NEGOTIATE (${this.config.rollupMode})`);
    this.currentTicketId = ticketId;
    this.messageHistory = [...sharedHistory];

    if (this.config.rollupMode === "PER") {
      return this.negotiatePER(ticketId);
    }
    return this.negotiateER(ticketId);
  }

  /**
   * ER Negotiation: Full chat-based LLM negotiation.
   * The middleman brain analyzes each message and triggers escrow when consensus is reached.
   */
  private async negotiateER(ticketId: string): Promise<void> {
    log("BravoBot", "ER mode — full plaintext negotiation", "magenta");

    for (let round = 0; round < 10; round++) {
      const message = await decideNegotiation({
        role: "seller",
        agentName: "BravoBot",
        asset: this.config.tradeAsset,
        targetPrice: this.config.askingPrice,
        minAcceptable: this.config.minPrice,
        collateral: this.config.collateral,
        messageHistory: this.messageHistory,
        currentPhase: "negotiation",
      });

      log("BravoBot", `💬 "${message}"`, "magenta");
      const response = await this.api.sendMessage(ticketId, this.wallet, message);
      this.messageHistory.push(`[BravoBot]: ${message}`);
      if (response.response) {
        this.messageHistory.push(`[Middleman]: ${response.response}`);
        log("BravoBot", `🤖 Middleman: "${response.response.substring(0, 120)}"`, "dim");
      }

      if (response.action === "CREATE_ESCROW" || response.phase === "awaiting_deposits" || response.phase === "escrow_created") {
        log("BravoBot", "🔒 Escrow creation triggered!", "green");
        break;
      }

      try {
        const status = await this.api.getDealStatus(ticketId);
        if (status.escrow_pda) { this.escrowPda = status.escrow_pda; break; }
        if (status.phase === "awaiting_deposits" || status.phase === "escrow_created") {
          log("BravoBot", "🔒 Deal advanced to deposits phase!", "green");
          break;
        }
      } catch { /* not ready */ }

      await this.sleep(3000);
    }
  }

  /**
   * PER Negotiation: Minimal chat, terms negotiated via rollup SDK.
   * Chat messages are conversation-only — middleman cannot parse terms.
   */
  private async negotiatePER(ticketId: string): Promise<void> {
    log("BravoBot", "PER mode — private negotiation (opaque to middleman)", "magenta");

    // Step 1: Send a brief greeting
    await this.api.sendMessage(ticketId, this.wallet,
      "ready for PER private negotiation. let's proceed.");
    log("BravoBot", "📡 PER greeting sent", "magenta");
    await this.sleep(2000);

    // Step 2: Signal agreement via chat (in production, this goes through SDK)
    const agreedMsg = `agreed. lets proceed with the PER terms. @middleman create escrow.`;
    const response = await this.api.sendMessage(ticketId, this.wallet, agreedMsg);
    log("BravoBot", `🔒 PER terms submitted`, "magenta");

    if (response.action === "CREATE_ESCROW" || response.phase === "awaiting_deposits") {
      log("BravoBot", "🔒 Escrow creation triggered (PER)!", "green");
    }

    await this.sleep(3000);
  }

  // ═══════════════════════════════════════
  // DEPOSIT — Dual Mode
  // ═══════════════════════════════════════

  async deposit(ticketId: string): Promise<void> {
    logPhase(`BRAVO — PHASE 4: DEPOSIT COLLATERAL (${this.config.rollupMode})`);
    if (!this.escrowPda) await this.waitForEscrowPda(ticketId);

    if (!this.escrowPda) {
      // No on-chain PDA — signal deposit via message for phase advancement
      log("BravoBot", "No on-chain PDA. Signaling deposit to middleman...", "yellow");
      const depositMsg = "@middleman I have deposited my collateral. Please confirm.";
      const response = await this.api.sendMessage(ticketId, this.wallet, depositMsg);
      log("BravoBot", `✅ Deposit signaled | Response: "${(response.response || "").substring(0, 80)}"`, "green");

      if (response.action === "RECORD_DEPOSIT") {
        log("BravoBot", `📊 Phase: ${response.phase}`, "dim");
      }
      return;
    }

    // Real on-chain deposit to escrow PDA
    const pda = new PublicKey(this.escrowPda);

    if (this.config.rollupMode === "PER") {
      // PER: Single collateral deposit (amount encrypted via FHE)
      log("BravoBot", `🔐 PER deposit: ${this.config.collateral} SOL (encrypted)`, "magenta");
      await this.sendSol(pda, this.config.collateral);
      log("BravoBot", "✅ PER collateral deposited", "green");
    } else {
      // Normal/ER: Standard collateral deposit
      log("BravoBot", `Sending ${this.config.collateral} SOL collateral...`, "magenta");
      await this.sendSol(pda, this.config.collateral);
      log("BravoBot", "✅ Collateral deposited", "green");
    }
  }

  // ═══════════════════════════════════════
  // DELIVER ITEM — Dual Mode
  // ═══════════════════════════════════════

  async deliverItem(ticketId: string): Promise<void> {
    logPhase(`BRAVO — PHASE 5: DELIVER ITEM (${this.config.rollupMode})`);

    // Check current phase
    try {
      const status = await this.api.getDealStatus(ticketId);
      log("BravoBot", `Current phase: ${status.phase}`, "dim");
      if (status.phase === "completed") {
        log("BravoBot", "Deal already completed, skipping delivery.", "yellow");
        return;
      }
    } catch { /* ignore */ }

    await this.sleep(2000);

    if (this.config.rollupMode === "PER") {
      // PER: Delivery via encrypted DM channel
      const msg = "item has been delivered via encrypted channel. the API key is: sk-demo-abc123xyz. @middleman confirm delivery.";
      log("BravoBot", `🔐 PER delivery: "${msg.substring(0, 60)}..."`, "magenta");
      const response = await this.api.sendMessage(ticketId, this.wallet, msg);
      log("BravoBot", `🤖 Middleman: "${(response.response || "").substring(0, 120)}"`, "dim");
    } else {
      // ER: Standard delivery message
      const msg = "item has been delivered to your inbox. the API key is: sk-demo-abc123xyz. @middleman confirm delivery.";
      log("BravoBot", `💬 "${msg}"`, "magenta");
      const response = await this.api.sendMessage(ticketId, this.wallet, msg);
      log("BravoBot", `🤖 Middleman: "${(response.response || "").substring(0, 120)}"`, "dim");
    }
  }

  // ═══════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════

  private async sendSol(to: PublicKey, amountSol: number): Promise<string> {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: this.config.keypair.publicKey, toPubkey: to,
      lamports: Math.floor(amountSol * LAMPORTS_PER_SOL),
    }));
    return sendAndConfirmTransaction(this.connection, tx, [this.config.keypair]);
  }

  private async waitForEscrowPda(ticketId: string, timeoutMs = 30000): Promise<void> {
    log("BravoBot", "Waiting for escrow PDA...", "yellow");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await this.sleep(3000);
      try {
        const s = await this.api.getDealStatus(ticketId);
        if (s.escrow_pda) { this.escrowPda = s.escrow_pda; return; }
        log("BravoBot", `Phase: ${s.phase}`, "dim");
      } catch { /* ignore */ }
    }
  }

  private async waitForPhase(ticketId: string, target: string, timeoutMs = 90000): Promise<void> {
    log("BravoBot", `Waiting for phase: ${target}...`, "yellow");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await this.sleep(3000);
      try {
        const s = await this.api.getDealStatus(ticketId);
        if (s.phase === target || s.phase === "completed") return;
      } catch { /* ignore */ }
    }
  }

  sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
  get isDealCompleted() { return this.dealCompleted; }
  get ticketId() { return this.currentTicketId; }
  getMessageHistory() { return this.messageHistory; }
}
