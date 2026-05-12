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

// Track active watchers so we can unsubscribe later
const activeWatchers: Map<string, { subId: number; connection: Connection }> = new Map();

// Track last known balance per PDA to detect deposits
const lastKnownBalance: Map<string, number> = new Map(); // pda_base58 → lamports

export interface DepositExpectation {
  ticketId: string;
  dealPda: PublicKey;
  expectedBuyerCollateral: number;
  expectedSellerCollateral: number;
  expectedPayment: number;
  buyerDeposited: boolean;
  sellerDeposited: boolean;
  paymentDeposited: boolean;
}

const expectations: Map<string, DepositExpectation> = new Map();
type DepositType = "buyer_collateral" | "seller_collateral" | "buyer_payment";

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
    watcherLog.info("deposit_watcher_initial_balance", {
      balance: initialBalance / LAMPORTS_PER_SOL,
    });
  } catch (e: any) {
    watcherLog.error("deposit_watcher_initial_balance_failed", { error: e.message });
    throw e;
  }

  const subscriptionId = connection.onAccountChange(
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

  activeWatchers.set(ticketId, { subId: subscriptionId, connection });
}



async function identifyAndConfirmDeposit(
  connection: Connection,
  ticketId: string,
  expect: DepositExpectation,
  currentBalance: number,
  depositAmount: number,
): Promise<void> {
  const DUST_TOLERANCE = 2000; // Allow max 2000 lamports drift for rent/fees

  function isClose(actual: number, expected: number): boolean {
    if (expected === 0) return false;
    return Math.abs(actual - expected) <= DUST_TOLERANCE;
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
    try {
      const existingTx = await prisma.transaction.findFirst({
        where: {
          OR: [
            { txSignature: sigInfo.signature },
            { txSignature: { startsWith: `${sigInfo.signature}-` } },
          ],
        },
      });
      if (existingTx) {
        logger.info("deposit_replay_prevented", { ticket_id: ticketId, signature: sigInfo.signature });
        continue;
      }
    } catch (err: any) {
      logger.error("deposit_db_check_failed", { ticket_id: ticketId, error: err.message });
      continue;
    }

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

    if (!expect.buyerDeposited && isClose(txDepositAmount, expect.expectedBuyerCollateral)) {
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
    } else if (!expect.buyerDeposited && !expect.paymentDeposited && isClose(txDepositAmount, expect.expectedBuyerCollateral + expect.expectedPayment)) {
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
      depositTypes.push("buyer_collateral", "buyer_payment");
      expect.buyerDeposited = true;
      expect.paymentDeposited = true;
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
    } else if (!expect.paymentDeposited && isClose(txDepositAmount, expect.expectedPayment)) {
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

  if (expect.buyerDeposited && expect.sellerDeposited && expect.paymentDeposited) {
    stopWatching(ticketId);
  }
}

export function stopWatching(ticketId: string): void {
  const watcher = activeWatchers.get(ticketId);
  if (watcher !== undefined) {
    void watcher.connection.removeAccountChangeListener(watcher.subId).catch((e: any) => {
      logger.warn("deposit_watcher_unsubscribe_failed", { ticket_id: ticketId, error: e.message });
    });
    activeWatchers.delete(ticketId);
    expectations.delete(ticketId);
    logger.info("deposit_watcher_stopped", { ticket_id: ticketId });
  }
}

export function getDepositStatus(ticketId: string): DepositExpectation | null {
  return expectations.get(ticketId) || null;
}
