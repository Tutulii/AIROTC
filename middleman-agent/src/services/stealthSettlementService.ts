import { loadConfig } from "../config";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { pipelineStateStore } from "../state/pipelineStateStore";
import { loadWallet } from "../solana/wallet";
import type {
  DealPipelineContext,
  SettlementAddressPlan,
  StealthSettlementPreparation,
} from "../types/dealPipeline";
import { logger } from "../utils/logger";
import { walletRegistry } from "../state/walletRegistry";
import { getUmbraServiceInstance, type UmbraService } from "./umbraService";
import { UmbraSettlementOrchestrator } from "./umbraSettlement";
import {
  prepareReceiverSettlementRecord,
  type UmbraSettlementLifecycleMode,
} from "./umbraSettlementV2";
import { deliverStructuredToAgent } from "./outboundRouter";

type UmbraNetwork = "mainnet" | "devnet";

interface StealthSettlementServiceDeps {
  loadConfig: typeof loadConfig;
  loadWallet: typeof loadWallet;
  pipelineStateStore: Pick<typeof pipelineStateStore, "ensureDealId">;
  getUmbraService: (
    secretKey: Uint8Array,
    rpcUrl: string,
    network: UmbraNetwork
  ) => UmbraService;
  createOrchestrator: (
    umbraService: UmbraService
  ) => Pick<UmbraSettlementOrchestrator, "ensureSettlement">;
  prepareReceiverSettlementRecord: typeof prepareReceiverSettlementRecord;
  walletRegistry: Pick<typeof walletRegistry, "getOrCreateAgent">;
  deliverStructuredToAgent: typeof deliverStructuredToAgent;
}

const defaultDeps: StealthSettlementServiceDeps = {
  loadConfig,
  loadWallet,
  pipelineStateStore,
  getUmbraService: (secretKey, rpcUrl, network) =>
    getUmbraServiceInstance(secretKey, rpcUrl, network),
  createOrchestrator: (umbraService) => new UmbraSettlementOrchestrator(umbraService),
  prepareReceiverSettlementRecord,
  walletRegistry,
  deliverStructuredToAgent,
};

function resolveUmbraNetwork(network: string): UmbraNetwork {
  return network === "mainnet-beta" ? "mainnet" : "devnet";
}

function solToLamportsString(sol: number, label: string): string {
  if (!Number.isFinite(sol) || sol <= 0) {
    throw new Error(`${label} must be a positive SOL amount for full Umbra lifecycle`);
  }
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) {
    throw new Error(`${label} resolved to an invalid lamport amount`);
  }
  return String(lamports);
}

function resolveUmbraLifecycleAmountLamports(
  context: DealPipelineContext,
  role: "buyer" | "seller"
): string | undefined {
  const override = process.env.AIROTC_UMBRA_LIFECYCLE_AMOUNT_LAMPORTS;
  if (override) {
    if (!/^[1-9]\d*$/.test(override)) {
      throw new Error("AIROTC_UMBRA_LIFECYCLE_AMOUNT_LAMPORTS must be a positive lamport string");
    }
    return override;
  }

  if (context.termsVisibility === "REDACTED") {
    return undefined;
  }

  const payoutSol =
    role === "buyer"
      ? context.collateralBuyer
      : context.price + context.collateralSeller;
  return solToLamportsString(payoutSol, `${role} Umbra lifecycle payout`);
}

function resolveLifecycleMode(
  context: DealPipelineContext,
  config: ReturnType<typeof loadConfig>
): UmbraSettlementLifecycleMode {
  const explicit = process.env.UMBRA_SETTLEMENT_LIFECYCLE_MODE;
  if (explicit === "FULL_UMBRA" || explicit === "RECEIVER_WALLET_ONLY") {
    return explicit;
  }

  if (process.env.AIROTC_REQUIRE_FULL_UMBRA === "true" || config.requireFullUmbraLifecycle) {
    return "FULL_UMBRA";
  }

  const strictPrivatePer =
    context.negotiationSource === "PER" &&
    context.executionPolicy === "CONFIDENTIAL" &&
    context.settlementPolicy === "STEALTH";
  if (strictPrivatePer && config.perStrictOpaqueMode !== false) {
    return "FULL_UMBRA";
  }

  return config.umbraSettlementLifecycleMode || "RECEIVER_WALLET_ONLY";
}

export function createStealthSettlementService(
  deps: StealthSettlementServiceDeps = defaultDeps
) {
  async function prepareStealthSettlement(
    context: DealPipelineContext,
    settlementPlan: SettlementAddressPlan
  ): Promise<StealthSettlementPreparation> {
    // This prepares the legacy standalone Umbra settlement record. The
    // production confidential route reuses the resolved Umbra receiver targets
    // but should not execute the old five-phase branch unless explicitly opted in.
    if (context.settlementPolicy !== "STEALTH") {
      throw new Error("Stealth settlement preparation requested for a non-stealth pipeline");
    }

    if (settlementPlan.resolution !== "resolved") {
      throw new Error("Stealth settlement requires resolved settlement targets");
    }

    if (!settlementPlan.assetMint) {
      throw new Error("Stealth settlement requires a resolved Umbra-supported mint");
    }

    const config = deps.loadConfig();
    const wallet = deps.loadWallet(config.privateKey);
    const network = resolveUmbraNetwork(config.network);
    const umbraService = deps.getUmbraService(wallet.secretKey, config.solanaRpcUrl, network);
    const orchestrator = deps.createOrchestrator(umbraService);
    const dealId = await deps.pipelineStateStore.ensureDealId(context.ticketId);
    const { settlement, created } = await orchestrator.ensureSettlement(
      dealId,
      settlementPlan.assetMint
    );
    const lifecycleMode = resolveLifecycleMode(context, config);
    const receiverRecord = await deps.prepareReceiverSettlementRecord({
      dealId,
      settlementId: settlement.id,
      mint: settlementPlan.assetMint,
      settlementPlan,
      lifecycleMode,
    });

    logger.info("stealth_settlement_prepared", {
      ticket_id: context.ticketId,
      deal_id: dealId,
      settlement_id: settlement.id,
      created,
      mint: settlement.mint,
      phase: receiverRecord.phase,
      lifecycleMode: receiverRecord.lifecycleMode,
    });

    if (receiverRecord.lifecycleMode === "FULL_UMBRA") {
      const [buyerAgent, sellerAgent] = await Promise.all([
        deps.walletRegistry.getOrCreateAgent(context.buyer),
        deps.walletRegistry.getOrCreateAgent(context.seller),
      ]);
      const issuedAt = new Date().toISOString();
      const phases = ["SHIELD", "CREATE_UTXO", "CLAIM", "UNSHIELD"] as const;
      const buyerAmountLamports = resolveUmbraLifecycleAmountLamports(context, "buyer");
      const sellerAmountLamports = resolveUmbraLifecycleAmountLamports(context, "seller");
      await Promise.all([
        deps.deliverStructuredToAgent({
          ticketId: context.ticketId,
          agentId: buyerAgent.id,
          phase: "umbra_lifecycle_requested",
          eventType: "umbra_lifecycle_request",
          timestamp: issuedAt,
          idempotencyKey: `${context.ticketId}:${buyerAgent.id}:umbra_lifecycle:${settlement.id}`,
          payload: {
            type: "UMBRA_LIFECYCLE_REQUEST",
            ticket_id: context.ticketId,
            payload: {
              ticketId: context.ticketId,
              dealId,
              settlementId: settlement.id,
              role: "buyer",
              mint: settlement.mint,
              baseWallet: settlementPlan.buyerTarget.baseWallet,
              receiverWallet: settlementPlan.buyerTarget.resolvedAddress,
              requiredPhases: phases,
              ...(buyerAmountLamports ? { amountLamports: buyerAmountLamports } : {}),
              finalWalletRequired: true,
              issuedAt,
            },
          },
        }),
        deps.deliverStructuredToAgent({
          ticketId: context.ticketId,
          agentId: sellerAgent.id,
          phase: "umbra_lifecycle_requested",
          eventType: "umbra_lifecycle_request",
          timestamp: issuedAt,
          idempotencyKey: `${context.ticketId}:${sellerAgent.id}:umbra_lifecycle:${settlement.id}`,
          payload: {
            type: "UMBRA_LIFECYCLE_REQUEST",
            ticket_id: context.ticketId,
            payload: {
              ticketId: context.ticketId,
              dealId,
              settlementId: settlement.id,
              role: "seller",
              mint: settlement.mint,
              baseWallet: settlementPlan.sellerTarget.baseWallet,
              receiverWallet: settlementPlan.sellerTarget.resolvedAddress,
              requiredPhases: phases,
              ...(sellerAmountLamports ? { amountLamports: sellerAmountLamports } : {}),
              finalWalletRequired: true,
              issuedAt,
            },
          },
        }),
      ]);
    }

    return {
      dealId,
      settlementId: settlement.id,
      mint: settlement.mint,
      phase: receiverRecord.phase,
      created,
    };
  }

  return {
    prepareStealthSettlement,
  };
}

export const { prepareStealthSettlement } = createStealthSettlementService();
