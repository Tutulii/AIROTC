/**
 * Execution Service compatibility adapter.
 *
 * Called by src/index.ts when agreement_detected fires through the negotiation
 * pipeline. This module now delegates into the converged `dealPipeline`
 * instead of owning a separate settlement architecture.
 *
 * Current production route:
 *   1. Build the negotiation outcome
 *   2. Resolve unified route selection
 *   3. Dispatch through STANDARD or CONFIDENTIAL pipeline stages
 *   4. Let the active pipeline own funding, approvals, and release
 */

import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ticketStore } from "../state/ticketStore";
import { detectAgreement } from "../../services/agreementService";
import { executionStore } from "../state/executionStore";
import { dealTracker } from "../state/dealTracker";
import { walletRegistry } from "../state/walletRegistry";
import { eventBus } from "./eventBus";
import { logger } from "../utils/logger";
import { circuitBreaker } from "../utils/circuitBreaker";
import {
  executeCreateDealPhase,
  executeReleasePhase,
  executeFullDealLifecycle,
  getDealContext,
  AgreementResult,
  assertDealWithinLifetime,
} from "./onChainExecutionService";
import { watchForDeposits } from "../listeners/depositWatcher";
import { dealPhaseManager } from "../../core/dealPhaseManager";
import { createConnection } from "../solana/connection";
import { loadConfig } from "../config";
import { appendAuditLog } from "./auditTrail";
import { economicSafety } from "./economicSafety";
import { reputationEngine } from "./reputationEngine";
import { shouldEnforceReleaseLifetime } from "./releaseLifetimePolicy";

import { shutdownManager } from "../utils/shutdownManager";
import { getPrivacyStatus } from "./privacyService";
import { UMBRA_SUPPORTED_MINTS } from "./umbraService";
import { PublicKey } from "@solana/web3.js";
import {
  executeConfidentialDeal,
  initConfidentialEscrow,
  isConfidentialEscrowReady,
} from "./confidentialExecutionService";
import { dealPipeline } from "./dealPipeline";
import { inferNegotiationSource } from "./pipelineRouting";
/**
 * Execute a deal through the unified pipeline adapter.
 */
export async function executeDeal(ticket_id: string): Promise<void> {
  const executionLogger = logger.withContext({ ticket_id });
  executionLogger.info("executeDeal_invoked");

  if (!shutdownManager.canAcceptNewWork()) {
    executionLogger.warn("execution_aborted", { reason: "shutdown_in_progress", step: "executeDeal" });
    return;
  }

  if (circuitBreaker.isOpen()) {
    executionLogger.warn("execution_aborted", { reason: "circuit_breaker_open" });
    return;
  }

  const ticket = await ticketStore.getTicket(ticket_id);
  const agreement = await detectAgreement(ticket_id);

  if (!ticket) {
    executionLogger.error("execution_aborted", { reason: "ticket_not_found" });
    return;
  }

  const resolvedAgreement =
    agreement ||
    (ticket.agreed_terms
      ? {
          ticketId: ticket_id,
          price: ticket.agreed_terms.price,
          collateral_buyer: ticket.agreed_terms.collateral_buyer,
          collateral_seller: ticket.agreed_terms.collateral_seller,
          asset_type: ticket.agreed_terms.asset_type || ticket.tokenMint || "SOL",
          confidence: 100,
          buyer: ticket.buyer,
          seller: ticket.seller,
        }
      : null);

  if (!resolvedAgreement) {
    executionLogger.error("execution_aborted", { reason: "agreement_confidence_failed" });
    return;
  }

  try {
    const resolvedAssetType =
      ("asset_type" in resolvedAgreement ? resolvedAgreement.asset_type : undefined) ||
      ticket.tokenMint ||
      "SOL";

    const result = await dealPipeline.start({
      ticketId: ticket_id,
      buyer: ticket.buyer,
      seller: ticket.seller,
      price: resolvedAgreement.price,
      collateralBuyer: resolvedAgreement.collateral_buyer,
      collateralSeller: resolvedAgreement.collateral_seller,
      assetType: resolvedAssetType,
      tokenMint: ticket.tokenMint,
      decimals: ticket.decimals,
      confidence: resolvedAgreement.confidence,
      rollupMode: ticket.rollup_mode || "NONE",
      negotiationSource: inferNegotiationSource(ticket.rollup_mode || "NONE"),
    });

    if (!result.success) {
      executionLogger.error("deal_execution_failed", {
        step: "deal_pipeline_dispatch",
        error_message: result.error,
      });
    }
  } catch (error: any) {
    executionLogger.error("deal_execution_failed", { step: "deal_pipeline_dispatch" }, error);
  }
}

/**
 * Execute the release phase (Phase 2).
 * Called when buyer confirms receipt via NLP → RELEASE_FUNDS action.
 */
export async function executeRelease(ticket_id: string): Promise<void> {
  const executionLogger = logger.withContext({ ticket_id });
  executionLogger.info("executeRelease_invoked");

  if (!shutdownManager.canAcceptNewWork()) {
    executionLogger.warn("execution_aborted", { reason: "shutdown_in_progress", step: "executeRelease" });
    return;
  }

  const canExecute = await executionStore.beginExecution(ticket_id, "release_funds");
  if (!canExecute) {
    executionLogger.info("duplicate_execution_blocked", { step: "release_funds" });
    return;
  }

  try {
    // Deal TTL check before release — handle timeout distinctly from execution failure
    const deal = await dealPhaseManager.getDealWithFallback(ticket_id);
    if (deal && shouldEnforceReleaseLifetime(deal)) {
      try {
        assertDealWithinLifetime(deal.created_at, ticket_id);
      } catch (lifetimeError: any) {
        await executionStore.markFailed(ticket_id, "release_funds");
        await dealTracker.updateStatus(ticket_id, "timed_out", lifetimeError.message);
        appendAuditLog(ticket_id, "deal_timed_out", { error: lifetimeError.message });
        executionLogger.warn("deal_timed_out", { step: "release_funds", error_message: lifetimeError.message });
        return;
      }
    } else if (deal) {
      executionLogger.info("release_lifetime_check_bypassed", {
        reason: "payment_locked_buyer_release",
        payment_locked: deal.payment_locked,
      });
    }

    const result = await executeReleasePhase(ticket_id);

    if (result.success) {
      await executionStore.markSuccess(ticket_id, "release_funds", result.tx || "unknown_tx");
      await dealTracker.updateStatus(ticket_id, "completed");
      appendAuditLog(ticket_id, "funds_released", { tx: result.tx });

      // LEVEL 5: Reputation reward for both parties
      const ticket = await ticketStore.getTicket(ticket_id);
      if (ticket) {
        reputationEngine.recordCompletion(ticket.buyer).catch(() => { });
        reputationEngine.recordCompletion(ticket.seller).catch(() => { });
      }

      executionLogger.info("deal_execution_step_success", {
        step: "release_phase_complete",
        tx: result.tx,
      });

      eventBus.publish("deal_executed", {
        ticket_id,
        status: "completed",
      });
    } else {
      await executionStore.markFailed(ticket_id, "release_funds");
      await dealTracker.updateStatus(ticket_id, "failed", result.error);
      appendAuditLog(ticket_id, "release_failed", { error: result.error });

      // LEVEL 5: Reputation penalty for both parties
      const ticket = await ticketStore.getTicket(ticket_id);
      if (ticket) {
        reputationEngine.recordFailure(ticket.buyer).catch(() => { });
        reputationEngine.recordFailure(ticket.seller).catch(() => { });
      }

      executionLogger.error("deal_execution_failed", { step: "release_phase_failed", error_message: result.error });
    }
  } catch (error) {
    await executionStore.markFailed(ticket_id, "release_funds");
    await dealTracker.updateStatus(ticket_id, "failed", String(error));
    executionLogger.error("deal_execution_failed", { step: "release_phase_failed" }, error);
  }
}
