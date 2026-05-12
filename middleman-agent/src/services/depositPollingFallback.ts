/**
 * Deposit Polling Fallback (Level 5 Autonomy)
 *
 * Backup mechanism for deposit detection. The primary method
 * (connection.onAccountChange WebSocket) can silently drop.
 * This polls PDA balances every heartbeat cycle as a safety net.
 *
 * DUNE SIM INTEGRATION:
 * When available, uses Dune SIM's SVM Balances API as an
 * additional fallback data source. This provides triple-redundancy:
 * 1. Primary: WebSocket (real-time)
 * 2. Secondary: RPC getBalance (heartbeat polling)
 * 3. Tertiary: Dune SIM SVM Balances (independent index)
 *
 * Guarantees: deposits are detected within 30s even if WS drops.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { logger } from "../utils/logger";
import { duneSIM } from "../services/duneSIMService";

/**
 * Polls PDA balance and returns true if expected total is met.
 * Designed to be called from the heartbeat loop for each active deal.
 *
 * Uses dual data sources:
 * 1. Solana RPC getBalance (direct chain query)
 * 2. Dune SIM SVM Balances API (independent verification)
 */
export async function pollDepositsForActiveDeal(
    connection: Connection,
    ticketId: string,
    escrowPda: PublicKey,
    expectedTotalLamports: number
): Promise<boolean> {
    const pdaAddress = escrowPda.toBase58();

    // ── Source 1: Solana RPC (primary) ──
    try {
        const balance = await connection.getBalance(escrowPda);
        if (balance >= expectedTotalLamports) {
            logger.info("deposit_polling_fallback_triggered", {
                ticket_id: ticketId,
                balance_lamports: balance,
                expected_lamports: expectedTotalLamports,
                balance_sol: balance / LAMPORTS_PER_SOL,
                source: "rpc",
            });
            return true;
        }
    } catch (e: any) {
        // RPC failure — try Dune SIM as backup
        logger.debug("deposit_polling_rpc_failed", { ticket_id: ticketId, error: e.message });
    }

    // ── Source 2: Dune SIM SVM Balances (tertiary fallback) ──
    if (duneSIM.isAvailable) {
        try {
            const verification = await duneSIM.verifyDeposit(
                pdaAddress,
                expectedTotalLamports,
            );

            if (verification.verified) {
                logger.info("deposit_polling_dune_sim_fallback_triggered", {
                    ticket_id: ticketId,
                    sim_balance: verification.currentBalance,
                    expected_lamports: expectedTotalLamports,
                    recent_deposits: verification.recentDeposits.length,
                    source: "dune_sim",
                });
                return true;
            }

            logger.debug("deposit_polling_dune_sim_insufficient", {
                ticket_id: ticketId,
                sim_balance: verification.currentBalance,
                expected_lamports: expectedTotalLamports,
            });
        } catch (simErr: any) {
            logger.debug("deposit_polling_dune_sim_failed", {
                ticket_id: ticketId,
                error: simErr.message,
            });
        }
    }

    return false;
}
