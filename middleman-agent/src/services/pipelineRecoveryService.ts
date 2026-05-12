import { dealPipeline } from "./dealPipeline";
import { pipelineStateStore } from "../state/pipelineStateStore";
import { magicBlockSessions } from "./magicBlockSessionManager";
import { dealTracker } from "../state/dealTracker";
import { appendAuditLog } from "./auditTrail";
import { eventBus } from "./eventBus";
import { logger } from "../utils/logger";
import { prisma } from "../lib/prisma";
import { privateEscrowIntentStore } from "../state/privateEscrowIntentStore";
import { syncObservatoryTicketStatus } from "./observatoryBridge";

const STALE_RECOVERY_ABANDON_THRESHOLD_MS = 30 * 60 * 1000;

export async function recoverPendingDealPipelines(): Promise<number> {
  const candidates = await pipelineStateStore.listRecoverablePipelines();
  let recovered = 0;

  for (const candidate of candidates) {
    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: candidate.ticketId },
      });
      const latestIntent = await privateEscrowIntentStore.getLatestByTicket(candidate.ticketId);

      if (ticket?.rollupMode === "PER" && latestIntent) {
        await dealPipeline.startFromPrivateEscrowIntent(latestIntent);
      } else {
        await dealPipeline.resumeTicket(candidate.ticketId);
      }

      recovered++;
      logger.info("deal_pipeline_recovered", {
        ticket_id: candidate.ticketId,
        previous_stage: candidate.stage,
        previous_status: candidate.status,
        recoverySource:
          ticket?.rollupMode === "PER" && latestIntent ? "private_escrow_intent" : "ticket_terms",
      });
    } catch (error: any) {
      const candidateAgeMs = Date.now() - new Date(candidate.createdAt).getTime();
      const missingSession =
        typeof error?.message === "string" &&
        error.message.includes("No active negotiation session found");

      if (missingSession && candidateAgeMs >= STALE_RECOVERY_ABANDON_THRESHOLD_MS) {
        await pipelineStateStore.markStage(candidate.ticketId, "failed", "confirmed", {
          abandonedByRecovery: true,
          previousStage: candidate.stage,
          previousStatus: candidate.status,
          ageMs: candidateAgeMs,
          reason: error.message,
        });
        await prisma.dealPhaseState
          .update({
            where: { ticketId: candidate.ticketId },
            data: { phase: "cancelled" },
          })
          .catch(() => undefined);
        await prisma.ticket
          .update({
            where: { id: candidate.ticketId },
            data: { status: "cancelled" },
          })
          .catch(() => undefined);
        await syncObservatoryTicketStatus(candidate.ticketId, "cancelled").catch(() => undefined);
        await dealTracker.updateStatus(candidate.ticketId, "cancelled").catch(() => undefined);
        await appendAuditLog(candidate.ticketId, "deal_pipeline_recovery_abandoned", {
          previousStage: candidate.stage,
          previousStatus: candidate.status,
          ageMs: candidateAgeMs,
          reason: error.message,
        });
        logger.warn("deal_pipeline_recovery_abandoned", {
          ticket_id: candidate.ticketId,
          previous_stage: candidate.stage,
          previous_status: candidate.status,
          age_ms: candidateAgeMs,
          reason: error.message,
        });
        continue;
      }

      logger.warn("deal_pipeline_recovery_skipped", {
        ticket_id: candidate.ticketId,
        previous_stage: candidate.stage,
        previous_status: candidate.status,
        error: error?.message || String(error),
      });
    }
  }

  logger.info("deal_pipeline_recovery_complete", {
    candidates: candidates.length,
    recovered,
  });

  return recovered;
}

export async function recoverPendingPrivateSessionFinalizations(
  maxAgeHours: number = 24
): Promise<number> {
  const threshold = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
  const pendingDeals = await prisma.deal.findMany({
    where: {
      status: {
        in: ["pending_confidential_session_close", "settled_pending_session_close"],
      },
      createdAt: { gt: threshold },
    },
  });

  let finalized = 0;
  for (const deal of pendingDeals) {
    try {
      const commitSignature = await magicBlockSessions.finalizePrivateTicket(deal.ticketId);
      if (!commitSignature) {
        logger.warn("deal_pipeline_private_finalize_session_missing", {
          ticket_id: deal.ticketId,
        });
        continue;
      }

      magicBlockSessions.completeTicketSession(deal.ticketId);
      const recoveredStatus =
        deal.status === "settled_pending_session_close" ? "settled" : "completed_confidential";
      const executionStatus =
        recoveredStatus === "settled" ? "settled" : "confidential_completed";

      await dealTracker.updateStatus(deal.ticketId, recoveredStatus);
      await appendAuditLog(deal.ticketId, "deal_pipeline_private_session_finalize_recovered", {
        commitSignature,
        recoveredStatus,
      });
      eventBus.publish("deal_executed", {
        ticket_id: deal.ticketId,
        status: executionStatus,
      });
      finalized++;
    } catch (error: any) {
      logger.warn("deal_pipeline_private_finalize_recovery_failed", {
        ticket_id: deal.ticketId,
        error: error?.message || String(error),
      });
    }
  }

  logger.info("deal_pipeline_private_finalize_recovery_complete", {
    candidates: pendingDeals.length,
    finalized,
  });

  return finalized;
}
