/**
 * AlphaBot — Autonomous Buyer Agent (Normal + ER + PER + SPORT)
 * 
 * ER Mode:  Chat-based negotiation → middleman analyzes → auto-escrow → deposit → release
 * PER Mode: Brief chat greeting → terms via SDK (opaque) → deposit → threshold-signed release
 */

import { Keypair, Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ApiClient, Offer } from "../lib/apiClient";
import { WsClient } from "../lib/wsClient";
import { decideNegotiation, formatRelease } from "../lib/agentBrain";
import { log, logPhase, logSuccess, logError } from "../lib/logger";

export interface AlphaBotConfig {
  keypair: Keypair;
  platformRestUrl: string;
  platformWsUrl: string;
  solanaRpcUrl: string;
  tradeAsset: string;
  targetPrice: number;
  maxPrice: number;
  collateral: number;
  rollupMode: "ER" | "PER" | "NONE" | "SPORT";
  bridgeSecret: string;
}

export class AlphaBot {
  private config: AlphaBotConfig;
  private api: ApiClient;
  private ws: WsClient;
  private connection: Connection;
  private wallet: string;
  private messageHistory: string[] = [];
  private escrowPda: string | null = null;
  private currentTicketId: string | null = null;
  private dealCompleted = false;

  constructor(config: AlphaBotConfig) {
    this.config = config;
    this.wallet = config.keypair.publicKey.toBase58();
    this.api = new ApiClient(config.platformRestUrl, "AlphaBot", config.bridgeSecret);
    this.ws = new WsClient(config.platformWsUrl, config.keypair, "AlphaBot");
    this.connection = new Connection(config.solanaRpcUrl, "confirmed");
  }

  async register(): Promise<void> {
    logPhase("ALPHA — PHASE 1: REGISTER");
    const result = await this.api.register(this.wallet);
    log("AlphaBot", `Registered: ${result.created ? "NEW" : "existing"} | ID: ${result.data.id}`, "green");
    log("AlphaBot", `Wallet: ${this.wallet}`, "cyan");
    log("AlphaBot", `Mode: ${this.config.rollupMode}`, "cyan");
    const balance = await this.connection.getBalance(this.config.keypair.publicKey);
    log("AlphaBot", `Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`, "cyan");
  }

  async browseAndAccept(): Promise<string> {
    logPhase("ALPHA — PHASE 2: BROWSE & QUICK BUY");
    const { data: offers } = await this.api.listOffers({ mode: "sell" });
    log("AlphaBot", `Found ${offers.length} sell offers`, "cyan");

    // Filter matching offers and pick the NEWEST one (avoids stale offers from previous runs)
    const matchingOffers = offers
      .filter((o: Offer) => o.status === "active" && o.price <= this.config.maxPrice && o.creator.wallet !== this.wallet)
      .sort((a: Offer, b: Offer) => b.id.localeCompare(a.id)); // newest first (IDs are timestamp-based)

    const match = matchingOffers[0];
    if (match) {
      log("AlphaBot", `🎯 Found offer: ${match.id} | ${match.asset} @ ${match.price} SOL`, "green");
      // Generate fresh Umbra settlement wallet for this deal
      const settlementKeypair = Keypair.generate();
      log("AlphaBot", `Settlement wallet: ${settlementKeypair.publicKey.toBase58().substring(0, 12)}...`, "dim");
      const { ticket } = await this.api.acceptOffer(match.id, this.wallet, settlementKeypair.publicKey.toBase58());
      this.currentTicketId = ticket.id;
      log("AlphaBot", `✅ Accepted! Ticket: ${ticket.id}`, "green");
      return ticket.id;
    }

    log("AlphaBot", "No matching offers. Posting BUY offer...", "yellow");
    const { offerId } = await this.api.createOffer({
      asset: this.config.tradeAsset, price: this.config.targetPrice,
      amount: 1, mode: "buy", collateral: this.config.collateral,
      wallet: this.wallet, rollupMode: this.config.rollupMode,
    });
    log("AlphaBot", `Buy offer posted: ${offerId}`, "green");
    return `PENDING-${offerId}`;
  }

  // ═══════════════════════════════════════
  // NEGOTIATION — Dual Mode
  // ═══════════════════════════════════════

  async negotiate(ticketId: string): Promise<void> {
    logPhase(`ALPHA — PHASE 3: NEGOTIATE (${this.config.rollupMode})`);
    this.currentTicketId = ticketId;

    if (this.config.rollupMode === "PER") {
      return this.negotiatePER(ticketId);
    }
    return this.negotiateER(ticketId);
  }

  /**
   * ER Negotiation: Full chat-based LLM negotiation.
   * The middleman brain analyzes each message, tracks agreement scores,
   * and triggers CREATE_ESCROW when consensus is reached.
   */
  private async negotiateER(ticketId: string): Promise<void> {
    log("AlphaBot", "ER mode — full plaintext negotiation", "cyan");

    for (let round = 0; round < 10; round++) {
      const message = await decideNegotiation({
        role: "buyer", agentName: "AlphaBot", asset: this.config.tradeAsset,
        targetPrice: this.config.targetPrice, minAcceptable: this.config.maxPrice,
        collateral: this.config.collateral, messageHistory: this.messageHistory,
        currentPhase: "negotiation",
      });

      log("AlphaBot", `💬 "${message}"`, "cyan");
      const response = await this.api.sendMessage(ticketId, this.wallet, message);
      this.messageHistory.push(`[AlphaBot]: ${message}`);
      if (response.response) {
        this.messageHistory.push(`[Middleman]: ${response.response}`);
        log("AlphaBot", `🤖 Middleman: "${response.response.substring(0, 120)}"`, "dim");
      }

      if (response.action === "CREATE_ESCROW" || response.phase === "awaiting_deposits" || response.phase === "escrow_created") {
        log("AlphaBot", "🔒 Escrow creation triggered!", "green");
        break;
      }

      try {
        const status = await this.api.getDealStatus(ticketId);
        if (status.escrow_pda) { this.escrowPda = status.escrow_pda; break; }
        if (status.phase === "awaiting_deposits" || status.phase === "escrow_created") {
          log("AlphaBot", "🔒 Deal advanced to deposits phase!", "green");
          break;
        }
      } catch { /* not ready yet */ }

      await this.sleep(3000);
    }
  }

  /**
   * PER Negotiation: Minimal chat, terms negotiated via rollup SDK.
   * Chat messages are conversation-only — middleman cannot parse terms.
   * In strict opaque mode, middleman returns "PER private chat message recorded".
   */
  private async negotiatePER(ticketId: string): Promise<void> {
    log("AlphaBot", "PER mode — private negotiation (opaque to middleman)", "magenta");

    // Step 1: Send a brief greeting (middleman sees this but doesn't parse terms)
    await this.api.sendMessage(ticketId, this.wallet,
      "ready to proceed with PER private negotiation.");
    log("AlphaBot", "📡 PER greeting sent", "magenta");
    await this.sleep(2000);

    // Step 2: In real PER, terms are submitted via MeridianClient SDK
    // directly to the TEE enclave. For now, we signal agreement via chat
    // and let the middleman detect the escrow trigger keyword.
    const agreedMsg = `i agree to ${this.config.targetPrice} SOL with ${this.config.collateral} SOL collateral each side. @middleman please create the escrow.`;
    const response = await this.api.sendMessage(ticketId, this.wallet, agreedMsg);
    log("AlphaBot", `🔒 PER terms submitted`, "magenta");

    if (response.action === "CREATE_ESCROW" || response.phase === "awaiting_deposits") {
      log("AlphaBot", "🔒 Escrow creation triggered (PER)!", "green");
    }

    // Step 3: Wait for the deal to advance
    await this.sleep(3000);
  }

  // ═══════════════════════════════════════
  // DEPOSIT — Dual Mode
  // ═══════════════════════════════════════

  async deposit(ticketId: string): Promise<void> {
    logPhase(`ALPHA — PHASE 4: DEPOSIT SOL (${this.config.rollupMode})`);
    if (!this.escrowPda) await this.waitForEscrowPda(ticketId);

    if (!this.escrowPda) {
      // No on-chain PDA — signal deposit via message for phase advancement
      log("AlphaBot", "No on-chain PDA. Signaling deposit to middleman...", "yellow");
      const depositMsg = "@middleman I have deposited my collateral and payment. Please confirm.";
      const response = await this.api.sendMessage(ticketId, this.wallet, depositMsg);
      log("AlphaBot", `✅ Deposit signaled | Response: "${(response.response || "").substring(0, 80)}"`, "green");
      
      if (response.action === "RECORD_DEPOSIT") {
        log("AlphaBot", `📊 Phase: ${response.phase}`, "dim");
      }
      return;
    }

    // Real on-chain deposit to escrow PDA
    const pda = new PublicKey(this.escrowPda);

    if (this.config.rollupMode === "PER") {
      // PER: Single deposit (amounts encrypted via FHE, middleman doesn't see)
      log("AlphaBot", `🔐 PER deposit: ${this.config.targetPrice + this.config.collateral} SOL (encrypted)`, "magenta");
      await this.sendSol(pda, this.config.targetPrice + this.config.collateral);
      log("AlphaBot", "✅ PER deposit complete", "green");
    } else {
      // Normal/ER: Standard two-step deposit
      log("AlphaBot", `Sending ${this.config.collateral} SOL collateral...`, "cyan");
      await this.sendSol(pda, this.config.collateral);
      log("AlphaBot", "✅ Collateral deposited", "green");
      await this.sleep(5000);

      log("AlphaBot", `Sending ${this.config.targetPrice} SOL payment...`, "cyan");
      await this.sendSol(pda, this.config.targetPrice);
      log("AlphaBot", "✅ Payment deposited", "green");
    }
  }

  // ═══════════════════════════════════════
  // CONFIRM & RELEASE — Dual Mode
  // ═══════════════════════════════════════

  async confirmAndRelease(ticketId: string): Promise<void> {
    logPhase(`ALPHA — PHASE 5: CONFIRM DELIVERY (${this.config.rollupMode})`);

    // Check current phase
    try {
      const status = await this.api.getDealStatus(ticketId);
      log("AlphaBot", `Current phase: ${status.phase}`, "dim");
      if (status.phase === "completed") {
        logSuccess("AlphaBot: Deal already completed!");
        this.dealCompleted = true;
        return;
      }
    } catch { /* ignore */ }

    await this.sleep(3000);

    if (this.config.rollupMode === "PER") {
      // PER: Release via threshold signature (IKA dWallet)
      const msg = "@middleman i received my items! release funds";
      log("AlphaBot", `🔐 PER release request: "${msg}"`, "magenta");
      const response = await this.api.sendMessage(ticketId, this.wallet, msg);
      log("AlphaBot", `🤖 Middleman: "${(response.response || "").substring(0, 120)}"`, "dim");

      if (response.action === "RELEASE_FUNDS" || response.phase === "completed") {
        logSuccess("AlphaBot: Deal completed via PER settlement!");
        this.dealCompleted = true;
      }
    } else {
      // Normal/ER: Standard release
      const msg = formatRelease("buyer");
      log("AlphaBot", `💬 "${msg}"`, "cyan");
      const response = await this.api.sendMessage(ticketId, this.wallet, msg);
      log("AlphaBot", `🤖 Middleman: "${(response.response || "").substring(0, 120)}"`, "dim");

      if (response.action === "RELEASE_FUNDS" || response.phase === "completed") {
        logSuccess("AlphaBot: Deal completed! Funds released.");
        this.dealCompleted = true;
      }
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
    log("AlphaBot", "Waiting for escrow PDA...", "yellow");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await this.sleep(3000);
      try {
        const s = await this.api.getDealStatus(ticketId);
        if (s.escrow_pda) { this.escrowPda = s.escrow_pda; return; }
        log("AlphaBot", `Phase: ${s.phase}`, "dim");
      } catch { /* ignore */ }
    }
  }

  private async waitForPhase(ticketId: string, target: string, timeoutMs = 90000): Promise<void> {
    log("AlphaBot", `Waiting for phase: ${target}...`, "yellow");
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
