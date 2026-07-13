import axios from "axios";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import { MeridianOtcGuard } from "./meridianOtcGuard";
import type { DealPipelineContext, VerificationSummary } from "../types/dealPipeline";
import { UMBRA_SUPPORTED_MINTS } from "./umbraService";
import { economicSafety } from "./economicSafety";

type AssetResolution = VerificationSummary["assetResolution"];

interface VerificationDeps {
  getConnection: typeof getConnection;
  withRetry: typeof withRetry;
  loadConfig: typeof loadConfig;
  httpGet: typeof axios.get;
  validateEconomicSafety: typeof economicSafety.validateDeal;
}

interface ResolvedAsset {
  assetMint?: string;
  assetSymbol: string;
  assetResolution: AssetResolution;
}

interface ZerionPosition {
  id?: string;
  attributes?: {
    name?: string;
    quantity?: {
      int?: string;
      decimals?: number;
      float?: number;
      numeric?: string;
    };
    value?: number;
    price?: number;
    updated_at?: string;
    updated_at_block?: number;
    fungible_info?: {
      name?: string;
      symbol?: string;
      implementations?: Array<{
        chain_id?: string;
        address?: string | null;
        decimals?: number;
      }>;
    };
  };
  relationships?: {
    chain?: {
      data?: {
        id?: string;
      };
    };
  };
}

interface ZerionPositionsResponse {
  data?: ZerionPosition[];
}

type ZerionVerificationMode = ReturnType<typeof loadConfig>["zerionVerificationMode"];

const defaultDeps: VerificationDeps = {
  getConnection,
  withRetry,
  loadConfig,
  httpGet: axios.get.bind(axios),
  validateEconomicSafety: economicSafety.validateDeal.bind(economicSafety),
};

function resolveAsset(context: DealPipelineContext): ResolvedAsset {
  if (context.rollupMode === "SPORT" && MeridianOtcGuard.isSportSyntheticAsset(context.assetType)) {
    return {
      assetMint: UMBRA_SUPPORTED_MINTS.wSOL,
      assetSymbol: context.assetType || "SPORT",
      assetResolution: "native_sol",
    };
  }

  const normalizedAsset = MeridianOtcGuard.normalizeSupportedAsset(context.assetType);

  if (context.tokenMint) {
    return {
      assetMint: context.tokenMint,
      assetSymbol: context.assetType || "TOKEN",
      assetResolution: "token_mint",
    };
  }

  if (normalizedAsset === UMBRA_SUPPORTED_MINTS.wSOL) {
    return {
      assetMint: normalizedAsset,
      assetSymbol: context.assetType || "SOL",
      assetResolution: "native_sol",
    };
  }

  if (normalizedAsset) {
    return {
      assetMint: normalizedAsset,
      assetSymbol: context.assetType || "TOKEN",
      assetResolution: "supported_alias",
    };
  }

  return {
    assetSymbol: context.assetType || "UNKNOWN",
    assetResolution: "unknown",
  };
}

function buildPolicyOnlySummary(
  context: DealPipelineContext,
  reason: string,
  assetMint?: string,
  assetResolution: AssetResolution = "unknown"
): VerificationSummary {
  return {
    verificationLevel: "policy_only",
    provider: "SOLANA_RPC",
    verificationScope: "balance_readiness",
    sellerWallet: context.seller,
    assetMint,
    assetSymbol: context.assetType || "UNKNOWN",
    assetResolution,
    checkedAt: new Date().toISOString(),
    validationSources: ["SOLANA_RPC"],
    reason,
  };
}

function buildBasicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

function shouldUseZerionAsAuthority(
  mode: ZerionVerificationMode
): boolean {
  return mode === "strict";
}

function zerionIsSupportedOnRuntimeNetwork(network: string): boolean {
  return network === "mainnet-beta";
}

function toRawAmount(context: DealPipelineContext, assetMint: string): string | undefined {
  if (context.termsVisibility === "REDACTED") {
    return undefined;
  }

  if (assetMint === UMBRA_SUPPORTED_MINTS.wSOL) {
    return Math.round(Math.max(context.price, context.collateralSeller) * LAMPORTS_PER_SOL).toString();
  }

  if (typeof context.decimals === "number") {
    const scale = 10 ** Math.min(context.decimals, 12);
    return BigInt(Math.round(context.price * scale)).toString();
  }

  return undefined;
}

function positionMatchesAsset(position: ZerionPosition, assetMint: string, assetSymbol: string): boolean {
  const symbol = position.attributes?.fungible_info?.symbol?.toUpperCase();
  const chainId = position.relationships?.chain?.data?.id || "unknown";
  const implementations = position.attributes?.fungible_info?.implementations || [];

  if (assetMint === UMBRA_SUPPORTED_MINTS.wSOL) {
    return chainId === "solana" && symbol === "SOL";
  }

  return implementations.some(
    (implementation) =>
      implementation.chain_id === "solana" &&
      implementation.address === assetMint
  ) || symbol === assetSymbol.toUpperCase();
}

function buildZerionSummary(
  context: DealPipelineContext,
  resolvedAsset: ResolvedAsset,
  position: ZerionPosition,
  requiredAmountRaw?: string,
  validationSources: VerificationSummary["validationSources"] = ["ZERION_API"]
): VerificationSummary {
  const quantity = position.attributes?.quantity;
  const chainId = position.relationships?.chain?.data?.id || "solana";

  return {
    verificationLevel: "zerion_position_check",
    provider: "ZERION_API",
    verificationScope: "balance_readiness",
    sellerWallet: context.seller,
    assetMint: resolvedAsset.assetMint,
    assetSymbol:
      position.attributes?.fungible_info?.symbol ||
      resolvedAsset.assetSymbol,
    assetResolution: resolvedAsset.assetResolution,
    requiredAmountRaw,
    availableAmountRaw: quantity?.int,
    observationBlock: position.attributes?.updated_at_block,
    chainId,
    checkedAt: new Date().toISOString(),
    validationSources,
    positionCount: 1,
    reason: "zerion_position_confirms_wallet_asset_presence",
  };
}

function buildRpcSummary(
  context: DealPipelineContext,
  resolvedAsset: ResolvedAsset,
  requiredAmountRaw: string | undefined,
  availableAmountRaw: string,
  observationSlot: number,
  reason: string,
  fallbackReason?: string,
  validationSources: VerificationSummary["validationSources"] = ["SOLANA_RPC"]
): VerificationSummary {
  return {
    verificationLevel: "onchain_balance_check",
    provider: "SOLANA_RPC",
    verificationScope: "balance_readiness",
    sellerWallet: context.seller,
    assetMint: resolvedAsset.assetMint,
    assetSymbol: resolvedAsset.assetSymbol,
    assetResolution: resolvedAsset.assetResolution,
    requiredAmountRaw,
    availableAmountRaw,
    observationSlot,
    checkedAt: new Date().toISOString(),
    validationSources,
    fallbackReason,
    reason,
  };
}

function isSufficient(availableRaw?: string, requiredAmountRaw?: string): boolean {
  if (!requiredAmountRaw) {
    return !!availableRaw && BigInt(availableRaw) > 0n;
  }
  if (!availableRaw) {
    return false;
  }
  return BigInt(availableRaw) >= BigInt(requiredAmountRaw);
}

async function verifySellerBalanceOnRpc(
  deps: VerificationDeps,
  context: DealPipelineContext,
  resolvedAsset: ResolvedAsset
): Promise<VerificationSummary> {
  if (!resolvedAsset.assetMint) {
    return buildPolicyOnlySummary(
      context,
      "policy_only_verification_without_concrete_asset_mint",
      undefined,
      resolvedAsset.assetResolution
    );
  }

  const connection = deps.getConnection();
  const seller = new PublicKey(context.seller);
  const assetMint = resolvedAsset.assetMint;
  const requiredAmountRaw = toRawAmount(context, assetMint);

  if (assetMint === UMBRA_SUPPORTED_MINTS.wSOL) {
    const { value: availableLamports, context: balanceContext } = await deps.withRetry(
      () => connection.getBalanceAndContext(seller, "confirmed"),
      {
        label: "pipeline_verify_seller_sol_balance",
        ticketId: context.ticketId,
        step: "verify_seller_balance",
      }
    );

    if (!isSufficient(availableLamports.toString(), requiredAmountRaw)) {
      throw new Error(
        `Seller wallet ${seller.toBase58()} has insufficient SOL for execution readiness. ` +
          `required=${requiredAmountRaw || "positive_balance"}, available=${availableLamports}`
      );
    }

      logger.info("pipeline_seller_balance_verified", {
        ticket_id: context.ticketId,
        seller: seller.toBase58(),
        assetMint,
      availableLamports,
      requiredAmountRaw,
      verificationLevel: "onchain_balance_check",
      slot: balanceContext.slot,
    });

    return buildRpcSummary(
      context,
      resolvedAsset,
      requiredAmountRaw,
      availableLamports.toString(),
      balanceContext.slot,
      "seller_sol_balance_meets_execution_threshold"
    );
  }

  const tokenResponse = await deps.withRetry(
    () =>
      connection.getParsedTokenAccountsByOwner(
        seller,
        { mint: new PublicKey(assetMint) },
        "confirmed"
      ),
    {
      label: "pipeline_verify_seller_token_balance",
      ticketId: context.ticketId,
      step: "verify_seller_balance",
    }
  );

  let totalRaw = 0n;
  for (const account of tokenResponse.value) {
    const parsed = account.account.data.parsed.info.tokenAmount.amount as string;
    totalRaw += BigInt(parsed);
  }

  if (!isSufficient(totalRaw.toString(), requiredAmountRaw)) {
    throw new Error(
        `Seller wallet ${seller.toBase58()} has insufficient token balance for negotiated mint ${resolvedAsset.assetMint}. ` +
        `required=${requiredAmountRaw || "positive_balance"}, available=${totalRaw.toString()}`
    );
  }

  logger.info("pipeline_seller_token_presence_verified", {
    ticket_id: context.ticketId,
    seller: seller.toBase58(),
    assetMint: resolvedAsset.assetMint,
    availableRaw: totalRaw.toString(),
    requiredAmountRaw,
    verificationLevel: "onchain_balance_check",
    slot: tokenResponse.context.slot,
  });

  return buildRpcSummary(
    context,
    resolvedAsset,
    requiredAmountRaw,
    totalRaw.toString(),
    tokenResponse.context.slot,
    "seller_token_balance_meets_execution_threshold"
  );
}

async function queryZerionPosition(
  deps: VerificationDeps,
  context: DealPipelineContext,
  resolvedAsset: ResolvedAsset
): Promise<{ summary: VerificationSummary | null; reason?: string }> {
  const config = deps.loadConfig();
  if (config.zerionVerificationMode === "rpc_only") {
    return { summary: null, reason: "zerion_verification_disabled_by_policy" };
  }

  if (!config.zerionApiKey) {
    return { summary: null, reason: "zerion_api_key_not_configured" };
  }

  if (!zerionIsSupportedOnRuntimeNetwork(config.network)) {
    return { summary: null, reason: "zerion_api_not_supported_for_runtime_network" };
  }

  if (!resolvedAsset.assetMint) {
    return { summary: null, reason: "zerion_asset_lookup_requires_resolved_mint" };
  }

  const response = await deps.withRetry(
    async () => {
      const { data } = await deps.httpGet<ZerionPositionsResponse>(
        `${config.zerionApiBaseUrl}/wallets/${encodeURIComponent(context.seller)}/positions/`,
        {
          headers: {
            Accept: "application/json",
            Authorization: buildBasicAuthHeader(config.zerionApiKey!),
          },
          params: {
            "filter[positions]": "only_simple",
            "filter[chain_ids]": "solana",
          },
          timeout: 20_000,
        }
      );
      return data;
    },
    {
      label: "pipeline_verify_seller_zerion_positions",
      ticketId: context.ticketId,
      step: "verify_seller_balance",
    }
  );

  const positions = response.data || [];
  const matching = positions.find((position) =>
    positionMatchesAsset(position, resolvedAsset.assetMint!, resolvedAsset.assetSymbol)
  );

  if (!matching) {
    logger.warn("pipeline_zerion_missing_position", {
      ticket_id: context.ticketId,
      seller: context.seller,
      assetMint: resolvedAsset.assetMint,
      assetSymbol: resolvedAsset.assetSymbol,
      positionCount: positions.length,
    });
    return { summary: null, reason: "zerion_position_not_found_for_asset" };
  }

  const requiredAmountRaw = toRawAmount(context, resolvedAsset.assetMint);
  const summary = buildZerionSummary(context, resolvedAsset, matching, requiredAmountRaw);

  if (!isSufficient(summary.availableAmountRaw, summary.requiredAmountRaw)) {
    logger.warn("pipeline_zerion_reported_insufficient_balance", {
      ticket_id: context.ticketId,
      seller: context.seller,
      assetMint: resolvedAsset.assetMint,
      availableAmountRaw: summary.availableAmountRaw,
      requiredAmountRaw: summary.requiredAmountRaw,
    });
    return {
      summary: {
        ...summary,
        fallbackReason: "zerion_reported_insufficient_balance",
      },
      reason: "zerion_reported_insufficient_balance",
    };
  }

  logger.info("pipeline_zerion_position_verified", {
    ticket_id: context.ticketId,
    seller: context.seller,
    assetMint: resolvedAsset.assetMint,
    availableAmountRaw: summary.availableAmountRaw,
    requiredAmountRaw: summary.requiredAmountRaw,
    observationBlock: summary.observationBlock,
  });

  return { summary };
}

export function createNegotiationVerifier(deps: VerificationDeps = defaultDeps) {
  async function verifyNegotiationForExecution(
    context: DealPipelineContext
  ): Promise<VerificationSummary> {
    const config = deps.loadConfig();
    const redactedPrivateTerms =
      context.negotiationSource === "PER" && context.termsVisibility === "REDACTED";

    if (!redactedPrivateTerms) {
      const econCheck = await deps.validateEconomicSafety({
        buyerAgentId: context.buyer,
        sellerAgentId: context.seller,
        priceSol: context.price,
        collateralBuyerSol: context.collateralBuyer,
        collateralSellerSol: context.collateralSeller,
        collateralPolicy: context.rollupMode === "SPORT" ? "sport_equal_stake" : "standard",
      });

      if (!econCheck.valid) {
        throw new Error(`economic_safety_blocked: ${econCheck.errors.join("; ")}`);
      }

      if (econCheck.warnings.length > 0) {
        logger.warn("pipeline_economic_safety_warnings", {
          ticket_id: context.ticketId,
          warnings: econCheck.warnings,
        });
      }
    }

    MeridianOtcGuard.verifyOrThrow({
      price: redactedPrivateTerms ? 0 : context.price,
      chain: "solana",
      buyerMint: "SOL",
      sellerMint: context.tokenMint || context.assetType,
      asset_type: context.assetType,
      rollupMode: context.rollupMode,
    });

    const resolvedAsset = resolveAsset(context);
    if (!resolvedAsset.assetMint) {
      return buildPolicyOnlySummary(
        context,
        redactedPrivateTerms
          ? "per_private_handoff_redacted_terms_without_concrete_asset_mint"
          : "policy_only_verification_without_concrete_asset_mint",
        undefined,
        resolvedAsset.assetResolution
      );
    }

    const zerionResult = await queryZerionPosition(deps, context, resolvedAsset).catch((error) => {
      logger.warn("pipeline_zerion_verification_failed", {
        ticket_id: context.ticketId,
        error: (error as Error)?.message || String(error),
      });
      return {
        summary: null,
        reason: "zerion_api_request_failed",
      };
    });

    const rpcSummary = await verifySellerBalanceOnRpc(deps, context, resolvedAsset);
    const zerionRequired = shouldUseZerionAsAuthority(config.zerionVerificationMode);

    if (!zerionResult.summary) {
      if (zerionRequired) {
        throw new Error(
          `zerion_verification_required: ${zerionResult.reason || "zerion_verification_unavailable"}`
        );
      }

      return {
        ...rpcSummary,
        validationSources: ["SOLANA_RPC"],
        fallbackReason: zerionResult.reason,
        reason:
          zerionResult.reason === "zerion_api_not_supported_for_runtime_network"
            ? "rpc_balance_check_used_on_non_mainnet_runtime"
            : rpcSummary.reason,
      };
    }

    if (!isSufficient(zerionResult.summary.availableAmountRaw, zerionResult.summary.requiredAmountRaw)) {
      if (zerionRequired) {
        throw new Error("zerion_reported_insufficient_balance");
      }

      logger.warn("pipeline_zerion_rpc_disagreement_resolved_by_rpc_backstop", {
        ticket_id: context.ticketId,
        zerionAvailableAmountRaw: zerionResult.summary.availableAmountRaw,
        zerionRequiredAmountRaw: zerionResult.summary.requiredAmountRaw,
        rpcAvailableAmountRaw: rpcSummary.availableAmountRaw,
        rpcRequiredAmountRaw: rpcSummary.requiredAmountRaw,
      });

      return {
        ...rpcSummary,
        validationSources: ["ZERION_API", "SOLANA_RPC"],
        fallbackReason: zerionResult.reason,
        reason: "rpc_backstop_confirmed_balance_after_zerion_underreported_availability",
      };
    }

    return {
      ...zerionResult.summary,
      validationSources: ["ZERION_API", "SOLANA_RPC"],
      fallbackReason: zerionResult.reason,
      reason:
        config.zerionVerificationMode === "strict"
          ? "zerion_strict_verification_confirmed_by_rpc_backstop"
          : "zerion_primary_verification_confirmed_by_rpc_backstop",
    };
  }

  return {
    verifyNegotiationForExecution,
  };
}

export const { verifyNegotiationForExecution } = createNegotiationVerifier();
