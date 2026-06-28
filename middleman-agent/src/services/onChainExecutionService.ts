/**
 * On-Chain Execution Service (COMPLETE + REAL WALLETS)
 *
 * Full escrow lifecycle with:
 * - Real wallet resolution from walletRegistry (Day 2)
 * - Deal status tracking via dealTracker (Day 2)
 * - All 8 Anchor instructions (Day 1)
 * - Safety checks, PDA derivation, BN conversion
 */

import { PublicKey, SystemProgram, LAMPORTS_PER_SOL, Connection, Keypair, ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs";
import { logger } from "../utils/logger";
import { loadConfig } from "../config";
import { loadWallet } from "../solana/wallet";
import bs58 from "bs58";
import { walletRegistry } from "../state/walletRegistry";
import { ticketStore } from "../state/ticketStore";
import { dealTracker } from "../state/dealTracker";
import { executionStore } from "../state/executionStore";
import { interpretExecutionError } from "../../core/autoHealer";
import { withRetry } from "../utils/retry";
import { prisma } from "../lib/prisma";
import { getConnection } from "../solana/connection";
import { recordFeeRevenue } from "./treasuryManager";
import { magicBlockSessions } from "./magicBlockSessionManager";

// ==========================================
// TYPES
// ==========================================

export type AgreementResult = {
  ticketId: string;
  price: number;
  collateral_buyer: number;
  collateral_seller: number;
  asset_type?: string;
  confidence: number;
  buyer?: string;   // Agent ID or wallet pubkey
  seller?: string;  // Agent ID or wallet pubkey
};

export type DealContext = {
  dealId: BN;
  dealPda: PublicKey;
  configPda: PublicKey;
  buyer: PublicKey;
  seller: PublicKey;
  middleman: PublicKey;
  programId: PublicKey;
  tokenMint: PublicKey;
};

export type ExecutionResult = {
  success: boolean;
  tx?: string;
  error?: string;
  step?: string;
};

// ==========================================
// STATE
// ==========================================

export const dealContexts: Record<string, DealContext> = {};

const MAX_DEAL_LIFETIME_MS = 30 * 60 * 1000; // 30 min hard cap

/**
 * SAFETY GUARD: Asserts that a deal has not exceeded its maximum lifetime.
 * Prevents perpetually stuck deals even if all other recovery mechanisms fail.
 */
export function assertDealWithinLifetime(createdAt: string, ticketId: string): void {
  const age = Date.now() - new Date(createdAt).getTime();
  if (age > MAX_DEAL_LIFETIME_MS) {
    logger.error("deal_ttl_exceeded", { ticket_id: ticketId, age_ms: age, max_ms: MAX_DEAL_LIFETIME_MS });
    throw new Error("DEAL_TTL_EXCEEDED");
  }
}

/**
 * Verifies on-chain deal state matches expected state.
 * Fetches the deal PDA account and reads its status enum.
 * This is the ground truth — if chain and agent disagree, chain wins.
 */
export async function verifyOnChainState(ticketId: string): Promise<{
  verified: boolean;
  onChainStatus?: string;
  error?: string;
}> {
  const ctx = await getDealContextSafe(ticketId);
  if (!ctx) return { verified: false, error: "No deal context" };

  try {
    const { program } = getAnchorProgram();
    const dealAccount = await (program.account as any).deal.fetch(ctx.dealPda);

    // Map on-chain enum to string status
    const statusKey = Object.keys(dealAccount.status)[0];
    return { verified: true, onChainStatus: statusKey };
  } catch (e: any) {
    if (e.message?.includes("Account does not exist") || e.message?.includes("could not find account")) {
      return { verified: true, onChainStatus: "not_created" };
    }
    return { verified: false, error: e.message };
  }
}


/**
 * Safely get a deal context. Checks memory first, then DB if missing.
 */
export async function getDealContextSafe(ticketId: string): Promise<DealContext | null> {
  // Using reconstructed context
  if (dealContexts[ticketId]) {
    return dealContexts[ticketId];
  }

  const ctx = await prisma.executionContext.findUnique({
    where: { ticketId }
  });

  if (!ctx) return null;

  const dealIdBn = new BN(ctx.dealIdBn, 16);
  const reconstructedContext: DealContext = {
    dealId: dealIdBn,
    dealPda: new PublicKey(ctx.dealPda),
    configPda: new PublicKey(ctx.configPda),
    buyer: new PublicKey(ctx.buyerWallet),
    seller: new PublicKey(ctx.sellerWallet),
    middleman: new PublicKey(ctx.middlemanWallet),
    programId: new PublicKey(ctx.programId),
    tokenMint: new PublicKey(ctx.tokenMint || NATIVE_MINT.toBase58()),
  };

  dealContexts[ticketId] = reconstructedContext;
  return reconstructedContext;
}

// ==========================================
// ANCHOR PROGRAM LOADER
// ==========================================

export function getAnchorProgram(): { program: Program; wallet: Wallet; programId: PublicKey } {
  const config = loadConfig();
  const keypair = loadWallet(config.privateKey);

  // Default to the deployed devnet/mainnet escrow ABI. Local target IDLs can
  // drift ahead of the live program during development, which breaks the ER
  // runtime if the client starts speaking an unreleased account layout.
  const deployedIdlPath = path.join(__dirname, "../idl/escrow_deployed.json");
  const targetIdlPath = path.join(__dirname, "../../../escrow/target/idl/escrow.json");
  const idlPath = process.env.ESCROW_IDL_PATH
    || process.env.IDL_PATH
    || (fs.existsSync(deployedIdlPath) ? deployedIdlPath : targetIdlPath);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  // Uses rpcManager dynamically under the hood
  const connection = getConnection();
  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

  const programIdStr = config.programId || (idl as any).metadata?.address || (idl as any).address;
  if (!programIdStr) throw new Error("[OnChainExecution] Missing program ID");

  const programId = new PublicKey(programIdStr);
  (idl as any).address = programIdStr;

  const program = new Program(idl as any, provider);

  return { program, wallet, programId };
}

function normalizeIdlName(name: string): string {
  return name.replace(/_/g, "").toLowerCase();
}

function findInstruction(program: Program, instructionName: string): any | undefined {
  const instructions = ((program as any).idl?.instructions ?? []) as any[];
  const target = normalizeIdlName(instructionName);
  return instructions.find((instruction) => normalizeIdlName(instruction.name) === target);
}

function instructionHasAccount(program: Program, instructionName: string, accountName: string): boolean {
  const instruction = findInstruction(program, instructionName);
  if (!instruction) return false;
  const target = normalizeIdlName(accountName);
  return (instruction.accounts ?? []).some((account: any) => normalizeIdlName(account.name) === target);
}

function instructionHasArg(program: Program, instructionName: string, argName: string): boolean {
  const instruction = findInstruction(program, instructionName);
  if (!instruction) return false;
  const target = normalizeIdlName(argName);
  return (instruction.args ?? []).some((arg: any) => normalizeIdlName(arg.name) === target);
}

function createAtaIdempotentIx(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ata,
    owner,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

function buildTokenEscrowAccounts(ctx: DealContext, mint: PublicKey) {
  return {
    dealAta: getAssociatedTokenAddressSync(mint, ctx.dealPda, true),
    buyerAta: getAssociatedTokenAddressSync(mint, ctx.buyer, true),
    sellerAta: getAssociatedTokenAddressSync(mint, ctx.seller, true),
    feeAta: getAssociatedTokenAddressSync(mint, ctx.middleman, true),
  };
}

function buildReleaseAtaPreInstructions(
  payer: PublicKey,
  ctx: DealContext,
  mint: PublicKey,
  accounts: ReturnType<typeof buildTokenEscrowAccounts>,
): TransactionInstruction[] {
  return [
    createAtaIdempotentIx(payer, accounts.dealAta, ctx.dealPda, mint),
    createAtaIdempotentIx(payer, accounts.buyerAta, ctx.buyer, mint),
    createAtaIdempotentIx(payer, accounts.sellerAta, ctx.seller, mint),
    createAtaIdempotentIx(payer, accounts.feeAta, ctx.middleman, mint),
  ];
}

// ==========================================
// WALLET RESOLUTION REMOVED
// Identities must be fetched rigorously via DB Agent.id
// ==========================================

// ==========================================
// PDA HELPERS & MEV DEFENSE
// ==========================================

async function getPriorityFeeIx(connection: Connection): Promise<TransactionInstruction> {
  try {
    const fees = await connection.getRecentPrioritizationFees();
    let finalFee = 10_000; // Baseline to outcompete basic free-tier bots
    if (fees.length > 0) {
      fees.sort((a, b) => b.prioritizationFee - a.prioritizationFee);
      const topFee = fees[0].prioritizationFee;
      // MEV Defense: Outbid the top fee by 20% to avoid sandwiching, capped at 250,000 microLamports safely
      const targetFee = Math.min(Math.floor(topFee * 1.2), 250_000);
      finalFee = Math.max(targetFee, 10_000);
    }
    return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: finalFee });
  } catch (e) {
    return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 });
  }
}

function deriveDealPda(buyer: PublicKey, dealId: BN, programId: PublicKey): PublicKey {
  const dealIdBuffer = dealId.toArrayLike(Buffer, "le", 8);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("deal"), buyer.toBuffer(), dealIdBuffer],
    programId
  );
  return pda;
}

function deriveConfigPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    programId
  );
  return pda;
}

function normalizeEscrowAssetType(rawAssetType?: string): string {
  if (!rawAssetType) return "data";

  const trimmed = rawAssetType.trim();
  if (!trimmed) return "data";
  if (trimmed.length <= 32) return trimmed;

  if (trimmed === NATIVE_MINT.toBase58()) {
    return "SOL";
  }

  const compact = trimmed.replace(/[^a-zA-Z0-9:_-]/g, "");
  if (compact.length <= 32) {
    return compact;
  }

  return `asset:${compact.slice(0, 26)}`;
}

function isCreateDealAlreadyInitializedError(error: any): boolean {
  const message = [
    error?.message,
    error?.logs?.join("\n"),
    error?.transactionLogs?.join("\n"),
    String(error ?? ""),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return (
    message.includes("already in use") ||
    message.includes("accountalreadyinuse")
  );
}

async function recoverCreateDealSuccessIfPresent(
  ticketId: string,
  txSignature: string,
  executionLogger = logger.withContext({ ticket_id: ticketId })
): Promise<ExecutionResult | null> {
  const onChainCheck = await verifyOnChainState(ticketId);
  if (
    onChainCheck.verified &&
    (onChainCheck.onChainStatus === "created" || onChainCheck.onChainStatus === "active")
  ) {
    await dealTracker.updateStatus(ticketId, "created");
    await executionStore.markSuccess(ticketId, "create_deal", txSignature);
    executionLogger.info("tx_confirmed_idempotent_recovery", {
      step: "create_deal",
      tx: txSignature,
      on_chain_status: onChainCheck.onChainStatus,
    });
    return { success: true, tx: txSignature, step: "create_deal" };
  }

  return null;
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
    // Duplicate prevention is handled by executionStore.beginExecution() DB mutex
    const { program, wallet, programId } = getAnchorProgram();

    const dealId = new BN(crypto.randomBytes(8));

    // STRICT IDENTITY RESOLUTION GRAPH
    const ticket = await ticketStore.getTicket(result.ticketId);
    if (!ticket) throw new Error("Ticket not found for execution");

    // ticket.buyer and ticket.seller are wallet pubkey strings from ticketStore
    const buyerAgent = await walletRegistry.getOrCreateAgent(ticket.buyer);
    const sellerAgent = await walletRegistry.getOrCreateAgent(ticket.seller);
    const middlemanAgent = await walletRegistry.getOrCreateAgent(wallet.publicKey.toBase58());

    if (!buyerAgent?.wallet || !sellerAgent?.wallet) {
      throw new Error("Invalid agent identity: missing wallet");
    }
    if (buyerAgent.wallet === sellerAgent.wallet) {
      throw new Error("Invalid agent identity: buyer and seller cannot be same wallet");
    }

    const buyer = new PublicKey(buyerAgent.wallet);
    const seller = new PublicKey(sellerAgent.wallet);
    const middleman = wallet.publicKey;
    const tokenMintPublicKey = (ticket as any).tokenMint ? new PublicKey((ticket as any).tokenMint) : NATIVE_MINT;

    const dealPda = deriveDealPda(buyer, dealId, programId);
    const configPda = deriveConfigPda(programId);

    // Store context for subsequent lifecycle calls in-memory
    dealContexts[result.ticketId] = { dealId, dealPda, configPda, buyer, seller, middleman, programId, tokenMint: tokenMintPublicKey };

    // Persist to Postgres for restart/recovery
    await prisma.executionContext.upsert({
      where: { ticketId: result.ticketId },
      update: {
        tokenMint: tokenMintPublicKey.toBase58(),
        lastSuccessfulStep: "create_deal",
        status: "created",
      },
      create: {
        ticketId: result.ticketId,
        dealIdBn: dealId.toString(16),
        dealPda: dealPda.toBase58(),
        configPda: configPda.toBase58(),
        buyerWallet: buyer.toBase58(),
        sellerWallet: seller.toBase58(),
        middlemanWallet: middleman.toBase58(),
        programId: programId.toBase58(),
        tokenMint: tokenMintPublicKey.toBase58(),
        lastSuccessfulStep: "create_deal",
        status: "created",
      }
    });

    const timeoutSeconds = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    const timeoutDate = new Date(timeoutSeconds * 1000);

    // Initialize deal tracker matching explicit constraints
    await dealTracker.initDeal({
      ticketId: result.ticketId,
      buyerId: buyerAgent.id,
      sellerId: sellerAgent.id,
      middlemanId: middlemanAgent.id,
      price: result.price,
      collateralBuyer: result.collateral_buyer,
      collateralSeller: result.collateral_seller,
      timeout: timeoutDate,
    });

    const assetTypeLabel = normalizeEscrowAssetType(result.asset_type);
    const priceBn = new BN(Math.floor(result.price * LAMPORTS_PER_SOL));
    const colBuyerBn = new BN(Math.floor(result.collateral_buyer * LAMPORTS_PER_SOL));
    const colSellerBn = new BN(Math.floor(result.collateral_seller * LAMPORTS_PER_SOL));
    const timeout = new BN(timeoutSeconds);

    const executionLogger = logger.withContext({ ticket_id: result.ticketId });
    executionLogger.info("tx_sent", {
      step: "create_deal",
      buyer: buyer.toBase58(),
      seller: seller.toBase58(),
    });

    const existingDeal = await recoverCreateDealSuccessIfPresent(
      result.ticketId,
      "existing_onchain_deal",
      executionLogger
    );
    if (existingDeal) return existingDeal;

    const tx = await withRetry(
      async () => {
        const { program } = getAnchorProgram();
        const supportsTokenEscrowAbi = instructionHasAccount(program, "create_deal", "mint");
        const supportsTermsHash = instructionHasArg(program, "create_deal", "terms_hash");
        const createDealArgs = [
          dealId,
          assetTypeLabel,
          "OTC Trade",
          priceBn,
          colBuyerBn,
          colSellerBn,
          timeout,
          { normal: {} },
          ...(supportsTermsHash ? [null] : []),
        ];

        let methodBuilder = (program.methods as any).createDeal(...createDealArgs).accounts({
          deal: dealPda,
          initializer: middleman,
          buyer,
          seller,
          middleman,
          mint: tokenMintPublicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        });

        if (supportsTokenEscrowAbi) {
          const dealAta = getAssociatedTokenAddressSync(tokenMintPublicKey, dealPda, true);
          const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
            middleman,
            dealAta,
            dealPda,
            tokenMintPublicKey
          );
          methodBuilder = methodBuilder.preInstructions([createAtaIx]);
        }

        return await methodBuilder.signers([]).rpc();
      },
      { label: "create_deal", ticketId: result.ticketId, step: "create" }
    );

    await dealTracker.updateStatus(result.ticketId, "created");
    await executionStore.markSuccess(result.ticketId, "create_deal", tx);

    // LEVEL 5: Post-TX on-chain verification (state halt gate)
    const onChainCheck = await verifyOnChainState(result.ticketId);
    if (onChainCheck.verified && onChainCheck.onChainStatus !== "created" && onChainCheck.onChainStatus !== "active") {
      executionLogger.error("on_chain_state_mismatch", {
        step: "create_deal",
        expected: "created",
        actual: onChainCheck.onChainStatus,
      });
      return { success: false, error: `State mismatch: chain=${onChainCheck.onChainStatus}`, step: "create_deal" };
    }

    executionLogger.info("tx_confirmed", { step: "create_deal", tx, on_chain_verified: onChainCheck.verified });
    return { success: true, tx, step: "create_deal" };

  } catch (error: any) {
    const executionLogger = logger.withContext({ ticket_id: result.ticketId });
    if (isCreateDealAlreadyInitializedError(error)) {
      const recovered = await recoverCreateDealSuccessIfPresent(
        result.ticketId,
        "existing_onchain_deal",
        executionLogger
      );
      if (recovered) return recovered;
    }
    executionLogger.error("tx_failed", { step: "create_deal" }, error);
    await dealTracker.updateStatus(result.ticketId, "failed", error.message);
    await executionStore.markFailed(result.ticketId, "create_deal", error.message);
    return { success: false, error: error.message || error.toString(), step: "create_deal" };
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

    // NOTE: In Option A (autonomous deposit) flow, lock_collateral is called
    // via confirm_deposit instead. This path is kept for the legacy full-lifecycle
    // orchestrator but requires the user's signature (not the middleman's).

    logger.info("tx_sent", { ticket_id: ticketId, step: `lock_collateral_${party}` });

    const tx = await withRetry(
      async () => {
        const { program } = getAnchorProgram();
        const supportsTokenEscrowAbi = instructionHasAccount(program, "lock_collateral", "deal_ata");
        let methodBuilder = (program.methods as any).lockCollateral().accounts({
          deal: ctx.dealPda,
          user,
          config: ctx.configPda,
          dealAta: undefined,
          userAta: undefined,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        });
        if (supportsTokenEscrowAbi) {
          const mint = ctx.tokenMint || NATIVE_MINT;
          const dealAta = getAssociatedTokenAddressSync(mint, ctx.dealPda, true);
          const userAta = getAssociatedTokenAddressSync(mint, user, true);
          methodBuilder = (program.methods as any).lockCollateral().accounts({
            deal: ctx.dealPda,
            user,
            config: ctx.configPda,
            dealAta,
            userAta,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          });
        } else {
          methodBuilder = (program.methods as any).lockCollateral().accounts({
            deal: ctx.dealPda,
            user,
            config: ctx.configPda,
            systemProgram: SystemProgram.programId,
          });
        }
        return await methodBuilder.signers([]).rpc();
      },
      { label: `lock_collateral_${party}`, ticketId, step: "lock_collateral" }
    );

    // Determine new status
    const currentDeal = await dealTracker.getDealByTicket(ticketId);
    let newStatus: string = party === "buyer" ? "collateral_buyer" : "collateral_seller";
    if (currentDeal) {
      if (
        (party === "buyer" && currentDeal.status === "collateral_seller") ||
        (party === "seller" && currentDeal.status === "collateral_buyer")
      ) {
        newStatus = "collateral_locked";
      }
    }

    await dealTracker.updateStatus(ticketId, newStatus);
    await executionStore.markSuccess(ticketId, `lock_collateral_${party}`, tx);

    // Persist step to DB
    await prisma.executionContext.update({
      where: { ticketId },
      data: { lastSuccessfulStep: `lock_collateral_${party}`, status: newStatus }
    });

    logger.info("tx_confirmed", { ticket_id: ticketId, step: `lock_collateral_${party}`, tx });
    return { success: true, tx, step: `lock_collateral_${party}` };

  } catch (error: any) {
    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.error("tx_failed", { step: "unknown" }, error);
    await dealTracker.updateStatus(ticketId, "failed", error.message);
    await executionStore.markFailed(ticketId, `lock_collateral_${party}`, error.message);
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

    // NOTE: In Option A (autonomous deposit) flow, lock_payment is called
    // via confirm_deposit instead. This path is for the legacy full-lifecycle
    // orchestrator and requires the buyer's signature.

    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.info("tx_sent", { step: "lock_payment" });

    const tx = await withRetry(
      async () => {
        const { program } = getAnchorProgram();
        const supportsTokenEscrowAbi = instructionHasAccount(program, "lock_payment", "deal_ata");
        let methodBuilder;
        if (supportsTokenEscrowAbi) {
          const mint = ctx.tokenMint || NATIVE_MINT;
          const dealAta = getAssociatedTokenAddressSync(mint, ctx.dealPda, true);
          const buyerAta = getAssociatedTokenAddressSync(mint, ctx.buyer, true);
          methodBuilder = (program.methods as any).lockPayment().accounts({
            deal: ctx.dealPda,
            buyer: ctx.buyer,
            config: ctx.configPda,
            dealAta,
            buyerAta,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          });
        } else {
          methodBuilder = (program.methods as any).lockPayment().accounts({
            deal: ctx.dealPda,
            buyer: ctx.buyer,
            config: ctx.configPda,
            systemProgram: SystemProgram.programId,
          });
        }
        return await methodBuilder.signers([]).rpc();
      },
      { label: "lock_payment", ticketId, step: "lock_payment" }
    );

    await dealTracker.updateStatus(ticketId, "payment_locked");
    await executionStore.markSuccess(ticketId, "lock_payment", tx);

    // Persist step to DB
    await prisma.executionContext.update({
      where: { ticketId },
      data: { lastSuccessfulStep: "lock_payment", status: "payment_locked" }
    });

    executionLogger.info("tx_confirmed", { step: "lock_payment", tx });
    return { success: true, tx, step: "lock_payment" };

  } catch (error: any) {
    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.error("tx_failed", { step: "unknown" }, error);
    await dealTracker.updateStatus(ticketId, "failed", error.message);
    await executionStore.markFailed(ticketId, "lock_payment", error.message);
    return { success: false, error: error.message, step: "lock_payment" };
  }
}

// ==========================================
// 4. RELEASE FUNDS
// ==========================================

export async function executeReleaseFunds(ticketId: string): Promise<ExecutionResult> {
  try {
    const ctx = await getDealContextSafe(ticketId);
    if (!ctx) return { success: false, error: "No deal context", step: "release_funds" };

    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.info("tx_sent", { step: "release_funds" });

    const tx = await withRetry(
      async () => {
        const { program, wallet } = getAnchorProgram();
        const preInstructions = [
          await getPriorityFeeIx((program.provider as any).connection),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })
        ];

        const supportsTokenEscrowAbi = instructionHasAccount(program, "release_funds", "deal_ata");
        let methodBuilder;
        if (supportsTokenEscrowAbi) {
          const mint = ctx.tokenMint || NATIVE_MINT;
          const tokenAccounts = buildTokenEscrowAccounts(ctx, mint);
          preInstructions.push(...buildReleaseAtaPreInstructions(wallet.publicKey, ctx, mint, tokenAccounts));
          methodBuilder = (program.methods as any).releaseFunds().accounts({
            deal: ctx.dealPda,
            middleman: ctx.middleman,
            buyer: ctx.buyer,
            seller: ctx.seller,
            feeReceiver: ctx.middleman,
            dealAta: tokenAccounts.dealAta,
            buyerAta: tokenAccounts.buyerAta,
            sellerAta: tokenAccounts.sellerAta,
            feeAta: tokenAccounts.feeAta,
            config: ctx.configPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          });
        } else {
          methodBuilder = (program.methods as any).releaseFunds().accounts({
            deal: ctx.dealPda,
            middleman: ctx.middleman,
            buyer: ctx.buyer,
            seller: ctx.seller,
            feeReceiver: ctx.middleman,
            config: ctx.configPda,
            systemProgram: SystemProgram.programId,
          });
        }
        return await methodBuilder.preInstructions(preInstructions).signers([]).rpc();
      },
      { label: "release_funds", ticketId, step: "release_funds" }
    );

    await dealTracker.updateStatus(ticketId, "completed");
    await executionStore.markSuccess(ticketId, "release_funds", tx);

    // Persist step to DB
    await prisma.executionContext.update({
      where: { ticketId },
      data: { lastSuccessfulStep: "release_funds", status: "completed" }
    });

    // Update reputation for both parties
    const ticket = await ticketStore.getTicket(ticketId);
    if (ticket) {
      walletRegistry.recordTradeComplete(ticket.buyer, true);
      walletRegistry.recordTradeComplete(ticket.seller, true);
    }

    // Record fee revenue for treasury tracking (Level 5)
    // Standard middleman fee: 1% of deal price
    const deal = await dealTracker.getDealByTicket(ticketId);
    if (deal && tx) {
      const feeAmount = (deal as any).price * 0.01;
      recordFeeRevenue(deal.id, feeAmount, tx).catch(() => { });
    }

    executionLogger.info("tx_confirmed", { step: "release_funds", tx });

    // ── MagicBlock: Close negotiation session and commit back to L1 ──
    // If a MagicBlock session was opened for this deal, this commits the
    // finalized state and triggers FHE encryption of agreed terms.
    // Non-fatal: silently skipped if no session was opened.
    magicBlockSessions.closeForDeal(ticketId).catch((err) => {
      executionLogger.warn("magicblock_close_on_release_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { success: true, tx, step: "release_funds" };

  } catch (error: any) {
    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.error("tx_failed", { step: "unknown" }, error);
    await dealTracker.updateStatus(ticketId, "failed", error.message);
    await executionStore.markFailed(ticketId, "release_funds", error.message);
    return { success: false, error: error.message, step: "release_funds" };
  }
}

// ==========================================
// 4b. FRACTIONAL SPLIT
// ==========================================

export async function executeFractionalSplit(
  ticketId: string,
  splitRatios?: { buyerRefundPercent: number; sellerReleasePercent: number }
): Promise<ExecutionResult> {
  try {
    const ctx = dealContexts[ticketId];
    if (!ctx) return { success: false, error: "No deal context", step: "fractional_split" };

    const { program } = getAnchorProgram();
    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.info("tx_sent", { step: "fractional_split", splitRatios });

    // Dynamic split mapping for Level 5 Autonomy
    const buyerBasisPoints = (splitRatios?.buyerRefundPercent || 0) * 100;
    const sellerBasisPoints = (splitRatios?.sellerReleasePercent || 100) * 100;

    const tx = await withRetry(
      async () => {
        const { program } = getAnchorProgram();
        const preInstructions = [
          await getPriorityFeeIx((program.provider as any).connection),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })
        ];

        // Assuming the L5 Anchor program has a `fractionalSplit` method that takes BP.
        // Fallback to releaseFunds if IDL lacks it during this architectural transition.
        const supportsTokenEscrowAbi = instructionHasAccount(program, "release_funds", "deal_ata");

        if ((program.methods as any).fractionalSplit) {
          let methodBuilder;
          if (supportsTokenEscrowAbi) {
            const mint = ctx.tokenMint || NATIVE_MINT;
            const dealAta = getAssociatedTokenAddressSync(mint, ctx.dealPda, true);
            const buyerAta = getAssociatedTokenAddressSync(mint, ctx.buyer, true);
            const sellerAta = getAssociatedTokenAddressSync(mint, ctx.seller, true);
            const feeAta = getAssociatedTokenAddressSync(mint, ctx.middleman, true);
            methodBuilder = (program.methods as any).fractionalSplit(buyerBasisPoints, sellerBasisPoints)
              .accounts({
                deal: ctx.dealPda,
                middleman: ctx.middleman,
                buyer: ctx.buyer,
                seller: ctx.seller,
                feeReceiver: ctx.middleman,
                dealAta,
                buyerAta,
                sellerAta,
                feeAta,
                config: ctx.configPda,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
              });
          } else {
            methodBuilder = (program.methods as any).fractionalSplit(buyerBasisPoints, sellerBasisPoints)
              .accounts({
                deal: ctx.dealPda,
                middleman: ctx.middleman,
                buyer: ctx.buyer,
                seller: ctx.seller,
                feeReceiver: ctx.middleman,
                config: ctx.configPda,
                systemProgram: SystemProgram.programId,
              });
          }
          return await methodBuilder.preInstructions(preInstructions).signers([]).rpc();
        } else {
          executionLogger.warn("fractional_split_unsupported_by_idl", {
            msg: "Falling back to standard release process while L5 contract is deploying."
          });
          let releaseBuilder;
          if (supportsTokenEscrowAbi) {
            const mint = ctx.tokenMint || NATIVE_MINT;
            const dealAta = getAssociatedTokenAddressSync(mint, ctx.dealPda, true);
            const buyerAta = getAssociatedTokenAddressSync(mint, ctx.buyer, true);
            const sellerAta = getAssociatedTokenAddressSync(mint, ctx.seller, true);
            const feeAta = getAssociatedTokenAddressSync(mint, ctx.middleman, true);
            releaseBuilder = (program.methods as any).releaseFunds()
              .accounts({
                deal: ctx.dealPda,
                middleman: ctx.middleman,
                buyer: ctx.buyer,
                seller: ctx.seller,
                feeReceiver: ctx.middleman,
                dealAta,
                buyerAta,
                sellerAta,
                feeAta,
                config: ctx.configPda,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
              });
          } else {
            releaseBuilder = (program.methods as any).releaseFunds()
              .accounts({
                deal: ctx.dealPda,
                middleman: ctx.middleman,
                buyer: ctx.buyer,
                seller: ctx.seller,
                feeReceiver: ctx.middleman,
                config: ctx.configPda,
                systemProgram: SystemProgram.programId,
              });
          }
          return await releaseBuilder.preInstructions(preInstructions).signers([]).rpc();
        }
      },
      { label: "fractional_split", ticketId, step: "fractional_split" }
    );

    await dealTracker.updateStatus(ticketId, "completed");
    await executionStore.markSuccess(ticketId, "fractional_split", tx);

    // Persist step to DB
    await prisma.executionContext.update({
      where: { ticketId },
      data: { lastSuccessfulStep: "fractional_split", status: "completed" }
    });

    // Update reputation
    const ticket = await ticketStore.getTicket(ticketId);
    if (ticket) {
      walletRegistry.recordTradeComplete(ticket.buyer, true);
      walletRegistry.recordTradeComplete(ticket.seller, true);
    }

    executionLogger.info("tx_confirmed", { step: "fractional_split", tx });
    return { success: true, tx, step: "fractional_split" };

  } catch (error: any) {
    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.error("tx_failed", { step: "fractional_split" }, error);
    await dealTracker.updateStatus(ticketId, "failed", error.message);
    await executionStore.markFailed(ticketId, "fractional_split", error.message);
    return { success: false, error: error.message, step: "fractional_split" };
  }
}

// ==========================================
// 5. CANCEL DEAL
// ==========================================

export async function executeCancelDeal(ticketId: string): Promise<ExecutionResult> {
  try {
    const ctx = dealContexts[ticketId];
    if (!ctx) return { success: false, error: "No deal context", step: "cancel_deal" };

    const { program, wallet } = getAnchorProgram();

    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.info("tx_sent", { step: "cancel_deal" });

    const tx = await withRetry(
      async () => {
        const { program, wallet } = getAnchorProgram();
        const supportsTokenEscrowAbi = instructionHasAccount(program, "cancel_deal", "deal_ata");
        let methodBuilder;
        if (supportsTokenEscrowAbi) {
          const mint = ctx.tokenMint || NATIVE_MINT;
          const dealAta = getAssociatedTokenAddressSync(mint, ctx.dealPda, true);
          const buyerAta = getAssociatedTokenAddressSync(mint, ctx.buyer, true);
          const sellerAta = getAssociatedTokenAddressSync(mint, ctx.seller, true);
          methodBuilder = (program.methods as any).cancelDeal().accounts({
            deal: ctx.dealPda,
            caller: wallet.publicKey,
            buyer: ctx.buyer,
            seller: ctx.seller,
            dealAta,
            buyerAta,
            sellerAta,
            config: ctx.configPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          });
        } else {
          methodBuilder = (program.methods as any).cancelDeal().accounts({
            deal: ctx.dealPda,
            caller: wallet.publicKey,
            buyer: ctx.buyer,
            seller: ctx.seller,
            config: ctx.configPda,
            systemProgram: SystemProgram.programId,
          });
        }
        return await methodBuilder.signers([]).rpc();
      },
      { label: "cancel_deal", ticketId, step: "cancel_deal" }
    );

    await dealTracker.updateStatus(ticketId, "cancelled");
    await executionStore.markSuccess(ticketId, "cancel_deal", tx);

    // Persist step to DB
    await prisma.executionContext.update({
      where: { ticketId },
      data: { lastSuccessfulStep: "cancel_deal", status: "cancelled" }
    });

    executionLogger.info("tx_confirmed", { step: "cancel_deal", tx });

    // ── MagicBlock: Force-close the session (no FHE — deal was cancelled) ──
    magicBlockSessions.forceClose(ticketId).catch(() => { });

    return { success: true, tx, step: "cancel_deal" };

  } catch (error: any) {
    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.error("tx_failed", { step: "unknown" }, error);
    await dealTracker.updateStatus(ticketId, "failed", error.message);
    await executionStore.markFailed(ticketId, "cancel_deal", error.message);
    return { success: false, error: error.message, step: "cancel_deal" };
  }
}

// ==========================================
// 6. REFUND ON TIMEOUT
// ==========================================

export async function executeRefundOnTimeout(input: {
  ticketId: string;
  dealIdOnChain: string;
  buyerWallet: string;
  sellerWallet: string;
}): Promise<ExecutionResult> {
  const { ticketId, dealIdOnChain, buyerWallet, sellerWallet } = input;
  try {
    const { program, wallet, programId } = getAnchorProgram();

    const dealPda = new PublicKey(dealIdOnChain);
    const buyer = new PublicKey(buyerWallet);
    const seller = new PublicKey(sellerWallet);
    const configPda = deriveConfigPda(programId);

    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.info("tx_sent", { step: "refund_on_timeout" });

    const tx = await withRetry(
      async () => {
        const { program, wallet } = getAnchorProgram();
        const supportsTokenEscrowAbi = instructionHasAccount(program, "refund_on_timeout", "deal_ata");
        let methodBuilder;
        if (supportsTokenEscrowAbi) {
          const dbCtx = await getDealContextSafe(ticketId);
          const mint = dbCtx?.tokenMint || NATIVE_MINT;
          const dealAta = getAssociatedTokenAddressSync(mint, dealPda, true);
          const buyerAta = getAssociatedTokenAddressSync(mint, buyer, true);
          const sellerAta = getAssociatedTokenAddressSync(mint, seller, true);
          methodBuilder = (program.methods as any).refundOnTimeout().accounts({
            deal: dealPda,
            caller: wallet.publicKey,
            buyer,
            seller,
            dealAta,
            buyerAta,
            sellerAta,
            config: configPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          });
        } else {
          methodBuilder = (program.methods as any).refundOnTimeout().accounts({
            deal: dealPda,
            caller: wallet.publicKey,
            buyer,
            seller,
            config: configPda,
            systemProgram: SystemProgram.programId,
          });
        }
        return await methodBuilder.signers([]).rpc();
      },
      { label: "refund_on_timeout", ticketId, step: "refund_on_timeout" }
    );

    await dealTracker.updateStatus(ticketId, "refunded");
    await executionStore.markSuccess(ticketId, "refund_on_timeout", tx);

    // Persist step to DB
    await prisma.executionContext.update({
      where: { ticketId },
      data: { lastSuccessfulStep: "refund_on_timeout", status: "refunded" }
    });

    executionLogger.info("tx_confirmed", { step: "refund_on_timeout", tx });
    return { success: true, tx, step: "refund_on_timeout" };

  } catch (error: any) {
    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.error("tx_failed", { step: "unknown" }, error);
    await dealTracker.updateStatus(ticketId, "failed", error.message);
    await executionStore.markFailed(ticketId, "refund_on_timeout", error.message);
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

    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.info("tx_sent", { step: "close_deal" });

    const tx = await withRetry(
      async () => {
        const { program, wallet } = getAnchorProgram();
        return await program.methods.closeDeal()
          .accounts({
            deal: ctx.dealPda, authority: wallet.publicKey,
            rentReceiver: wallet.publicKey,
          })
          .signers([]).rpc();
      },
      { label: "close_deal", ticketId, step: "close_deal" }
    );

    await dealTracker.updateStatus(ticketId, "closed");
    await executionStore.markSuccess(ticketId, "close_deal", tx);
    delete dealContexts[ticketId];

    executionLogger.info("tx_confirmed", { step: "close_deal", tx });

    // ── MagicBlock: Force-close the session (deal is fully closed) ──
    magicBlockSessions.forceClose(ticketId).catch(() => { });

    return { success: true, tx, step: "close_deal" };

  } catch (error: any) {
    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.error("tx_failed", { step: "unknown" }, error);
    await dealTracker.updateStatus(ticketId, "failed", error.message);
    await executionStore.markFailed(ticketId, "close_deal", error.message);
    return { success: false, error: error.message, step: "close_deal" };
  }
}

// ==========================================
// 8. CONFIRM DEPOSIT (Option A — Plain SOL Transfers)
// ==========================================

/**
 * Calls the `confirm_deposit` Anchor instruction.
 * Only the middleman can call this — verifies that a plain SOL transfer
 * arrived at the deal PDA and updates the on-chain state flags.
 */
export async function executeConfirmDeposit(
  ticketId: string,
  depositType: "buyer_collateral" | "seller_collateral" | "buyer_payment"
): Promise<ExecutionResult> {
  try {
    const ctx = await getDealContextSafe(ticketId);
    if (!ctx) return { success: false, error: "No deal context", step: `confirm_deposit_${depositType}` };

    // Map to Anchor enum variant
    const depositEnum =
      depositType === "buyer_collateral" ? { buyerCollateral: {} } :
        depositType === "seller_collateral" ? { sellerCollateral: {} } :
          { buyerPayment: {} };

    logger.info("tx_sent", { ticket_id: ticketId, step: `confirm_deposit_${depositType}` });

    const tx = await withRetry(
      async () => {
        const { program } = getAnchorProgram();
        const supportsTokenEscrowAbi = instructionHasAccount(program, "confirm_deposit", "deal_ata");
        let methodBuilder;
        if (supportsTokenEscrowAbi) {
          const mint = ctx.tokenMint || NATIVE_MINT;
          const dealAta = getAssociatedTokenAddressSync(mint, ctx.dealPda, true);
          methodBuilder = (program.methods as any)
            .confirmDeposit(depositEnum)
            .accounts({
              deal: ctx.dealPda,
              middleman: ctx.middleman,
              dealAta,
              config: ctx.configPda,
            });
        } else {
          methodBuilder = (program.methods as any)
            .confirmDeposit(depositEnum)
            .accounts({
              deal: ctx.dealPda,
              middleman: ctx.middleman,
              config: ctx.configPda,
            });
        }
        return await methodBuilder.signers([]).rpc();
      },
      { label: `confirm_deposit_${depositType}`, ticketId, step: `confirm_deposit_${depositType}` }
    );

    // Determine new status based on deposit type
    let newStatus: string;
    if (depositType === "buyer_payment") {
      newStatus = "payment_locked";
    } else {
      const currentDeal = await dealTracker.getDealByTicket(ticketId);
      if (
        currentDeal &&
        ((depositType === "buyer_collateral" && currentDeal.status === "collateral_seller") ||
          (depositType === "seller_collateral" && currentDeal.status === "collateral_buyer"))
      ) {
        newStatus = "collateral_locked";
      } else {
        newStatus = depositType === "buyer_collateral" ? "collateral_buyer" : "collateral_seller";
      }
    }

    await dealTracker.updateStatus(ticketId, newStatus);
    await executionStore.markSuccess(ticketId, `confirm_deposit_${depositType}`, tx);
    logger.info("tx_confirmed", { ticket_id: ticketId, step: `confirm_deposit_${depositType}`, tx });
    return { success: true, tx, step: `confirm_deposit_${depositType}` };

  } catch (error: any) {
    const executionLogger = logger.withContext({ ticket_id: ticketId });
    executionLogger.error("tx_failed", { step: "unknown" }, error);
    await dealTracker.updateStatus(ticketId, "failed", error.message);
    await executionStore.markFailed(ticketId, `confirm_deposit_${depositType}`, error.message);
    return { success: false, error: error.message, step: `confirm_deposit_${depositType}` };
  }
}

// ==========================================
// FULL LIFECYCLE ORCHESTRATOR (Legacy — agent signs all)
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

  const dbContext = await prisma.executionContext.findUnique({ where: { ticketId: result.ticketId } });
  const lastStep = dbContext?.lastSuccessfulStep || "none";
  const stepNames = steps.map(s => s.name);
  const startIndex = lastStep === "none" ? 0 : Math.max(0, stepNames.indexOf(lastStep) + 1);

  const lifecycleLog = logger.withContext({ ticket_id: result.ticketId });
  lifecycleLog.info("lifecycle_started", {
    steps: steps.map(s => s.name),
    resuming_from: startIndex > 0 ? steps[startIndex]?.name : "beginning"
  });

  let lastTx: string | undefined;

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    let r = await step.fn();

    // Auto-Healing Loop (Level 4 Autonomy)
    let retryCount = 0;
    while (!r.success && retryCount < 2) {
      lifecycleLog.warn("lifecycle_error_caught", { step: step.name, error_message: r.error });
      const healPlan = await interpretExecutionError(step.name, r.error || "Unknown Error");
      lifecycleLog.info("lifecycle_healing_attempt", { step: step.name, strategy: healPlan.strategy, msg: healPlan.userMessage });

      if (healPlan.strategy === "RETRY_IMMEDIATE" || healPlan.strategy === "RETRY_WITH_HIGHER_FEE") {
        retryCount++;
        lifecycleLog.info("lifecycle_retrying", { attempt: retryCount, step: step.name });
        r = await step.fn(); // Autonomous retry execution
      } else if (healPlan.strategy === "RESUME_FROM_STEP") {
        lifecycleLog.info("lifecycle_healing_resume", { step: step.name, reason: "Account already exists / Step previously completed" });
        r = { success: true, tx: "recovered_tx", step: step.name }; // Treat as success to proceed
        break;
      } else if (healPlan.strategy === "RE_DERIVE_PDA") {
        retryCount++;
        lifecycleLog.info("lifecycle_healing_rederive", { step: step.name });
        const ctx = dealContexts[result.ticketId];
        if (ctx) {
          // Re-derive the core PDA in memory before retrying
          ctx.dealPda = deriveDealPda(ctx.buyer, ctx.dealId, ctx.programId);
          ctx.configPda = deriveConfigPda(ctx.programId);
        }
        r = await step.fn(); // Retry with fixed PDAs
      } else {
        return { success: false, error: healPlan.userMessage, step: step.name };
      }
    }

    if (!r.success) {
      lifecycleLog.error("lifecycle_halted", { step: step.name, error_message: r.error });
      return { success: false, error: `Halted at ${step.name} after retries: ${r.error}`, step: step.name };
    }
    lastTx = r.tx !== "recovered_tx" ? r.tx : lastTx; // Keep real tx if we bypassed
  }

  lifecycleLog.info("lifecycle_complete", { finalTx: lastTx });
  return { success: true, tx: lastTx, step: "lifecycle_complete" };
}

// ==========================================
// AUTONOMOUS LIFECYCLE (Option A — Plain SOL Deposits)
// ==========================================

/**
 * Phase 1: Middleman creates the deal on-chain.
 * After this, the middleman tells buyer/seller the PDA address
 * to send their deposits. The depositWatcher handles the rest.
 */
export async function executeCreateDealPhase(result: AgreementResult): Promise<ExecutionResult & { dealPda?: string }> {
  const createResult = await executeCreateDeal(result);

  if (createResult.success) {
    const ctx = dealContexts[result.ticketId];
    if (ctx) {
      logger.info("deal_pda_ready_for_deposits", {
        ticket_id: result.ticketId,
        deal_id: ctx.dealPda.toBase58(),
        buyerCollateral: result.collateral_buyer,
        sellerCollateral: result.collateral_seller,
        payment: result.price,
      });
      return { ...createResult, dealPda: ctx.dealPda.toBase58() };
    }
  }

  return createResult;
}

/**
 * Phase 2: All deposits confirmed → middleman releases funds.
 * Called automatically after depositWatcher confirms all 3 deposits.
 */
export async function executeReleasePhase(ticketId: string): Promise<ExecutionResult> {
  const releaseResult = await executeReleaseFunds(ticketId);
  if (!releaseResult.success) return releaseResult;

  // LEVEL 5: Post-TX on-chain verification — confirm funds were actually released
  const onChainCheck = await verifyOnChainState(ticketId);
  if (onChainCheck.verified && onChainCheck.onChainStatus !== "completed" && onChainCheck.onChainStatus !== "released") {
    logger.error("on_chain_state_mismatch_release", {
      ticket_id: ticketId,
      expected: "completed/released",
      actual: onChainCheck.onChainStatus,
    });
    // Don't close the deal if funds weren't actually released
    return { success: false, error: `Release state mismatch: chain=${onChainCheck.onChainStatus}`, step: "release_funds" };
  }

  const closeResult = await executeCloseDeal(ticketId);
  if (!closeResult.success) {
    logger.warn("close_after_release_failed", {
      ticket_id: ticketId,
      error: closeResult.error,
      release_tx: releaseResult.tx,
    });
  }

  return releaseResult;
}

/** Backward-compatible entry point */
export async function executeOnChainDeal(result: AgreementResult): Promise<ExecutionResult> {
  return executeFullDealLifecycle(result);
}

export function getDealContext(ticketId: string): DealContext | null {
  return dealContexts[ticketId] || null;
}
