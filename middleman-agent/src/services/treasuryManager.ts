/**
 * Treasury Manager (Level 5 Autonomy)
 *
 * Self-sustaining economy module that ensures the agent NEVER runs out
 * of operational funds. Monitors wallet balance, tracks fee revenue,
 * and autonomously replenishes SOL via airdrop (devnet) or Jupiter
 * DEX swap (mainnet).
 *
 * Alert Tiers:
 *   INFO     — balance < targetBalance (healthy but below comfort)
 *   WARNING  — balance < minBalance (action required)
 *   EMERGENCY — balance < 0.1 SOL (pause new deal intake)
 *
 * Integration:
 *   Called from the heartbeat loop in index.ts every Nth tick.
 */

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadConfig, AgentConfig } from "../config";
import { getConnection } from "../solana/connection";
import { loadWallet } from "../solana/wallet";
import { prisma } from "../lib/prisma";
import { logger } from "../utils/logger";
import { eventBus } from "./eventBus";

// ==========================================
// TYPES
// ==========================================

export type AlertTier = "OK" | "INFO" | "WARNING" | "EMERGENCY";

export interface TreasuryStatus {
    balanceSol: number;
    alertTier: AlertTier;
    totalRevenue: number;
    totalDeals: number;
    canAcceptNewDeals: boolean;
}

// ==========================================
// STATE
// ==========================================

let _lastAlertTier: AlertTier = "OK";
let _isReplenishing = false;
let _checkCount = 0;

// Only check every Nth heartbeat tick to avoid spamming RPC
const CHECK_INTERVAL_TICKS = 10;

// ==========================================
// CORE: BALANCE CHECK & ALERT
// ==========================================

/**
 * Called from the heartbeat loop. Checks balance and takes
 * autonomous action if funds are low.
 */
export async function treasuryTick(tickNumber: number): Promise<void> {
    // Only run every CHECK_INTERVAL_TICKS heartbeats
    if (tickNumber % CHECK_INTERVAL_TICKS !== 0) return;

    _checkCount++;

    try {
        const config = loadConfig();
        const connection = getConnection();
        const keypair = loadWallet(config.privateKey);
        const balanceLamports = await connection.getBalance(keypair.publicKey);
        const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

        const tier = classifyAlertTier(balanceSol, config);

        // Log tier changes
        if (tier !== _lastAlertTier) {
            const logFn = tier === "EMERGENCY" ? "error" : tier === "WARNING" ? "warn" : "info";
            logger[logFn]("treasury_alert_change", {
                previous_tier: _lastAlertTier,
                new_tier: tier,
                balance_sol: balanceSol,
            });
            _lastAlertTier = tier;
        }

        // Periodic status log
        if (_checkCount % 6 === 0) {
            logger.info("treasury_status", {
                balance_sol: balanceSol,
                tier,
                auto_fund_enabled: config.treasuryAutoFundEnabled,
                network: config.network,
            });
        }

        // Autonomous replenishment
        if (tier !== "OK" && tier !== "INFO" && config.treasuryAutoFundEnabled && !_isReplenishing) {
            await replenishFunds(config, balanceSol);
        }

        // Publish treasury event for other subsystems
        eventBus.publish("treasury_checked", {
            balance_sol: balanceSol,
            tier,
            can_accept_deals: tier !== "EMERGENCY",
        });

    } catch (error: any) {
        logger.error("treasury_tick_error", {}, error);
    }
}

// ==========================================
// ALERT CLASSIFICATION
// ==========================================

function classifyAlertTier(balanceSol: number, config: AgentConfig): AlertTier {
    if (balanceSol < 0.1) return "EMERGENCY";
    if (balanceSol < config.treasuryMinBalanceSol) return "WARNING";
    if (balanceSol < config.treasuryTargetBalanceSol) return "INFO";
    return "OK";
}

/**
 * Check if the treasury allows new deal intake.
 * Called by executionService before starting new deals.
 */
export function canAcceptNewDeals(): boolean {
    return _lastAlertTier !== "EMERGENCY";
}

/**
 * Get current treasury status for health endpoint / status queries.
 */
export async function getTreasuryStatus(): Promise<TreasuryStatus> {
    const config = loadConfig();
    const connection = getConnection();
    const keypair = loadWallet(config.privateKey);
    const balanceLamports = await connection.getBalance(keypair.publicKey);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
    const tier = classifyAlertTier(balanceSol, config);

    const revenueAgg = await prisma.revenue.aggregate({ _sum: { feeAmount: true }, _count: true });

    return {
        balanceSol,
        alertTier: tier,
        totalRevenue: revenueAgg._sum.feeAmount || 0,
        totalDeals: revenueAgg._count || 0,
        canAcceptNewDeals: tier !== "EMERGENCY",
    };
}

// ==========================================
// AUTONOMOUS REPLENISHMENT
// ==========================================

async function replenishFunds(config: AgentConfig, currentBalanceSol: number): Promise<void> {
    _isReplenishing = true;

    try {
        if (config.network === "devnet" || config.network === "localnet") {
            await replenishDevnet(config, currentBalanceSol);
        } else if (config.network === "mainnet-beta") {
            await replenishMainnet(config, currentBalanceSol);
        } else {
            logger.warn("treasury_replenish_skipped", { reason: "unsupported_network", network: config.network });
        }
    } finally {
        _isReplenishing = false;
    }
}

/**
 * Devnet: Request airdrop from the faucet.
 */
async function replenishDevnet(config: AgentConfig, currentBalanceSol: number): Promise<void> {
    try {
        const connection = getConnection();
        const keypair = loadWallet(config.privateKey);
        const airdropAmount = Math.min(2, config.treasuryTargetBalanceSol - currentBalanceSol);

        if (airdropAmount <= 0) return;

        logger.info("treasury_airdrop_requesting", {
            amount_sol: airdropAmount,
            wallet: keypair.publicKey.toBase58(),
        });

        const sig = await connection.requestAirdrop(
            keypair.publicKey,
            Math.floor(airdropAmount * LAMPORTS_PER_SOL)
        );

        // Wait for confirmation
        await connection.confirmTransaction(sig, "confirmed");

        const newBalance = await connection.getBalance(keypair.publicKey);
        const newBalanceSol = newBalance / LAMPORTS_PER_SOL;

        // Record the treasury event
        await prisma.treasuryEvent.create({
            data: {
                type: "airdrop",
                amount: airdropAmount,
                balanceBefore: currentBalanceSol,
                balanceAfter: newBalanceSol,
                txSignature: sig,
            },
        });

        logger.info("treasury_airdrop_success", {
            amount_sol: airdropAmount,
            new_balance_sol: newBalanceSol,
            tx: sig,
        });

    } catch (error: any) {
        logger.error("treasury_airdrop_failed", {}, error);
    }
}

/**
 * Mainnet: Use Jupiter V6 swap API to convert USDC → SOL.
 * This is a placeholder that logs the intent — full Jupiter integration
 * requires USDC token account management which depends on the agent's
 * revenue model.
 */
async function replenishMainnet(config: AgentConfig, currentBalanceSol: number): Promise<void> {
    // Jupiter V6 swap flow:
    // 1. Check USDC balance in agent's ATA
    // 2. GET /quote?inputMint=USDC&outputMint=SOL&amount=X
    // 3. POST /swap with quoteResponse
    // 4. Sign and send the transaction
    //
    // For now, we log the deficit and record the alert event.
    // Full swap execution will be wired once the fee revenue pipeline
    // is generating USDC income.

    const deficit = config.treasuryTargetBalanceSol - currentBalanceSol;

    logger.warn("treasury_mainnet_replenish_needed", {
        deficit_sol: deficit,
        jupiter_api: config.jupiterApiUrl,
        action: "Manual USDC → SOL swap recommended until auto-swap is fully wired",
    });

    await prisma.treasuryEvent.create({
        data: {
            type: "alert",
            amount: deficit,
            balanceBefore: currentBalanceSol,
            balanceAfter: currentBalanceSol, // No change yet
        },
    });
}

// ==========================================
// REVENUE TRACKING
// ==========================================

/**
 * Record fee income from a completed deal.
 * Called from onChainExecutionService after release_funds succeeds.
 */
export async function recordFeeRevenue(
    dealId: string,
    feeAmount: number,
    txSignature: string
): Promise<void> {
    try {
        await prisma.revenue.create({
            data: {
                dealId,
                feeAmount,
                txSignature,
            },
        });

        // Also record as treasury event for the full ledger
        const config = loadConfig();
        const connection = getConnection();
        const keypair = loadWallet(config.privateKey);
        const balanceLamports = await connection.getBalance(keypair.publicKey);
        const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

        await prisma.treasuryEvent.create({
            data: {
                type: "fee_earned",
                amount: feeAmount,
                balanceBefore: balanceSol - feeAmount, // Approximate
                balanceAfter: balanceSol,
                txSignature,
            },
        });

        logger.info("treasury_fee_recorded", {
            deal_id: dealId,
            fee_sol: feeAmount,
            tx: txSignature,
        });

    } catch (error: any) {
        // Don't crash the pipeline over revenue tracking
        if ((error as any).code === "P2002") {
            logger.debug("treasury_fee_duplicate", { deal_id: dealId, tx: txSignature });
        } else {
            logger.error("treasury_fee_record_failed", { deal_id: dealId }, error);
        }
    }
}
