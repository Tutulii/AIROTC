import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { dealPhaseManager } from "../../core/dealPhaseManager";
import { watchForDeposits } from "../listeners/depositWatcher";
import { eventBus } from "./eventBus";
import { getConnection } from "../solana/connection";
import { getDealContext } from "./onChainExecutionService";
import { dealTracker } from "../state/dealTracker";
import { appendAuditLog } from "./auditTrail";
import { logger } from "../utils/logger";

export interface StandardEscrowActivationInput {
  ticketId: string;
  buyer: string;
  seller: string;
  dealPda: string;
  price: number;
  collateralBuyer: number;
  collateralSeller: number;
  assetType?: string;
}

export interface StandardEscrowActivationResult {
  phase: string;
  depositInstructionsPublished: boolean;
  watcherAttached: boolean;
}

export async function activateStandardEscrowLifecycle(
  input: StandardEscrowActivationInput
): Promise<StandardEscrowActivationResult> {
  const activationLog = logger.withContext({
    ticket_id: input.ticketId,
    deal_pda: input.dealPda,
  });

  await dealTracker.storeOnChainId(input.ticketId, input.dealPda);

  const deal = await dealPhaseManager.upsertNegotiationTerms(
    input.ticketId,
    input.buyer,
    input.seller,
    {
      price: input.price,
      collateral_buyer: input.collateralBuyer,
      collateral_seller: input.collateralSeller,
      asset_type: input.assetType,
    }
  );

  if (deal.phase === "negotiation") {
    dealPhaseManager.transition(deal, "escrow_created", "system", "AUTO");
  }

  dealPhaseManager.setEscrowPda(input.ticketId, input.dealPda);

  const dealCtx = getDealContext(input.ticketId);
  let watcherAttached = false;
  if (dealCtx) {
    const connection = getConnection();
    await watchForDeposits(
      connection,
      input.ticketId,
      dealCtx.dealPda,
      Math.floor(input.collateralBuyer * LAMPORTS_PER_SOL),
      Math.floor(input.collateralSeller * LAMPORTS_PER_SOL),
      Math.floor(input.price * LAMPORTS_PER_SOL)
    );
    watcherAttached = true;
  } else {
    activationLog.warn("standard_escrow_activation_missing_context");
  }

  const awaitingDeposits = await dealPhaseManager.advanceToAwaitingDeposits(input.ticketId);
  if (awaitingDeposits) {
    eventBus.publish("middleman_response", {
      ticket_id: awaitingDeposits.response.ticket_id,
      content: awaitingDeposits.response.content,
      phase: awaitingDeposits.response.phase,
      timestamp: awaitingDeposits.response.timestamp,
    });
  }

  await appendAuditLog(input.ticketId, "standard_escrow_activated", {
    dealPda: input.dealPda,
    watcherAttached,
    depositInstructionsPublished: Boolean(awaitingDeposits),
  });

  return {
    phase: awaitingDeposits?.new_phase || deal.phase,
    depositInstructionsPublished: Boolean(awaitingDeposits),
    watcherAttached,
  };
}
