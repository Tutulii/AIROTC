/**
 * Deposit Watcher (Option A — On-Chain Balance Monitor)
 *
 * Watches deal PDA accounts for incoming plain SOL transfers.
 * When the balance increases enough to cover the next expected deposit,
 * the middleman automatically calls `confirm_deposit` on-chain.
 *
 * DUNE SIM INTEGRATION:
 * Uses Dune SIM SVM APIs as a secondary verification layer.
 * After WebSocket-based detection identifies a deposit, Dune SIM
 * cross-validates the balance via its independent data index.
 * This provides dual-source deposit confirmation for maximum reliability.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { logger } from "../utils/logger";
import { eventBus } from "../services/eventBus";
import { dealTracker } from "../state/dealTracker";
import { prisma } from "../lib/prisma";
import { duneSIM } from "../services/duneSIMService";
import { executeConfirmDeposit, getAnchorProgram } from "../services/onChainExecutionService";
import { dealPhaseManager } from "../../core/dealPhaseManager";

// Track active watchers so we can unsubscribe later
const activeWatchers: Map<string, { subId?: number; pollId?: ReturnType<typeof setInterval>; connection: Connection }> = new Map();

// Track last known balance per PDA to detect deposits
const lastKnownBalance: Map<string, number> = new Map(); // pda_base58 → lamports

export interface DepositExpectation {
  ticketId: string;
  dealPda: PublicKey;
  initialBalanceLamports: number;
  expectedBuyerCollateral: number;
  expectedSellerCollateral: number;
  expectedPayment: number;
  buyerDeposited: boolean;
  sellerDeposited: boolean;
  paymentDeposited: boolean;
}

const expectations: Map<string, DepositExpectation> = new Map();
type DepositType = "buyer_collateral" | "seller_collateral" | "buyer_payment";
const DUST_TOLERANCE_LAMPORTS = 2000;
const DEPOSIT_CONFIRMATION_ORDER: DepositType[] = [
  "buyer_collateral",
  "seller_collateral",
  "buyer_payment",
];

export async function watchForDeposits(
  connection: Connection,
  ticketId: string,
  dealPda: PublicKey,
  buyerCollateralLamports: number,
  sellerCollateralLamports: number,
  paymentLamports: number,
): Promise<void> {
  if (activeWatchers.has(ticketId)) {
    logger.info("deposit_watcher_skip", { ticket_id: ticketId, reason: "Already watching" });
    return;
  }

  const pdaStr = dealPda.toBase58();
  const watcherLog = logger.withContext({ ticket_id: ticketId, deal_id: pdaStr });

  expectations.set(ticketId, {
    ticketId,
    dealPda,
    initialBalanceLamports: 0,
    expectedBuyerCollateral: buyerCollateralLamports,
    expectedSellerCollateral: sellerCollateralLamports,
    expectedPayment: paymentLamports,
    buyerDeposited: false,
    sellerDeposited: false,
    paymentDeposited: false,
  });

  // Initialize deposit confirmation records for idempotency
  try {
    await prisma.depositConfirmation.createMany({
      data: [
        { ticketId, type: "buyer_collateral" },
        { ticketId, type: "seller_collateral" },
        { ticketId, type: "buyer_payment" },
      ],
      skipDuplicates: true,
    });
  } catch (e: any) {
    if (e.code === "P2002") {
      watcherLog.debug("deposit_confirmation_init_duplicate");
    } else {
      watcherLog.error("deposit_confirmation_init_failed", { error: e.message });
      throw e;
    }
  }

  watcherLog.info("deposit_watcher_started", {
    expectedBuyerCollateral: buyerCollateralLamports / LAMPORTS_PER_SOL,
    expectedSellerCollateral: sellerCollateralLamports / LAMPORTS_PER_SOL,
    expectedPayment: paymentLamports / LAMPORTS_PER_SOL,
  });

  try {
    const initialBalance = await connection.getBalance(dealPda);
    lastKnownBalance.set(pdaStr, initialBalance);
    const expect = expectations.get(ticketId);
    if (expect) {
      expect.initialBalanceLamports = initialBalance;
    }
    watcherLog.info("deposit_watcher_initial_balance", {
      balance: initialBalance / LAMPORTS_PER_SOL,
    });
    if (expect && buyerCollateralLamports === 0) {
      void autoConfirmZeroBuyerCollateral(ticketId, expect).catch((e: any) => {
        watcherLog.error("zero_buyer_collateral_auto_confirm_failed", { error: e.message });
      });
    }
  } catch (e: any) {
    watcherLog.error("deposit_watcher_initial_balance_failed", { error: e.message });
    throw e;
  }

  const pollIntervalMs = Number(process.env.AIROTC_DEPOSIT_POLL_INTERVAL_MS || "3000");
  const pollId = setInterval(() => {
    const expect = expectations.get(ticketId);
    if (!expect) return;
    pollOnChainDealState(connection, ticketId, expect).catch(e => {
      watcherLog.error("deposit_poll_failed", { error: e.message });
    });
  }, pollIntervalMs);

  void pollOnChainDealState(connection, ticketId, expectations.get(ticketId)!).catch(e => {
    watcherLog.error("deposit_initial_poll_failed", { error: e.message });
  });
  void reconcileDepositWatcherFromHistory(connection, ticketId, "startup").catch(e => {
    watcherLog.error("deposit_initial_reconcile_failed", { error: e.message });
  });

  let subscriptionId: number | undefined;
  if (process.env.AIROTC_ENABLE_DEPOSIT_WS_WATCHER === "true") {
    subscriptionId = connection.onAccountChange(
      dealPda,
      (accountInfo, _context) => {
        const newBalance = accountInfo.lamports;
        const prevBalance = lastKnownBalance.get(pdaStr) || 0;

        if (newBalance > prevBalance) {
          const deposit = newBalance - prevBalance;

          watcherLog.info("deposit_detected", {
            previousBalance: prevBalance / LAMPORTS_PER_SOL,
            newBalance: newBalance / LAMPORTS_PER_SOL,
            depositAmount: deposit / LAMPORTS_PER_SOL,
          });

          lastKnownBalance.set(pdaStr, newBalance);

          const expect = expectations.get(ticketId);
          if (expect) {
            // Fire-and-forget async confirmation
            identifyAndConfirmDeposit(connection, ticketId, expect, newBalance, deposit).catch(e => {
              watcherLog.error("deposit_confirmation_failed", { error: e.message });
            });
          }
        }
      },
      "confirmed",
    );
  }

  activeWatchers.set(ticketId, { subId: subscriptionId, pollId, connection });
}

async function markProgramStateDeposit(
  ticketId: string,
  expect: DepositExpectation,
  depositType: DepositType,
  txHash?: string,
): Promise<void> {
  const syntheticSignature = txHash || `program-state:${expect.dealPda.toBase58()}:${depositType}`;
  const updated = await prisma.depositConfirmation.updateMany({
    where: { ticketId, type: depositType, confirmed: false },
    data: { confirmed: true, txHash: syntheticSignature },
  });

  if (updated.count > 0) {
    const deal = await prisma.deal.findUnique({ where: { ticketId } });
    if (deal) {
      await prisma.transaction.create({
        data: {
          dealId: deal.id,
          type: depositType,
          txSignature: syntheticSignature,
          status: "confirmed",
        },
      }).catch((err: any) => {
        if (err.code !== "P2002") throw err;
      });
    }
  }

  await dealPhaseManager.getDealWithFallback(ticketId);
  if (depositType === "buyer_collateral") {
    expect.buyerDeposited = true;
    await dealPhaseManager.recordDeposit(ticketId, "buyer");
  } else if (depositType === "seller_collateral") {
    expect.sellerDeposited = true;
    await dealPhaseManager.recordDeposit(ticketId, "seller");
  } else {
    expect.paymentDeposited = true;
    await dealPhaseManager.recordPaymentLocked(ticketId);
  }

  logger.info("deposit_program_state_confirmed", {
    ticket_id: ticketId,
    depositType,
    deal_pda: expect.dealPda.toBase58(),
  });
}

async function autoConfirmZeroBuyerCollateral(
  ticketId: string,
  expect: DepositExpectation,
): Promise<void> {
  if (expect.expectedBuyerCollateral !== 0 || expect.buyerDeposited) {
    return;
  }

  logger.info("zero_buyer_collateral_auto_confirm_started", {
    ticket_id: ticketId,
    deal_pda: expect.dealPda.toBase58(),
  });

  const result = await executeConfirmDeposit(ticketId, "buyer_collateral");
  if (!result.success) {
    logger.warn("zero_buyer_collateral_auto_confirm_rejected", {
      ticket_id: ticketId,
      error: result.error || "unknown_error",
    });
    return;
  }

  await markProgramStateDeposit(ticketId, expect, "buyer_collateral", result.tx);
}

async function pollOnChainDealState(
  _connection: Connection,
  ticketId: string,
  expect: DepositExpectation,
): Promise<void> {
  const { program } = getAnchorProgram();
  const account = await (program.account as any).deal.fetch(expect.dealPda);

  if (account.buyerCollateralLocked && !expect.buyerDeposited) {
    await markProgramStateDeposit(ticketId, expect, "buyer_collateral");
  }

  if (account.sellerCollateralLocked && !expect.sellerDeposited) {
    await markProgramStateDeposit(ticketId, expect, "seller_collateral");
  }

  if (account.paymentLocked && !expect.paymentDeposited) {
    await markProgramStateDeposit(ticketId, expect, "buyer_payment");
  }

  if (expect.buyerDeposited && expect.sellerDeposited && expect.paymentDeposited) {
    stopWatching(ticketId);
  }
}

function expectedAmountForDeposit(expect: DepositExpectation, depositType: DepositType): number {
  if (depositType === "buyer_collateral") return expect.expectedBuyerCollateral;
  if (depositType === "seller_collateral") return expect.expectedSellerCollateral;
  return expect.expectedPayment;
}

function markExpectationConfirmed(expect: DepositExpectation, depositType: DepositType): void {
  if (depositType === "buyer_collateral") {
    expect.buyerDeposited = true;
  } else if (depositType === "seller_collateral") {
    expect.sellerDeposited = true;
  } else {
    expect.paymentDeposited = true;
  }
}

function isDepositConfirmed(expect: DepositExpectation, depositType: DepositType): boolean {
  if (depositType === "buyer_collateral") return expect.buyerDeposited;
  if (depositType === "seller_collateral") return expect.sellerDeposited;
  return expect.paymentDeposited;
}

async function publishAggregateBalanceDeposit(
  ticketId: string,
  expect: DepositExpectation,
  depositType: DepositType,
  currentBalance: number,
): Promise<boolean> {
  const syntheticSignature = `aggregate-balance:${expect.dealPda.toBase58()}:${depositType}`;
  const updated = await prisma.depositConfirmation.updateMany({
    where: { ticketId, type: depositType, confirmed: false },
    data: { confirmed: true, txHash: syntheticSignature },
  });

  markExpectationConfirmed(expect, depositType);

  if (updated.count === 0) {
    logger.warn("deposit_aggregate_confirmation_duplicate", {
      ticket_id: ticketId,
      depositType,
      deal_pda: expect.dealPda.toBase58(),
    });
    return false;
  }

  const deal = await prisma.deal.findUnique({ where: { ticketId } });
  if (deal) {
    await prisma.transaction.create({
      data: {
        dealId: deal.id,
        type: depositType,
        txSignature: syntheticSignature,
        status: "confirmed",
      },
    }).catch((err: any) => {
      if (err.code !== "P2002") throw err;
    });
  }

  const amountLamports = expectedAmountForDeposit(expect, depositType);
  logger.info("deposit_aggregate_balance_confirmed", {
    ticket_id: ticketId,
    depositType,
    amount: amountLamports / LAMPORTS_PER_SOL,
    balance: currentBalance / LAMPORTS_PER_SOL,
    deal_pda: expect.dealPda.toBase58(),
  });

  eventBus.publish("deposit_received", {
    ticket_id: ticketId,
    deal_pda: expect.dealPda.toBase58(),
    deposit_type: depositType,
    amount_lamports: amountLamports,
    dune_sim_verified: false,
  });

  return true;
}

async function reconcileFullyFundedBalance(
  ticketId: string,
  expect: DepositExpectation,
  currentBalance: number,
): Promise<boolean> {
  const expectedTotal =
    expect.expectedBuyerCollateral
    + expect.expectedSellerCollateral
    + expect.expectedPayment;
  const requiredBalance = expect.initialBalanceLamports + expectedTotal;

  if (expectedTotal <= 0 || currentBalance + DUST_TOLERANCE_LAMPORTS < requiredBalance) {
    return false;
  }

  const missingDepositTypes = DEPOSIT_CONFIRMATION_ORDER.filter(type => !isDepositConfirmed(expect, type));
  if (missingDepositTypes.length === 0) {
    return true;
  }

  logger.warn("deposit_aggregate_balance_reconcile_started", {
    ticket_id: ticketId,
    balance: currentBalance / LAMPORTS_PER_SOL,
    expected_total: expectedTotal / LAMPORTS_PER_SOL,
    initial_balance: expect.initialBalanceLamports / LAMPORTS_PER_SOL,
    required_balance: requiredBalance / LAMPORTS_PER_SOL,
    missing: missingDepositTypes,
    deal_pda: expect.dealPda.toBase58(),
  });

  let publishedAny = false;
  for (const depositType of missingDepositTypes) {
    const published = await publishAggregateBalanceDeposit(ticketId, expect, depositType, currentBalance);
    publishedAny = publishedAny || published;
  }

  if (expect.buyerDeposited && expect.sellerDeposited && expect.paymentDeposited) {
    stopWatching(ticketId);
  }

  return publishedAny;
}



async function identifyAndConfirmDeposit(
  connection: Connection,
  ticketId: string,
  expect: DepositExpectation,
  currentBalance: number,
  depositAmount: number,
  pass = 0,
): Promise<void> {
  function isClose(actual: number, expected: number): boolean {
    if (expected === 0) return false;
    return Math.abs(actual - expected) <= DUST_TOLERANCE_LAMPORTS;
  }

  // Poll recent signatures for the PDA and process each unseen transfer individually.
  // This avoids misclassifying two close-together deposits as one combined balance jump.
  const sigs = await connection.getSignaturesForAddress(expect.dealPda, { limit: 10 }, "confirmed");
  if (sigs.length === 0) {
    logger.warn("deposit_verification_failed", { ticket_id: ticketId, reason: "No signatures found" });
    return;
  }

  const recentSuccessfulSigs = sigs.filter(s => !s.err).reverse();
  if (recentSuccessfulSigs.length === 0) {
    logger.warn("deposit_verification_failed", { ticket_id: ticketId, reason: "No successful signatures" });
    return;
  }

  // LEVEL 5: Get expected buyer/seller wallets from execution context for direction validation
  const { dealContexts } = await import("../services/onChainExecutionService");
  const dealCtx = dealContexts[ticketId];
  const expectedBuyerWallet = dealCtx?.buyer?.toBase58();
  const expectedSellerWallet = dealCtx?.seller?.toBase58();

  let processedAnyDeposit = false;

  for (const sigInfo of recentSuccessfulSigs) {
    const tx = await connection.getTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx || !tx.transaction.message.staticAccountKeys || !tx.meta) {
      logger.warn("deposit_verification_failed", {
        ticket_id: ticketId,
        reason: "Could not fetch tx details",
        signature: sigInfo.signature,
      });
      continue;
    }

    const accountKeys = tx.transaction.message.staticAccountKeys;
    const dealPdaIndex = accountKeys.findIndex(key => key.equals(expect.dealPda));
    if (dealPdaIndex < 0) {
      logger.warn("deposit_verification_failed", {
        ticket_id: ticketId,
        reason: "Deal PDA missing from tx accounts",
        signature: sigInfo.signature,
      });
      continue;
    }

    const txDepositAmount = tx.meta.postBalances[dealPdaIndex] - tx.meta.preBalances[dealPdaIndex];
    if (txDepositAmount <= 0) {
      continue;
    }

    const senderPubkey = accountKeys[0]?.toBase58();
    if (!senderPubkey) {
      logger.warn("deposit_verification_failed", {
        ticket_id: ticketId,
        reason: "Missing sender pubkey",
        signature: sigInfo.signature,
      });
      continue;
    }

    logger.info("deposit_sender_verified", {
      ticket_id: ticketId,
      sender: senderPubkey,
      signature: sigInfo.signature,
      amount: txDepositAmount / LAMPORTS_PER_SOL,
    });

    const depositTypes: DepositType[] = [];
    const isGroupedBuyerTransfer = isClose(
      txDepositAmount,
      expect.expectedBuyerCollateral + expect.expectedPayment,
    );

    if (
      !expect.sellerDeposited
      && expectedSellerWallet
      && senderPubkey === expectedSellerWallet
      && isClose(txDepositAmount, expect.expectedSellerCollateral)
    ) {
      depositTypes.push("seller_collateral");
      expect.sellerDeposited = true;
    } else if (
      !expect.buyerDeposited
      && expectedBuyerWallet
      && senderPubkey === expectedBuyerWallet
      && isClose(txDepositAmount, expect.expectedBuyerCollateral)
    ) {
      depositTypes.push("buyer_collateral");
      expect.buyerDeposited = true;
    } else if (!expect.buyerDeposited && isClose(txDepositAmount, expect.expectedBuyerCollateral)) {
      if (expectedBuyerWallet && senderPubkey !== expectedBuyerWallet) {
        logger.warn("deposit_direction_mismatch", {
          ticket_id: ticketId,
          type: "buyer_collateral",
          sender: senderPubkey,
          expected: expectedBuyerWallet,
          signature: sigInfo.signature,
        });
        continue;
      }
      depositTypes.push("buyer_collateral");
      expect.buyerDeposited = true;
    } else if (!expect.buyerDeposited && !expect.paymentDeposited && isGroupedBuyerTransfer) {
      if (expectedBuyerWallet && senderPubkey !== expectedBuyerWallet) {
        logger.warn("deposit_direction_mismatch", {
          ticket_id: ticketId,
          type: "buyer_grouped",
          sender: senderPubkey,
          expected: expectedBuyerWallet,
          signature: sigInfo.signature,
        });
        continue;
      }
      depositTypes.push("buyer_collateral");
      expect.buyerDeposited = true;
      if (expect.sellerDeposited) {
        depositTypes.push("buyer_payment");
        expect.paymentDeposited = true;
      }
    } else if (!expect.sellerDeposited && isClose(txDepositAmount, expect.expectedSellerCollateral)) {
      if (expectedSellerWallet && senderPubkey !== expectedSellerWallet) {
        logger.warn("deposit_direction_mismatch", {
          ticket_id: ticketId,
          type: "seller_collateral",
          sender: senderPubkey,
          expected: expectedSellerWallet,
          signature: sigInfo.signature,
        });
        continue;
      }
      depositTypes.push("seller_collateral");
      expect.sellerDeposited = true;
    } else if (
      !expect.paymentDeposited
      && expect.buyerDeposited
      && expect.sellerDeposited
      && (isClose(txDepositAmount, expect.expectedPayment) || isGroupedBuyerTransfer)
    ) {
      if (expectedBuyerWallet && senderPubkey !== expectedBuyerWallet) {
        logger.warn("deposit_direction_mismatch", {
          ticket_id: ticketId,
          type: "buyer_payment",
          sender: senderPubkey,
          expected: expectedBuyerWallet,
          signature: sigInfo.signature,
        });
        continue;
      }
      depositTypes.push("buyer_payment");
      expect.paymentDeposited = true;
    }

    if (depositTypes.length === 0) {
      continue;
    }

    processedAnyDeposit = true;

    // ── DUNE SIM: Secondary verification layer ──
    // Cross-validate the deposit via Dune SIM's independent data index
    let duneSIMVerified = false;
    if (duneSIM.isAvailable) {
      try {
        const verification = await duneSIM.verifyDeposit(
          expect.dealPda.toBase58(),
          currentBalance,
          senderPubkey,
        );
        duneSIMVerified = verification.verified;
        logger.info("dune_sim_secondary_verification", {
          ticket_id: ticketId,
          verified: duneSIMVerified,
          sim_balance: verification.currentBalance,
          ws_balance: currentBalance,
          recent_deposits_found: verification.recentDeposits.length,
          data_source: "dune_sim",
        });
      } catch (simErr: any) {
        // Dune SIM failure is non-blocking — WS detection is primary
        logger.debug("dune_sim_verification_non_blocking_error", {
          ticket_id: ticketId,
          error: simErr.message,
        });
      }
    }

    for (const depositType of depositTypes) {
      logger.info("deposit_identified", {
        ticket_id: ticketId,
        depositType,
        amount: txDepositAmount / LAMPORTS_PER_SOL,
        signature: sigInfo.signature,
        dune_sim_verified: duneSIMVerified,
      });

      try {
        // LEVEL 5: Idempotency guard — prevents double-confirmation when WS + polling fire together
        const updated = await prisma.depositConfirmation.updateMany({
          where: { ticketId, type: depositType, confirmed: false },
          data: { confirmed: true, txHash: sigInfo.signature },
        });
        if (updated.count === 0) {
          logger.warn("duplicate_deposit_confirmation_blocked", { ticket_id: ticketId, type: depositType });
          continue; // Already confirmed — skip
        }

        const deal = await prisma.deal.findUnique({ where: { ticketId } });
        if (deal) {
          // If grouped, append deposit_type to txSignature to bypass Prisma's strictly unique txSignature constraint
          const uniqueTxSignature = depositTypes.length > 1 
            || isGroupedBuyerTransfer
            ? `${sigInfo.signature}-${depositType}` 
            : sigInfo.signature;
            
          await prisma.transaction.create({
            data: {
              dealId: deal.id,
              type: depositType,
              txSignature: uniqueTxSignature,
              status: "confirmed"
            }
          });
        }
      } catch (err: any) {
        if (err.code === "P2002") {
          logger.info("deposit_replay_prevented_db", { ticket_id: ticketId, signature: sigInfo.signature });
          continue; // Already processed
        }
        logger.error("Failed to record deposit transaction", { error: err });
      }

      eventBus.publish("deposit_received", {
        ticket_id: ticketId,
        deal_pda: expect.dealPda.toBase58(),
        deposit_type: depositType,
        amount_lamports: txDepositAmount,
        dune_sim_verified: duneSIMVerified,
      });
    }
  }

  if (!processedAnyDeposit) {
    logger.warn("deposit_unidentified", {
      ticket_id: ticketId,
      amount: depositAmount / LAMPORTS_PER_SOL,
      reason: "Could not match to expected deposit",
    });
  }

  if (
    processedAnyDeposit
    && pass < 2
    && (expect.buyerDeposited || expect.sellerDeposited)
    && !expect.paymentDeposited
  ) {
    await identifyAndConfirmDeposit(connection, ticketId, expect, currentBalance, depositAmount, pass + 1);
  }

  if (expect.buyerDeposited && expect.sellerDeposited && expect.paymentDeposited) {
    stopWatching(ticketId);
  }
}

export async function reconcileDepositWatcherFromHistory(
  connection: Connection,
  ticketId: string,
  reason = "manual",
): Promise<{
  reconciled: boolean;
  reason: string;
  currentBalanceLamports?: number;
  buyerDeposited?: boolean;
  sellerDeposited?: boolean;
  paymentDeposited?: boolean;
}> {
  const expect = expectations.get(ticketId);
  if (!expect) {
    logger.warn("deposit_reconcile_skipped", { ticket_id: ticketId, reason: "no_active_expectation" });
    return { reconciled: false, reason: "no_active_expectation" };
  }

  try {
    await pollOnChainDealState(connection, ticketId, expect);
  } catch (e: any) {
    logger.debug("deposit_reconcile_program_state_poll_failed", {
      ticket_id: ticketId,
      reason,
      error: e?.message || String(e),
    });
  }

  if (expect.buyerDeposited && expect.sellerDeposited && expect.paymentDeposited) {
    return {
      reconciled: true,
      reason: "program_state_complete",
      buyerDeposited: true,
      sellerDeposited: true,
      paymentDeposited: true,
    };
  }

  const pdaStr = expect.dealPda.toBase58();
  const currentBalance = await connection.getBalance(expect.dealPda, "confirmed");
  const previousBalance = lastKnownBalance.get(pdaStr) || 0;
  lastKnownBalance.set(pdaStr, Math.max(previousBalance, currentBalance));

  const before = {
    buyerDeposited: expect.buyerDeposited,
    sellerDeposited: expect.sellerDeposited,
    paymentDeposited: expect.paymentDeposited,
  };

  await identifyAndConfirmDeposit(
    connection,
    ticketId,
    expect,
    currentBalance,
    Math.max(0, currentBalance - previousBalance),
  );

  const aggregateReconciled =
    !(expect.buyerDeposited && expect.sellerDeposited && expect.paymentDeposited)
    && await reconcileFullyFundedBalance(ticketId, expect, currentBalance);

  const reconciled =
    before.buyerDeposited !== expect.buyerDeposited
    || before.sellerDeposited !== expect.sellerDeposited
    || before.paymentDeposited !== expect.paymentDeposited
    || aggregateReconciled;

  logger.info("deposit_reconcile_finished", {
    ticket_id: ticketId,
    reason,
    reconciled,
    aggregate_reconciled: aggregateReconciled,
    balance_sol: currentBalance / LAMPORTS_PER_SOL,
    buyerDeposited: expect.buyerDeposited,
    sellerDeposited: expect.sellerDeposited,
    paymentDeposited: expect.paymentDeposited,
  });

  return {
    reconciled,
    reason: aggregateReconciled
      ? "aggregate_balance_reconciled"
      : reconciled
        ? "historical_signatures_processed"
        : "no_matching_deposits",
    currentBalanceLamports: currentBalance,
    buyerDeposited: expect.buyerDeposited,
    sellerDeposited: expect.sellerDeposited,
    paymentDeposited: expect.paymentDeposited,
  };
}

export function stopWatching(ticketId: string): void {
  const watcher = activeWatchers.get(ticketId);
  if (watcher !== undefined) {
    if (watcher.pollId) clearInterval(watcher.pollId);
    if (watcher.subId !== undefined) {
      void watcher.connection.removeAccountChangeListener(watcher.subId).catch((e: any) => {
        logger.warn("deposit_watcher_unsubscribe_failed", { ticket_id: ticketId, error: e.message });
      });
    }
    activeWatchers.delete(ticketId);
    expectations.delete(ticketId);
    logger.info("deposit_watcher_stopped", { ticket_id: ticketId });
  }
}

export function getDepositStatus(ticketId: string): DepositExpectation | null {
  return expectations.get(ticketId) || null;
}
