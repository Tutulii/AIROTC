import { dealPhaseManager } from "../../core/dealPhaseManager";
import { ticketStore } from "../state/ticketStore";
import { appendAuditLog } from "./auditTrail";
import { executeCancelDeal, executeReleasePhase, executeSettleToBuyerPhase } from "./onChainExecutionService";
import { logger } from "../utils/logger";

export type SportSettlementAction =
  | "release_to_maker"
  | "refund_to_taker"
  | "release_to_seller"
  | "release_to_buyer"
  | "void_refund";

export interface ExecuteSportSettlementInput {
  ticketId: string;
  settlementAction: SportSettlementAction;
  matchId?: string;
  fixtureId?: string;
  outcomeWinner?: string;
  winnerWallet?: string;
}

export interface ExecuteSportSettlementResult {
  success: boolean;
  ticketId: string;
  settlementAction: SportSettlementAction;
  onChainAction: "release_funds" | "settle_to_buyer" | "cancel_deal";
  tx?: string;
  status?: "completed" | "refunded" | "cancelled";
  error?: string;
}

function bridgeError(message: string, statusCode: number): Error {
  const error = new Error(message);
  (error as any).statusCode = statusCode;
  return error;
}

function isSportSettlementAction(value: unknown): value is SportSettlementAction {
  return (
    value === "release_to_maker" ||
    value === "refund_to_taker" ||
    value === "release_to_seller" ||
    value === "release_to_buyer" ||
    value === "void_refund"
  );
}

function onChainActionForSettlement(
  settlementAction: SportSettlementAction,
): "release_funds" | "settle_to_buyer" | "cancel_deal" {
  if (settlementAction === "void_refund") {
    return "cancel_deal";
  }
  if (settlementAction === "release_to_maker" || settlementAction === "release_to_seller") {
    return "release_funds";
  }
  return "settle_to_buyer";
}

export async function executeSportSettlement(
  input: ExecuteSportSettlementInput,
): Promise<ExecuteSportSettlementResult> {
  const ticketId = typeof input.ticketId === "string" ? input.ticketId.trim() : "";
  if (!ticketId) throw bridgeError("ticket_id_required", 400);
  if (!isSportSettlementAction(input.settlementAction)) {
    throw bridgeError("invalid_sport_settlement_action", 400);
  }

  const ticket = await ticketStore.getTicket(ticketId);
  if (!ticket) throw bridgeError("sport_ticket_not_found", 404);
  if (ticket.rollup_mode !== "SPORT") {
    throw bridgeError("sport_ticket_rollup_mode_required", 409);
  }

  const deal = await dealPhaseManager.getDealWithFallback(ticketId);
  if (!deal) throw bridgeError("sport_deal_not_found", 404);

  const escrowFunded =
    deal.buyer_deposited &&
    deal.seller_deposited &&
    deal.payment_locked &&
    (deal.phase === "awaiting_result" || deal.phase === "delivery" || deal.phase === "awaiting_release");
  if (!escrowFunded) {
    throw bridgeError("sport_escrow_not_funded", 409);
  }

  const auditPayload = {
    matchId: input.matchId || null,
    fixtureId: input.fixtureId || null,
    outcomeWinner: input.outcomeWinner || null,
    winnerWallet: input.winnerWallet || null,
    settlementAction: input.settlementAction,
  };
  await appendAuditLog(ticketId, "sport_settlement_authorized", auditPayload);

  logger.info("sport_settlement_bridge_authorized", {
    ticketId,
    settlementAction: input.settlementAction,
    fixtureId: input.fixtureId || null,
    matchId: input.matchId || null,
  });

  const onChainAction = onChainActionForSettlement(input.settlementAction);
  const execution =
    onChainAction === "release_funds"
      ? await executeReleasePhase(ticketId)
      : onChainAction === "settle_to_buyer"
        ? await executeSettleToBuyerPhase(ticketId)
        : await executeCancelDeal(ticketId);

  if (!execution.success) {
    await appendAuditLog(ticketId, "sport_settlement_execution_failed", {
      ...auditPayload,
      onChainAction,
      error: execution.error || "unknown_error",
    });
    return {
      success: false,
      ticketId,
      settlementAction: input.settlementAction,
      onChainAction,
      error: execution.error || "sport_settlement_execution_failed",
    };
  }

  const terminalStatus = onChainAction === "release_funds"
    ? "completed"
    : onChainAction === "settle_to_buyer"
      ? "refunded"
      : "cancelled";
  await dealPhaseManager.syncTerminalPhaseFromExecutionStatus(ticketId, terminalStatus);
  await appendAuditLog(ticketId, "sport_settlement_executed", {
    ...auditPayload,
    onChainAction,
    tx: execution.tx || null,
    terminalStatus,
  });

  return {
    success: true,
    ticketId,
    settlementAction: input.settlementAction,
    onChainAction,
    tx: execution.tx,
    status: terminalStatus,
  };
}
