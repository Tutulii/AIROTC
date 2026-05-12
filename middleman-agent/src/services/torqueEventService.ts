import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { loadConfig } from "../config";
import { eventBus } from "./eventBus";
import { rewardTargetStore } from "../state/rewardTargetStore";
import { ticketStore } from "../state/ticketStore";
import { privateEscrowIntentStore } from "../state/privateEscrowIntentStore";
import { confidentialFundingStore } from "../state/confidentialFundingStore";
import { dealTracker } from "../state/dealTracker";
import { logger } from "../utils/logger";
import type { DealPipelineStageChangedEvent } from "../types/events";
import type { PipelineRoute, SettlementPolicy } from "../types/dealPipeline";
import { revealPrivateExecutionTerms } from "./privateExecutionTerms";
import { fetchConfidentialDealFundingSnapshot } from "./confidentialExecutionService";
import {
  TORQUE_EVENT_NAME,
  TORQUE_SCHEMA_VERSION,
  bigintToSafeNumber,
  calculateTorqueParticipantReward,
  solToLamports,
  type TorqueRewardQuote,
} from "./torqueRewardPolicy";

const DEFAULT_DELIVERY_BATCH_SIZE = 25;

type ParticipantRole = "buyer" | "seller";

interface TorqueParticipantEventData {
  tradeRef: string;
  participantRole: ParticipantRole;
  rollupMode: "ER" | "PER";
  settlementPolicy: SettlementPolicy;
  pipelineRoute: PipelineRoute;
  tradeNotionalLamports: number;
  platformFeeBps: number;
  platformFeeLamports: number;
  participantRewardLamports: number;
  schemaVersion: number;
}

export interface TorqueIngestPayload {
  userPubkey: string;
  timestamp: number;
  eventName: typeof TORQUE_EVENT_NAME;
  data: TorqueParticipantEventData;
}

interface TorqueEventServiceDeps {
  eventBus: Pick<typeof eventBus, "subscribe" | "unsubscribe">;
  loadConfig: typeof loadConfig;
  rewardTargetStore: Pick<typeof rewardTargetStore, "getLatestByTicket">;
  ticketStore: Pick<typeof ticketStore, "getTicket">;
  privateEscrowIntentStore: Pick<typeof privateEscrowIntentStore, "getLatestByTicket">;
  confidentialFundingStore?: Pick<typeof confidentialFundingStore, "getLatestByTicket">;
  dealTracker: Pick<typeof dealTracker, "getDealByTicket">;
  fetchConfidentialDealFundingSnapshot: typeof fetchConfidentialDealFundingSnapshot;
  prisma: Pick<typeof prisma, "torqueEventDelivery"> & Partial<Pick<typeof prisma, "privateSettlement">>;
  fetchImpl: typeof fetch;
  now: () => Date;
  logger: typeof logger;
}

const defaultDeps: TorqueEventServiceDeps = {
  eventBus,
  loadConfig,
  rewardTargetStore,
  ticketStore,
  privateEscrowIntentStore,
  confidentialFundingStore,
  dealTracker,
  fetchConfidentialDealFundingSnapshot,
  prisma,
  fetchImpl: fetch,
  now: () => new Date(),
  logger,
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildIdempotencyKey(ticketId: string, participantRole: ParticipantRole): string {
  return `${ticketId}:${TORQUE_EVENT_NAME}:${participantRole}:${TORQUE_SCHEMA_VERSION}`;
}

function normalizeRollupMode(
  payload: DealPipelineStageChangedEvent
): "ER" | "PER" | null {
  if (payload.negotiationSource === "ER" || payload.negotiationSource === "PER") {
    return payload.negotiationSource;
  }
  return null;
}

async function hasPendingFullUmbraLifecycle(
  ticketId: string,
  deps: TorqueEventServiceDeps
): Promise<boolean> {
  const privateSettlement = deps.prisma.privateSettlement;
  if (!privateSettlement) {
    return false;
  }

  const pending = await privateSettlement.findFirst({
    where: {
      dealId: ticketId,
      lifecycleMode: "FULL_UMBRA",
      phase: { not: "COMPLETED" },
    },
    select: { id: true, phase: true },
  });

  return !!pending;
}

function clampError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
  return raw.length > 500 ? `${raw.slice(0, 497)}...` : raw;
}

async function resolveRewardQuote(
  ticketId: string,
  rollupMode: "ER" | "PER",
  deps: TorqueEventServiceDeps
): Promise<TorqueRewardQuote> {
  const config = deps.loadConfig();
  let fallbackError: Error | null = null;

  if (rollupMode === "PER") {
    const intent = await deps.privateEscrowIntentStore.getLatestByTicket(ticketId);
    if (intent) {
      try {
        const executionTerms = revealPrivateExecutionTerms(intent);
        return calculateTorqueParticipantReward({
          rollupMode,
          tradeNotionalLamports: BigInt(executionTerms.agreedPriceLamports),
          config,
        });
      } catch (error) {
        fallbackError = error instanceof Error ? error : new Error(String(error));
      }
    }

    const fundingState = await deps.confidentialFundingStore?.getLatestByTicket(ticketId);
    const fundedNotional = fundingState?.fundingAmounts?.buyerPaymentLamports;
    if (fundedNotional) {
      return calculateTorqueParticipantReward({
        rollupMode,
        tradeNotionalLamports: BigInt(fundedNotional),
        config,
      });
    }

    const trackedDeal = await deps.dealTracker.getDealByTicket(ticketId);
    const dealPda = trackedDeal?.dealIdOnChain || intent?.dealPda;
    if (dealPda) {
      try {
        const snapshot = (await deps.fetchConfidentialDealFundingSnapshot(dealPda)) as
          | {
              privateFundingRegistered?: boolean;
              buyerPaymentDeposited?: boolean;
              buyerCollateralDeposited?: boolean;
              sellerCollateralDeposited?: boolean;
              buyerPaymentLamports?: bigint | number | string;
            }
          | undefined;
        const legacyBuyerPaymentLamports = snapshot?.buyerPaymentLamports;
        if (legacyBuyerPaymentLamports != null) {
          return calculateTorqueParticipantReward({
            rollupMode,
            tradeNotionalLamports: BigInt(legacyBuyerPaymentLamports),
            config,
          });
        }
        if (
          snapshot &&
          snapshot.privateFundingRegistered &&
          snapshot.buyerPaymentDeposited &&
          snapshot.buyerCollateralDeposited &&
          snapshot.sellerCollateralDeposited
        ) {
          throw new Error(`torque_reward_requires_offchain_funding_snapshot:${ticketId}`);
        }
      } catch (error) {
        fallbackError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (fallbackError) {
      throw fallbackError;
    }
  }

  const ticket = await deps.ticketStore.getTicket(ticketId);
  if (ticket?.agreed_terms?.price && ticket.agreed_terms.price > 0) {
    return calculateTorqueParticipantReward({
      rollupMode,
      tradeNotionalLamports: solToLamports(ticket.agreed_terms.price),
      config,
    });
  }

  throw new Error(`torque_reward_terms_missing:${ticketId}:${rollupMode}`);
}

export function createTorqueEventService(deps: TorqueEventServiceDeps = defaultDeps) {
  let started = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let processingPromise: Promise<void> | null = null;
  let replayRequested = false;
  let warnedDisabled = false;
  let warnedMissingKey = false;

  async function upsertDelivery(
    ticketId: string,
    participantRole: ParticipantRole,
    userPubkey: string,
    payload: TorqueIngestPayload
  ): Promise<void> {
    const idempotencyKey = buildIdempotencyKey(ticketId, participantRole);
    const payloadHash = sha256Hex(JSON.stringify(payload));
    const payloadJson = JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;

    await deps.prisma.torqueEventDelivery.upsert({
      where: {
        idempotencyKey,
      },
      update: {
        userPubkey,
        payload: payloadJson,
        payloadHash,
      },
      create: {
        idempotencyKey,
        ticketId,
        eventName: TORQUE_EVENT_NAME,
        participantRole,
        userPubkey,
        payload: payloadJson,
        payloadHash,
        schemaVersion: TORQUE_SCHEMA_VERSION,
        status: "queued",
      },
    });
  }

  function buildPayload(
    ticketId: string,
    participantRole: ParticipantRole,
    userPubkey: string,
    payload: DealPipelineStageChangedEvent,
    timestamp: number,
    rewardQuote: TorqueRewardQuote
  ): TorqueIngestPayload {
    const rollupMode = normalizeRollupMode(payload);
    if (!rollupMode) {
      throw new Error(`unsupported_torque_rollup_mode:${payload.negotiationSource}`);
    }

    return {
      userPubkey,
      timestamp,
      eventName: TORQUE_EVENT_NAME,
      data: {
        tradeRef: sha256Hex(ticketId),
        participantRole,
        rollupMode,
        settlementPolicy: payload.settlementPolicy,
        pipelineRoute: payload.route,
        tradeNotionalLamports: bigintToSafeNumber(
          rewardQuote.tradeNotionalLamports,
          "trade_notional_lamports"
        ),
        platformFeeBps: rewardQuote.platformFeeBps,
        platformFeeLamports: bigintToSafeNumber(
          rewardQuote.platformFeeLamports,
          "platform_fee_lamports"
        ),
        participantRewardLamports: bigintToSafeNumber(
          rewardQuote.participantRewardLamports,
          "participant_reward_lamports"
        ),
        schemaVersion: TORQUE_SCHEMA_VERSION,
      },
    };
  }

  async function handleStageChanged(payload: DealPipelineStageChangedEvent): Promise<void> {
    const isSettlementRewardGate =
      payload.stage === "settled" || payload.stage === "umbra_lifecycle_completed";
    if (!isSettlementRewardGate || payload.status !== "confirmed") {
      return;
    }

    if (
      payload.stage === "settled" &&
      payload.settlementPolicy === "STEALTH" &&
      (await hasPendingFullUmbraLifecycle(payload.ticketId, deps))
    ) {
      deps.logger.info("torque_event_waiting_for_umbra_lifecycle", {
        ticket_id: payload.ticketId,
        stage: payload.stage,
      });
      return;
    }

    const config = deps.loadConfig();
    if (!config.enableTorqueEvents) {
      if (!warnedDisabled) {
        warnedDisabled = true;
        deps.logger.info("torque_events_disabled", {
          reason: "ENABLE_TORQUE_EVENTS is false",
        });
      }
      return;
    }

    const rewardTargets = await deps.rewardTargetStore.getLatestByTicket(payload.ticketId);
    if (!rewardTargets?.buyerRewardWallet || !rewardTargets?.sellerRewardWallet) {
      deps.logger.warn("torque_event_skipped_missing_reward_targets", {
        ticket_id: payload.ticketId,
        route: payload.route,
        settlementPolicy: payload.settlementPolicy,
      });
      return;
    }

    const rollupMode = normalizeRollupMode(payload);
    if (!rollupMode) {
      deps.logger.warn("torque_event_skipped_unsupported_rollup_mode", {
        ticket_id: payload.ticketId,
        negotiationSource: payload.negotiationSource,
      });
      return;
    }

    let rewardQuote: TorqueRewardQuote;
    try {
      rewardQuote = await resolveRewardQuote(payload.ticketId, rollupMode, deps);
    } catch (error) {
      deps.logger.warn("torque_event_skipped_missing_trade_terms", {
        ticket_id: payload.ticketId,
        rollupMode,
        error: clampError(error),
      });
      return;
    }

    const timestamp = deps.now().getTime();
    await upsertDelivery(
      payload.ticketId,
      "buyer",
      rewardTargets.buyerRewardWallet,
      buildPayload(
        payload.ticketId,
        "buyer",
        rewardTargets.buyerRewardWallet,
        payload,
        timestamp,
        rewardQuote
      )
    );
    await upsertDelivery(
      payload.ticketId,
      "seller",
      rewardTargets.sellerRewardWallet,
      buildPayload(
        payload.ticketId,
        "seller",
        rewardTargets.sellerRewardWallet,
        payload,
        timestamp,
        rewardQuote
      )
    );

    deps.logger.info("torque_event_delivery_queued", {
      ticket_id: payload.ticketId,
      eventName: TORQUE_EVENT_NAME,
      participantCount: 2,
    });

    void processPendingDeliveries(payload.ticketId);
  }

  async function markFailed(record: {
    id: string;
    attemptCount: number;
  }, error: unknown): Promise<void> {
    const config = deps.loadConfig();
    const now = deps.now();
    const attemptCount = record.attemptCount + 1;
    const delayMs = Math.min(
      config.torqueRetryBaseMs * Math.pow(2, Math.max(attemptCount - 1, 0)),
      config.torqueRetryMaxMs
    );

    await deps.prisma.torqueEventDelivery.update({
      where: { id: record.id },
      data: {
        status: "failed",
        attemptCount,
        lastError: clampError(error),
        lastAttemptAt: now,
        nextAttemptAt: new Date(now.getTime() + delayMs),
      },
    });
  }

  async function deliverRecord(record: {
    id: string;
    ticketId: string;
    userPubkey: string;
    participantRole: string;
    payload: unknown;
    attemptCount: number;
  }): Promise<void> {
    const config = deps.loadConfig();
    if (!config.torqueEventApiKey) {
      if (!warnedMissingKey) {
        warnedMissingKey = true;
        deps.logger.warn("torque_event_delivery_missing_api_key", {
          ingestUrl: config.torqueIngestUrl,
        });
      }
      return;
    }

    try {
      const response = await deps.fetchImpl(config.torqueIngestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.torqueEventApiKey,
        },
        body: JSON.stringify(record.payload),
        signal: AbortSignal.timeout(config.torqueRequestTimeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Torque ingest failed with status ${response.status}`);
      }

      await deps.prisma.torqueEventDelivery.update({
        where: { id: record.id },
        data: {
          status: "sent",
          attemptCount: record.attemptCount + 1,
          lastError: null,
          lastAttemptAt: deps.now(),
          nextAttemptAt: null,
          deliveredAt: deps.now(),
        },
      });

      deps.logger.info("torque_event_delivery_sent", {
        ticket_id: record.ticketId,
        participantRole: record.participantRole,
      });
    } catch (error) {
      await markFailed(record, error);
      deps.logger.warn("torque_event_delivery_failed", {
        ticket_id: record.ticketId,
        participantRole: record.participantRole,
        error: clampError(error),
      });
    }
  }

  async function processPendingDeliveries(ticketId?: string): Promise<void> {
    if (processingPromise) {
      replayRequested = true;
      return processingPromise;
    }

    processingPromise = (async () => {
      const config = deps.loadConfig();
      if (!config.enableTorqueEvents || !config.torqueEventApiKey) {
        return;
      }

      while (true) {
        const now = deps.now();
        const records = await deps.prisma.torqueEventDelivery.findMany({
          where: {
            ...(ticketId ? { ticketId } : {}),
            status: {
              in: ["queued", "failed"],
            },
            OR: [
              { nextAttemptAt: null },
              { nextAttemptAt: { lte: now } },
            ],
          },
          orderBy: [
            { createdAt: "asc" },
            { id: "asc" },
          ],
          take: DEFAULT_DELIVERY_BATCH_SIZE,
        });

        if (records.length === 0) {
          break;
        }

        for (const record of records) {
          await deliverRecord(record as any);
        }

        if (records.length < DEFAULT_DELIVERY_BATCH_SIZE) {
          break;
        }
      }
    })();

    try {
      await processingPromise;
    } finally {
      processingPromise = null;
      if (replayRequested) {
        replayRequested = false;
        await processPendingDeliveries();
      }
    }
  }

  function start(): void {
    if (started) {
      return;
    }

    started = true;
    deps.eventBus.subscribe("deal_pipeline_stage_changed", handleStageChanged);

    const config = deps.loadConfig();
    if (!config.enableTorqueEvents) {
      deps.logger.info("torque_event_service_ready_disabled", {
        ingestUrl: config.torqueIngestUrl,
      });
      return;
    }

    if (!config.torqueEventApiKey) {
      warnedMissingKey = true;
      deps.logger.warn("torque_event_service_missing_api_key", {
        ingestUrl: config.torqueIngestUrl,
      });
    }

    retryTimer = setInterval(() => {
      void processPendingDeliveries().catch((error) => {
        deps.logger.error("torque_event_delivery_poll_failed", {}, error);
      });
    }, config.torqueRetryPollMs);
    retryTimer.unref?.();

    void processPendingDeliveries().catch((error) => {
      deps.logger.error("torque_event_delivery_recovery_failed", {}, error);
    });
  }

  function stop(): void {
    if (!started) {
      return;
    }
    started = false;
    deps.eventBus.unsubscribe("deal_pipeline_stage_changed", handleStageChanged);
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  return {
    start,
    stop,
    handleStageChanged,
    processPendingDeliveries,
  };
}

export const torqueEventService = createTorqueEventService();

export function initTorqueEventService(): void {
  torqueEventService.start();
}

export function stopTorqueEventService(): void {
  torqueEventService.stop();
}
