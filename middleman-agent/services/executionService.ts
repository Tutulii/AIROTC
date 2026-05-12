/**
 * Execution Service (Outer Module)
 *
 * Wrapper that bridges the src/ ticket system with the on-chain execution service.
 * Replaces the old fake setTimeout stubs with real Anchor calls.
 */

import { program, wallet, connection, programId } from "../config/solana";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import * as crypto from "crypto";

export type AgreementResult = {
  ticketId: string;
  price: number;
  collateral_buyer: number;
  collateral_seller: number;
  asset_type?: string;
  confidence: number;
};

export type DealContext = {
  dealId: BN;
  dealPda: PublicKey;
  configPda: PublicKey;
  buyer: PublicKey;
  seller: PublicKey;
  middleman: PublicKey;
};

export type ExecutionResult = {
  success: boolean;
  tx?: string;
  error?: string;
  step?: string;
};

// In-memory maps for tracking
const executedDeals: Record<string, boolean> = {};
const dealContexts: Record<string, DealContext> = {};

// ==========================================
// HELPER: PDA Derivation
// ==========================================

function deriveDealPda(buyer: PublicKey, dealId: BN): PublicKey {
  const dealIdBuffer = dealId.toArrayLike(Buffer, "le", 8);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("deal"), buyer.toBuffer(), dealIdBuffer],
    programId
  );
  return pda;
}

function deriveConfigPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId
  );
  return pda;
}

// ==========================================
// 1. CREATE DEAL
// ==========================================

export async function executeCreateDeal(result: AgreementResult): Promise<ExecutionResult> {
  try {
    if (result.confidence < 80) {
      return { success: false, error: "Confidence too low", step: "create_deal" };
    }
    if (!result.price || !result.collateral_buyer || !result.collateral_seller) {
      return { success: false, error: "Missing price or collateral", step: "create_deal" };
    }
    if (executedDeals[result.ticketId]) {
      return { success: false, error: "Duplicate execution", step: "create_deal" };
    }

    executedDeals[result.ticketId] = true;

    const dealId = new BN(crypto.randomBytes(8));
    // TODO: Replace with real buyer/seller pubkeys from ticket store
    const buyer = wallet.publicKey;
    const seller = wallet.publicKey;
    const middleman = wallet.publicKey;

    const dealPda = deriveDealPda(buyer, dealId);
    const configPda = deriveConfigPda();

    dealContexts[result.ticketId] = { dealId, dealPda, configPda, buyer, seller, middleman };

    const priceBn = new BN(Math.floor(result.price * LAMPORTS_PER_SOL));
    const colBuyerBn = new BN(Math.floor(result.collateral_buyer * LAMPORTS_PER_SOL));
    const colSellerBn = new BN(Math.floor(result.collateral_seller * LAMPORTS_PER_SOL));
    const timeout = new BN(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);

    console.log(`[ExecutionService] Calling create_deal for ticket ${result.ticketId}`);

    const tx = await program.methods.createDeal(
      dealId, result.asset_type || "data", "OTC Trade",
      priceBn, colBuyerBn, colSellerBn, timeout, { normal: {} }
    )
      .accounts({
        deal: dealPda, initializer: middleman, buyer, seller, middleman,
        config: configPda, systemProgram: SystemProgram.programId,
      })
      .signers([]).rpc();

    console.log(`[ExecutionService] create_deal tx: ${tx}`);
    return { success: true, tx, step: "create_deal" };

  } catch (error: any) {
    delete executedDeals[result.ticketId];
    return { success: false, error: error.message, step: "create_deal" };
  }
}

// ==========================================
// 2. LOCK COLLATERAL
// ==========================================

export async function executeLockCollateral(ticketId: string, party: "buyer" | "seller"): Promise<ExecutionResult> {
  try {
    const ctx = dealContexts[ticketId];
    if (!ctx) return { success: false, error: "No deal context", step: `lock_collateral_${party}` };

    const user = party === "buyer" ? ctx.buyer : ctx.seller;

    console.log(`[ExecutionService] Calling lock_collateral (${party}) for ticket ${ticketId}`);

    const tx = await program.methods.lockCollateral()
      .accounts({
        deal: ctx.dealPda, user, config: ctx.configPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([]).rpc();

    console.log(`[ExecutionService] lock_collateral_${party} tx: ${tx}`);
    return { success: true, tx, step: `lock_collateral_${party}` };

  } catch (error: any) {
    return { success: false, error: error.message, step: `lock_collateral_${party}` };
  }
}

// ==========================================
// 3. LOCK PAYMENT
// ==========================================

export async function executeLockPayment(ticketId: string): Promise<ExecutionResult> {
  try {
    const ctx = dealContexts[ticketId];
    if (!ctx) return { success: false, error: "No deal context", step: "lock_payment" };

    console.log(`[ExecutionService] Calling lock_payment for ticket ${ticketId}`);

    const tx = await program.methods.lockPayment()
      .accounts({
        deal: ctx.dealPda, buyer: ctx.buyer, config: ctx.configPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([]).rpc();

    console.log(`[ExecutionService] lock_payment tx: ${tx}`);
    return { success: true, tx, step: "lock_payment" };

  } catch (error: any) {
    return { success: false, error: error.message, step: "lock_payment" };
  }
}

// ==========================================
// 4. RELEASE FUNDS
// ==========================================

export async function executeReleaseFunds(ticketId: string): Promise<ExecutionResult> {
  try {
    const ctx = dealContexts[ticketId];
    if (!ctx) return { success: false, error: "No deal context", step: "release_funds" };

    console.log(`[ExecutionService] Calling release_funds for ticket ${ticketId}`);

    const tx = await program.methods.releaseFunds()
      .accounts({
        deal: ctx.dealPda, middleman: ctx.middleman,
        buyer: ctx.buyer, seller: ctx.seller,
        feeReceiver: ctx.middleman,
        config: ctx.configPda, systemProgram: SystemProgram.programId,
      })
      .signers([]).rpc();

    console.log(`[ExecutionService] release_funds tx: ${tx}`);
    return { success: true, tx, step: "release_funds" };

  } catch (error: any) {
    return { success: false, error: error.message, step: "release_funds" };
  }
}

// ==========================================
// 5. CANCEL DEAL
// ==========================================

export async function executeCancelDeal(ticketId: string): Promise<ExecutionResult> {
  try {
    const ctx = dealContexts[ticketId];
    if (!ctx) return { success: false, error: "No deal context", step: "cancel_deal" };

    console.log(`[ExecutionService] Calling cancel_deal for ticket ${ticketId}`);

    const tx = await program.methods.cancelDeal()
      .accounts({
        deal: ctx.dealPda, caller: wallet.publicKey,
        buyer: ctx.buyer, seller: ctx.seller,
        config: ctx.configPda, systemProgram: SystemProgram.programId,
      })
      .signers([]).rpc();

    console.log(`[ExecutionService] cancel_deal tx: ${tx}`);
    return { success: true, tx, step: "cancel_deal" };

  } catch (error: any) {
    return { success: false, error: error.message, step: "cancel_deal" };
  }
}

// ==========================================
// 6. REFUND ON TIMEOUT
// ==========================================

export async function executeRefundOnTimeout(ticketId: string): Promise<ExecutionResult> {
  try {
    const ctx = dealContexts[ticketId];
    if (!ctx) return { success: false, error: "No deal context", step: "refund_on_timeout" };

    console.log(`[ExecutionService] Calling refund_on_timeout for ticket ${ticketId}`);

    const tx = await program.methods.refundOnTimeout()
      .accounts({
        deal: ctx.dealPda, caller: wallet.publicKey,
        buyer: ctx.buyer, seller: ctx.seller,
        config: ctx.configPda, systemProgram: SystemProgram.programId,
      })
      .signers([]).rpc();

    console.log(`[ExecutionService] refund_on_timeout tx: ${tx}`);
    return { success: true, tx, step: "refund_on_timeout" };

  } catch (error: any) {
    return { success: false, error: error.message, step: "refund_on_timeout" };
  }
}

// ==========================================
// 7. CLOSE DEAL
// ==========================================

export async function executeCloseDeal(ticketId: string): Promise<ExecutionResult> {
  try {
    const ctx = dealContexts[ticketId];
    if (!ctx) return { success: false, error: "No deal context", step: "close_deal" };

    console.log(`[ExecutionService] Calling close_deal for ticket ${ticketId}`);

    const tx = await program.methods.closeDeal()
      .accounts({
        deal: ctx.dealPda, authority: wallet.publicKey,
        rentReceiver: wallet.publicKey,
      })
      .signers([]).rpc();

    delete dealContexts[ticketId];

    console.log(`[ExecutionService] close_deal tx: ${tx}`);
    return { success: true, tx, step: "close_deal" };

  } catch (error: any) {
    return { success: false, error: error.message, step: "close_deal" };
  }
}

// ==========================================
// FULL LIFECYCLE ORCHESTRATOR
// ==========================================

export async function executeFullDealLifecycle(result: AgreementResult): Promise<ExecutionResult> {
  const steps: { name: string; fn: () => Promise<ExecutionResult> }[] = [
    { name: "create_deal", fn: () => executeCreateDeal(result) },
    { name: "lock_collateral_buyer", fn: () => executeLockCollateral(result.ticketId, "buyer") },
    { name: "lock_collateral_seller", fn: () => executeLockCollateral(result.ticketId, "seller") },
    { name: "lock_payment", fn: () => executeLockPayment(result.ticketId) },
    { name: "release_funds", fn: () => executeReleaseFunds(result.ticketId) },
    { name: "close_deal", fn: () => executeCloseDeal(result.ticketId) },
  ];

  console.log(`[ExecutionService] Starting full lifecycle for ticket ${result.ticketId}`);

  let lastTx: string | undefined;

  for (const step of steps) {
    const r = await step.fn();
    if (!r.success) {
      console.error(`[ExecutionService] Lifecycle HALTED at ${step.name}: ${r.error}`);
      return { success: false, error: `Halted at ${step.name}: ${r.error}`, step: step.name };
    }
    lastTx = r.tx;
  }

  console.log(`[ExecutionService] Full lifecycle COMPLETE for ticket ${result.ticketId}`);
  return { success: true, tx: lastTx, step: "lifecycle_complete" };
}

// BACKWARD-COMPATIBLE EXPORT
// NOTE: Now maps to Phase 1 only (create_deal). Use executeFullDealLifecycle() explicitly
// if you need the entire lifecycle in one shot (testing/devnet only).
export async function executeDeal(result: AgreementResult): Promise<ExecutionResult> {
  console.warn("[ExecutionService] DEPRECATION: executeDeal() now only creates the deal (Phase 1). Use executeFullDealLifecycle() for the complete flow.");
  return executeCreateDeal(result);
}

export function getDealContext(ticketId: string): DealContext | null {
  return dealContexts[ticketId] || null;
}
