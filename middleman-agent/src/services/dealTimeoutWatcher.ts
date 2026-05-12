import { prisma } from "../lib/prisma";
import { executeRefundOnTimeout } from "./onChainExecutionService";
import { logger } from "../utils/logger";
import { withRetry, sleep } from "../utils/retry";

type DealStatus =
  | "created"
  | "collateral_locked"
  | "payment_locked"
  | "completed"
  | "refunded"
  | "expired"
  | "timeout_failed";

import { shutdownManager } from "../utils/shutdownManager";

export let isTimeoutWatcherRunning = false;

export function stopDealTimeoutWatcher() {
  logger.info("watcher_stopped");
  isTimeoutWatcherRunning = false;
}

export async function startDealTimeoutWatcher() {
  logger.info("watcher_started");
  isTimeoutWatcherRunning = true;

  while (isTimeoutWatcherRunning) {
    if (!shutdownManager.canAcceptNewWork()) break;

    try {
      await runWatcherCycle();
    } catch (err: any) {
      logger.error("watcher_tick_error", {}, err);
    }
    await sleep(30000);
  }
}

export async function runWatcherCycle() {
  const now = new Date();

  const expiredDeals = await prisma.deal.findMany({
    where: {
      status: { in: ["created", "collateral_locked", "payment_locked"] },
      timeout: { lt: now },
      isProcessing: false,
      // Skip simulated and test deals that have fake wallet addresses
      NOT: [
        { id: { startsWith: "SOUL-SIM" } },
        { ticketId: { startsWith: "TCK-TEST" } },
      ],
    },
    include: {
      buyer: true,
      seller: true,
    }
  });

  if (expiredDeals.length > 0) {
    logger.info("watcher_tick", { expired_count: expiredDeals.length });
  }

  for (const deal of expiredDeals) {
    const updated = await prisma.deal.updateMany({
      where: {
        id: deal.id,
        isProcessing: false,
      },
      data: {
        isProcessing: true,
      },
    });

    if (updated.count === 0) continue;

    logger.info("deal_expired_detected", {
      deal_id: deal.id,
      ticket_id: deal.ticketId,
      status: deal.status,
      timeout: deal.timeout?.toISOString(),
    });

    try {
      await handleExpiredDeal(deal);
    } catch (error: any) {
      logger.error("timeout_failed", { deal_id: deal.id, ticket_id: deal.ticketId }, error);
      await prisma.deal.update({
        where: { id: deal.id },
        data: { isProcessing: false, status: "timeout_failed" },
      });
    }
  }
}

async function handleExpiredDeal(deal: any) {
  if (deal.status === "created") {
    await prisma.deal.update({
      where: { id: deal.id },
      data: { status: "expired" as DealStatus, isProcessing: false },
    });
    logger.info("deal_expired_safe", { deal_id: deal.id, reason: "no_funds_locked" });
    return;
  }

  if (deal.status === "collateral_locked" || deal.status === "payment_locked") {
    logger.info("refund_triggered", { deal_id: deal.id, status: deal.status });
    
    if (!deal.dealIdOnChain || !deal.buyer?.wallet || !deal.seller?.wallet) {
       logger.error("refund_blocked", { deal_id: deal.id, reason: "missing_on_chain_state_or_wallets" });
       await prisma.deal.update({ where: { id: deal.id }, data: { status: "timeout_failed" as DealStatus, isProcessing: false } });
       return;
    }

    await withRetry(async () => {
      const result = await executeRefundOnTimeout({
        ticketId: deal.ticketId,
        dealIdOnChain: deal.dealIdOnChain,
        buyerWallet: deal.buyer.wallet,
        sellerWallet: deal.seller.wallet,
      });
      if (!result.success) {
        throw new Error(result.error || "Refund execution failed");
      }
    }, { label: "watcher_refund", ticketId: deal.ticketId, step: "timeout_refund" });

    await prisma.deal.update({
      where: { id: deal.id },
      data: { status: "refunded" as DealStatus, isProcessing: false },
    });
    logger.info("refund_completed", { deal_id: deal.id, ticket_id: deal.ticketId });
  }
}
