import fs from "fs";
import path from "path";
import nacl from "tweetnacl";
import {
  Connection,
  Ed25519Program,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { loadConfig } from "../config";
import { loadWallet } from "../solana/wallet";
import { getConnection } from "../solana/connection";
import { eventBus } from "./eventBus";
import { logger } from "../utils/logger";
import { prisma } from "../lib/prisma";
import { deliverStructuredToAgent } from "./outboundRouter";
import { releaseApprovalStore } from "../state/releaseApprovalStore";
import { walletRegistry } from "../state/walletRegistry";
import { confidentialIdentityStore } from "../state/confidentialIdentityStore";
import type { AgentMessage } from "../protocol/agentProtocol";
import {
  buildReleaseApprovalPayload,
  computeSettlementPlanHash,
  encodeReleaseApprovalMessageBase64,
  ReleaseApprovalAction,
  ReleaseApprovalCanonicalPayload,
  type ReleaseApprovalRequestKind,
  type ReleaseApprovalRecord,
  type ReleaseApprovalRequestEnvelope,
  type ReleaseApprovalRole,
  type ReleaseApprovalStateSnapshot,
  serializeReleaseApprovalPayload,
} from "../protocol/releaseApprovalProtocol";
import type {
  DealPipelineContext,
  AttestedEscrowIntent,
  SettlementAddressPlan,
} from "../types/dealPipeline";

const CONFIDENTIAL_ESCROW_IDL_PATH = path.join(
  __dirname,
  "../../../escrow/target/idl/escrow_confidential.json"
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function confirmSubmittedTransaction(
  connection: Connection,
  signature: string,
  context: Record<string, unknown>
): Promise<void> {
  try {
    await connection.confirmTransaction(signature, "confirmed");
    return;
  } catch (error) {
    logger.warn("release_approval_confirm_timeout_checking_status", {
      ...context,
      txSignature: signature,
      error: error instanceof Error ? error.message : String(error),
    });

    for (let attempt = 1; attempt <= 8; attempt++) {
      const status = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const value = status.value[0];
      if (value?.err) {
        throw new Error(`Release approval transaction ${signature} failed on-chain: ${JSON.stringify(value.err)}`);
      }
      if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") {
        logger.info("release_approval_tx_confirmed_by_status_lookup", {
          ...context,
          txSignature: signature,
          attempt,
          confirmationStatus: value.confirmationStatus,
        });
        return;
      }
      await sleep(1_500);
    }

    throw error;
  }
}

export interface PreparedConfidentialSettlement {
  ticketId: string;
  dealPda: string;
  sessionPda: string;
  intentId?: string;
  termsHash: string;
  planHash?: string;
  buyerSettlementTarget: string;
  sellerSettlementTarget: string;
  requestAccount: string;
  dwalletPda: string;
  decryptedValue: string;
  winner: string;
  txSignatures: string[];
}

function getConfidentialEscrowProgram(): { connection: Connection; program: Program; programId: PublicKey } {
  const config = loadConfig();
  const connection = getConnection();
  const payer = loadWallet(config.privateKey);
  const idlPath = process.env.CONFIDENTIAL_ESCROW_IDL_PATH || CONFIDENTIAL_ESCROW_IDL_PATH;
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const programId = new PublicKey(
    config.confidentialEscrowProgramId ||
      (idl as any).metadata?.address ||
      (idl as any).address ||
      "BuTf7gVrjD2wzKe4Tu1Ny2m7gC9SY65fRCY7gHnBgLqj"
  );
  (idl as any).address = programId.toBase58();
  return {
    connection,
    program: new Program(idl as any, provider),
    programId,
  };
}

const REQUEST_TTL_MS = 10 * 60 * 1000;
const BUYER_ROLE_SEED = 0;
const SELLER_ROLE_SEED = 1;

function encodeApprovalRoleSeed(role: ReleaseApprovalRole): number {
  return role === "buyer" ? BUYER_ROLE_SEED : SELLER_ROLE_SEED;
}

function getSellerDisputeWindowMs(): number {
  return loadConfig().releaseDisputeWindowSeconds * 1000;
}

async function loadTicketAgents(
  ticketId: string,
  wallets?: { buyerWallet: string; sellerWallet: string }
): Promise<{
  buyerAgentId: string;
  sellerAgentId: string;
}> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { buyerId: true, sellerId: true },
  });

  if (ticket) {
    return {
      buyerAgentId: ticket.buyerId,
      sellerAgentId: ticket.sellerId,
    };
  }

  if (!wallets?.buyerWallet || !wallets?.sellerWallet) {
    throw new Error(`release_approval_ticket_missing:${ticketId}`);
  }

  const [buyerAgent, sellerAgent] = await Promise.all([
    walletRegistry.getOrCreateAgent(wallets.buyerWallet),
    walletRegistry.getOrCreateAgent(wallets.sellerWallet),
  ]);

  logger.warn("release_approval_ticket_missing_fallback", {
    ticket_id: ticketId,
    buyer_wallet: wallets.buyerWallet,
    seller_wallet: wallets.sellerWallet,
    buyer_agent_id: buyerAgent.id,
    seller_agent_id: sellerAgent.id,
  });

  return {
    buyerAgentId: buyerAgent.id,
    sellerAgentId: sellerAgent.id,
  };
}

function buildSummary(
  context: DealPipelineContext,
  role: ReleaseApprovalRole,
  expiresAt: Date,
  requestKind: ReleaseApprovalRequestKind,
  disputeWindowEndsAt?: Date
) {
  const redacted = context.termsVisibility === "REDACTED";
  return {
    ticketId: context.ticketId,
    role,
    counterparty: role === "buyer" ? context.seller : context.buyer,
    asset: context.assetType,
    price: redacted ? 0 : context.price,
    buyerCollateral: redacted ? 0 : context.collateralBuyer,
    sellerCollateral: redacted ? 0 : context.collateralSeller,
    settlementMode:
      context.settlementPolicy === "STEALTH"
        ? "Stealth settlement"
        : "Public wallet settlement",
    actionLabel:
      requestKind === "SETTLEMENT_PLAN"
        ? "Approve settlement plan"
        : "Confirm final release",
    expiresAt: expiresAt.toISOString(),
    disputeWindowEndsAt: disputeWindowEndsAt?.toISOString(),
    redacted,
    localTermsRequired: redacted,
  } as const;
}

function nextRoleNonce(
  state: ReleaseApprovalStateSnapshot | null,
  role: ReleaseApprovalRole
): bigint {
  if (!state) return 1n;
  const records =
    role === "buyer"
      ? [state.buyerApproval, state.buyerReleaseConfirmation]
      : [state.sellerApproval];
  const maxNonce = records.reduce<bigint>(
    (current, record) => (record ? BigInt(record.nonce) > current ? BigInt(record.nonce) : current : current),
    0n
  );
  return maxNonce + 1n;
}

function derivePayloadForAction(
  snapshot: ReleaseApprovalStateSnapshot,
  role: ReleaseApprovalRole,
  action: ReleaseApprovalAction,
  nowMs: number
): ReleaseApprovalCanonicalPayload {
  const expiresAtMs = BigInt(nowMs + 10 * 60 * 1000);
  return buildReleaseApprovalPayload({
    action,
    ticketId: snapshot.ticketId,
    dealPda: snapshot.dealPda,
    sessionPda: snapshot.sessionPda,
    intentId: snapshot.intentId,
    role,
    route: snapshot.route,
    settlementPolicy: snapshot.settlementPolicy,
    termsHash: snapshot.termsHash,
    planHash: snapshot.planHash,
    nonce: nextRoleNonce(snapshot, role),
    expiresAt: expiresAtMs,
    timestamp: BigInt(nowMs),
  });
}

function toAnchorReleaseApprovalPayload(payload: ReleaseApprovalCanonicalPayload) {
  const approvalAction =
    payload.action === "APPROVE_SETTLEMENT"
      ? { approveSettlement: {} }
      : payload.action === "REVOKE_SETTLEMENT"
        ? { revokeSettlement: {} }
        : payload.action === "CONFIRM_RELEASE"
          ? { confirmRelease: {} }
          : { openDispute: {} };

  const approvalRole =
    payload.role === "buyer" ? { buyer: {} } : { seller: {} };

  const settlementPolicy =
    payload.settlementPolicy === "STEALTH" ? { stealth: {} } : { direct: {} };

  return {
    version: payload.version,
    action: approvalAction,
    ticketIdHash: Array.from(Buffer.from(payload.ticketIdHash, "hex")),
    dealPda: new PublicKey(payload.dealPda),
    sessionPda: new PublicKey(payload.sessionPda),
    intentIdHash: Array.from(Buffer.from(payload.intentIdHash, "hex")),
    role: approvalRole,
    route: { confidentialEscrow: {} },
    settlementPolicy,
    termsHash: Array.from(Buffer.from(payload.termsHash, "hex")),
    planHash: Array.from(Buffer.from(payload.planHash, "hex")),
    nonce: new BN(payload.nonce),
    expiresAt: new BN(payload.expiresAt),
    timestamp: new BN(payload.timestamp),
  };
}

function resolveRequestFromState(
  state: ReleaseApprovalStateSnapshot,
  requestId: string
): {
  role: ReleaseApprovalRole;
  requestKind: ReleaseApprovalRequestKind;
  request: ReleaseApprovalRequestEnvelope;
} {
  if (state.buyerReleaseRequest?.requestId === requestId) {
    return {
      role: "buyer",
      requestKind: "BUYER_RELEASE_CONFIRMATION",
      request: state.buyerReleaseRequest,
    };
  }
  if (state.buyerRequest.requestId === requestId) {
    return {
      role: "buyer",
      requestKind: "SETTLEMENT_PLAN",
      request: state.buyerRequest,
    };
  }
  if (state.sellerRequest.requestId === requestId) {
    return {
      role: "seller",
      requestKind: "SETTLEMENT_PLAN",
      request: state.sellerRequest,
    };
  }
  throw new Error(`release_approval_request_missing:${requestId}`);
}

function mapMessageTypeToAction(
  type: AgentMessage["type"],
  requestKind: ReleaseApprovalRequestKind
): ReleaseApprovalAction | null {
  if (type === "RELEASE_DISPUTE_OPEN") return "OPEN_DISPUTE";
  if (type === "RELEASE_APPROVAL_REVOKE") {
    return requestKind === "SETTLEMENT_PLAN" ? "REVOKE_SETTLEMENT" : null;
  }
  if (type === "RELEASE_APPROVAL_RESPONSE") {
    return requestKind === "BUYER_RELEASE_CONFIRMATION"
      ? "CONFIRM_RELEASE"
      : "APPROVE_SETTLEMENT";
  }
  return null;
}

function buildBuyerReleaseRequest(
  state: ReleaseApprovalStateSnapshot,
  issuedAt: Date
): ReleaseApprovalRequestEnvelope {
  const expiresAt = new Date(issuedAt.getTime() + REQUEST_TTL_MS);
  const payload = buildReleaseApprovalPayload({
    action: "CONFIRM_RELEASE",
    ticketId: state.ticketId,
    dealPda: state.dealPda,
    sessionPda: state.sessionPda,
    intentId: state.intentId,
    role: "buyer",
    route: state.route,
    settlementPolicy: state.settlementPolicy,
    termsHash: state.termsHash,
    planHash: state.planHash,
    nonce: nextRoleNonce(state, "buyer"),
    expiresAt: BigInt(expiresAt.getTime()),
    timestamp: BigInt(issuedAt.getTime()),
  });

  return {
    requestId: `${state.ticketId}:buyer:release:${payload.nonce}`,
    ticketId: state.ticketId,
    role: "buyer",
    requestKind: "BUYER_RELEASE_CONFIRMATION",
    summary: {
      ...state.buyerRequest.summary,
      actionLabel: "Confirm final release",
      expiresAt: expiresAt.toISOString(),
    },
    payload,
    messageBase64: encodeReleaseApprovalMessageBase64(payload),
    issuedAt: issuedAt.toISOString(),
  };
}

function shouldSendSettlementPlanRequest(
  state: ReleaseApprovalStateSnapshot,
  role: ReleaseApprovalRole
): boolean {
  return role === "buyer"
    ? !state.buyerApproval?.active
    : !state.sellerApproval?.active;
}

async function sendReleaseApprovalRequest(
  agentId: string,
  request: ReleaseApprovalRequestEnvelope,
  options: { allowRepeatDeliveryWhenSent?: boolean } = {}
): Promise<void> {
  const wsPayload = {
    type: "RELEASE_APPROVAL_REQUEST",
    ticket_id: request.ticketId,
    payload: request,
  };
  const phase =
    request.requestKind === "BUYER_RELEASE_CONFIRMATION"
      ? "awaiting_buyer_release_confirmation"
      : "awaiting_settlement_plan_approvals";
  await deliverStructuredToAgent({
    ticketId: request.ticketId,
    agentId,
    payload: wsPayload,
    phase,
    eventType: "release_approval_request",
    timestamp: request.issuedAt,
    idempotencyKey: `${request.ticketId}:${agentId}:release_approval_request:${request.requestId}`,
    allowRepeatDeliveryWhenSent: options.allowRepeatDeliveryWhenSent,
  });
}

class ReleaseApprovalService {
  private authorizationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private clearAuthorizationTimer(ticketId: string): void {
    const timer = this.authorizationTimers.get(ticketId);
    if (timer) {
      clearTimeout(timer);
      this.authorizationTimers.delete(ticketId);
    }
  }

  private scheduleAuthorizationCheck(ticketId: string, deadlineIso: string): void {
    this.clearAuthorizationTimer(ticketId);
    const delayMs = Math.max(0, new Date(deadlineIso).getTime() - Date.now());
    const timer = setTimeout(() => {
      void this.maybeAuthorizeRelease(ticketId);
    }, delayMs);
    this.authorizationTimers.set(ticketId, timer);
  }

  async maybeAuthorizeRelease(
    ticketId: string,
    state?: ReleaseApprovalStateSnapshot
  ): Promise<ReleaseApprovalStateSnapshot | null> {
    const current = state || (await releaseApprovalStore.getLatestByTicket(ticketId));
    if (!current) {
      return null;
    }
    if (
      current.releaseAuthorized ||
      current.releaseExecuted ||
      current.disputeOpen ||
      !current.settlementPlanApproved ||
      !current.buyerReleaseConfirmed ||
      !current.sellerDisputeDeadlineAt
    ) {
      if (current.releaseAuthorized || current.releaseExecuted || current.disputeOpen) {
        this.clearAuthorizationTimer(ticketId);
      }
      return current;
    }

    const deadlineMs = new Date(current.sellerDisputeDeadlineAt).getTime();
    if (!Number.isFinite(deadlineMs)) {
      return current;
    }
    if (Date.now() < deadlineMs) {
      this.scheduleAuthorizationCheck(ticketId, current.sellerDisputeDeadlineAt);
      return current;
    }

    this.clearAuthorizationTimer(ticketId);
    const authorizedState = await releaseApprovalStore.markAuthorized(ticketId);
    if (authorizedState && !authorizedState.disputeOpen) {
      eventBus.publish("release_authorized", {
        ticketId,
        dealPda: authorizedState.dealPda,
      });
      return authorizedState;
    }
    return current;
  }

  async initializeApprovalRequests(
    context: DealPipelineContext,
    prepared: PreparedConfidentialSettlement,
    settlementPlan: SettlementAddressPlan,
    attestedEscrowIntent?: AttestedEscrowIntent
  ): Promise<ReleaseApprovalStateSnapshot> {
    const { buyerAgentId, sellerAgentId } = await loadTicketAgents(context.ticketId, {
      buyerWallet: context.buyer,
      sellerWallet: context.seller,
    });
    const identitySnapshot = await confidentialIdentityStore.getLatestByTicket(context.ticketId);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + REQUEST_TTL_MS);
    const planHash =
      prepared.planHash ||
      computeSettlementPlanHash({
        policy: context.settlementPolicy,
        buyerSettlementTarget: prepared.buyerSettlementTarget,
        sellerSettlementTarget: prepared.sellerSettlementTarget,
      });

    const common = {
      ticketId: context.ticketId,
      dealPda: prepared.dealPda,
      sessionPda: prepared.sessionPda,
      intentId: prepared.intentId || attestedEscrowIntent?.intentId,
      route: "CONFIDENTIAL_ESCROW" as const,
      settlementPolicy: context.settlementPolicy,
      termsHash: prepared.termsHash,
      planHash,
    };

    const buyerPayload = buildReleaseApprovalPayload({
      ...common,
      action: "APPROVE_SETTLEMENT",
      role: "buyer",
      nonce: 1n,
      expiresAt: BigInt(expiresAt.getTime()),
      timestamp: BigInt(issuedAt.getTime()),
    });
    const sellerPayload = buildReleaseApprovalPayload({
      ...common,
      action: "APPROVE_SETTLEMENT",
      role: "seller",
      nonce: 1n,
      expiresAt: BigInt(expiresAt.getTime()),
      timestamp: BigInt(issuedAt.getTime()),
    });

    const buyerRequest: ReleaseApprovalRequestEnvelope = {
      requestId: `${context.ticketId}:buyer:1`,
      ticketId: context.ticketId,
      role: "buyer",
      requestKind: "SETTLEMENT_PLAN",
      summary: buildSummary(context, "buyer", expiresAt, "SETTLEMENT_PLAN"),
      payload: buyerPayload,
      messageBase64: encodeReleaseApprovalMessageBase64(buyerPayload),
      issuedAt: issuedAt.toISOString(),
    };
    const sellerRequest: ReleaseApprovalRequestEnvelope = {
      requestId: `${context.ticketId}:seller:1`,
      ticketId: context.ticketId,
      role: "seller",
      requestKind: "SETTLEMENT_PLAN",
      summary: buildSummary(context, "seller", expiresAt, "SETTLEMENT_PLAN"),
      payload: sellerPayload,
      messageBase64: encodeReleaseApprovalMessageBase64(sellerPayload),
      issuedAt: issuedAt.toISOString(),
    };

    const snapshot: ReleaseApprovalStateSnapshot = {
      ticketId: context.ticketId,
      dealPda: prepared.dealPda,
      sessionPda: prepared.sessionPda,
      intentId: prepared.intentId || attestedEscrowIntent?.intentId,
      buyerWallet: context.buyer,
      sellerWallet: context.seller,
      buyerFundingWallet: identitySnapshot?.buyerFundingWallet,
      sellerFundingWallet: identitySnapshot?.sellerFundingWallet,
      route: "CONFIDENTIAL_ESCROW",
      settlementPolicy: context.settlementPolicy,
      termsHash: prepared.termsHash,
      planHash,
      buyerSettlementTarget: prepared.buyerSettlementTarget,
      sellerSettlementTarget: prepared.sellerSettlementTarget,
      requestIssuedAt: issuedAt.toISOString(),
      buyerRequest,
      sellerRequest,
      settlementPlanApproved: false,
      buyerReleaseConfirmed: false,
      disputeOpen: false,
      releaseAuthorized: false,
      releaseSigned: false,
      releaseExecuted: false,
      requestAccount: prepared.requestAccount,
      dwalletPda: prepared.dwalletPda,
      decryptedValue: prepared.decryptedValue,
      winner: prepared.winner,
      txSignatures: [...prepared.txSignatures],
      updatedAt: issuedAt.toISOString(),
    };

    await releaseApprovalStore.createInitial(snapshot);
    await Promise.all([
      sendReleaseApprovalRequest(buyerAgentId, buyerRequest),
      sendReleaseApprovalRequest(sellerAgentId, sellerRequest),
    ]);

    eventBus.publish("release_approval_requested", {
      ticketId: context.ticketId,
      dealPda: prepared.dealPda,
      role: "buyer",
      request: buyerRequest,
    });
    eventBus.publish("release_approval_requested", {
      ticketId: context.ticketId,
      dealPda: prepared.dealPda,
      role: "seller",
      request: sellerRequest,
    });

    return snapshot;
  }

  async getLatestState(ticketId: string): Promise<ReleaseApprovalStateSnapshot | null> {
    return releaseApprovalStore.getLatestByTicket(ticketId);
  }

  async resendPendingRequests(ticketId: string, agentId: string): Promise<void> {
    const state = await releaseApprovalStore.getLatestByTicket(ticketId);
    if (!state) {
      return;
    }

    const agent = await walletRegistry.getAgentById(agentId);
    if (!agent) {
      return;
    }

    if (agent.wallet === state.buyerWallet) {
      if (shouldSendSettlementPlanRequest(state, "buyer")) {
        await sendReleaseApprovalRequest(agentId, state.buyerRequest, {
          allowRepeatDeliveryWhenSent: true,
        });
        return;
      }

      if (
        state.settlementPlanApproved &&
        !state.buyerReleaseConfirmed &&
        !state.disputeOpen &&
        state.buyerReleaseRequest
      ) {
        await sendReleaseApprovalRequest(agentId, state.buyerReleaseRequest, {
          allowRepeatDeliveryWhenSent: true,
        });
      }
      return;
    }

    if (agent.wallet === state.sellerWallet && shouldSendSettlementPlanRequest(state, "seller")) {
      await sendReleaseApprovalRequest(agentId, state.sellerRequest, {
        allowRepeatDeliveryWhenSent: true,
      });
    }
  }

  async processAgentResponse(message: Extract<
    AgentMessage,
    { type: "RELEASE_APPROVAL_RESPONSE" | "RELEASE_APPROVAL_REVOKE" | "RELEASE_DISPUTE_OPEN" }
  >): Promise<ReleaseApprovalStateSnapshot> {
    logger.info("release_approval_processing_started", {
      ticket_id: message.ticket_id,
      requestId: message.requestId,
      type: message.type,
      agent_id: message.agent_id,
    });
    const state = await releaseApprovalStore.getLatestByTicket(message.ticket_id);
    if (!state) {
      throw new Error(`release_approval_state_missing:${message.ticket_id}`);
    }
    const requestMeta = resolveRequestFromState(state, message.requestId);
    const action = mapMessageTypeToAction(message.type, requestMeta.requestKind);
    if (!action) {
      throw new Error(
        `unsupported_release_approval_message:${message.type}:${requestMeta.requestKind}`
      );
    }

    const agent = await prisma.agent.findUnique({
      where: { id: message.agent_id },
      select: { wallet: true },
    });
    if (!agent) {
      throw new Error(`release_approval_agent_missing:${message.agent_id}`);
    }

    const role: ReleaseApprovalRole = requestMeta.role;
    const expectedAgentWallet = role === "buyer" ? state.buyerWallet : state.sellerWallet;
    if (agent.wallet !== expectedAgentWallet) {
      throw new Error(`release_approval_wrong_agent:${message.agent_id}`);
    }
    const expectedSignerWallet =
      role === "buyer"
        ? state.buyerFundingWallet || state.buyerWallet
        : state.sellerFundingWallet || state.sellerWallet;
    const roleSeed = encodeApprovalRoleSeed(role);
    const payload =
      action === "APPROVE_SETTLEMENT" || action === "CONFIRM_RELEASE"
        ? requestMeta.request.payload
        : derivePayloadForAction(state, role, action, message.timestamp);
    const messageBytes = serializeReleaseApprovalPayload(payload);
    const signature = Buffer.from(message.signatureBase64, "base64");

    if (
      !nacl.sign.detached.verify(
        messageBytes,
        signature,
        new PublicKey(expectedSignerWallet).toBytes()
      )
    ) {
      throw new Error(`invalid_release_approval_signature:${message.requestId}`);
    }

    logger.info("release_approval_signature_verified", {
      ticket_id: message.ticket_id,
      requestId: message.requestId,
      role,
      action,
      wallet: expectedSignerWallet,
    });

    eventBus.publish("release_approval_received", {
      ticketId: message.ticket_id,
      requestId: message.requestId,
      role,
      agentId: message.agent_id,
      action,
    });

    const { connection, program } = getConfidentialEscrowProgram();
    const payer = loadWallet(loadConfig().privateKey);
    const dealPda = new PublicKey(state.dealPda);
    const approverWallet = new PublicKey(expectedSignerWallet);
    const [approvalPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("release_approval"), dealPda.toBuffer(), Buffer.from([roleSeed])],
      program.programId
    );
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: approverWallet.toBytes(),
      message: messageBytes,
      signature,
      instructionIndex: 0,
    });

    const methodName =
      action === "APPROVE_SETTLEMENT"
        ? "submitReleaseApproval"
        : action === "REVOKE_SETTLEMENT"
          ? "revokeReleaseApproval"
          : action === "CONFIRM_RELEASE"
            ? "confirmRelease"
            : "openReleaseDispute";

    const ixBuilder = (program.methods as any)[methodName](
      toAnchorReleaseApprovalPayload(payload),
      roleSeed
    );
    const tx = new Transaction().add(ed25519Ix);
    const methodIx = await ixBuilder.accounts({
      deal: dealPda,
      releaseApproval: approvalPda,
      approver: approverWallet,
      payer: payer.publicKey,
      instructions: new PublicKey("Sysvar1nstructions1111111111111111111111111"),
      systemProgram: SystemProgram.programId,
    }).instruction();
    tx.add(methodIx);
    logger.info("release_approval_tx_submitting", {
      ticket_id: message.ticket_id,
      requestId: message.requestId,
      role,
      action,
      approvalPda: approvalPda.toBase58(),
      dealPda: dealPda.toBase58(),
    });
    const txSignature = await connection.sendTransaction(tx, [payer], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    logger.info("release_approval_tx_submitted", {
      ticket_id: message.ticket_id,
      requestId: message.requestId,
      role,
      action,
      txSignature,
    });
    await confirmSubmittedTransaction(connection, txSignature, {
      ticket_id: message.ticket_id,
      requestId: message.requestId,
      role,
      action,
    });
    logger.info("release_approval_tx_confirmed", {
      ticket_id: message.ticket_id,
      requestId: message.requestId,
      role,
      action,
      txSignature,
    });

    const record: ReleaseApprovalRecord = {
      agentId: message.agent_id,
      wallet: expectedSignerWallet,
      action,
      signatureBase64: message.signatureBase64,
      txSignature,
      approvalPda: approvalPda.toBase58(),
      recordedAt: new Date().toISOString(),
      nonce: payload.nonce,
      active: action === "APPROVE_SETTLEMENT" || action === "CONFIRM_RELEASE",
    };

    let nextState: ReleaseApprovalStateSnapshot | null = null;
    if (action === "APPROVE_SETTLEMENT") {
      nextState = await releaseApprovalStore.recordApproval(message.ticket_id, role, record);
      eventBus.publish("release_approval_recorded", {
        ticketId: message.ticket_id,
        requestId: message.requestId,
        role,
        approvalPda: approvalPda.toBase58(),
        txSignature,
      });
    } else if (action === "REVOKE_SETTLEMENT") {
      nextState = await releaseApprovalStore.markRevoked(message.ticket_id, role, record);
      eventBus.publish("release_approval_revoked", {
        ticketId: message.ticket_id,
        requestId: message.requestId,
        role,
        txSignature,
      });
    } else if (action === "CONFIRM_RELEASE") {
      const disputeOpenedAt = new Date();
      const disputeDeadlineAt = new Date(
        disputeOpenedAt.getTime() + getSellerDisputeWindowMs()
      );
      nextState = await releaseApprovalStore.markBuyerReleaseConfirmed(
        message.ticket_id,
        record,
        disputeOpenedAt.toISOString(),
        disputeDeadlineAt.toISOString()
      );
      eventBus.publish("release_approval_recorded", {
        ticketId: message.ticket_id,
        requestId: message.requestId,
        role,
        approvalPda: approvalPda.toBase58(),
        txSignature,
      });
    } else {
      this.clearAuthorizationTimer(message.ticket_id);
      nextState = await releaseApprovalStore.markDispute(message.ticket_id, role, record);
      eventBus.publish("release_dispute_opened", {
        ticketId: message.ticket_id,
        requestId: message.requestId,
        role,
        txSignature,
        disputeReason: message.disputeReason,
      });
    }

    if (!nextState) {
      throw new Error(`release_approval_state_update_failed:${message.ticket_id}`);
    }

    if (
      action === "APPROVE_SETTLEMENT" &&
      nextState.buyerApproval?.active &&
      nextState.sellerApproval?.active &&
      !nextState.buyerReleaseRequest &&
      !nextState.disputeOpen
    ) {
      const buyerReleaseRequest = buildBuyerReleaseRequest(nextState, new Date());
      const updatedState = await releaseApprovalStore.attachBuyerReleaseRequest(
        message.ticket_id,
        buyerReleaseRequest
      );
      if (updatedState) {
        nextState = updatedState;
      }
      const { buyerAgentId } = await loadTicketAgents(message.ticket_id, {
        buyerWallet: nextState.buyerWallet,
        sellerWallet: nextState.sellerWallet,
      });
      await sendReleaseApprovalRequest(buyerAgentId, buyerReleaseRequest);
      eventBus.publish("deal_pipeline_stage_changed", {
        ticketId: message.ticket_id,
        stage: "awaiting_buyer_release_confirmation",
        status: "confirmed",
        route: nextState.route,
        executionPolicy: "CONFIDENTIAL",
        settlementPolicy: nextState.settlementPolicy,
        negotiationSource: nextState.buyerRequest.summary.localTermsRequired ? "PER" : "ER",
      });
      eventBus.publish("deal_executed", {
        ticket_id: message.ticket_id,
        status: "awaiting_buyer_release_confirmation",
      });
      eventBus.publish("release_approval_requested", {
        ticketId: message.ticket_id,
        dealPda: nextState.dealPda,
        role: "buyer",
        request: buyerReleaseRequest,
      });
    }

    nextState = (await this.maybeAuthorizeRelease(message.ticket_id, nextState)) || nextState;
    return nextState;
  }

  async markReleaseSigned(
    ticketId: string,
    update: Pick<
      ReleaseApprovalStateSnapshot,
      "messageApprovalPda" | "approvalTxSignature" | "crossChainSignature" | "signatureScheme"
    >
  ): Promise<ReleaseApprovalStateSnapshot | null> {
    return releaseApprovalStore.markReleaseSigned(ticketId, update);
  }

  async markReleaseExecuted(
    ticketId: string,
    update: Pick<ReleaseApprovalStateSnapshot, "releaseTxSignature" | "winner">
  ): Promise<ReleaseApprovalStateSnapshot | null> {
    this.clearAuthorizationTimer(ticketId);
    return releaseApprovalStore.markReleaseExecuted(ticketId, update);
  }
}

export const releaseApprovalService = new ReleaseApprovalService();
