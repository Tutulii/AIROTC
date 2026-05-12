import crypto from "crypto";
import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";
import { walletRegistry } from "../state/walletRegistry";
import { eventBus } from "./eventBus";
import { prisma } from "../lib/prisma";
import { confidentialFundingStore } from "../state/confidentialFundingStore";
import { confidentialIdentityStore } from "../state/confidentialIdentityStore";
import { deliverStructuredToAgent } from "./outboundRouter";
import type {
  ConfidentialFundingPartyRole,
  ConfidentialFundingRequestEnvelope,
  ConfidentialFundingStateSnapshot,
  FundingPrivacyTier,
} from "../protocol/confidentialFundingProtocol";
import type { ConfidentialFundingRole } from "../protocol/privateHandoffProtocol";
import type { DealPipelineContext, AttestedEscrowIntent } from "../types/dealPipeline";

const REQUEST_TTL_MS = 10 * 60 * 1000;
const DEPOSIT_ENCRYPTED_DISCRIMINATOR = crypto
  .createHash("sha256")
  .update("global:deposit_encrypted", "utf8")
  .digest()
  .subarray(0, 8);
const LOCK_CREDIT_FOR_DEAL_DISCRIMINATOR = crypto
  .createHash("sha256")
  .update("global:lock_credit_for_deal", "utf8")
  .digest()
  .subarray(0, 8);

function decodeFundingRole(roleCode: number): ConfidentialFundingRole | null {
  switch (roleCode) {
    case 0:
      return "buyer_payment";
    case 1:
      return "buyer_collateral";
    case 2:
      return "seller_collateral";
    default:
      return null;
  }
}

function readAccountKey(message: any, index: number): PublicKey | null {
  if (typeof message?.getAccountKeys === "function") {
    const accountKeys = message.getAccountKeys();
    if (typeof accountKeys?.get === "function") {
      return accountKeys.get(index) || null;
    }
    if (Array.isArray(accountKeys?.staticAccountKeys)) {
      return accountKeys.staticAccountKeys[index] || null;
    }
  }
  if (Array.isArray(message?.staticAccountKeys)) {
    return message.staticAccountKeys[index] || null;
  }
  return null;
}

interface ObservedFundingEntry {
  role: ConfidentialFundingRole;
  amountLamports: bigint;
}

function extractObservedFundingEntries(input: {
  tx: any;
  confidentialEscrowProgramId: string;
  expectedWallet: string;
  dealPda: string;
  fundingRail: FundingPrivacyTier;
}): ObservedFundingEntry[] {
  const compiledInstructions = input.tx?.transaction?.message?.compiledInstructions || [];
  const observedEntries: ObservedFundingEntry[] = [];

  for (const ix of compiledInstructions) {
    const programKey = readAccountKey(input.tx.transaction.message, ix.programIdIndex);
    if (!programKey || programKey.toBase58() !== input.confidentialEscrowProgramId) {
      continue;
    }

    const rawData = typeof ix.data === "string" ? Buffer.from(bs58.decode(ix.data)) : Buffer.from(ix.data);
    if (rawData.length < 17) {
      continue;
    }

    const isDirectSolDeposit = rawData.subarray(0, 8).equals(DEPOSIT_ENCRYPTED_DISCRIMINATOR);
    const isShieldedCreditLock = rawData.subarray(0, 8).equals(LOCK_CREDIT_FOR_DEAL_DISCRIMINATOR);
    if (input.fundingRail === "SHIELDED_CREDIT" && !isShieldedCreditLock) {
      continue;
    }
    if (input.fundingRail !== "SHIELDED_CREDIT" && !isDirectSolDeposit) {
      continue;
    }

    const dealAccountIndex = isShieldedCreditLock ? 3 : 0;
    const signerAccountIndex = isShieldedCreditLock ? 4 : 1;
    const dealKey = readAccountKey(
      input.tx.transaction.message,
      ix.accountKeyIndexes?.[dealAccountIndex] ?? -1
    );
    const depositorKey = readAccountKey(
      input.tx.transaction.message,
      ix.accountKeyIndexes?.[signerAccountIndex] ?? -1
    );
    if (!dealKey || !depositorKey) {
      continue;
    }
    if (dealKey.toBase58() !== input.dealPda || depositorKey.toBase58() !== input.expectedWallet) {
      continue;
    }

    const role = decodeFundingRole(rawData[8]);
    if (role) {
      observedEntries.push({
        role,
        amountLamports: rawData.readBigUInt64LE(9),
      });
    }
  }

  return observedEntries;
}

function resolveFundingRail(config: ReturnType<typeof loadConfig>): FundingPrivacyTier {
  const rail = config.perFundingPrivacyTier || "SHIELDED_CREDIT";
  if (
    config.perStrictOpaqueMode &&
    rail === "DIRECT_SOL" &&
    !config.perAllowDirectSolUnsafe
  ) {
    throw new Error(
      "strict_per_direct_sol_blocked: set PER_ALLOW_DIRECT_SOL_UNSAFE=true only for explicit legacy demos"
    );
  }
  return rail;
}

function deriveCreditVaultPda(programId: string): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("credit_vault")],
    new PublicKey(programId)
  )[0].toBase58();
}

export interface PreparedPrivateFunding {
  ticketId: string;
  dealPda: string;
  sessionPda: string;
  intentId?: string;
  termsHash: string;
  planHash: string;
  buyerSettlementTarget: string;
  sellerSettlementTarget: string;
  dwalletPda?: string;
  txSignatures: string[];
}

function isPendingFundingRequest(
  request: ConfidentialFundingRequestEnvelope | undefined,
  active?: boolean
): request is ConfidentialFundingRequestEnvelope {
  return !!request && !active;
}

interface ConfidentialFundingServiceDeps {
  loadConfig: typeof loadConfig;
  getConnection: typeof getConnection;
  walletRegistry: Pick<typeof walletRegistry, "getOrCreateAgent" | "getAgentById">;
  eventBus: Pick<typeof eventBus, "publish">;
  store: Pick<
    typeof confidentialFundingStore,
    "createInitial" | "getLatestByTicket" | "recordFunding"
  >;
  confidentialIdentityStore: Pick<typeof confidentialIdentityStore, "getLatestByTicket">;
  prisma: Pick<typeof prisma, "ticket">;
  deliverStructuredToAgent: typeof deliverStructuredToAgent;
}

const defaultDeps: ConfidentialFundingServiceDeps = {
  loadConfig,
  getConnection,
  walletRegistry,
  eventBus,
  store: confidentialFundingStore,
  confidentialIdentityStore,
  prisma,
  deliverStructuredToAgent,
};

async function loadTicketAgents(
  deps: ConfidentialFundingServiceDeps,
  ticketId: string,
  wallets: { buyerWallet: string; sellerWallet: string }
): Promise<{
  buyerAgentId: string;
  sellerAgentId: string;
}> {
  const ticket = await deps.prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { buyerId: true, sellerId: true },
  });

  if (ticket) {
    return {
      buyerAgentId: ticket.buyerId,
      sellerAgentId: ticket.sellerId,
    };
  }

  const [buyerAgent, sellerAgent] = await Promise.all([
    deps.walletRegistry.getOrCreateAgent(wallets.buyerWallet),
    deps.walletRegistry.getOrCreateAgent(wallets.sellerWallet),
  ]);

  logger.warn("confidential_funding_ticket_missing_fallback", {
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
  role: ConfidentialFundingPartyRole,
  expiresAt: Date
) {
  const redacted = context.termsVisibility === "REDACTED";
  return {
    ticketId: context.ticketId,
    role,
    counterparty: role === "buyer" ? context.seller : context.buyer,
    asset: context.assetType,
    buyerPayment: redacted ? 0 : context.price,
    buyerCollateral: redacted ? 0 : context.collateralBuyer,
    sellerCollateral: redacted ? 0 : context.collateralSeller,
    settlementMode:
      context.settlementPolicy === "STEALTH"
        ? "Stealth settlement"
        : "Public wallet settlement",
    actionLabel: "Fund confidential escrow",
    expiresAt: expiresAt.toISOString(),
    redacted,
    localTermsRequired: redacted,
  } as const;
}

async function verifyFundingTransactions(
  connection: Connection,
  ticketId: string,
  request: ConfidentialFundingRequestEnvelope,
  expectedWallet: string,
  transactionSignatures: string[],
  confidentialEscrowProgramId: string
): Promise<Partial<Record<ConfidentialFundingRole, string>>> {
  if (transactionSignatures.length < request.instructions.length) {
    throw new Error(`confidential_funding_missing_signatures:${request.requestId}`);
  }

  const seen = new Set<string>();
  const observedRoles = new Set<ConfidentialFundingRole>();
  const observedAmounts: Partial<Record<ConfidentialFundingRole, string>> = {};
  const expectedRoles = request.instructions.map((instruction) => instruction.fundingRole);

  for (const signature of transactionSignatures) {
    if (seen.has(signature)) {
      throw new Error(`confidential_funding_duplicate_signature:${signature}`);
    }
    seen.add(signature);

    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      throw new Error(`confidential_funding_tx_missing:${signature}`);
    }
    if (tx.meta?.err) {
      throw new Error(`confidential_funding_tx_failed:${signature}`);
    }

    const txObservedEntries = extractObservedFundingEntries({
      tx,
      confidentialEscrowProgramId,
      expectedWallet,
      dealPda: request.dealPda,
      fundingRail: request.fundingRail || "DIRECT_SOL",
    });
    if (txObservedEntries.length === 0) {
      throw new Error(`confidential_funding_wrong_instruction:${signature}`);
    }

    for (const entry of txObservedEntries) {
      const role = entry.role;
      if (!expectedRoles.includes(role)) {
        throw new Error(`confidential_funding_unexpected_role:${signature}:${role}`);
      }
      if (observedRoles.has(role)) {
        throw new Error(`confidential_funding_duplicate_role:${signature}:${role}`);
      }
      observedRoles.add(role);
      observedAmounts[role] = entry.amountLamports.toString();
    }
  }

  for (const role of expectedRoles) {
    if (!observedRoles.has(role)) {
      throw new Error(`confidential_funding_missing_role:${request.requestId}:${role}`);
    }
  }

  logger.info("confidential_funding_transactions_verified", {
    ticket_id: ticketId,
    requestId: request.requestId,
    signatureCount: transactionSignatures.length,
      observedRoles: Array.from(observedRoles),
      fundingRail: request.fundingRail || "DIRECT_SOL",
  });

  return observedAmounts;
}

async function sendFundingRequest(
  deps: ConfidentialFundingServiceDeps,
  agentId: string,
  request: ConfidentialFundingRequestEnvelope,
  options: { allowRepeatDeliveryWhenSent?: boolean } = {}
): Promise<void> {
  const wsPayload = {
    type: "CONFIDENTIAL_FUNDING_REQUEST",
    ticket_id: request.ticketId,
    payload: request,
  };
  await deps.deliverStructuredToAgent({
    ticketId: request.ticketId,
    agentId,
    payload: wsPayload,
    phase: "awaiting_confidential_funding",
    eventType: "confidential_funding_request",
    timestamp: request.issuedAt,
    idempotencyKey: `${request.ticketId}:${agentId}:confidential_funding_request:${request.requestId}`,
    allowRepeatDeliveryWhenSent: options.allowRepeatDeliveryWhenSent,
  });
}

export function createConfidentialFundingService(
  overrides: Partial<ConfidentialFundingServiceDeps> = {}
) {
  const deps: ConfidentialFundingServiceDeps = {
    ...defaultDeps,
    ...overrides,
  };

  return {
    async initializeFundingRequests(
      context: DealPipelineContext,
      prepared: PreparedPrivateFunding,
      attestedEscrowIntent: AttestedEscrowIntent
    ): Promise<ConfidentialFundingStateSnapshot> {
      const { buyerAgentId, sellerAgentId } = await loadTicketAgents(deps, context.ticketId, {
        buyerWallet: context.buyer,
        sellerWallet: context.seller,
      });
      const identitySnapshot = await deps.confidentialIdentityStore.getLatestByTicket(context.ticketId);
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + REQUEST_TTL_MS);
      const config = deps.loadConfig();
      const fundingRail = resolveFundingRail(config);
      const vaultPda =
        fundingRail === "SHIELDED_CREDIT"
          ? deriveCreditVaultPda(config.confidentialEscrowProgramId)
          : undefined;

      const buyerRequest: ConfidentialFundingRequestEnvelope = {
        version: fundingRail === "SHIELDED_CREDIT" ? 2 : 1,
        requestId: `${context.ticketId}:buyer:funding:1`,
        ticketId: context.ticketId,
        role: "buyer",
        requestKind: "BUYER_FUNDING",
        fundingRail,
        summary: buildSummary(context, "buyer", expiresAt),
        dealPda: prepared.dealPda,
        sessionPda: prepared.sessionPda,
        intentId: prepared.intentId,
        termsHash: prepared.termsHash,
        vaultPda,
        instructions: [
          {
            fundingRole: "buyer_payment",
            fundingHash: attestedEscrowIntent.fundingCommitments.buyerPaymentHash,
          },
          {
            fundingRole: "buyer_collateral",
            fundingHash: attestedEscrowIntent.fundingCommitments.buyerCollateralHash,
          },
        ],
        requiredCreditLamports: undefined,
        issuedAt: issuedAt.toISOString(),
      };

      const sellerRequest: ConfidentialFundingRequestEnvelope = {
        version: fundingRail === "SHIELDED_CREDIT" ? 2 : 1,
        requestId: `${context.ticketId}:seller:funding:1`,
        ticketId: context.ticketId,
        role: "seller",
        requestKind: "SELLER_FUNDING",
        fundingRail,
        summary: buildSummary(context, "seller", expiresAt),
        dealPda: prepared.dealPda,
        sessionPda: prepared.sessionPda,
        intentId: prepared.intentId,
        termsHash: prepared.termsHash,
        vaultPda,
        instructions: [
          {
            fundingRole: "seller_collateral",
            fundingHash: attestedEscrowIntent.fundingCommitments.sellerCollateralHash,
          },
        ],
        requiredCreditLamports: undefined,
        issuedAt: issuedAt.toISOString(),
      };

      const snapshot: ConfidentialFundingStateSnapshot = {
        ticketId: context.ticketId,
        dealPda: prepared.dealPda,
        sessionPda: prepared.sessionPda,
        intentId: prepared.intentId,
        buyerWallet: context.buyer,
        sellerWallet: context.seller,
        buyerFundingWallet: identitySnapshot?.buyerFundingWallet,
        sellerFundingWallet: identitySnapshot?.sellerFundingWallet,
        buyerSettlementTarget: prepared.buyerSettlementTarget,
        sellerSettlementTarget: prepared.sellerSettlementTarget,
        dwalletPda: prepared.dwalletPda,
        termsHash: prepared.termsHash,
        planHash: prepared.planHash,
        requestIssuedAt: issuedAt.toISOString(),
        buyerRequest,
        sellerRequest,
        allFundingRecorded: false,
        txSignatures: [...prepared.txSignatures],
        updatedAt: issuedAt.toISOString(),
      };

      await deps.store.createInitial(snapshot);
      await Promise.all([
        sendFundingRequest(deps, buyerAgentId, buyerRequest),
        sendFundingRequest(deps, sellerAgentId, sellerRequest),
      ]);

      deps.eventBus.publish("confidential_funding_requested", {
        ticketId: context.ticketId,
        dealPda: prepared.dealPda,
        role: "buyer",
        request: buyerRequest,
      });
      deps.eventBus.publish("confidential_funding_requested", {
        ticketId: context.ticketId,
        dealPda: prepared.dealPda,
        role: "seller",
        request: sellerRequest,
      });

      return snapshot;
    },

    async getLatestState(ticketId: string): Promise<ConfidentialFundingStateSnapshot | null> {
      return deps.store.getLatestByTicket(ticketId);
    },

    async resendPendingRequests(ticketId: string, agentId: string): Promise<void> {
      const snapshot = await deps.store.getLatestByTicket(ticketId);
      if (!snapshot) {
        return;
      }

      const agent = await deps.walletRegistry.getAgentById(agentId);
      if (!agent) {
        return;
      }

      if (agent.wallet === snapshot.buyerWallet) {
        if (isPendingFundingRequest(snapshot.buyerRequest, snapshot.buyerFunding?.active)) {
          await sendFundingRequest(deps, agentId, snapshot.buyerRequest, {
            allowRepeatDeliveryWhenSent: true,
          });
        }
        return;
      }

      if (agent.wallet === snapshot.sellerWallet) {
        if (isPendingFundingRequest(snapshot.sellerRequest, snapshot.sellerFunding?.active)) {
          await sendFundingRequest(deps, agentId, snapshot.sellerRequest, {
            allowRepeatDeliveryWhenSent: true,
          });
        }
      }
    },

    async processAgentSubmission(payload: {
      ticketId: string;
      agentId: string;
      requestId: string;
      transactionSignatures: string[];
    }): Promise<ConfidentialFundingStateSnapshot | null> {
      const current = await deps.store.getLatestByTicket(payload.ticketId);
      if (!current) {
        throw new Error(`confidential_funding_state_missing:${payload.ticketId}`);
      }

      const request =
        current.buyerRequest.requestId === payload.requestId
          ? current.buyerRequest
          : current.sellerRequest.requestId === payload.requestId
            ? current.sellerRequest
            : null;
      if (!request) {
        throw new Error(`confidential_funding_request_missing:${payload.requestId}`);
      }

      const expectedWallet =
        request.role === "buyer"
          ? current.buyerFundingWallet || current.buyerWallet
          : current.sellerFundingWallet || current.sellerWallet;
      const agentRecord = await deps.walletRegistry.getAgentById(payload.agentId);
      const wallet = agentRecord?.wallet || payload.agentId;
      const expectedAgentWallet = request.role === "buyer" ? current.buyerWallet : current.sellerWallet;
      if (wallet !== expectedAgentWallet) {
        throw new Error(`confidential_funding_wrong_agent:${payload.agentId}`);
      }

      const connection = deps.getConnection();
      const config = deps.loadConfig();
      const observedFundingRoleAmounts = await verifyFundingTransactions(
        connection,
        payload.ticketId,
        request,
        expectedWallet,
        payload.transactionSignatures,
        config.confidentialEscrowProgramId
      );

      const next = await deps.store.recordFunding(payload.ticketId, request.role, {
        agentId: payload.agentId,
        wallet: expectedWallet,
        fundingRail: request.fundingRail || "DIRECT_SOL",
        transactionSignatures: payload.transactionSignatures,
        observedFundingRoleAmounts,
        recordedAt: new Date().toISOString(),
        active: true,
      });

      deps.eventBus.publish("confidential_funding_recorded", {
        ticketId: payload.ticketId,
        requestId: payload.requestId,
        role: request.role,
        transactionSignatures: payload.transactionSignatures,
      });

      if (next?.allFundingRecorded) {
        deps.eventBus.publish("confidential_funding_completed", {
          ticketId: payload.ticketId,
          dealPda: next.dealPda,
        });
      }

      return next;
    },
  };
}

export const confidentialFundingService = createConfidentialFundingService();
