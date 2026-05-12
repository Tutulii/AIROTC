import { loadConfig } from "../config";
import { loadWallet } from "../solana/wallet";
import { logger } from "../utils/logger";
import type { DealPipelineContext, SettlementAddressPlan } from "../types/dealPipeline";
import { settlementTargetStore } from "../state/settlementTargetStore";
import { MeridianOtcGuard } from "./meridianOtcGuard";
import {
  getUmbraServiceInstance,
  type UmbraService,
  UMBRA_SUPPORTED_MINTS,
} from "./umbraService";

type UmbraNetwork = "mainnet" | "devnet";

interface SettlementAddressPlannerDeps {
  loadConfig: typeof loadConfig;
  loadWallet: typeof loadWallet;
  getUmbraService: (
    secretKey: Uint8Array,
    rpcUrl: string,
    network: UmbraNetwork
  ) => Pick<UmbraService, "initClient" | "ensureRegistered" | "queryUserAccount">;
  getSettlementTargetSnapshot: (
    ticketId: string
  ) => Promise<{
    buyerSettlementWallet: string;
    sellerSettlementWallet: string;
  } | null>;
}

const defaultDeps: SettlementAddressPlannerDeps = {
  loadConfig,
  loadWallet,
  getUmbraService: (secretKey, rpcUrl, network) =>
    getUmbraServiceInstance(secretKey, rpcUrl, network),
  getSettlementTargetSnapshot: async (ticketId) =>
    settlementTargetStore.getLatestByTicket(ticketId),
};

function resolveUmbraNetwork(network: string): UmbraNetwork {
  return network === "mainnet-beta" ? "mainnet" : "devnet";
}

function normalizeUmbraMint(assetType?: string, tokenMint?: string): string | null {
  const direct = tokenMint || MeridianOtcGuard.normalizeSupportedAsset(assetType || "");
  return direct && Object.values(UMBRA_SUPPORTED_MINTS).includes(direct as any) ? direct : null;
}

export function createSettlementAddressPlanner(
  deps: SettlementAddressPlannerDeps = defaultDeps
) {
  async function prepareDirectPlan(
    context: DealPipelineContext
  ): Promise<SettlementAddressPlan> {
    const assetMint = tokenMintOrAlias(context);
    return {
      policy: context.settlementPolicy,
      resolution: "resolved",
      assetMint,
      buyerTarget: {
        role: "buyer",
        strategy: "DIRECT_WALLET",
        baseWallet: context.buyer,
        resolvedAddress: context.buyer,
        resolvedAddressKind: "participant_wallet",
        status: "resolved",
      },
      sellerTarget: {
        role: "seller",
        strategy: "DIRECT_WALLET",
        baseWallet: context.seller,
        resolvedAddress: context.seller,
        resolvedAddressKind: "participant_wallet",
        status: "resolved",
      },
      notes: ["Settlement uses public wallet destinations for both participants."],
    };
  }

  function tokenMintOrAlias(context: DealPipelineContext): string | undefined {
    return context.tokenMint || MeridianOtcGuard.normalizeSupportedAsset(context.assetType || "") || undefined;
  }

  async function prepareStealthPlan(
    context: DealPipelineContext
  ): Promise<SettlementAddressPlan> {
    const supportedMint = normalizeUmbraMint(context.assetType, context.tokenMint);
    if (!supportedMint) {
      throw new Error(
        `Umbra stealth settlement does not support negotiated asset ${context.assetType || "unknown"}`
      );
    }

    const dealScopedTargets =
      context.buyerSettlementWallet && context.sellerSettlementWallet
        ? {
            buyerSettlementWallet: context.buyerSettlementWallet,
            sellerSettlementWallet: context.sellerSettlementWallet,
          }
        : await deps.getSettlementTargetSnapshot(context.ticketId);

    if (
      !dealScopedTargets?.buyerSettlementWallet ||
      !dealScopedTargets?.sellerSettlementWallet
    ) {
      throw new Error(
        `Fresh Umbra settlement wallets are missing for ticket ${context.ticketId}. ` +
          "Stealth settlement requires per-deal registered receiver wallets."
      );
    }

    const config = deps.loadConfig();
    const payer = deps.loadWallet(config.privateKey);
    const network = resolveUmbraNetwork(config.network);
    const umbra = deps.getUmbraService(payer.secretKey, config.solanaRpcUrl, network);

    await umbra.initClient();

    const operatorAccount = await umbra.queryUserAccount();
    if (!operatorAccount) {
      await umbra.ensureRegistered();
    }

    const [buyerAccount, sellerAccount] = await Promise.all([
      umbra.queryUserAccount(dealScopedTargets.buyerSettlementWallet),
      umbra.queryUserAccount(dealScopedTargets.sellerSettlementWallet),
    ]);

    const missing: string[] = [];
    if (!buyerAccount) missing.push("buyer");
    if (!sellerAccount) missing.push("seller");

    if (missing.length > 0) {
      throw new Error(
        `Umbra registration missing for ${missing.join(" and ")} on ${network}. ` +
          `Both counterparties must register before stealth settlement can execute.`
      );
    }

    logger.info("settlement_umbra_receivers_resolved", {
      ticket_id: context.ticketId,
      network,
      supportedMint,
      buyer: context.buyer,
      seller: context.seller,
      buyerSettlementWallet: dealScopedTargets.buyerSettlementWallet,
      sellerSettlementWallet: dealScopedTargets.sellerSettlementWallet,
    });

    return {
      policy: context.settlementPolicy,
      resolution: "resolved",
      assetMint: supportedMint,
      buyerTarget: {
        role: "buyer",
        strategy: "UMBRA_STEALTH",
        baseWallet: context.buyer,
        resolvedAddress: dealScopedTargets.buyerSettlementWallet,
        resolvedAddressKind: "umbra_registered_receiver_wallet",
        status: "resolved",
      },
      sellerTarget: {
        role: "seller",
        strategy: "UMBRA_STEALTH",
        baseWallet: context.seller,
        resolvedAddress: dealScopedTargets.sellerSettlementWallet,
        resolvedAddressKind: "umbra_registered_receiver_wallet",
        status: "resolved",
      },
      notes: [
        `Umbra registration verified for both counterparties on ${network}.`,
        `Stealth settlement will route through Umbra for mint ${supportedMint}.`,
        "Resolved settlement addresses are fresh per-deal Umbra receiver wallets, not long-lived participant wallets.",
        "Each deal uses unique payout targets so repeated trades do not reuse the same on-chain settlement address.",
      ],
    };
  }

  async function prepareSettlementAddressPlan(
    context: DealPipelineContext
  ): Promise<SettlementAddressPlan> {
    if (context.settlementPolicy === "STEALTH") {
      return prepareStealthPlan(context);
    }

    return prepareDirectPlan(context);
  }

  return {
    prepareSettlementAddressPlan,
  };
}

export const { prepareSettlementAddressPlan } = createSettlementAddressPlanner();
