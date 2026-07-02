import { PublicKey } from "@solana/web3.js";
import { loadConfig, type AgentConfig } from "../config";
import { ticketStore } from "../state/ticketStore";
import { pipelineStateStore } from "../state/pipelineStateStore";
import { dealTracker } from "../state/dealTracker";
import { privateEscrowIntentStore } from "../state/privateEscrowIntentStore";
import { logger } from "../utils/logger";
import { getPrivacyStatus, type PrivacyStatus } from "./privacyService";
import { eventBus } from "./eventBus";
import { appendAuditLog } from "./auditTrail";
import {
  executeCreateDealPhase,
  type AgreementResult,
} from "./onChainExecutionService";
import {
  executeConfidentialDeal,
  authorizeConfidentialRelease,
  executeConfidentialRelease,
  prepareConfidentialSettlementAfterFunding,
  initConfidentialEscrow,
  isConfidentialEscrowReady,
  type ConfidentialExecutionResult,
} from "./confidentialExecutionService";
import { magicBlockSessions } from "./magicBlockSessionManager";
import { verifyNegotiationForExecution } from "./zerionVerificationService";
import { prepareSettlementAddressPlan } from "./settlementAddressService";
import { prepareStealthSettlement } from "./stealthSettlementService";
import { executeStealthSettlement } from "./stealthSettlementLifecycleService";
import { activateStandardEscrowLifecycle } from "./standardEscrowActivationService";
import { releaseApprovalService } from "./releaseApprovalService";
import { confidentialFundingService } from "./confidentialFundingService";
import {
  buildPipelineContext,
  inferNegotiationSource,
  resolvePipelineRoute,
} from "./pipelineRouting";
import { resolveEscrowTermsForTicket } from "./escrowTermsResolver";
import type { AgreementDetectedEvent } from "../types/events";
import type { Ticket } from "../types/ticket";
import type {
  DealPipelineContext,
  DealPipelineExecutionResult,
  DealPipelineStage,
  NegotiationOutcome,
  PipelineStageStatus,
  SettlementAddressPlan,
  AttestedEscrowIntent,
  PrivateHandoffProofState,
} from "../types/dealPipeline";
import type { ReleaseApprovalStateSnapshot } from "../protocol/releaseApprovalProtocol";
import type { ConfidentialFundingStateSnapshot } from "../protocol/confidentialFundingProtocol";

interface DealPipelineDependencies {
  loadConfig: () => AgentConfig;
  ticketStore: Pick<typeof ticketStore, "getTicket" | "recordNegotiatedTerms">;
  privateEscrowIntentStore: Pick<typeof privateEscrowIntentStore, "updateStatus"> &
    Partial<
      Pick<
        typeof privateEscrowIntentStore,
        "getLatestByTicket" | "getByIntentId" | "save"
      >
    >;
  dealTracker: Pick<typeof dealTracker, "initDeal" | "storeOnChainId" | "updateStatus">;
  getPrivacyStatus: (ticketId: string) => Promise<PrivacyStatus>;
  pipelineStateStore: Pick<
    typeof pipelineStateStore,
    "markStage" | "markRouteSelected" | "getLatestStage"
  >;
  eventBus: Pick<typeof eventBus, "publish">;
  appendAuditLog: typeof appendAuditLog;
  executeCreateDealPhase: typeof executeCreateDealPhase;
  isConfidentialEscrowReady: typeof isConfidentialEscrowReady;
  initConfidentialEscrow: typeof initConfidentialEscrow;
  executeConfidentialDeal: typeof executeConfidentialDeal;
  prepareConfidentialSettlementAfterFunding: typeof prepareConfidentialSettlementAfterFunding;
  authorizeConfidentialRelease: typeof authorizeConfidentialRelease;
  executeConfidentialRelease: typeof executeConfidentialRelease;
  confidentialFundingService: Pick<
    typeof confidentialFundingService,
    "initializeFundingRequests" | "getLatestState"
  >;
  releaseApprovalService: Pick<
    typeof releaseApprovalService,
    | "initializeApprovalRequests"
    | "getLatestState"
    | "maybeAuthorizeRelease"
    | "markReleaseSigned"
    | "markReleaseExecuted"
  >;
  verifyNegotiationForExecution: typeof verifyNegotiationForExecution;
  prepareSettlementAddressPlan: typeof prepareSettlementAddressPlan;
  prepareStealthSettlement: typeof prepareStealthSettlement;
  executeStealthSettlement: typeof executeStealthSettlement;
  activateStandardEscrowLifecycle: typeof activateStandardEscrowLifecycle;
  magicBlockSessions: Pick<
    typeof magicBlockSessions,
    | "finalizePrivateTicket"
    | "completeTicketSession"
    | "fetchLivePrivateHandoffProof"
  > &
    Partial<Pick<typeof magicBlockSessions, "fetchCommittedPrivateHandoffProof">>;
}

const defaultDependencies: DealPipelineDependencies = {
  loadConfig,
  ticketStore,
  privateEscrowIntentStore,
  dealTracker,
  getPrivacyStatus,
  pipelineStateStore,
  eventBus,
  appendAuditLog,
  executeCreateDealPhase,
  isConfidentialEscrowReady,
  initConfidentialEscrow,
  executeConfidentialDeal,
  prepareConfidentialSettlementAfterFunding,
  authorizeConfidentialRelease,
  executeConfidentialRelease,
  confidentialFundingService,
  releaseApprovalService,
  verifyNegotiationForExecution,
  prepareSettlementAddressPlan,
  prepareStealthSettlement,
  executeStealthSettlement,
  activateStandardEscrowLifecycle,
  magicBlockSessions,
};

interface StartPipelineOptions {
  rememberTerms: boolean;
  attestedEscrowIntent?: AttestedEscrowIntent;
}

function isStrictPerOpaqueMode(config: AgentConfig): boolean {
  return config.perStrictOpaqueMode;
}

function isLegacyUmbraStealthLifecycleEnabled(config: AgentConfig): boolean {
  return config.enableLegacyUmbraStealthLifecycle && process.env.NODE_ENV === "test";
}

function toAgreementResult(outcome: NegotiationOutcome): AgreementResult {
  return {
    ticketId: outcome.ticketId,
    price: outcome.price,
    collateral_buyer: outcome.collateralBuyer,
    collateral_seller: outcome.collateralSeller,
    asset_type: outcome.assetType,
    confidence: outcome.confidence,
    buyer: outcome.buyer,
    seller: outcome.seller,
  };
}

function assertFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid_pipeline_outcome:${field} must be a finite positive number`);
  }
}

function assertFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid_pipeline_outcome:${field} must be a finite non-negative number`);
  }
}

function validateNegotiationOutcome(outcome: NegotiationOutcome): void {
  if (!outcome.ticketId?.trim()) {
    throw new Error("invalid_pipeline_outcome:ticketId is required");
  }

  if (!outcome.buyer?.trim() || !outcome.seller?.trim()) {
    throw new Error("invalid_pipeline_outcome:buyer and seller are required");
  }

  if (outcome.buyer === outcome.seller) {
    throw new Error("invalid_pipeline_outcome:buyer and seller must be different wallets");
  }

  if (!outcome.assetType?.trim()) {
    throw new Error("invalid_pipeline_outcome:assetType is required");
  }

  const redactedPrivateTerms =
    outcome.negotiationSource === "PER" && outcome.termsVisibility === "REDACTED";

  if (redactedPrivateTerms) {
    assertFiniteNonNegative(outcome.price, "price");
    assertFiniteNonNegative(outcome.collateralBuyer, "collateralBuyer");
    assertFiniteNonNegative(outcome.collateralSeller, "collateralSeller");
  } else {
    assertFinitePositive(outcome.price, "price");
    assertFiniteNonNegative(outcome.collateralBuyer, "collateralBuyer");
    assertFiniteNonNegative(outcome.collateralSeller, "collateralSeller");
  }

  if (!Number.isFinite(outcome.confidence) || outcome.confidence < 0 || outcome.confidence > 100) {
    throw new Error("invalid_pipeline_outcome:confidence must be between 0 and 100");
  }

  if (outcome.rollupMode === "PER" && outcome.negotiationSource !== "PER") {
    throw new Error("invalid_pipeline_outcome:PER rollupMode requires PER negotiationSource");
  }

  if (outcome.rollupMode === "ER" && outcome.negotiationSource !== "ER") {
    throw new Error("invalid_pipeline_outcome:ER rollupMode requires ER negotiationSource");
  }

  if (outcome.rollupMode === "NONE" && outcome.negotiationSource !== "OFFCHAIN") {
    throw new Error("invalid_pipeline_outcome:OFFCHAIN negotiationSource required for NONE rollupMode");
  }
}

export function createDealPipeline(
  overrides: Partial<DealPipelineDependencies> = {}
) {
  const deps = {
    ...defaultDependencies,
    ...overrides,
  } as DealPipelineDependencies;
  const ticketPipelineLocks = new Map<string, Promise<void>>();

  async function withTicketPipelineLock<T>(
    ticketId: string,
    work: () => Promise<T>
  ): Promise<T> {
    const previous = ticketPipelineLocks.get(ticketId) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => gate);
    ticketPipelineLocks.set(ticketId, next);

    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (ticketPipelineLocks.get(ticketId) === next) {
        ticketPipelineLocks.delete(ticketId);
      }
    }
  }

  async function publishStage(
    context: DealPipelineContext,
    stage: DealPipelineStage,
    status: PipelineStageStatus,
    details?: Record<string, unknown>
  ): Promise<void> {
    await deps.pipelineStateStore.markStage(context.ticketId, stage, status, {
      route: context.route,
      executionPolicy: context.executionPolicy,
      settlementPolicy: context.settlementPolicy,
      ...details,
    });
    deps.eventBus.publish("deal_pipeline_stage_changed", {
      ticketId: context.ticketId,
      stage,
      status,
      route: context.route,
      executionPolicy: context.executionPolicy,
      settlementPolicy: context.settlementPolicy,
      negotiationSource: context.negotiationSource,
    });
  }

  async function appendPipelineSummary(
    ticketId: string,
    eventName: string,
    details: Record<string, unknown>
  ): Promise<void> {
    await deps.appendAuditLog(ticketId, eventName, details);
  }

  async function buildNegotiationOutcome(
    payload: AgreementDetectedEvent
  ): Promise<NegotiationOutcome> {
    const ticket = await deps.ticketStore.getTicket(payload.ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${payload.ticketId} not found for pipeline execution`);
    }

    const resolvedTerms = resolveEscrowTermsForTicket(ticket, {
      price: payload.price,
      collateral_buyer: payload.collateral_buyer,
      collateral_seller: payload.collateral_seller,
      asset_type: payload.asset_type || "data",
    });

    return {
      ticketId: payload.ticketId,
      buyer: payload.buyer || ticket.buyer,
      seller: payload.seller || ticket.seller,
      price: resolvedTerms.price,
      collateralBuyer: resolvedTerms.collateral_buyer,
      collateralSeller: resolvedTerms.collateral_seller,
      assetType: resolvedTerms.asset_type || "data",
      tokenMint: ticket.tokenMint,
      decimals: ticket.decimals,
      confidence: payload.confidence,
      rollupMode: ticket.rollup_mode || "NONE",
      negotiationSource: inferNegotiationSource(ticket.rollup_mode || "NONE"),
    };
  }

  async function buildNegotiationOutcomeFromPrivateIntent(
    intent: AttestedEscrowIntent
  ): Promise<NegotiationOutcome> {
    const ticket = await deps.ticketStore.getTicket(intent.ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${intent.ticketId} not found for private escrow intent execution`);
    }

    let proof: PrivateHandoffProofState;
    try {
      proof = await deps.magicBlockSessions.fetchLivePrivateHandoffProof(intent.ticketId);
    } catch (error: any) {
      logger.warn("per_private_handoff_live_proof_unavailable_using_committed", {
        ticket_id: intent.ticketId,
        sessionPda: intent.sessionPda,
        error_message: error?.message || String(error),
      });
      if (!deps.magicBlockSessions.fetchCommittedPrivateHandoffProof) {
        throw error;
      }
      proof = await deps.magicBlockSessions.fetchCommittedPrivateHandoffProof(intent.ticketId);
    }
    assertPrivateIntentMatchesProof(intent, proof);

    return {
      ticketId: intent.ticketId,
      buyer: intent.buyer,
      seller: intent.seller,
      price: 0,
      collateralBuyer: 0,
      collateralSeller: 0,
      assetType: intent.assetSymbol || intent.assetMint,
      tokenMint: ticket.tokenMint || intent.assetMint,
      decimals: ticket.decimals,
      confidence: 100,
      rollupMode: "PER",
      negotiationSource: "PER",
      termsVisibility: "REDACTED",
    };
  }

  function assertPrivateIntentMatchesProof(
    intent: AttestedEscrowIntent,
    proof: PrivateHandoffProofState
  ): void {
    const comparisons: Array<[field: string, actual: string, expected: string]> = [
      ["buyer", proof.buyer, intent.buyer],
      ["seller", proof.seller, intent.seller],
      ["sessionPda", proof.sessionPda, intent.sessionPda],
      ["termsHash", proof.termsHash, intent.termsHash],
      [
        "buyerPaymentFundingHash",
        proof.buyerPaymentFundingHash,
        intent.fundingCommitments.buyerPaymentHash,
      ],
      [
        "buyerCollateralFundingHash",
        proof.buyerCollateralFundingHash,
        intent.fundingCommitments.buyerCollateralHash,
      ],
      [
        "sellerCollateralFundingHash",
        proof.sellerCollateralFundingHash,
        intent.fundingCommitments.sellerCollateralHash,
      ],
      [
        "buyerCollateralCiphertext",
        proof.buyerCollateralCiphertext,
        intent.encryptedTerms.buyerCollateral.account,
      ],
      [
        "sellerCollateralCiphertext",
        proof.sellerCollateralCiphertext,
        intent.encryptedTerms.sellerCollateral.account,
      ],
      [
        "paymentAmountCiphertext",
        proof.paymentAmountCiphertext,
        intent.encryptedTerms.paymentAmount.account,
      ],
      [
        "settlementResultCiphertext",
        proof.settlementResultCiphertext,
        intent.encryptedTerms.settlementResult.account,
      ],
      [
        "networkEncryptionKeyPda",
        proof.networkEncryptionKeyPda,
        intent.encryptedTerms.networkEncryptionKeyPda,
      ],
    ];

    for (const [field, actual, expected] of comparisons) {
      if (actual !== expected) {
        throw new Error(`private_handoff_proof_mismatch:${field}:${actual}!==${expected}`);
      }
    }

    if (proof.status !== "confidentialHandoff") {
      throw new Error(`private_handoff_proof_invalid_status:${proof.status}`);
    }
  }

  async function buildContext(outcome: NegotiationOutcome): Promise<DealPipelineContext> {
    const cfg = deps.loadConfig();
    const privacy = await deps.getPrivacyStatus(outcome.ticketId);
    const selection = resolvePipelineRoute({
      outcome,
      privacy,
      enableConfidentialEscrow: cfg.enableConfidentialEscrow,
    });

    return buildPipelineContext(outcome, selection);
  }

  async function rememberOutcome(context: NegotiationOutcome): Promise<void> {
    if (
      context.rollupMode === "PER" &&
      context.negotiationSource === "PER" &&
      isStrictPerOpaqueMode(deps.loadConfig())
    ) {
      throw new Error("per_strict_opaque_mode_violation:plaintext_terms_cannot_be_recorded");
    }
    await deps.ticketStore.recordNegotiatedTerms(context.ticketId, {
      price: context.price,
      collateral_buyer: context.collateralBuyer,
      collateral_seller: context.collateralSeller,
      asset_type: context.assetType,
    });
  }

  async function resolveOutcomeAgainstTicket(outcome: NegotiationOutcome): Promise<NegotiationOutcome> {
    if (outcome.termsVisibility === "REDACTED") {
      return outcome;
    }

    const ticket = await deps.ticketStore.getTicket(outcome.ticketId);
    if (!ticket) {
      return outcome;
    }

    const resolvedTerms = resolveEscrowTermsForTicket(ticket, {
      price: outcome.price,
      collateral_buyer: outcome.collateralBuyer,
      collateral_seller: outcome.collateralSeller,
      asset_type: outcome.assetType,
    });

    if (
      resolvedTerms.price === outcome.price
      && resolvedTerms.collateral_buyer === outcome.collateralBuyer
      && resolvedTerms.collateral_seller === outcome.collateralSeller
      && resolvedTerms.asset_type === outcome.assetType
    ) {
      return outcome;
    }

    return {
      ...outcome,
      price: resolvedTerms.price,
      collateralBuyer: resolvedTerms.collateral_buyer,
      collateralSeller: resolvedTerms.collateral_seller,
      assetType: resolvedTerms.asset_type || outcome.assetType,
    };
  }

  async function runVerificationStage(context: DealPipelineContext): Promise<void> {
    try {
      const verification = await deps.verifyNegotiationForExecution(context);
      await publishStage(context, "verified", "confirmed", { ...verification });
    } catch (error: any) {
      await publishStage(context, "failed", "failed", {
        failedStage: "verified",
        error: error?.message || String(error),
      });
      throw error;
    }
  }

  async function runSettlementPreparationStage(
    context: DealPipelineContext
  ): Promise<SettlementAddressPlan> {
    try {
      const settlementPlan = await deps.prepareSettlementAddressPlan(context);
      await publishStage(context, "settlement_address_ready", "confirmed", {
        assetMint: settlementPlan.assetMint || null,
        resolution: settlementPlan.resolution,
        buyerTarget: settlementPlan.buyerTarget,
        sellerTarget: settlementPlan.sellerTarget,
        notes: settlementPlan.notes,
      });
      return settlementPlan;
    } catch (error: any) {
      await publishStage(context, "failed", "failed", {
        failedStage: "settlement_address_ready",
        error: error?.message || String(error),
      });
      throw error;
    }
  }

  async function runStealthSettlementStage(
    context: DealPipelineContext,
    settlementPlan: SettlementAddressPlan
  ): Promise<void> {
    try {
      const preparation = await deps.prepareStealthSettlement(context, settlementPlan);
      await publishStage(context, "stealth_settlement_ready", "confirmed", {
        dealId: preparation.dealId,
        settlementId: preparation.settlementId,
        mint: preparation.mint,
        phase: preparation.phase,
        created: preparation.created,
      });
    } catch (error: any) {
      await publishStage(context, "failed", "failed", {
        failedStage: "stealth_settlement_ready",
        error: error?.message || String(error),
      });
      throw error;
    }
  }

  async function runStandardEscrow(
    context: DealPipelineContext,
    settlementPlan?: SettlementAddressPlan
  ): Promise<DealPipelineExecutionResult> {
    if (context.settlementPolicy === "STEALTH") {
      if (!isLegacyUmbraStealthLifecycleEnabled(deps.loadConfig())) {
        throw new Error(
          "legacy_umbra_stealth_lifecycle_test_only:use_confidential_escrow_route"
        );
      }
      if (!settlementPlan) {
        throw new Error("Stealth settlement execution requires a resolved settlement plan");
      }

      const stealth = await deps.executeStealthSettlement(
        context,
        settlementPlan,
        async (stage, details) => {
          await publishStage(context, stage, "confirmed", details);
        }
      );

      await publishStage(context, "settled", "confirmed", {
        settlementId: stealth.settlementId,
        dealId: stealth.dealId,
        phase: stealth.phase,
        buyerShieldTx: stealth.buyerShieldTx || null,
        sellerShieldTx: stealth.sellerShieldTx || null,
        settlementUtxoTx: stealth.settlementUtxoTx || null,
        claimTx: stealth.claimTx || null,
        buyerUnshieldTx: stealth.buyerUnshieldTx || null,
        sellerUnshieldTx: stealth.sellerUnshieldTx || null,
      });

      await deps.dealTracker.initDeal({
        ticketId: context.ticketId,
        buyerId: context.buyer,
        sellerId: context.seller,
        middlemanId: "system",
        price: context.price,
        collateralBuyer: context.collateralBuyer,
        collateralSeller: context.collateralSeller,
        timeout: new Date(Date.now() + 30 * 60 * 1000),
      });
      await deps.dealTracker.storeOnChainId(context.ticketId, stealth.dealId);
      await deps.dealTracker.updateStatus(context.ticketId, "settled");

      deps.eventBus.publish("deal_executed", {
        ticket_id: context.ticketId,
        status: "settled",
      });

      return {
        success: true,
        stage: "settled",
        route: context.route,
        status: "settled",
        dealPda: stealth.dealId,
        txSignatures: [
          stealth.buyerShieldTx,
          stealth.sellerShieldTx,
          stealth.settlementUtxoTx,
          stealth.claimTx,
          stealth.buyerUnshieldTx,
          stealth.sellerUnshieldTx,
        ].filter((value): value is string => !!value),
      };
    }

    const result = await deps.executeCreateDealPhase(toAgreementResult(context));

    if (!result.success) {
      await publishStage(context, "failed", "failed", {
        failedStage: "standard_escrow_dispatch",
        error: result.error || "standard escrow dispatch failed",
      });
      deps.eventBus.publish("deal_executed", {
        ticket_id: context.ticketId,
        status: "failed",
      });
      return {
        success: false,
        stage: "failed",
        route: context.route,
        status: "failed",
        error: result.error || "standard escrow dispatch failed",
      };
    }

    if (result.dealPda) {
      const activation = await deps.activateStandardEscrowLifecycle({
        ticketId: context.ticketId,
        buyer: context.buyer,
        seller: context.seller,
        dealPda: result.dealPda,
        price: context.price,
        collateralBuyer: context.collateralBuyer,
        collateralSeller: context.collateralSeller,
        assetType: context.assetType,
      });

      await deps.appendAuditLog(context.ticketId, "deal_pipeline_standard_escrow_operational", {
        phase: activation.phase,
        watcherAttached: activation.watcherAttached,
        depositInstructionsPublished: activation.depositInstructionsPublished,
      });
    }

    await publishStage(context, "escrow_created", "confirmed", {
      dealPda: result.dealPda || null,
    });
    deps.eventBus.publish("deal_executed", {
      ticket_id: context.ticketId,
      status: "created_awaiting_deposits",
    });

    return {
      success: true,
      stage: "escrow_created",
      route: context.route,
      status: "created_awaiting_deposits",
      dealPda: result.dealPda,
      txSignatures: result.tx ? [result.tx] : [],
    };
  }

  async function trackConfidentialDeal(
    context: DealPipelineContext,
    result: ConfidentialExecutionResult,
    status: DealPipelineExecutionResult["status"]
  ): Promise<void> {
    const timeout = new Date(Date.now() + 30 * 60 * 1000);
    await deps.dealTracker.initDeal({
      ticketId: context.ticketId,
      buyerId: context.buyer,
      sellerId: context.seller,
      middlemanId: "system",
      price: context.price,
      collateralBuyer: context.collateralBuyer,
      collateralSeller: context.collateralSeller,
      timeout,
    });

    if (result.dealPda) {
      await deps.dealTracker.storeOnChainId(context.ticketId, result.dealPda);
    }

    await deps.dealTracker.updateStatus(
      context.ticketId,
      status === "awaiting_settlement_plan_approvals"
        ? "awaiting_settlement_plan_approvals"
        : status === "awaiting_buyer_release_confirmation"
          ? "awaiting_buyer_release_confirmation"
          : status === "seller_dispute_window"
            ? "seller_dispute_window"
        : status === "awaiting_release_approvals"
          ? "awaiting_release_approvals"
        : status === "release_authorized"
          ? "release_authorized"
          :
      status === "confidential_pending_session_close"
        ? "pending_confidential_session_close"
        : status === "settled_pending_session_close"
          ? "settled_pending_session_close"
          : status === "settled"
          ? "settled"
          : "completed_confidential"
    );
  }

  async function finalizePrivateSessionIfNeeded(
    context: DealPipelineContext,
    result: ConfidentialExecutionResult
  ): Promise<DealPipelineExecutionResult["status"]> {
    const settlementStatus =
      result.crossChainSignature && result.releaseTxSignature ? "settled" : "confidential_completed";

    if (context.negotiationSource !== "PER") {
      return settlementStatus;
    }

    try {
      await deps.magicBlockSessions.finalizePrivateTicket(context.ticketId);
      deps.magicBlockSessions.completeTicketSession(context.ticketId);
      return settlementStatus;
    } catch (finalizeError: any) {
      await deps.appendAuditLog(context.ticketId, "deal_pipeline_private_session_finalize_pending", {
        error: finalizeError?.message || String(finalizeError),
        dealPda: result.dealPda || null,
      });

      logger.error(
        "deal_pipeline_private_session_finalize_failed",
        {
          ticket_id: context.ticketId,
          route: context.route,
        },
        finalizeError instanceof Error
          ? finalizeError
          : new Error(finalizeError?.message || String(finalizeError))
      );

      deps.eventBus.publish("deal_executed", {
        ticket_id: context.ticketId,
        status:
          settlementStatus === "settled"
            ? "settled_pending_session_close"
            : "confidential_pending_session_close",
      });

      return settlementStatus === "settled"
        ? "settled_pending_session_close"
        : "confidential_pending_session_close";
    }
  }

  async function runConfidentialEscrow(
    context: DealPipelineContext,
    settlementPlan?: SettlementAddressPlan,
    attestedEscrowIntent?: AttestedEscrowIntent
  ): Promise<DealPipelineExecutionResult> {
    if (!deps.isConfidentialEscrowReady()) {
      await deps.initConfidentialEscrow();
    }

    if (context.settlementPolicy === "STEALTH" && !settlementPlan) {
      throw new Error("Confidential stealth settlement requires a resolved settlement address plan");
    }

    deps.eventBus.publish("deal_executed", {
      ticket_id: context.ticketId,
      status: "confidential_encrypting",
    });

    const result = await deps.executeConfidentialDeal(
      context.ticketId,
      toAgreementResult(context),
      settlementPlan,
      attestedEscrowIntent
    );

    if (!result.success) {
      await publishStage(context, "failed", "failed", {
        failedStage: "confidential_escrow_dispatch",
        error: result.error || "confidential escrow dispatch failed",
      });
      deps.eventBus.publish("deal_executed", {
        ticket_id: context.ticketId,
        status: "failed",
      });
      return {
        success: false,
        stage: "failed",
        route: context.route,
        status: "failed",
        error: result.error || "confidential escrow dispatch failed",
      };
    }

    await publishStage(context, "encrypted", "confirmed", {
      dealPda: result.dealPda || null,
      txCount: result.txSignatures.length,
    });

    if (result.approvalStatus === "created_awaiting_deposits") {
      if (!attestedEscrowIntent) {
        throw new Error("private_confidential_funding_requires_attested_intent");
      }
      await deps.confidentialFundingService.initializeFundingRequests(
        context,
        {
          ticketId: context.ticketId,
          dealPda: result.dealPda || "",
          sessionPda:
            result.sessionPda ||
            attestedEscrowIntent.sessionPda ||
            PublicKey.default.toBase58(),
          intentId: attestedEscrowIntent.intentId,
          termsHash: result.termsHash || attestedEscrowIntent.termsHash,
          planHash: result.planHash || "",
          buyerSettlementTarget:
            result.buyerSettlementTarget ||
            settlementPlan?.buyerTarget.resolvedAddress ||
            context.buyer,
          sellerSettlementTarget:
            result.sellerSettlementTarget ||
            settlementPlan?.sellerTarget.resolvedAddress ||
            context.seller,
          dwalletPda: result.dwalletPda,
          txSignatures: result.txSignatures,
        },
        attestedEscrowIntent
      );
      await publishStage(context, "escrow_created", "confirmed", {
        dealPda: result.dealPda || null,
        fundingCommitments: attestedEscrowIntent?.fundingCommitments || null,
      });
      await trackConfidentialDeal(context, result, "created_awaiting_deposits");
      deps.eventBus.publish("deal_executed", {
        ticket_id: context.ticketId,
        status: "created_awaiting_deposits",
      });
      return {
        success: true,
        stage: "escrow_created",
        route: context.route,
        status: "created_awaiting_deposits",
        dealPda: result.dealPda,
        txSignatures: result.txSignatures,
      };
    }

    if (result.approvalStatus !== "awaiting_settlement_plan_approvals") {
      if (result.releaseTxSignature) {
        await publishStage(context, "release_pending", "confirmed", {
          releaseTxSignature: result.releaseTxSignature,
          winner: result.winner || null,
          decryptedValue: result.decryptedValue || null,
        });
      }

      if (result.approvalTxSignature || result.crossChainSignature) {
        await publishStage(context, "release_signed", "confirmed", {
          approvalTxSignature: result.approvalTxSignature || null,
          messageApprovalPda: result.messageApprovalPda || null,
          signatureScheme: result.signatureScheme || null,
        });
      }

      if (result.crossChainSignature) {
        await publishStage(context, "settled", "confirmed", {
          crossChainSignature: result.crossChainSignature,
          messageApprovalPda: result.messageApprovalPda || null,
          winner: result.winner || null,
        });
      }

      const status = await finalizePrivateSessionIfNeeded(context, result);
      await trackConfidentialDeal(context, result, status);
      deps.eventBus.publish("deal_executed", {
        ticket_id: context.ticketId,
        status,
      });

      return {
        success: true,
        stage: result.crossChainSignature ? "settled" : "encrypted",
        route: context.route,
        status,
        dealPda: result.dealPda,
        txSignatures: result.txSignatures,
      };
    }

    const approvalState = await deps.releaseApprovalService.initializeApprovalRequests(
      context,
      {
        ticketId: context.ticketId,
        dealPda: result.dealPda || "",
        sessionPda: result.sessionPda || attestedEscrowIntent?.sessionPda || PublicKey.default.toBase58(),
        intentId: attestedEscrowIntent?.intentId,
        termsHash: result.termsHash || attestedEscrowIntent?.termsHash || "",
        planHash: result.planHash,
        buyerSettlementTarget:
          result.buyerSettlementTarget || settlementPlan?.buyerTarget.resolvedAddress || context.buyer,
        sellerSettlementTarget:
          result.sellerSettlementTarget || settlementPlan?.sellerTarget.resolvedAddress || context.seller,
        requestAccount: result.requestAccount || "",
        dwalletPda: result.dwalletPda || "",
        decryptedValue: result.decryptedValue || "0",
        winner: result.winner || context.seller,
        txSignatures: result.txSignatures,
      },
      settlementPlan!,
      attestedEscrowIntent
    );

    if (!approvalState.buyerApproval?.active || !approvalState.sellerApproval?.active) {
      await publishStage(context, "awaiting_settlement_plan_approvals", "confirmed", {
        dealPda: approvalState.dealPda,
        buyerRequestId: approvalState.buyerRequest.requestId,
        sellerRequestId: approvalState.sellerRequest.requestId,
        requestAccount: approvalState.requestAccount || null,
        termsHash: approvalState.termsHash,
        planHash: approvalState.planHash,
      });

      await trackConfidentialDeal(context, result, "awaiting_settlement_plan_approvals");
      deps.eventBus.publish("deal_executed", {
        ticket_id: context.ticketId,
        status: "awaiting_settlement_plan_approvals",
      });

      return {
        success: true,
        stage: "awaiting_settlement_plan_approvals",
        route: context.route,
        status: "awaiting_settlement_plan_approvals",
        dealPda: result.dealPda,
        txSignatures: result.txSignatures,
      };
    }

    if (!approvalState.buyerReleaseConfirmed) {
      await publishStage(context, "awaiting_buyer_release_confirmation", "confirmed", {
        dealPda: approvalState.dealPda,
        buyerReleaseRequestId: approvalState.buyerReleaseRequest?.requestId || null,
        requestAccount: approvalState.requestAccount || null,
      });

      await trackConfidentialDeal(context, result, "awaiting_buyer_release_confirmation");
      deps.eventBus.publish("deal_executed", {
        ticket_id: context.ticketId,
        status: "awaiting_buyer_release_confirmation",
      });

      return {
        success: true,
        stage: "awaiting_buyer_release_confirmation",
        route: context.route,
        status: "awaiting_buyer_release_confirmation",
        dealPda: result.dealPda,
        txSignatures: result.txSignatures,
      };
    }

    const maybeAuthorized =
      (await deps.releaseApprovalService.maybeAuthorizeRelease(
        context.ticketId,
        approvalState
      )) || approvalState;
    if (!maybeAuthorized.releaseAuthorized) {
      await publishStage(context, "seller_dispute_window", "confirmed", {
        dealPda: maybeAuthorized.dealPda,
        disputeWindowEndsAt: maybeAuthorized.sellerDisputeDeadlineAt || null,
      });

      await trackConfidentialDeal(context, result, "seller_dispute_window");
      deps.eventBus.publish("deal_executed", {
        ticket_id: context.ticketId,
        status: "seller_dispute_window",
      });

      return {
        success: true,
        stage: "seller_dispute_window",
        route: context.route,
        status: "seller_dispute_window",
        dealPda: result.dealPda,
        txSignatures: result.txSignatures,
      };
    }

    return continueConfidentialRelease(context.ticketId, context);
  }

  async function continueConfidentialSettlementAfterFunding(
    ticketId: string,
    prebuiltContext?: DealPipelineContext
  ): Promise<DealPipelineExecutionResult> {
    const fundingState = await deps.confidentialFundingService.getLatestState(ticketId);
    if (!fundingState) {
      throw new Error(`confidential_funding_state_missing:${ticketId}`);
    }

    let context = prebuiltContext;
    const privateIntent = fundingState.intentId
      ? (await deps.privateEscrowIntentStore.getByIntentId?.(
          ticketId,
          fundingState.intentId
        )) || (await deps.privateEscrowIntentStore.getLatestByTicket?.(ticketId))
      : await deps.privateEscrowIntentStore.getLatestByTicket?.(ticketId);
    if (!privateIntent) {
      throw new Error(`confidential_funding_intent_missing:${ticketId}`);
    }

    if (!context) {
      context = await buildContext(await buildNegotiationOutcomeFromPrivateIntent(privateIntent));
    }

    if (!fundingState.buyerFunding?.active || !fundingState.sellerFunding?.active) {
      await publishStage(context, "escrow_created", "confirmed", {
        dealPda: fundingState.dealPda,
        waitingFor:
          !fundingState.buyerFunding?.active ? "buyer_funding" : "seller_funding",
      });
      return {
        success: true,
        stage: "escrow_created",
        route: context.route,
        status: "created_awaiting_deposits",
        dealPda: fundingState.dealPda,
        txSignatures: fundingState.txSignatures,
      };
    }

    const result = await deps.prepareConfidentialSettlementAfterFunding(
      ticketId,
      {
        dealPda: fundingState.dealPda,
        sessionPda: fundingState.sessionPda,
        intentId: fundingState.intentId,
        termsHash: fundingState.termsHash,
        planHash: fundingState.planHash,
        buyerSettlementTarget: fundingState.buyerSettlementTarget,
        sellerSettlementTarget: fundingState.sellerSettlementTarget,
        dwalletPda: fundingState.dwalletPda,
        txSignatures: fundingState.txSignatures,
      },
      privateIntent
    );

    if (!result.success) {
      await publishStage(context, "failed", "failed", {
        failedStage: "confidential_settlement_after_funding",
        error: result.error || "confidential funding continuation failed",
      });
      return {
        success: false,
        stage: "failed",
        route: context.route,
        status: "failed",
        error: result.error || "confidential funding continuation failed",
      };
    }

    const approvalState = await deps.releaseApprovalService.initializeApprovalRequests(
      context,
      {
        ticketId: context.ticketId,
        dealPda: result.dealPda || fundingState.dealPda,
        sessionPda: result.sessionPda || fundingState.sessionPda,
        intentId: fundingState.intentId,
        termsHash: result.termsHash || fundingState.termsHash,
        planHash: result.planHash || fundingState.planHash,
        buyerSettlementTarget:
          result.buyerSettlementTarget || fundingState.buyerSettlementTarget,
        sellerSettlementTarget:
          result.sellerSettlementTarget || fundingState.sellerSettlementTarget,
        requestAccount: result.requestAccount || "",
        dwalletPda: result.dwalletPda || fundingState.dwalletPda || "",
        decryptedValue: result.decryptedValue || "0",
        winner: result.winner || fundingState.sellerSettlementTarget,
        txSignatures: result.txSignatures,
      },
      {
        policy: context.settlementPolicy,
        resolution: "resolved",
        assetMint: privateIntent.assetMint,
        buyerTarget: {
          role: "buyer",
          strategy: context.settlementPolicy === "STEALTH" ? "UMBRA_STEALTH" : "DIRECT_WALLET",
          baseWallet: context.buyer,
          resolvedAddress: fundingState.buyerSettlementTarget,
          status: "resolved",
        },
        sellerTarget: {
          role: "seller",
          strategy: context.settlementPolicy === "STEALTH" ? "UMBRA_STEALTH" : "DIRECT_WALLET",
          baseWallet: context.seller,
          resolvedAddress: fundingState.sellerSettlementTarget,
          status: "resolved",
        },
        notes: ["Resumed from committed confidential funding state."],
      },
      privateIntent
    );

    if (!approvalState.buyerApproval?.active || !approvalState.sellerApproval?.active) {
      await publishStage(context, "awaiting_settlement_plan_approvals", "confirmed", {
        dealPda: approvalState.dealPda,
        buyerRequestId: approvalState.buyerRequest.requestId,
        sellerRequestId: approvalState.sellerRequest.requestId,
        requestAccount: approvalState.requestAccount || null,
        termsHash: approvalState.termsHash,
        planHash: approvalState.planHash,
        resumedFromFunding: true,
      });

      await trackConfidentialDeal(context, result, "awaiting_settlement_plan_approvals");
      deps.eventBus.publish("deal_executed", {
        ticket_id: context.ticketId,
        status: "awaiting_settlement_plan_approvals",
      });

      return {
        success: true,
        stage: "awaiting_settlement_plan_approvals",
        route: context.route,
        status: "awaiting_settlement_plan_approvals",
        dealPda: result.dealPda,
        txSignatures: result.txSignatures,
      };
    }

    return continueConfidentialRelease(context.ticketId, context);
  }

  async function continueConfidentialRelease(
    ticketId: string,
    prebuiltContext?: DealPipelineContext
  ): Promise<DealPipelineExecutionResult> {
    const state = await deps.releaseApprovalService.getLatestState(ticketId);
    if (!state) {
      throw new Error(`release_approval_state_missing:${ticketId}`);
    }

    let context = prebuiltContext;
    if (!context) {
      const ticket = await deps.ticketStore.getTicket(ticketId);
      if (!ticket) {
        throw new Error(`release_resume_ticket_missing:${ticketId}`);
      }
      const strictPerOpaque =
        ticket.rollup_mode === "PER" && isStrictPerOpaqueMode(deps.loadConfig());
      if (!ticket.agreed_terms) {
        if (ticket.rollup_mode === "PER") {
          const privateIntent = await deps.privateEscrowIntentStore.getLatestByTicket?.(ticketId);
          if (!privateIntent) {
            throw new Error(`release_resume_terms_missing:${ticketId}`);
          }
          context = await buildContext(
            await buildNegotiationOutcomeFromPrivateIntent(privateIntent)
          );
        } else {
          throw new Error(`release_resume_terms_missing:${ticketId}`);
        }
      }
      if (!context) {
        if (strictPerOpaque) {
          throw new Error(
            `per_strict_opaque_mode_violation:release_resume_requires_private_intent:${ticketId}`
          );
        }
        const agreedTerms = ticket.agreed_terms;
        if (!agreedTerms) {
          throw new Error(`release_resume_terms_missing:${ticketId}`);
        }
        context = await buildContext({
          ticketId,
          buyer: ticket.buyer,
          seller: ticket.seller,
          price: agreedTerms.price,
          collateralBuyer: agreedTerms.collateral_buyer,
          collateralSeller: agreedTerms.collateral_seller,
          assetType: agreedTerms.asset_type || ticket.tokenMint || "SOL",
          tokenMint: ticket.tokenMint,
          decimals: ticket.decimals,
          confidence: 100,
          rollupMode: ticket.rollup_mode || "NONE",
          negotiationSource: inferNegotiationSource(ticket.rollup_mode || "NONE"),
        });
      }
    }

    if (!state.buyerApproval?.active || !state.sellerApproval?.active) {
      await publishStage(context, "awaiting_settlement_plan_approvals", "confirmed", {
        waitingFor:
          !state.buyerApproval?.active
            ? "buyer_plan_approval"
            : "seller_plan_approval",
      });
      return {
        success: true,
        stage: "awaiting_settlement_plan_approvals",
        route: context.route,
        status: "awaiting_settlement_plan_approvals",
        dealPda: state.dealPda,
        txSignatures: state.txSignatures,
      };
    }

    if (!state.buyerReleaseConfirmed) {
      await publishStage(context, "awaiting_buyer_release_confirmation", "confirmed", {
        buyerReleaseRequestId: state.buyerReleaseRequest?.requestId || null,
      });
      return {
        success: true,
        stage: "awaiting_buyer_release_confirmation",
        route: context.route,
        status: "awaiting_buyer_release_confirmation",
        dealPda: state.dealPda,
        txSignatures: state.txSignatures,
      };
    }

    if (state.disputeOpen) {
      await publishStage(context, "seller_dispute_window", "confirmed", {
        waitingFor: "dispute_resolution",
      });
      return {
        success: true,
        stage: "seller_dispute_window",
        route: context.route,
        status: "seller_dispute_window",
        dealPda: state.dealPda,
        txSignatures: state.txSignatures,
      };
    }

    const authorizationState =
      (await deps.releaseApprovalService.maybeAuthorizeRelease(ticketId, state)) || state;
    if (!authorizationState.releaseAuthorized) {
      await publishStage(context, "seller_dispute_window", "confirmed", {
        disputeWindowEndsAt: authorizationState.sellerDisputeDeadlineAt || null,
      });
      return {
        success: true,
        stage: "seller_dispute_window",
        route: context.route,
        status: "seller_dispute_window",
        dealPda: authorizationState.dealPda,
        txSignatures: authorizationState.txSignatures,
      };
    }

    await publishStage(context, "release_authorized", "confirmed", {
      dealPda: authorizationState.dealPda,
      buyerApprovalPda: authorizationState.buyerApproval?.approvalPda || null,
      sellerApprovalPda: authorizationState.sellerApproval?.approvalPda || null,
    });

    const signedResult = authorizationState.releaseSigned
      ? ({
          success: true,
          dealPda: authorizationState.dealPda,
          txSignatures: authorizationState.txSignatures,
          approvalStatus: "release_signed",
          decryptedValue: authorizationState.decryptedValue,
          winner: authorizationState.winner,
          approvalTxSignature: authorizationState.approvalTxSignature,
          crossChainSignature: authorizationState.crossChainSignature,
          signatureScheme: authorizationState.signatureScheme,
          messageApprovalPda: authorizationState.messageApprovalPda,
          requestAccount: authorizationState.requestAccount,
          sessionPda: authorizationState.sessionPda,
          termsHash: authorizationState.termsHash,
          planHash: authorizationState.planHash,
          buyerSettlementTarget: authorizationState.buyerSettlementTarget,
          sellerSettlementTarget: authorizationState.sellerSettlementTarget,
        } satisfies ConfidentialExecutionResult)
      : await deps.authorizeConfidentialRelease(ticketId, authorizationState);

    if (!signedResult.success) {
      await publishStage(context, "failed", "failed", {
        failedStage: "release_signed",
        error: signedResult.error || "confidential release authorization failed",
      });
      return {
        success: false,
        stage: "failed",
        route: context.route,
        status: "failed",
        error: signedResult.error || "confidential release authorization failed",
      };
    }

    if (!authorizationState.releaseSigned) {
      await deps.releaseApprovalService.markReleaseSigned(ticketId, {
        approvalTxSignature: signedResult.approvalTxSignature || "",
        crossChainSignature: signedResult.crossChainSignature || "",
        messageApprovalPda: signedResult.messageApprovalPda || "",
        signatureScheme: signedResult.signatureScheme || "",
      });
    }

    await publishStage(context, "release_signed", "confirmed", {
      approvalTxSignature: signedResult.approvalTxSignature || null,
      messageApprovalPda: signedResult.messageApprovalPda || null,
      signatureScheme: signedResult.signatureScheme || null,
    });

    const releaseState =
      (await deps.releaseApprovalService.getLatestState(ticketId)) || authorizationState;
    const releasedResult = releaseState.releaseExecuted
      ? ({
          success: true,
          dealPda: releaseState.dealPda,
          txSignatures: releaseState.txSignatures,
          approvalStatus: "settled",
          decryptedValue: releaseState.decryptedValue,
          winner: releaseState.winner,
          releaseTxSignature: releaseState.releaseTxSignature,
          approvalTxSignature: releaseState.approvalTxSignature,
          crossChainSignature: releaseState.crossChainSignature,
          signatureScheme: releaseState.signatureScheme,
          messageApprovalPda: releaseState.messageApprovalPda,
          requestAccount: releaseState.requestAccount,
          sessionPda: releaseState.sessionPda,
          termsHash: releaseState.termsHash,
          planHash: releaseState.planHash,
          buyerSettlementTarget: releaseState.buyerSettlementTarget,
          sellerSettlementTarget: releaseState.sellerSettlementTarget,
        } satisfies ConfidentialExecutionResult)
      : await deps.executeConfidentialRelease(ticketId, releaseState);

    if (!releasedResult.success) {
      await publishStage(context, "failed", "failed", {
        failedStage: "release_pending",
        error: releasedResult.error || "confidential release execution failed",
      });
      return {
        success: false,
        stage: "failed",
        route: context.route,
        status: "failed",
        error: releasedResult.error || "confidential release execution failed",
      };
    }

    if (!releaseState.releaseExecuted && releasedResult.releaseTxSignature) {
      await deps.releaseApprovalService.markReleaseExecuted(ticketId, {
        releaseTxSignature: releasedResult.releaseTxSignature,
        winner: releasedResult.winner || releaseState.winner || "",
      });
    }

    await publishStage(context, "release_pending", "confirmed", {
      releaseTxSignature: releasedResult.releaseTxSignature || null,
      winner: releasedResult.winner || null,
      decryptedValue: releasedResult.decryptedValue || null,
    });
    await publishStage(context, "settled", "confirmed", {
      crossChainSignature: releasedResult.crossChainSignature || null,
      messageApprovalPda: releasedResult.messageApprovalPda || null,
      winner: releasedResult.winner || null,
    });

    const status = await finalizePrivateSessionIfNeeded(context, releasedResult);
    await trackConfidentialDeal(context, releasedResult, status);
    deps.eventBus.publish("deal_executed", {
      ticket_id: context.ticketId,
      status,
    });

    return {
      success: true,
      stage: "settled",
      route: context.route,
      status,
      dealPda: releasedResult.dealPda,
      txSignatures: releasedResult.txSignatures,
    };
  }

  async function startPreparedOutcomeUnlocked(
    outcome: NegotiationOutcome,
    options: StartPipelineOptions
  ): Promise<DealPipelineExecutionResult> {
    const pipelineStartedAt = Date.now();
    let context: DealPipelineContext | null = null;
    let latestStage: Awaited<ReturnType<typeof deps.pipelineStateStore.getLatestStage>> = null;

    try {
      const preparedOutcome = await resolveOutcomeAgainstTicket(outcome);
      validateNegotiationOutcome(preparedOutcome);
      const strictPerOpaque =
        preparedOutcome.rollupMode === "PER" &&
        preparedOutcome.negotiationSource === "PER" &&
        isStrictPerOpaqueMode(deps.loadConfig());
      if (strictPerOpaque) {
        logger.info("per_strict_opaque_mode_enabled", {
          ticket_id: preparedOutcome.ticketId,
          termsVisibility: preparedOutcome.termsVisibility || "PLAINTEXT",
        });
        if (preparedOutcome.termsVisibility !== "REDACTED") {
          throw new Error(
            "per_strict_opaque_mode_violation:per_runtime_requires_redacted_private_intent"
          );
        }
        if (options.rememberTerms) {
          throw new Error(
            "per_strict_opaque_mode_violation:plaintext_terms_cannot_be_remembered"
          );
        }
      }
      if (options.rememberTerms) {
        await rememberOutcome(preparedOutcome);
      }
      context = await buildContext(preparedOutcome);
      const pipelineLog = logger.withContext({
        ticket_id: context.ticketId,
        route: context.route,
        negotiationSource: context.negotiationSource,
      });

      pipelineLog.info("deal_pipeline_started", {
        executionPolicy: context.executionPolicy,
        settlementPolicy: context.settlementPolicy,
        routeReason: context.routeReason,
      });

      latestStage = await deps.pipelineStateStore.getLatestStage(context.ticketId);
      if (latestStage?.status === "confirmed" && latestStage.stage === "escrow_created") {
        pipelineLog.info("deal_pipeline_skip_duplicate_dispatch", {
          latestStage: latestStage.stage,
          latestStatus: latestStage.status,
        });
        if (context.negotiationSource === "PER") {
          return continueConfidentialSettlementAfterFunding(context.ticketId, context);
        }
        const duplicateResult: DealPipelineExecutionResult = {
          success: true,
          stage: "escrow_created",
          route: context.route,
          status: "created_awaiting_deposits",
        };
        await appendPipelineSummary(context.ticketId, "deal_pipeline_completed", {
          ...duplicateResult,
          duplicateResume: true,
          durationMs: Date.now() - pipelineStartedAt,
        });
        return duplicateResult;
      }

      if (latestStage?.status === "confirmed" && latestStage.stage === "encrypted") {
        pipelineLog.info("deal_pipeline_skip_duplicate_confidential_dispatch", {
          latestStage: latestStage.stage,
          latestStatus: latestStage.status,
        });
        const duplicateResult: DealPipelineExecutionResult = {
          success: true,
          stage: "encrypted",
          route: context.route,
          status:
            context.negotiationSource === "PER"
              ? "confidential_pending_session_close"
              : "confidential_completed",
        };
        await appendPipelineSummary(context.ticketId, "deal_pipeline_completed", {
          ...duplicateResult,
          duplicateResume: true,
          durationMs: Date.now() - pipelineStartedAt,
        });
        return duplicateResult;
      }

      if (
        latestStage?.status === "confirmed" &&
        (latestStage.stage === "awaiting_settlement_plan_approvals" ||
          latestStage.stage === "awaiting_buyer_release_confirmation" ||
          latestStage.stage === "seller_dispute_window" ||
          latestStage.stage === "awaiting_release_approvals" ||
          latestStage.stage === "release_authorized" ||
          latestStage.stage === "release_signed")
      ) {
        pipelineLog.info("deal_pipeline_resume_confidential_release", {
          latestStage: latestStage.stage,
          latestStatus: latestStage.status,
        });
        return continueConfidentialRelease(context.ticketId, context);
      }

      if (latestStage?.status === "confirmed" && latestStage.stage === "settled") {
        pipelineLog.info("deal_pipeline_skip_duplicate_settlement", {
          latestStage: latestStage.stage,
          latestStatus: latestStage.status,
        });
        const duplicateResult: DealPipelineExecutionResult = {
          success: true,
          stage: "settled",
          route: context.route,
          status: "settled",
        };
        await appendPipelineSummary(context.ticketId, "deal_pipeline_completed", {
          ...duplicateResult,
          duplicateResume: true,
          durationMs: Date.now() - pipelineStartedAt,
        });
        return duplicateResult;
      }

      await publishStage(context, "received", "confirmed", {
        confidence: context.confidence,
        rollupMode: context.rollupMode,
      });
      await deps.pipelineStateStore.markRouteSelected(context.ticketId, context);
      deps.eventBus.publish("deal_pipeline_stage_changed", {
        ticketId: context.ticketId,
        stage: "route_selected",
        status: "confirmed",
        route: context.route,
        executionPolicy: context.executionPolicy,
        settlementPolicy: context.settlementPolicy,
        negotiationSource: context.negotiationSource,
      });
      const [, settlementPlan] = await Promise.all([
        runVerificationStage(context),
        runSettlementPreparationStage(context),
      ]);
      if (context.settlementPolicy === "STEALTH") {
        await runStealthSettlementStage(context, settlementPlan);
      }

      await publishStage(context, "dispatching", "pending", {
        dispatchRoute: context.route,
      });

      const result =
        context.route === "CONFIDENTIAL_ESCROW"
          ? await runConfidentialEscrow(context, settlementPlan, options.attestedEscrowIntent)
          : await runStandardEscrow(context, settlementPlan);

      if (options.attestedEscrowIntent) {
        await deps.privateEscrowIntentStore.updateStatus(
          options.attestedEscrowIntent.ticketId,
          options.attestedEscrowIntent.intentId,
          {
            status: result.stage === "settled" ? "settled" : "encrypted",
            dealPda: result.dealPda,
          }
        );
      }

      await appendPipelineSummary(context.ticketId, "deal_pipeline_completed", {
        route: context.route,
        executionPolicy: context.executionPolicy,
        settlementPolicy: context.settlementPolicy,
        stage: result.stage,
        status: result.status,
        success: result.success,
        dealPda: result.dealPda || null,
        txCount: result.txSignatures?.length || 0,
        privateEscrowIntentId: options.attestedEscrowIntent?.intentId || null,
        durationMs: Date.now() - pipelineStartedAt,
      });

      return result;
    } catch (error: any) {
      const ticketId = context?.ticketId || outcome.ticketId;
      const route = context?.route || null;
      const message = error?.message || String(error);

      logger.error(
        "deal_pipeline_failed",
        {
          ticket_id: ticketId,
          route,
          latestStage: latestStage?.stage || null,
        },
        error instanceof Error ? error : new Error(message)
      );

      await appendPipelineSummary(ticketId, "deal_pipeline_failed", {
        route,
        latestStage: latestStage?.stage || null,
        error: message,
        privateEscrowIntentId: options.attestedEscrowIntent?.intentId || null,
        durationMs: Date.now() - pipelineStartedAt,
      });

      if (options.attestedEscrowIntent) {
        await deps.privateEscrowIntentStore.updateStatus(
          options.attestedEscrowIntent.ticketId,
          options.attestedEscrowIntent.intentId,
          {
            status: "failed",
          }
        );
      }

      throw error;
    }
  }

  async function start(
    outcome: NegotiationOutcome
  ): Promise<DealPipelineExecutionResult> {
    return withTicketPipelineLock(outcome.ticketId, () =>
      startPreparedOutcomeUnlocked(outcome, { rememberTerms: true })
    );
  }

  async function startFromPrivateEscrowIntent(
    intent: AttestedEscrowIntent
  ): Promise<DealPipelineExecutionResult> {
    return withTicketPipelineLock(intent.ticketId, async () => {
      await deps.privateEscrowIntentStore.save?.(intent);
      const outcome = await buildNegotiationOutcomeFromPrivateIntent(intent);
      return startPreparedOutcomeUnlocked(outcome, {
        rememberTerms: false,
        attestedEscrowIntent: intent,
      });
    });
  }

  async function resumeTicket(ticketId: string): Promise<DealPipelineExecutionResult> {
    const ticket = await deps.ticketStore.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket ${ticketId} not found for pipeline resume`);
    }

    if (ticket.rollup_mode === "PER" && isStrictPerOpaqueMode(deps.loadConfig())) {
      const privateIntent = await deps.privateEscrowIntentStore.getLatestByTicket?.(ticketId);
      if (!privateIntent) {
        throw new Error(`Ticket ${ticketId} has no stored private escrow intent to resume from`);
      }
      return startFromPrivateEscrowIntent(privateIntent);
    }

    if (!ticket.agreed_terms) {
      if (ticket.rollup_mode === "PER") {
        const privateIntent = await deps.privateEscrowIntentStore.getLatestByTicket?.(ticketId);
        if (!privateIntent) {
          throw new Error(`Ticket ${ticketId} has no stored private escrow intent to resume from`);
        }
        return startFromPrivateEscrowIntent(privateIntent);
      }
      throw new Error(`Ticket ${ticketId} has no stored negotiated terms to resume from`);
    }

    const rollupMode = ticket.rollup_mode || "NONE";
    return start({
      ticketId,
      buyer: ticket.buyer,
      seller: ticket.seller,
      price: ticket.agreed_terms.price,
      collateralBuyer: ticket.agreed_terms.collateral_buyer,
      collateralSeller: ticket.agreed_terms.collateral_seller,
      assetType: ticket.agreed_terms.asset_type || ticket.tokenMint || "SOL",
      tokenMint: ticket.tokenMint,
      decimals: ticket.decimals,
      confidence: 100,
      rollupMode,
      negotiationSource: inferNegotiationSource(rollupMode),
    });
  }

  return {
    buildNegotiationOutcome,
    buildNegotiationOutcomeFromPrivateIntent,
    start,
    startFromPrivateEscrowIntent,
    continueConfidentialSettlementAfterFunding,
    continueConfidentialRelease,
    resumeTicket,
  };
}

export const dealPipeline = createDealPipeline();
