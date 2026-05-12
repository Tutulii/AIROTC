import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadConfig } from "../config";
import { pipelineStateStore } from "../state/pipelineStateStore";
import { loadWallet } from "../solana/wallet";
import type { DealPipelineContext, DealPipelineStage, SettlementAddressPlan } from "../types/dealPipeline";
import { logger } from "../utils/logger";
import { getUmbraServiceInstance, type UmbraService } from "./umbraService";
import { UmbraSettlementOrchestrator } from "./umbraSettlement";

type UmbraNetwork = "mainnet" | "devnet";

interface StealthLifecycleDeps {
  loadConfig: typeof loadConfig;
  loadWallet: typeof loadWallet;
  pipelineStateStore: Pick<typeof pipelineStateStore, "ensureDealId">;
  getUmbraService: (
    secretKey: Uint8Array,
    rpcUrl: string,
    network: UmbraNetwork
  ) => UmbraService;
  createOrchestrator: (umbraService: UmbraService) => UmbraSettlementOrchestrator;
}

interface StealthLifecycleResult {
  dealId: string;
  settlementId: string;
  phase: string;
  buyerShieldTx?: string | null;
  sellerShieldTx?: string | null;
  settlementUtxoTx?: string | null;
  claimTx?: string | null;
  buyerUnshieldTx?: string | null;
  sellerUnshieldTx?: string | null;
}

const defaultDeps: StealthLifecycleDeps = {
  loadConfig,
  loadWallet,
  pipelineStateStore,
  getUmbraService: (secretKey, rpcUrl, network) =>
    getUmbraServiceInstance(secretKey, rpcUrl, network),
  createOrchestrator: (umbraService) => new UmbraSettlementOrchestrator(umbraService),
};

function resolveUmbraNetwork(network: string): UmbraNetwork {
  return network === "mainnet-beta" ? "mainnet" : "devnet";
}

function toLamports(amount: number): bigint {
  return BigInt(Math.max(0, Math.round(amount * LAMPORTS_PER_SOL)));
}

export function createStealthSettlementLifecycleService(
  deps: StealthLifecycleDeps = defaultDeps
) {
  async function executeStealthSettlement(
    context: DealPipelineContext,
    settlementPlan: SettlementAddressPlan,
    onStage?: (stage: DealPipelineStage, details?: Record<string, unknown>) => Promise<void>
  ): Promise<StealthLifecycleResult> {
    // This service represents the older standalone Umbra 5-phase lifecycle.
    // Production confidential settlement should stay on the audited
    // CONFIDENTIAL_ESCROW route. The legacy branch is test-only even when its
    // feature flag is set, so it cannot be used accidentally in production.
    const config = deps.loadConfig();
    if (!config.enableLegacyUmbraStealthLifecycle || process.env.NODE_ENV !== "test") {
      throw new Error("legacy_umbra_stealth_lifecycle_test_only");
    }
    if (context.settlementPolicy !== "STEALTH") {
      throw new Error("Stealth settlement execution requested for a non-stealth pipeline");
    }
    if (settlementPlan.resolution !== "resolved" || !settlementPlan.assetMint) {
      throw new Error("Stealth settlement execution requires a fully resolved settlement plan");
    }

    const buyerTarget = settlementPlan.buyerTarget.resolvedAddress || context.buyer;
    const sellerTarget = settlementPlan.sellerTarget.resolvedAddress || context.seller;
    const buyerShieldAmount = toLamports(context.collateralBuyer);
    const sellerShieldAmount = toLamports(context.collateralSeller);
    const settlementAmount = toLamports(context.price);

    const wallet = deps.loadWallet(config.privateKey);
    const network = resolveUmbraNetwork(config.network);
    const umbraService = deps.getUmbraService(wallet.secretKey, config.solanaRpcUrl, network);
    await umbraService.initClient();
    await umbraService.ensureRegistered();

    const orchestrator = deps.createOrchestrator(umbraService);
    const dealId = await deps.pipelineStateStore.ensureDealId(context.ticketId);
    const { settlement } = await orchestrator.ensureSettlement(dealId, settlementPlan.assetMint);

    if (settlement.phase === "FAILED") {
      throw new Error(`Stealth settlement ${settlement.id} is in FAILED state`);
    }

    let current = settlement;

    if (!current.buyerShieldTx) {
      await orchestrator.shieldCollateral(
        dealId,
        "buyer",
        buyerShieldAmount,
        buyerTarget
      );
      current = await orchestrator.getSettlement(dealId);
    }
    if (!current.sellerShieldTx) {
      await orchestrator.shieldCollateral(
        dealId,
        "seller",
        sellerShieldAmount,
        sellerTarget
      );
      current = await orchestrator.getSettlement(dealId);
    }
    await onStage?.("stealth_shielding", {
      settlementId: current.id,
      buyerShieldTx: current.buyerShieldTx,
      sellerShieldTx: current.sellerShieldTx,
      phase: current.phase,
    });

    if (!current.buyerBalanceVerified || !current.sellerBalanceVerified) {
      const verified = await orchestrator.verifyBalances(dealId);
      if (!verified) {
        throw new Error(`Umbra encrypted balance verification failed for settlement ${current.id}`);
      }
      current = await orchestrator.getSettlement(dealId);
    }
    await onStage?.("stealth_balances_verified", {
      settlementId: current.id,
      buyerBalanceVerified: current.buyerBalanceVerified,
      sellerBalanceVerified: current.sellerBalanceVerified,
      phase: current.phase,
    });

    if (!current.settlementUtxoTx) {
      const created = await orchestrator.executeSettlementUtxo(
        dealId,
        buyerTarget,
        settlementAmount
      );
      if (!created) {
        throw new Error(`Umbra settlement UTXO creation failed for settlement ${current.id}`);
      }
      current = await orchestrator.getSettlement(dealId);
    }
    await onStage?.("stealth_settling", {
      settlementId: current.id,
      settlementUtxoTx: current.settlementUtxoTx,
      phase: current.phase,
    });

    if (!current.claimTx) {
      const claimed = await orchestrator.executeClaimUtxo(dealId);
      if (!claimed) {
        throw new Error(`Umbra claim phase failed for settlement ${current.id}`);
      }
      current = await orchestrator.getSettlement(dealId);
    }
    await onStage?.("stealth_claiming", {
      settlementId: current.id,
      claimTx: current.claimTx,
      phase: current.phase,
    });

    if (!current.buyerUnshieldTx) {
      await orchestrator.unshieldCollateral(
        dealId,
        "buyer",
        settlementAmount,
        buyerTarget
      );
      current = await orchestrator.getSettlement(dealId);
    }
    if (!current.sellerUnshieldTx) {
      await orchestrator.unshieldCollateral(
        dealId,
        "seller",
        sellerShieldAmount,
        sellerTarget
      );
      current = await orchestrator.getSettlement(dealId);
    }

    logger.info("stealth_settlement_completed", {
      ticket_id: context.ticketId,
      deal_id: dealId,
      settlement_id: current.id,
      phase: current.phase,
    });

    return {
      dealId,
      settlementId: current.id,
      phase: current.phase,
      buyerShieldTx: current.buyerShieldTx,
      sellerShieldTx: current.sellerShieldTx,
      settlementUtxoTx: current.settlementUtxoTx,
      claimTx: current.claimTx,
      buyerUnshieldTx: current.buyerUnshieldTx,
      sellerUnshieldTx: current.sellerUnshieldTx,
    };
  }

  return {
    executeStealthSettlement,
  };
}

export const { executeStealthSettlement } = createStealthSettlementLifecycleService();
