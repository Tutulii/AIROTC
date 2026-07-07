import { eventBus } from "../src/services/eventBus";

/**
 * Deal Phase Manager
 *
 * State machine managing the deal lifecycle.
 *
 * Phases:
 *   Normal: negotiation → escrow_created → awaiting_deposits → delivery → completed
 *   SPORT:  negotiation → escrow_created → awaiting_deposits → awaiting_result → completed/refunded
 *
 * Now accepts MiddlemanAction from the brain (NLP-based),
 * NOT rigid CommandType patterns.
 * 
 * [L3 ASYNC UPDATE]: Fully handles async Promise<MiddlemanMessage> generative responses.
 */

import { MiddlemanAction } from "./middlemanBrain";
import {
  MiddlemanMessage,
  DealTerms,
  dealCreatedMessage,
  depositInstructionMessage,
  depositsReceivedMessage,
  releaseQueuedMessage,
  disputeOpenedMessage,
  dealCancelledMessage,
  statusMessage,
  errorMessage,
  invalidCommandMessage,
} from "./outboundMessenger";
import { adjudicateDispute } from "./aiJudge";
import { vectorMemoryStore } from "../src/state/vectorMemoryStore";
import { dealTracker } from "../src/state/dealTracker";
import { logger } from "../src/utils/logger";
import { prisma } from "../src/lib/prisma";
import { appendAuditLog } from "../src/services/auditTrail";
import { PublicKey } from "@solana/web3.js";

function toNumber(value: unknown, field: string): number {
  if (typeof value === "number") {
    return value;
  }
  if (value && typeof (value as { toNumber?: () => number }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`deal_phase_manager_invalid_numeric_field:${field}`);
  }
  return parsed;
}

// ==========================================
// TYPES
// ==========================================

export type DealPhase =
  | "negotiation"
  | "escrow_created"
  | "awaiting_deposits"
  | "delivery"
  | "awaiting_result"
  | "awaiting_release"
  | "completed"
  | "disputed"
  | "cancelled"
  | "refunded";

export interface DealState {
  ticket_id: string;
  phase: DealPhase;
  buyer: string;
  seller: string;
  terms: DealTerms | null;
  escrow_pda: string | null;
  created_at: string;
  updated_at: string;
  buyer_deposited: boolean;
  seller_deposited: boolean;
  payment_locked: boolean;
  history: PhaseTransition[];
}

export interface PhaseTransition {
  from: DealPhase;
  to: DealPhase;
  triggered_by: string;
  action: MiddlemanAction | "AUTO";
  timestamp: string;
}

export interface ActionResult {
  success: boolean;
  response: MiddlemanMessage;
  new_phase?: DealPhase;
  on_chain_action?: string;
  tx?: string;
  splitRatios?: { buyerRefundPercent: number; sellerReleasePercent: number; };
}

function looksLikeAgentId(identity: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity);
}

async function resolveWalletIdentity(identity: string): Promise<string> {
  if (!looksLikeAgentId(identity)) {
    return identity;
  }

  const agentDelegate = (prisma as any).agent;
  if (!agentDelegate?.findUnique) {
    return identity;
  }

  const agent = await agentDelegate.findUnique({ where: { id: identity } }).catch(() => null);
  return agent?.wallet || identity;
}

async function identitiesMatch(left: string, right: string): Promise<boolean> {
  if (left === right) {
    return true;
  }

  const [leftWallet, rightWallet] = await Promise.all([
    resolveWalletIdentity(left),
    resolveWalletIdentity(right),
  ]);
  return leftWallet === rightWallet;
}

type OnChainDealSnapshot = {
  phase: DealPhase | null;
  buyerDeposited: boolean;
  sellerDeposited: boolean;
  paymentLocked: boolean;
};

function mapOnChainStatusToPhase(status: string | undefined): DealPhase | null {
  switch (status) {
    case "created":
      return "escrow_created";
    case "collateralLocked":
    case "paymentLocked":
      return "delivery";
    case "completed":
      return "completed";
    case "refunded":
      return "refunded";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

async function readOnChainDealSnapshot(escrowPda: string | null): Promise<OnChainDealSnapshot | null> {
  if (!escrowPda) {
    return null;
  }

  try {
    const { getAnchorProgram } = await import("../src/services/onChainExecutionService");
    const { program } = getAnchorProgram();
    const account = await (program.account as any).deal.fetch(new PublicKey(escrowPda));
    const status = Object.keys(account.status || {})[0];
    const terminalStatus = status === "completed" || status === "refunded" || status === "cancelled";
    return {
      phase: mapOnChainStatusToPhase(status),
      buyerDeposited: Boolean(account.buyerCollateralLocked),
      sellerDeposited: Boolean(account.sellerCollateralLocked),
      paymentLocked: terminalStatus ? false : Boolean(account.paymentLocked),
    };
  } catch (error: any) {
    logger.warn("deal_phase_onchain_reconcile_failed", {
      escrowPda,
      error: error?.message || String(error),
    });
    return null;
  }
}

// ==========================================
// DEAL PHASE MANAGER
// ==========================================

class DealPhaseManager {
  private deals: Map<string, DealState> = new Map();

  // ── INITIALIZATION ──

  public initDeal(ticket_id: string, buyer: string, seller: string): DealState {
    const state: DealState = {
      ticket_id,
      phase: "negotiation",
      buyer,
      seller,
      terms: null,
      escrow_pda: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      buyer_deposited: false,
      seller_deposited: false,
      payment_locked: false,
      history: [],
    };
    this.deals.set(ticket_id, state);
    this.persistDeal(state).catch((e: any) => logger.error("persist_init_failed", { ticket_id }, e));
    appendAuditLog(ticket_id, "deal_initialized", { buyer, seller, phase: "negotiation" });
    logger.info("deal_lifecycle_started", { ticket_id, phase: "negotiation" });
    return state;
  }

  public getDeal(ticket_id: string): DealState | null {
    const memDeal = this.deals.get(ticket_id);
    if (memDeal) return memDeal;
    return null;
  }

  public async upsertNegotiationTerms(
    ticket_id: string,
    buyer: string,
    seller: string,
    terms: DealTerms
  ): Promise<DealState> {
    const deal = (await this.getDealWithFallback(ticket_id)) || this.initDeal(ticket_id, buyer, seller);

    deal.buyer = deal.buyer || buyer;
    deal.seller = deal.seller || seller;
    deal.terms = terms;
    deal.updated_at = new Date().toISOString();

    await this.persistDeal(deal);
    appendAuditLog(ticket_id, "deal_terms_upserted", {
      price: terms.price,
      collateral_buyer: terms.collateral_buyer,
      collateral_seller: terms.collateral_seller,
      asset_type: terms.asset_type ?? "unknown",
    });

    return deal;
  }

  /**
   * Async getDeal with DB fallback. When in-memory state is lost (e.g., after restart),
   * reconstructs DealState from the persisted Deal record in PostgreSQL.
   */
  public async getDealWithFallback(ticket_id: string): Promise<DealState | null> {
    const memDeal = this.deals.get(ticket_id);
    if (memDeal) return memDeal;

    // DB fallback: reconstruct from DealPhaseState (primary) then Deal (legacy)
    try {
      const phaseState = await prisma.dealPhaseState.findUnique({ where: { ticketId: ticket_id } });
      if (phaseState) {
        const reconstructed: DealState = {
          ticket_id,
          phase: phaseState.phase as DealPhase,
          buyer: phaseState.buyer,
          seller: phaseState.seller,
          terms: phaseState.termsPrice ? {
            price: toNumber(phaseState.termsPrice, "termsPrice"),
            collateral_buyer: toNumber(phaseState.termsColBuyer, "termsColBuyer"),
            collateral_seller: toNumber(phaseState.termsColSeller, "termsColSeller"),
            asset_type: phaseState.termsAssetType ?? undefined,
          } : null,
          escrow_pda: phaseState.escrowPda,
          created_at: phaseState.createdAt.toISOString(),
          updated_at: phaseState.updatedAt.toISOString(),
          buyer_deposited: phaseState.buyerDeposited,
          seller_deposited: phaseState.sellerDeposited,
          payment_locked: phaseState.paymentLocked,
          history: JSON.parse(phaseState.historyJson || "[]"),
        };
        await this.reconcileDealWithChain(reconstructed);
        this.deals.set(ticket_id, reconstructed);
        logger.info("deal_phase_restored_from_phase_state", { ticket_id, phase: reconstructed.phase });
        return reconstructed;
      }

      // Legacy fallback: Deal table (without deposit flags/history)
      const dbDeal = await dealTracker.getDealByTicket(ticket_id);
      if (!dbDeal) return null;

      const deal = dbDeal as any;
      const reconstructed: DealState = {
        ticket_id,
        phase: this.mapStatusToPhase(deal.status),
        buyer: deal.buyerId || "unknown",
        seller: deal.sellerId || "unknown",
        terms: {
          price: deal.price,
          collateral_buyer: deal.collateralBuyer,
          collateral_seller: deal.collateralSeller,
        },
        escrow_pda: deal.dealIdOnChain || null,
        created_at: deal.createdAt?.toISOString?.() || new Date().toISOString(),
        updated_at: deal.createdAt?.toISOString?.() || new Date().toISOString(),
        buyer_deposited: false,
        seller_deposited: false,
        payment_locked: false,
        history: [],
      };

      await this.reconcileDealWithChain(reconstructed);
      this.deals.set(ticket_id, reconstructed);
      logger.info("deal_phase_restored_from_deal_table", { ticket_id, phase: reconstructed.phase });
      return reconstructed;
    } catch (e: any) {
      logger.error("deal_phase_db_fallback_failed", { ticket_id }, e);
      return null;
    }
  }

  private mapStatusToPhase(status: string): DealPhase {
    const mapping: Record<string, DealPhase> = {
      created: "escrow_created",
      collateral_locked: "awaiting_deposits",
      payment_locked: "delivery",
      awaiting_result: "awaiting_result",
      completed: "completed",
      refunded: "refunded",
      cancelled: "cancelled",
      pending_execution: "negotiation",
      failed: "cancelled",
    };
    return mapping[status] || "negotiation";
  }

  // ── HANDLE ACTION FROM BRAIN ──

  /**
   * Process a MiddlemanAction (produced by the brain's NLP analysis).
   * Now ASYNC to await generative LLM message bodies.
   */
  public async handleAction(
    action: MiddlemanAction,
    ticket_id: string,
    sender: string,
    terms?: DealTerms,
    reasoning?: string
  ): Promise<ActionResult> {
    let deal = this.deals.get(ticket_id);
    if (!deal) {
      // Self-healing: reconstruct correct identities from ticket record
      const { ticketStore } = await import("../src/state/ticketStore");
      const { walletRegistry } = await import("../src/state/walletRegistry");

      let resolvedBuyer = sender;
      let resolvedSeller = "unknown_seller";

      try {
        const ticket = await ticketStore.getTicket(ticket_id);
        if (ticket) {
          if (ticket.buyer && ticket.buyer !== "pending") {
            const b = await walletRegistry.getOrCreateAgent(ticket.buyer);
            resolvedBuyer = b.id;
          }
          if (ticket.seller && ticket.seller !== "pending") {
            const s = await walletRegistry.getOrCreateAgent(ticket.seller);
            resolvedSeller = s.id;
          }
        }
      } catch (err) {
        logger.warn("self_heal_identity_resolution_failed", { ticket_id }, err);
      }

      deal = this.initDeal(ticket_id, resolvedBuyer, resolvedSeller);
    }

    switch (action) {
      case "CREATE_ESCROW":
        return await this.handleCreateEscrow(deal, sender, terms);
      case "RELEASE_FUNDS":
        return await this.handleReleaseFunds(deal, sender);
      case "CANCEL_DEAL":
        return await this.handleCancel(deal, sender);
      case "DISPUTE":
        return await this.handleDispute(deal, sender);
      case "REPORT_STATUS":
        return await this.handleStatus(deal);
      case "RESPOND_GENERAL":
        console.log("!!! RESPOND_GENERAL TRIGGERED! Reasoning received:", reasoning);
        return {
          success: true,
          response: reasoning ? {
            ticket_id: deal.ticket_id,
            content: reasoning,
            phase: deal.phase,
            timestamp: new Date().toISOString()
          } : await statusMessage(deal.ticket_id, deal.phase, deal.terms || undefined),
        };
      default:
        return {
          success: true,
          response: await statusMessage(deal.ticket_id, deal.phase, deal.terms || undefined),
        };
    }
  }

  // ── PHASE HANDLERS ──

  private async handleCreateEscrow(deal: DealState, sender: string, terms?: DealTerms): Promise<ActionResult> {
    if (deal.phase !== "negotiation") {
      return {
        success: false,
        response: await invalidCommandMessage(deal.ticket_id,
          `Deal already in phase "${deal.phase}". Cannot create escrow again.`),
      };
    }

    if (
      !terms ||
      !Number.isFinite(terms.price) ||
      terms.price <= 0 ||
      !Number.isFinite(terms.collateral_buyer) ||
      terms.collateral_buyer < 0 ||
      !Number.isFinite(terms.collateral_seller) ||
      terms.collateral_seller < 0
    ) {
      return {
        success: false,
        response: await errorMessage(deal.ticket_id,
          "Cannot create escrow — no complete terms found. Need price, buyer collateral, and seller collateral."),
      };
    }

    deal.terms = terms;

    // Persist deal creation before status updates
    try {
      await dealTracker.initDeal({
        ticketId: deal.ticket_id,
        buyerId: deal.buyer,
        sellerId: deal.seller,
        middlemanId: "system",
        price: terms.price,
        collateralBuyer: terms.collateral_buyer,
        collateralSeller: terms.collateral_seller,
        timeout: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      });
    } catch (e: any) {
      logger.error("deal_init_persist_failed", e);
    }

    this.transition(deal, "escrow_created", sender, "CREATE_ESCROW");

    logger.info("deal_started", { ticket_id: deal.ticket_id, terms, triggered_by: sender });

    return {
      success: true,
      response: await dealCreatedMessage(
        deal.ticket_id,
        terms,
        deal.escrow_pda || undefined,
        { sport: await this.isSportTicket(deal.ticket_id) },
      ),
      new_phase: "escrow_created",
      on_chain_action: "create_deal",
    };
  }

  private async handleReleaseFunds(deal: DealState, sender: string): Promise<ActionResult> {
    if (deal.phase !== "delivery" && deal.phase !== "awaiting_release") {
      return {
        success: false,
        response: await invalidCommandMessage(deal.ticket_id,
          `Cannot release in phase "${deal.phase}". Seller must deliver first.`),
      };
    }

    if (!(await identitiesMatch(sender, deal.buyer))) {
      return {
        success: false,
        response: await invalidCommandMessage(deal.ticket_id,
          "Only the buyer can confirm receipt and release funds."),
      };
    }

    if (!deal.terms) {
      return { success: false, response: await errorMessage(deal.ticket_id, "No deal terms found.") };
    }

    if (!deal.buyer_deposited || !deal.seller_deposited || !deal.payment_locked) {
      return {
        success: false,
        response: await invalidCommandMessage(
          deal.ticket_id,
          "Cannot release funds before buyer collateral, seller collateral, and payment are all confirmed on-chain."
        ),
      };
    }

    if (deal.phase !== "awaiting_release") {
      this.transition(deal, "awaiting_release", sender, "RELEASE_FUNDS");
    }
    logger.info("release_authorized", { ticket_id: deal.ticket_id, released_by: sender });

    return {
      success: true,
      response: await releaseQueuedMessage(deal.ticket_id, deal.terms),
      new_phase: "awaiting_release",
      on_chain_action: "release_funds",
    };
  }

  private async handleDispute(deal: DealState, sender: string): Promise<ActionResult> {
    const terminalPhases: DealPhase[] = ["negotiation", "completed", "cancelled", "refunded"];
    if (terminalPhases.includes(deal.phase)) {
      return {
        success: false,
        response: await invalidCommandMessage(deal.ticket_id,
          `Cannot dispute in phase "${deal.phase}".`),
      };
    }

    this.transition(deal, "disputed", sender, "DISPUTE");
    logger.info("deal_disputed", { ticket_id: deal.ticket_id, disputed_by: sender });

    // FIX 3: Immediately Autonomously Adjudicate using RAG inside aiJudge
    const verdict = await adjudicateDispute(deal.ticket_id, deal.terms);

    // Apply the verdict autonomously
    if (verdict.action === "CANCEL_DEAL") {
      this.transition(deal, "cancelled", "ai_judge", "CANCEL_DEAL");
      logger.info("ai_judge_cancelled_deal", { ticket_id: deal.ticket_id, reason: verdict.verdictReasoning });

      return {
        success: true,
        new_phase: "cancelled",
        on_chain_action: "cancel_deal",
        response: {
          ticket_id: deal.ticket_id,
          phase: "cancelled",
          content: `🏛️ **AI JUDGE VERDICT** 🏛️\n\n**Decision:** CANCEL DEAL\n**Reasoning:** ${verdict.verdictReasoning}\n\n*The escrow is dynamically refunding both parties to secure funds.*`,
          timestamp: new Date().toISOString(),
        }
      };
    } else if (verdict.action === "FRACTIONAL_SPLIT") {
      this.transition(deal, "completed", "ai_judge", "FRACTIONAL_SPLIT");
      logger.info("ai_judge_fractional_split", { ticket_id: deal.ticket_id, reason: verdict.verdictReasoning });

      return {
        success: true,
        new_phase: "completed",
        on_chain_action: "fractional_split_funds",
        splitRatios: verdict.splitRatios,
        response: {
          ticket_id: deal.ticket_id,
          phase: "completed",
          content: `⚖️ **AI JUDGE VERDICT: FRACTIONAL SPLIT** ⚖️\n\n**Reasoning:** ${verdict.verdictReasoning}\n\n**Split:** ${verdict.splitRatios?.buyerRefundPercent}% to Buyer, ${verdict.splitRatios?.sellerReleasePercent}% to Seller.\n\n*The escrow is dynamically distributing the funds according to this split.*`,
          timestamp: new Date().toISOString(),
        }
      };
    } else {
      this.transition(deal, "completed", "ai_judge", "RELEASE_FUNDS");
      logger.info("ai_judge_released_funds", { ticket_id: deal.ticket_id, reason: verdict.verdictReasoning });

      return {
        success: true,
        new_phase: "completed",
        on_chain_action: "release_funds",
        response: {
          ticket_id: deal.ticket_id,
          phase: "completed",
          content: `🏛️ **AI JUDGE VERDICT** 🏛️\n\n**Decision:** FORCE RELEASE FUNDS\n**Reasoning:** ${verdict.verdictReasoning}\n\n*The escrow is actively routing the locked payouts.*`,
          timestamp: new Date().toISOString(),
        }
      };
    }
  }

  private async handleCancel(deal: DealState, sender: string): Promise<ActionResult> {
    const terminalPhases: DealPhase[] = ["completed", "cancelled", "refunded"];
    if (terminalPhases.includes(deal.phase)) {
      return {
        success: false,
        response: await invalidCommandMessage(deal.ticket_id,
          `Deal is already ${deal.phase}. Cannot cancel.`),
      };
    }

    const previousPhase = deal.phase;
    this.transition(deal, "cancelled", sender, "CANCEL_DEAL");
    logger.info("deal_cancelled", { ticket_id: deal.ticket_id, cancelled_by: sender });

    return {
      success: true,
      response: await dealCancelledMessage(deal.ticket_id, sender),
      new_phase: "cancelled",
      on_chain_action: previousPhase !== "negotiation" ? "cancel_deal" : undefined,
    };
  }

  private async handleStatus(deal: DealState): Promise<ActionResult> {
    return {
      success: true,
      response: await statusMessage(deal.ticket_id, deal.phase, deal.terms || undefined),
    };
  }

  // ── DEPOSIT TRACKING ──

  private async isSportTicket(ticket_id: string): Promise<boolean> {
    try {
      const { ticketStore } = await import("../src/state/ticketStore");
      const ticket = await ticketStore.getTicket(ticket_id);
      if (ticket?.rollup_mode === "SPORT") return true;
    } catch {
      // Fall through to Prisma if the local ticket store is unavailable.
    }

    try {
      const ticketDelegate = (prisma as any).ticket;
      if (!ticketDelegate?.findUnique) return false;
      const ticket = await ticketDelegate.findUnique({
        where: { id: ticket_id },
        select: { rollupMode: true },
      });
      return ticket?.rollupMode === "SPORT";
    } catch {
      return false;
    }
  }

  public async recordDeposit(ticket_id: string, party: "buyer" | "seller"): Promise<ActionResult | null> {
    const deal = this.deals.get(ticket_id);
    if (!deal) return null;
    const isSport = await this.isSportTicket(ticket_id);

    if (!deal.escrow_pda) {
      appendAuditLog(ticket_id, "deposit_blocked_missing_escrow", { party, phase: deal.phase });
      logger.warn("deposit_blocked_missing_escrow", { ticket_id, party, phase: deal.phase });
      return {
        success: false,
        response: await invalidCommandMessage(
          ticket_id,
          "Cannot record deposits before the on-chain escrow address exists."
        ),
      };
    }

    if (deal.phase !== "awaiting_deposits" && deal.phase !== "delivery" && deal.phase !== "awaiting_result") {
      appendAuditLog(ticket_id, "deposit_blocked_invalid_phase", { party, phase: deal.phase });
      logger.warn("deposit_blocked_invalid_phase", { ticket_id, party, phase: deal.phase });
      return {
        success: false,
        response: await invalidCommandMessage(
          ticket_id,
          `Cannot record deposits in phase "${deal.phase}".`
        ),
      };
    }

    if ((party === "buyer" && deal.buyer_deposited) || (party === "seller" && deal.seller_deposited)) {
      const targetPhase = isSport ? "awaiting_result" : "delivery";
      if (deal.buyer_deposited && deal.seller_deposited && deal.payment_locked && deal.phase !== targetPhase) {
        this.transition(deal, targetPhase, "system", "AUTO");
        this.persistDeal(deal).catch((e: any) => logger.error("persist_deposit_heal_failed", { ticket_id }, e));
      }
      logger.info("deposit_recorded_idempotent_skip", { ticket_id, party });
      return null;
    }

    if (party === "buyer") deal.buyer_deposited = true;
    else deal.seller_deposited = true;

    // Persist deposit flag immediately
    this.persistDeal(deal).catch((e: any) => logger.error("persist_deposit_failed", { ticket_id }, e));
    appendAuditLog(ticket_id, "deposit_recorded", { party, buyer: deal.buyer_deposited, seller: deal.seller_deposited });

    logger.info("deposit_recorded", {
      ticket_id, party,
      buyer: deal.buyer_deposited, seller: deal.seller_deposited,
    });

    if (deal.buyer_deposited && deal.seller_deposited) {
      if (isSport && !deal.payment_locked) {
        logger.info("sport_stakes_waiting_for_payment_lock", { ticket_id });
        return null;
      }
      deal.payment_locked = true;
      const targetPhase = isSport ? "awaiting_result" : "delivery";
      if (deal.phase !== targetPhase) {
        this.transition(deal, targetPhase, "system", "AUTO");
      }
      logger.info("payment_locked_on_dual_deposit", { ticket_id });
      return {
        success: true,
        response: await depositsReceivedMessage(ticket_id, targetPhase),
        new_phase: targetPhase,
      };
    }
    return null;
  }

  public async recordPaymentLocked(ticket_id: string): Promise<ActionResult | null> {
    const deal = await this.getDealWithFallback(ticket_id);
    if (!deal) return null;

    const isSport = await this.isSportTicket(ticket_id);
    const targetPhase: DealPhase = isSport ? "awaiting_result" : "delivery";
    deal.payment_locked = true;

    if (!deal.buyer_deposited || !deal.seller_deposited) {
      this.persistDeal(deal).catch((e: any) => logger.error("persist_payment_lock_partial_failed", { ticket_id }, e));
      logger.info("payment_locked_waiting_for_deposit_flags", {
        ticket_id,
        isSport,
        buyer: deal.buyer_deposited,
        seller: deal.seller_deposited,
      });
      return null;
    }

    if (deal.phase !== targetPhase) {
      this.transition(deal, targetPhase, "system", "AUTO");
      logger.info(isSport ? "sport_escrow_awaiting_result" : "deal_fully_funded", {
        ticket_id,
        targetPhase,
      });
      return {
        success: true,
        response: await depositsReceivedMessage(ticket_id, targetPhase),
        new_phase: targetPhase,
      };
    }

    this.persistDeal(deal).catch((e: any) => logger.error("persist_payment_lock_failed", { ticket_id }, e));
    return null;
  }

  public setEscrowPda(ticket_id: string, pda: string): void {
    const deal = this.deals.get(ticket_id);
    if (deal) {
      deal.escrow_pda = pda;
      deal.updated_at = new Date().toISOString();
      this.persistDeal(deal).catch((e: any) => logger.error("persist_pda_failed", { ticket_id }, e));
      appendAuditLog(ticket_id, "escrow_pda_set", { pda });
    }
  }

  public async advanceToAwaitingDeposits(ticket_id: string): Promise<ActionResult | null> {
    const deal = this.deals.get(ticket_id);
    if (!deal || deal.phase !== "escrow_created") return null;
    if (!deal.terms) return null;

    if (!deal.escrow_pda) {
      appendAuditLog(ticket_id, "awaiting_deposits_blocked_missing_escrow", { phase: deal.phase });
      logger.warn("awaiting_deposits_blocked_missing_escrow", { ticket_id, phase: deal.phase });
      return {
        success: false,
        response: await invalidCommandMessage(
          ticket_id,
          "Cannot move to awaiting deposits until the on-chain escrow address exists."
        ),
      };
    }

    this.transition(deal, "awaiting_deposits", "system", "AUTO");
    return {
      success: true,
      response: await depositInstructionMessage(
        ticket_id,
        deal.terms,
        deal.escrow_pda,
        { sport: await this.isSportTicket(ticket_id) },
      ),
      new_phase: "awaiting_deposits",
    };
  }

  // ── INTERNAL ──

  private async reconcileDealWithChain(deal: DealState): Promise<void> {
    const snapshot = await readOnChainDealSnapshot(deal.escrow_pda);
    if (!snapshot) {
      return;
    }

    const previousPhase = deal.phase;
    const isSport = await this.isSportTicket(deal.ticket_id);
    const reconciledPhase =
      isSport && snapshot.phase === "delivery" && snapshot.paymentLocked
        ? "awaiting_result"
        : snapshot.phase;
    const phaseChanged = Boolean(reconciledPhase && reconciledPhase !== deal.phase);
    const flagsChanged =
      deal.buyer_deposited !== snapshot.buyerDeposited ||
      deal.seller_deposited !== snapshot.sellerDeposited ||
      deal.payment_locked !== snapshot.paymentLocked;

    deal.buyer_deposited = snapshot.buyerDeposited;
    deal.seller_deposited = snapshot.sellerDeposited;
    deal.payment_locked = snapshot.paymentLocked;

    if (reconciledPhase && reconciledPhase !== deal.phase) {
      this.transition(deal, reconciledPhase, "on_chain_reconcile", "AUTO");
    }

    if (phaseChanged || flagsChanged) {
      await this.persistDeal(deal).catch((e: any) =>
        logger.error("persist_onchain_reconcile_failed", { ticket_id: deal.ticket_id }, e)
      );
      logger.warn("deal_phase_reconciled_from_onchain", {
        ticket_id: deal.ticket_id,
        from: previousPhase,
        to: deal.phase,
        buyerDeposited: deal.buyer_deposited,
        sellerDeposited: deal.seller_deposited,
        paymentLocked: deal.payment_locked,
      });
    }
  }

  public transition(
    deal: DealState,
    newPhase: DealPhase,
    triggered_by: string,
    action: MiddlemanAction | "AUTO"
  ): void {
    const from = deal.phase;
    deal.phase = newPhase;
    deal.updated_at = new Date().toISOString();
    deal.history.push({ from, to: newPhase, triggered_by, action, timestamp: deal.updated_at });
    logger.info("phase_transition", { ticket_id: deal.ticket_id, from, to: newPhase, triggered_by, action });

    // ★ CRITICAL: Publish phase_changed to eventBus so outboundRouter delivers to agents
    eventBus.publish("phase_changed", {
      ticket_id: deal.ticket_id,
      from_phase: from,
      to_phase: newPhase,
      triggered_by,
      action: action as MiddlemanAction,
    });

    // Persist phase transition to DealPhaseState (primary) + Deal table (legacy)
    this.persistDeal(deal).catch((e: any) => logger.error("phase_persist_failed", { ticket_id: deal.ticket_id }, e));
    appendAuditLog(deal.ticket_id, "phase_transition", { from, to: newPhase, triggered_by, action });

    const dbStatus = this.phaseToStatus(newPhase);
    dealTracker.updateStatus(deal.ticket_id, dbStatus).catch((e: any) => {
      logger.error("phase_transition_persist_failed", { ticket_id: deal.ticket_id }, e);
    });
  }

  private phaseToStatus(phase: DealPhase): string {
    const mapping: Record<DealPhase, string> = {
      negotiation: "pending_execution",
      escrow_created: "created",
      awaiting_deposits: "collateral_locked",
      delivery: "payment_locked",
      awaiting_result: "payment_locked",
      awaiting_release: "payment_locked",
      completed: "completed",
      disputed: "disputed",
      cancelled: "cancelled",
      refunded: "refunded",
    };
    return mapping[phase] || phase;
  }

  // ── ACCESSORS ──

  public getPhase(ticket_id: string): DealPhase | null {
    return this.deals.get(ticket_id)?.phase || null;
  }

  /**
   * Async phase lookup with DB fallback.
   */
  public async getPhaseWithFallback(ticket_id: string): Promise<DealPhase | null> {
    const deal = await this.getDealWithFallback(ticket_id);
    return deal?.phase || null;
  }

  public getTerms(ticket_id: string): DealTerms | null {
    return this.deals.get(ticket_id)?.terms || null;
  }

  public listActiveDeals(): DealState[] {
    const terminal: DealPhase[] = ["completed", "cancelled", "refunded"];
    return Array.from(this.deals.values()).filter((d) => !terminal.includes(d.phase));
  }

  public async syncTerminalPhaseFromExecutionStatus(
    ticket_id: string,
    status: string
  ): Promise<void> {
    const phaseMap: Record<string, DealPhase> = {
      settled: "completed",
      completed: "completed",
      confidential_completed: "completed",
      cancelled: "cancelled",
      refunded: "refunded",
      disputed: "disputed",
      failed: "disputed",
    };

    const targetPhase = phaseMap[status];
    if (!targetPhase) {
      return;
    }

    const deal = await this.getDealWithFallback(ticket_id);
    if (!deal) {
      logger.warn("deal_phase_terminal_sync_skipped", {
        ticket_id,
        status,
        reason: "deal_not_found",
      });
      return;
    }

    if (targetPhase === "completed" || targetPhase === "cancelled" || targetPhase === "refunded") {
      deal.payment_locked = false;
    }

    if (deal.phase === targetPhase) {
      await this.persistDeal(deal);
      return;
    }

    this.transition(deal, targetPhase, "system", "AUTO");
  }

  // ── DB PERSISTENCE (Level 5) ──

  /**
   * Persists the full DealState to the DealPhaseState table.
   * Called after every mutation (transition, deposit, PDA set, init).
   */
  /** Public wrapper for external callers (e.g. index.ts payment_locked update) */
  public persistDealPublic(deal: DealState): void {
    this.persistDeal(deal).catch((e: any) => logger.error("persist_public_failed", { ticket_id: deal.ticket_id }, e));
  }

  private async persistDeal(deal: DealState): Promise<void> {
    await prisma.dealPhaseState.upsert({
      where: { ticketId: deal.ticket_id },
      update: {
        phase: deal.phase,
        buyer: deal.buyer,
        seller: deal.seller,
        termsPrice: deal.terms?.price ?? null,
        termsColBuyer: deal.terms?.collateral_buyer ?? null,
        termsColSeller: deal.terms?.collateral_seller ?? null,
        termsAssetType: deal.terms?.asset_type ?? null,
        escrowPda: deal.escrow_pda,
        buyerDeposited: deal.buyer_deposited,
        sellerDeposited: deal.seller_deposited,
        paymentLocked: deal.payment_locked,
        historyJson: JSON.stringify(deal.history),
      },
      create: {
        ticketId: deal.ticket_id,
        phase: deal.phase,
        buyer: deal.buyer,
        seller: deal.seller,
        termsPrice: deal.terms?.price ?? null,
        termsColBuyer: deal.terms?.collateral_buyer ?? null,
        termsColSeller: deal.terms?.collateral_seller ?? null,
        termsAssetType: deal.terms?.asset_type ?? null,
        escrowPda: deal.escrow_pda,
        buyerDeposited: deal.buyer_deposited,
        sellerDeposited: deal.seller_deposited,
        paymentLocked: deal.payment_locked,
        historyJson: JSON.stringify(deal.history),
      },
    });
  }

  /**
   * Startup recovery: loads ALL active deal states from DealPhaseState table
   * into the in-memory Map. Called once during agent bootstrap.
   */
  public async recoverAllDeals(): Promise<number> {
    const rows = await prisma.dealPhaseState.findMany({
      where: { phase: { notIn: ["completed", "cancelled", "refunded"] } },
    });
    for (const row of rows) {
      const deal: DealState = {
        ticket_id: row.ticketId,
        phase: row.phase as DealPhase,
        buyer: row.buyer,
        seller: row.seller,
        terms: row.termsPrice
          ? {
            price: toNumber(row.termsPrice, "termsPrice"),
            collateral_buyer: toNumber(row.termsColBuyer, "termsColBuyer"),
            collateral_seller: toNumber(row.termsColSeller, "termsColSeller"),
            asset_type: row.termsAssetType ?? undefined,
          }
          : null,
        escrow_pda: row.escrowPda,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
        buyer_deposited: row.buyerDeposited,
        seller_deposited: row.sellerDeposited,
        payment_locked: row.paymentLocked,
        history: JSON.parse(row.historyJson || "[]"),
      };
      await this.reconcileDealWithChain(deal);
      this.deals.set(row.ticketId, deal);
    }
    logger.info("deal_phase_state_recovered", { count: rows.length });
    return rows.length;
  }
}

export const dealPhaseManager = new DealPhaseManager();
