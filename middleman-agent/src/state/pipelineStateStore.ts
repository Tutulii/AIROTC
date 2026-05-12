import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import { appendAuditLog } from "../services/auditTrail";
import type {
  DealPipelineContext,
  DealPipelineStage,
  PipelineStageRecord,
  PipelineStageStatus,
} from "../types/dealPipeline";

const PIPELINE_PREFIX = "pipeline:";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const RECOVERABLE_STAGES = new Set<DealPipelineStage>([
  "received",
  "route_selected",
  "verified",
  "settlement_address_ready",
  "stealth_settlement_ready",
  "stealth_shielding",
  "stealth_balances_verified",
  "stealth_settling",
  "stealth_claiming",
  "umbra_lifecycle_pending",
  "awaiting_settlement_plan_approvals",
  "awaiting_buyer_release_confirmation",
  "seller_dispute_window",
  "awaiting_release_approvals",
  "release_authorized",
  "release_pending",
  "release_signed",
]);

function toTxType(stage: DealPipelineStage): string {
  return `${PIPELINE_PREFIX}${stage}`;
}

class PipelineStateStore {
  private async ensureDealIdInternal(ticketId: string): Promise<string> {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        buyer: true,
        seller: true,
      },
    });

    if (!ticket) {
      throw new Error(`Cannot create pipeline state for unknown ticket ${ticketId}`);
    }

    const middlemanAgent = await prisma.agent.upsert({
      where: { wallet: "system" },
      update: {},
      create: { wallet: "system" },
    });

    const timeout = new Date(Date.now() + DEFAULT_TIMEOUT_MS);
    const deal = await prisma.deal.upsert({
      where: { ticketId },
      update: {},
      create: {
        id: ticketId,
        ticketId,
        buyerId: ticket.buyerId,
        sellerId: ticket.sellerId,
        middlemanId: middlemanAgent.id,
        price: 0,
        collateralBuyer: 0,
        collateralSeller: 0,
        status: "pending_execution",
        timeout,
      },
    });

    return deal.id;
  }

  private async upsertStage(
    ticketId: string,
    stage: DealPipelineStage,
    status: PipelineStageStatus
  ): Promise<void> {
    const dealId = await this.ensureDealIdInternal(ticketId);
    const type = toTxType(stage);

    const existing = await prisma.transaction.findFirst({
      where: { dealId, type },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      await prisma.transaction.update({
        where: { id: existing.id },
        data: { status, txSignature: null },
      });
      return;
    }

    await prisma.transaction.create({
      data: {
        dealId,
        type,
        status,
      },
    });
  }

  async markStage(
    ticketId: string,
    stage: DealPipelineStage,
    status: PipelineStageStatus,
    details?: Record<string, unknown>
  ): Promise<void> {
    await this.upsertStage(ticketId, stage, status);
    await appendAuditLog(ticketId, `deal_pipeline_${stage}_${status}`, details || {});

    logger.info("deal_pipeline_stage_persisted", {
      ticket_id: ticketId,
      stage,
      status,
    });
  }

  async markRouteSelected(ticketId: string, context: DealPipelineContext): Promise<void> {
    await this.markStage(ticketId, "route_selected", "confirmed", {
      route: context.route,
      executionPolicy: context.executionPolicy,
      settlementPolicy: context.settlementPolicy,
      routeReason: context.routeReason,
      negotiationSource: context.negotiationSource,
    });
  }

  async getLatestStage(ticketId: string): Promise<PipelineStageRecord | null> {
    const deal = await prisma.deal.findUnique({
      where: { ticketId },
      include: {
        transactions: {
          where: { type: { startsWith: PIPELINE_PREFIX } },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    const tx = deal?.transactions?.[0];
    if (!tx) {
      return null;
    }

    return {
      ticketId,
      stage: tx.type.replace(PIPELINE_PREFIX, "") as DealPipelineStage,
      status: tx.status as PipelineStageStatus,
      createdAt: tx.createdAt.toISOString(),
    };
  }

  async listRecoverablePipelines(maxAgeHours: number = 24): Promise<PipelineStageRecord[]> {
    const threshold = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const transactions = await prisma.transaction.findMany({
      where: {
        type: { startsWith: PIPELINE_PREFIX },
        createdAt: { gt: threshold },
      },
      include: {
        deal: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const latestByTicket = new Map<string, PipelineStageRecord>();
    for (const tx of transactions) {
      const ticketId = tx.deal.ticketId;
      if (latestByTicket.has(ticketId)) {
        continue;
      }

      latestByTicket.set(ticketId, {
        ticketId,
        stage: tx.type.replace(PIPELINE_PREFIX, "") as DealPipelineStage,
        status: tx.status as PipelineStageStatus,
        createdAt: tx.createdAt.toISOString(),
      });
    }

    return [...latestByTicket.values()].filter((record) => RECOVERABLE_STAGES.has(record.stage));
  }

  async ensureDealId(ticketId: string): Promise<string> {
    return this.ensureDealIdInternal(ticketId);
  }
}

export const pipelineStateStore = new PipelineStateStore();
