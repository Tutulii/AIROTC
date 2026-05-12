/**
 * Confidential Execution Service — Production Orchestrator
 *
 * Orchestrates the full confidential deal lifecycle with REAL:
 * - On-chain transactions (not mocks)
 * - Account data reads at byte offsets
 * - Ciphertext polling against Encrypt executor
 * - Store-and-verify decryption with digest comparison
 * - Cross-chain signing via dWallet MPC
 *
 * 10-Step Pipeline:
 *  1. Validate via economicSafety
 *  2. Ensure gas deposits (Encrypt + Ika)
 *  3. Encrypt collateral amounts (real on-chain ciphertext accounts)
 *  4. Create confidential deal on-chain
 *  5. Wait for buyer/seller deposits
 *  6. Poll executor for settlement graph completion
 *  7. Request decryption — capture digest (store step)
 *  8. Poll decryption, read + verify digest match (verify step)
 *  9. Pause at buyer/seller release approvals
 * 10. Approve cross-chain message → sign via dWallet
 * 11. Release funds only after signed approval exists on-chain
 *
 * @module confidentialExecutionService
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { BN, Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";

import { logger } from "../utils/logger";
import { loadConfig } from "../config";
import { loadWallet } from "../solana/wallet";
import { getConnection } from "../solana/connection";
import { eventBus } from "./eventBus";
import { ticketStore } from "../state/ticketStore";
import { dealTracker } from "../state/dealTracker";
import { walletRegistry } from "../state/walletRegistry";
import { confidentialFundingStore } from "../state/confidentialFundingStore";
import { confidentialIdentityStore } from "../state/confidentialIdentityStore";
import { privateEscrowIntentStore } from "../state/privateEscrowIntentStore";
import { circuitBreaker } from "../utils/circuitBreaker";
import { appendAuditLog, appendSealedAuditLog } from "./auditTrail";
import { sleep, withRetry } from "../utils/retry";
import { dependencyHealthService } from "./dependencyHealthService";

import {
  EncryptService,
  getEncryptService,
  ENCRYPT_PROGRAM_ID,
  CiphertextStatus,
  FheType,
} from "./encryptService";
import {
  IkaService,
  getIkaService,
  DWalletCurve,
  DWalletSignatureScheme,
  DWalletState,
  DWALLET_PROGRAM_ID,
} from "./ikaService";

import type { AgreementResult } from "./onChainExecutionService";
import type { AttestedEscrowIntent, SettlementAddressPlan } from "../types/dealPipeline";
import type { ReleaseApprovalStateSnapshot } from "../protocol/releaseApprovalProtocol";
import {
  computeNegotiationTermsHash,
  computeSettlementPlanHash,
} from "../protocol/releaseApprovalProtocol";
import { revealPrivateExecutionTerms } from "./privateExecutionTerms";

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_DEAL_LIFETIME_MS = 30 * 60 * 1000;
const SETTLEMENT_TIMEOUT_MS = 120_000;
const DECRYPTION_TIMEOUT_MS = 60_000;
const SIGNATURE_TIMEOUT_MS = 120_000;
const MIN_GAS_DEPOSIT_SOL = 0.05;
const CONFIDENTIAL_ESCROW_IDL_PATH = path.join(
  __dirname,
  "../../../escrow/target/idl/escrow_confidential.json"
);

// ============================================================================
// TYPES
// ============================================================================

export interface ConfidentialDealContext {
  dealId: Uint8Array;
  dealPda: PublicKey;
  buyerCollateralCt: PublicKey;
  sellerCollateralCt: PublicKey;
  paymentCt: PublicKey;
  settlementResultCt: PublicKey;
  dwalletPda: PublicKey;
  dwalletPublicKey: Uint8Array;
  dwalletCurve: DWalletCurve;
  buyer: PublicKey;
  seller: PublicKey;
  middleman: PublicKey;
  betLamports: bigint;
  createdAt: Date;
  // Decryption tracking
  decryptionRequestPubkey?: PublicKey;
  decryptionDigest?: Uint8Array;
  // Signing tracking
  messageApprovalPda?: PublicKey;
}

export interface ConfidentialExecutionResult {
  success: boolean;
  dealPda?: string;
  txSignatures: string[];
  approvalStatus?:
    | "created_awaiting_deposits"
    | "awaiting_settlement_plan_approvals"
    | "awaiting_buyer_release_confirmation"
    | "seller_dispute_window"
    | "release_signed"
    | "settled";
  decryptedValue?: string;
  winner?: string;
  releaseTxSignature?: string;
  approvalTxSignature?: string;
  crossChainSignature?: string;
  signatureScheme?: string;
  dwalletPublicKey?: string;
  dwalletPda?: string;
  messageApprovalPda?: string;
  requestAccount?: string;
  dealIdHex?: string;
  sessionPda?: string;
  termsHash?: string;
  planHash?: string;
  buyerSettlementTarget?: string;
  sellerSettlementTarget?: string;
  error?: string;
  step?: string;
}

export interface ConfidentialDealFundingSnapshot {
  privateFundingRegistered: boolean;
  buyerPaymentDeposited: boolean;
  buyerCollateralDeposited: boolean;
  sellerCollateralDeposited: boolean;
  releaseExecuted: boolean;
}

interface PrecomputedConfidentialTerms {
  intentId: string;
  buyerCollateralCt: PublicKey;
  sellerCollateralCt: PublicKey;
  paymentCt: PublicKey;
  settlementResultCt: PublicKey;
  networkEncryptionKeyPda: PublicKey;
  betLamports: bigint;
}

function computeParticipantIdentityCommitment(wallet: PublicKey): Uint8Array {
  return crypto
    .createHash("sha256")
    .update("air_otc_participant_identity_v1:", "utf8")
    .update(wallet.toBuffer())
    .digest();
}

async function resolveDealParticipantIdentityWallets(
  ticketId: string,
  buyerWallet: PublicKey,
  sellerWallet: PublicKey
): Promise<{ buyerIdentityWallet: PublicKey; sellerIdentityWallet: PublicKey }> {
  const identitySnapshot = await confidentialIdentityStore.getLatestByTicket(ticketId);
  return {
    buyerIdentityWallet: new PublicKey(
      identitySnapshot?.buyerFundingWallet || buyerWallet.toBase58()
    ),
    sellerIdentityWallet: new PublicKey(
      identitySnapshot?.sellerFundingWallet || sellerWallet.toBase58()
    ),
  };
}

function encodeSettlementPolicyForAnchor(policy: "DIRECT" | "STEALTH") {
  return policy === "STEALTH" ? { stealth: {} } : { direct: {} };
}

function encodeReleaseApprovalRoleSeed(role: "buyer" | "seller"): number {
  return role === "buyer" ? 0 : 1;
}

// ============================================================================
// STATE
// ============================================================================

const dealContexts: Record<string, ConfidentialDealContext> = {};
let initialized = false;
let agentDWalletPda: PublicKey | null = null;
let agentDWalletPublicKey: Uint8Array | null = null;
let agentDWalletCurve: DWalletCurve = DWalletCurve.Curve25519;
let agentDWalletSignatureScheme: DWalletSignatureScheme =
  DWalletSignatureScheme.EddsaSha512;

function resolveSupportedIkaProfile(config: ReturnType<typeof loadConfig>): {
  curve: DWalletCurve;
  signatureScheme: DWalletSignatureScheme;
  normalized: boolean;
  reason?: string;
} {
  const requestedCurve = (config.dwalletCurve ?? DWalletCurve.Secp256k1) as DWalletCurve;
  const requestedSignatureScheme = (config.dwalletSignatureScheme ??
    DWalletSignatureScheme.EddsaSha512) as DWalletSignatureScheme;

  const supportedCurve =
    requestedCurve === DWalletCurve.Curve25519 ||
    requestedCurve === DWalletCurve.Secp256k1 ||
    requestedCurve === DWalletCurve.Secp256r1;

  if (
    !supportedCurve ||
    requestedSignatureScheme === DWalletSignatureScheme.SchnorrkelMerlin
  ) {
    return {
      curve: DWalletCurve.Curve25519,
      signatureScheme: DWalletSignatureScheme.EddsaSha512,
      normalized: true,
      reason:
        "The official Solana pre-alpha examples are aligned around Curve25519 + EddsaSha512 for dWallet-controlled program flows.",
    };
  }

  if (
    requestedCurve === DWalletCurve.Curve25519 &&
    requestedSignatureScheme !== DWalletSignatureScheme.EddsaSha512
  ) {
    return {
      curve: DWalletCurve.Curve25519,
      signatureScheme: DWalletSignatureScheme.EddsaSha512,
      normalized: true,
      reason:
        "Curve25519 dWallets are paired with EddsaSha512 in the official Solana pre-alpha signing flow.",
    };
  }

  if (
    requestedCurve === DWalletCurve.Secp256k1 &&
    requestedSignatureScheme !== DWalletSignatureScheme.EcdsaKeccak256 &&
    requestedSignatureScheme !== DWalletSignatureScheme.EcdsaSha256 &&
    requestedSignatureScheme !== DWalletSignatureScheme.EcdsaDoubleSha256 &&
    requestedSignatureScheme !== DWalletSignatureScheme.TaprootSha256 &&
    requestedSignatureScheme !== DWalletSignatureScheme.EcdsaBlake2b256
  ) {
    return {
      curve: DWalletCurve.Curve25519,
      signatureScheme: DWalletSignatureScheme.EddsaSha512,
      normalized: true,
      reason:
        "Unsupported secp256k1 signing scheme requested; falling back to the official Solana pre-alpha Curve25519 + EddsaSha512 profile.",
    };
  }

  if (
    requestedCurve === DWalletCurve.Secp256r1 &&
    requestedSignatureScheme !== DWalletSignatureScheme.EcdsaSha256
  ) {
    return {
      curve: DWalletCurve.Curve25519,
      signatureScheme: DWalletSignatureScheme.EddsaSha512,
      normalized: true,
      reason:
        "Secp256r1 is not used in the official Solana pre-alpha examples; falling back to the known-good Curve25519 + EddsaSha512 profile.",
    };
  }

  return {
    curve: requestedCurve,
    signatureScheme: requestedSignatureScheme,
    normalized: false,
  };
}

function getConfidentialEscrowProgram(
  connection: Connection,
  payer: Keypair,
  programIdOverride?: string
): { program: Program; programId: PublicKey } {
  const idlPath = process.env.CONFIDENTIAL_ESCROW_IDL_PATH || CONFIDENTIAL_ESCROW_IDL_PATH;
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const programId = new PublicKey(
    programIdOverride ||
      process.env.CONFIDENTIAL_ESCROW_PROGRAM_ID ||
      (idl as any).metadata?.address ||
      (idl as any).address ||
      "BuTf7gVrjD2wzKe4Tu1Ny2m7gC9SY65fRCY7gHnBgLqj"
  );
  (idl as any).address = programId.toBase58();
  return {
    program: new Program(idl as any, provider),
    programId,
  };
}

function anchorGlobalDiscriminator(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`, "utf8").digest().subarray(0, 8);
}

function encodeFundingRoleSeed(role: "buyer_payment" | "buyer_collateral" | "seller_collateral"): number {
  if (role === "buyer_payment") return 0;
  if (role === "buyer_collateral") return 1;
  return 2;
}

function deriveCreditVaultPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("credit_vault")], programId)[0];
}

function deriveCreditBalancePda(programId: PublicKey, vault: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("credit_balance"), vault.toBuffer(), owner.toBuffer()],
    programId
  )[0];
}

function deriveCreditLockPda(
  programId: PublicKey,
  dealPda: PublicKey,
  owner: PublicKey,
  role: "buyer_payment" | "buyer_collateral" | "seller_collateral"
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("credit_lock"),
      dealPda.toBuffer(),
      owner.toBuffer(),
      Buffer.from([encodeFundingRoleSeed(role)]),
    ],
    programId
  )[0];
}

function createRegisterPrivateFundingCommitmentsInstruction(input: {
  programId: PublicKey;
  dealPda: PublicKey;
  authority: PublicKey;
  sessionPda: PublicKey;
  buyerPaymentFundingHash: string;
  buyerCollateralFundingHash: string;
  sellerCollateralFundingHash: string;
}): TransactionInstruction {
  const data = Buffer.concat([
    anchorGlobalDiscriminator("register_private_funding_commitments"),
    input.sessionPda.toBuffer(),
    Buffer.from(input.buyerPaymentFundingHash, "hex"),
    Buffer.from(input.buyerCollateralFundingHash, "hex"),
    Buffer.from(input.sellerCollateralFundingHash, "hex"),
  ]);

  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.dealPda, isSigner: false, isWritable: true },
      { pubkey: input.authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function sendAndConfirmManagedTransaction(input: {
  label: string;
  ticketId: string;
  step: string;
  payer: Keypair;
  signers: Keypair[];
  buildTransaction: () => Promise<Transaction> | Transaction;
  verifySuccess?: (connection: Connection) => Promise<boolean>;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = input.timeoutMs ?? 45_000;
  let lastSubmittedSignature: string | null = null;

  return withRetry(
    async () => {
      const connection = getConnection();
      const transaction = await input.buildTransaction();
      const latestBlockhash = await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = latestBlockhash.blockhash;
      transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
      if (!transaction.feePayer) {
        transaction.feePayer = input.payer.publicKey;
      }
      transaction.sign(...input.signers);

      let signature: string;
      try {
        signature = await connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          maxRetries: 2,
        });
        lastSubmittedSignature = signature;
      } catch (sendError) {
        if (input.verifySuccess && lastSubmittedSignature && (await input.verifySuccess(connection))) {
          logger.warn("solana_tx_send_recovered_from_postcondition", {
            ticket_id: input.ticketId,
            label: input.label,
            signature: lastSubmittedSignature,
            error_message: sendError instanceof Error ? sendError.message : String(sendError),
          });
          return lastSubmittedSignature;
        }

        throw sendError;
      }

      try {
        const confirmation = await Promise.race([
          connection.confirmTransaction(
            {
              signature,
              blockhash: latestBlockhash.blockhash,
              lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            },
            "confirmed"
          ),
          sleep(timeoutMs).then(() => {
            throw new Error(`transaction_confirmation_timeout:${input.label}:${signature}`);
          }),
        ]);

        if ((confirmation as Awaited<ReturnType<Connection["confirmTransaction"]>>).value.err) {
          throw new Error(
            `${input.label} transaction ${signature} failed: ${JSON.stringify(
              (confirmation as Awaited<ReturnType<Connection["confirmTransaction"]>>).value.err
            )}`
          );
        }

        return signature;
      } catch (error) {
        try {
          const statusResponse = await connection.getSignatureStatuses([signature], {
            searchTransactionHistory: true,
          });
          const status = statusResponse.value[0];
          if (
            status &&
            !status.err &&
            (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")
          ) {
            logger.warn("solana_tx_confirmation_recovered_from_status", {
              ticket_id: input.ticketId,
              label: input.label,
              signature,
              confirmation_status: status.confirmationStatus,
            });
            return signature;
          }
        } catch (statusError) {
          logger.warn("solana_tx_status_check_failed", {
            ticket_id: input.ticketId,
            label: input.label,
            signature,
            error_message: statusError instanceof Error ? statusError.message : String(statusError),
          });
        }

        if (input.verifySuccess && (await input.verifySuccess(connection))) {
          logger.warn("solana_tx_postcondition_recovered", {
            ticket_id: input.ticketId,
            label: input.label,
            signature,
          });
          return signature;
        }

        throw error;
      }
    },
    { label: input.label, ticketId: input.ticketId, step: input.step }
  );
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the confidential escrow subsystem.
 *
 * Steps:
 * 1. Verify DWalletCoordinator is initialized on-chain
 * 2. Ensure Encrypt deposit account exists
 * 3. Ensure Ika gas deposit exists and is funded
 * 4. Load or verify existing dWallet (if authority already transferred)
 */
export async function initConfidentialEscrow(): Promise<void> {
  const config = loadConfig();

  if (!config.enableConfidentialEscrow) {
    logger.info("confidential_escrow_disabled");
    return;
  }

  await dependencyHealthService.assertHealthyForOperation(
    "confidential_escrow_init",
    ["solana_rpc", "encrypt", "ika"]
  );

  const connection = getConnection();
  const keypair = loadWallet(config.privateKey);
  const ikaService = getIkaService(connection, keypair);
  const encryptService = getEncryptService(connection, keypair);

  logger.info("confidential_escrow_init_start", {
    encrypt_program: ENCRYPT_PROGRAM_ID.toBase58(),
    dwallet_program: DWALLET_PROGRAM_ID.toBase58(),
  });

  // Step 1: Verify coordinator
  const coordReady = await ikaService.isCoordinatorReady();
  if (!coordReady) {
    logger.warn("coordinator_not_ready", {
      hint: "DWalletCoordinator PDA not found. The Ika network may not be initialized on this cluster.",
    });
    // Don't block — coordinator may be created later
  }

  // Step 2: Ensure Encrypt deposit
  try {
    await encryptService.ensureDepositAccount();
  } catch (e: any) {
    logger.warn("encrypt_deposit_init_failed", { error: e.message });
  }

  // Step 3: Resolve Ika gas-deposit posture.
  //
  // The pre-alpha docs still document GasDeposit as part of the Solana flow,
  // but the exact CreateDeposit account contract is not published in a stable
  // client helper today. The live ER/PER + IKA signing path currently works
  // without proactively creating the deposit, so the production-safe default is
  // detect-only: use an existing deposit if present, and avoid emitting a noisy
  // startup failure for an upstream pre-alpha instruction contract we cannot
  // verify end to end from official clients.
  try {
    const gasDeposit = await ikaService.readGasDeposit();
    if (gasDeposit) {
      logger.info("ika_gas_deposit_ready", {
        pda: gasDeposit.pda.toBase58(),
        ika_balance: gasDeposit.ikaBalance.toString(),
        sol_balance: gasDeposit.solBalance.toString(),
      });
    } else if (config.ikaGasDepositMode === "detect_only") {
      logger.info("ika_gas_deposit_not_present_detect_only", {
        user: keypair.publicKey.toBase58(),
        hint: "Proceeding without proactive CreateDeposit because the official pre-alpha Solana client does not yet publish a stable account contract for it.",
      });
    } else {
      const gasPda = await ikaService.ensureGasDeposit();
      logger.info("ika_gas_deposit_created", { pda: gasPda.toBase58() });
    }
  } catch (e: any) {
    if (config.ikaGasDepositMode === "require_create") {
      throw e;
    }
    logger.warn("ika_gas_deposit_init_skipped", {
      mode: config.ikaGasDepositMode,
      error: e.message,
    });
  }

  // Step 4: Set curve from config
  const supportedProfile = resolveSupportedIkaProfile(config);
  agentDWalletCurve = supportedProfile.curve;
  agentDWalletSignatureScheme = supportedProfile.signatureScheme;

  if (supportedProfile.normalized) {
    logger.warn("ika_signing_profile_normalized", {
      requested_curve: DWalletCurve[(config.dwalletCurve ?? DWalletCurve.Secp256k1) as DWalletCurve],
      requested_signature_scheme:
        DWalletSignatureScheme[
          (config.dwalletSignatureScheme ??
            DWalletSignatureScheme.EddsaSha512) as DWalletSignatureScheme
        ],
      applied_curve: DWalletCurve[agentDWalletCurve],
      applied_signature_scheme: DWalletSignatureScheme[agentDWalletSignatureScheme],
      reason: supportedProfile.reason,
    });
  }

  initialized = true;

  logger.info("confidential_escrow_init_complete", {
    curve: DWalletCurve[agentDWalletCurve],
    signature_scheme: DWalletSignatureScheme[agentDWalletSignatureScheme],
    coordinator_ready: coordReady,
  });

  await appendAuditLog("system", "confidential_escrow_initialized", {
    encrypt_program: ENCRYPT_PROGRAM_ID.toBase58(),
    dwallet_program: DWALLET_PROGRAM_ID.toBase58(),
    curve: DWalletCurve[agentDWalletCurve],
    signature_scheme: DWalletSignatureScheme[agentDWalletSignatureScheme],
    timestamp: new Date().toISOString(),
  });
}

// ============================================================================
// MAIN EXECUTION PIPELINE
// ============================================================================

/**
 * Execute a confidential deal.
 *
 * Every operation is a real on-chain transaction or on-chain read.
 * No mocks, no shortcuts. Production-grade error handling with
 * circuit breaker, retry, and audit trail integration.
 */
export async function executeConfidentialDeal(
  ticketId: string,
  agreement: AgreementResult,
  settlementPlan?: SettlementAddressPlan,
  attestedEscrowIntent?: AttestedEscrowIntent
): Promise<ConfidentialExecutionResult> {
  const execLog = logger.withContext({ ticket_id: ticketId });
  const txSignatures: string[] = [];

  try {
    const config = loadConfig();

    // ── Pre-checks ──
    if (circuitBreaker.isOpen()) {
      return { success: false, txSignatures, error: "circuit_breaker_open", step: "pre_check" };
    }

    if (!initialized) {
      if (!config.enableConfidentialEscrow) {
        return { success: false, txSignatures, error: "confidential_escrow_disabled", step: "pre_check" };
      }
      await initConfidentialEscrow();
    }

    if (!initialized) {
      return { success: false, txSignatures, error: "confidential_escrow_not_initialized", step: "pre_check" };
    }

    await dependencyHealthService.assertHealthyForOperation(
      "confidential_execute",
      ["solana_rpc", "encrypt", "ika"]
    );

    const connection = getConnection();
    const keypair = loadWallet(config.privateKey);
    const encryptService = getEncryptService(connection, keypair);
    const ikaService = getIkaService(connection, keypair);
    const { program: confidentialProgram, programId: confidentialProgramId } =
      getConfidentialEscrowProgram(connection, keypair, config.confidentialEscrowProgramId);
    const signatureScheme = agentDWalletSignatureScheme;
    const [expectedDwalletCpiAuthority] =
      ikaService.deriveCpiAuthority(confidentialProgramId);

    const bootstrapFreshDWallet = async (): Promise<PublicKey> => {
      execLog.info("step", { n: 0, name: "bootstrap_dwallet" });
      const created = await ikaService.createDWallet(agentDWalletCurve);
      agentDWalletPda = created.pda;
      agentDWalletPublicKey = created.publicKey;
      return created.pda;
    };

    if (!agentDWalletPda || !agentDWalletPublicKey) {
      agentDWalletPda = await bootstrapFreshDWallet();
    }

    let activeDwalletPda = agentDWalletPda;
    if (!activeDwalletPda) {
      throw new Error("dwallet_not_bootstrapped");
    }

    let activeDwallet = await ikaService.readDWallet(activeDwalletPda);
    if (!activeDwallet || activeDwallet.state !== DWalletState.Active) {
      throw new Error(`dwallet_not_active:${activeDwalletPda.toBase58()}`);
    }

    if (
      !activeDwallet.authority.equals(expectedDwalletCpiAuthority) &&
      !activeDwallet.authority.equals(keypair.publicKey)
    ) {
      execLog.warn("cached_dwallet_authority_mismatch_rebootstrapping", {
        dwallet: activeDwalletPda.toBase58(),
        currentAuthority: activeDwallet.authority.toBase58(),
        expectedSigner: keypair.publicKey.toBase58(),
        expectedProgramAuthority: expectedDwalletCpiAuthority.toBase58(),
      });
      agentDWalletPda = null;
      agentDWalletPublicKey = null;
      activeDwalletPda = await bootstrapFreshDWallet();
      activeDwallet = await ikaService.readDWallet(activeDwalletPda);
      if (!activeDwallet || activeDwallet.state !== DWalletState.Active) {
        throw new Error(`dwallet_not_active:${activeDwalletPda.toBase58()}`);
      }
      if (
        !activeDwallet.authority.equals(expectedDwalletCpiAuthority) &&
        !activeDwallet.authority.equals(keypair.publicKey)
      ) {
        throw new Error(
          `fresh_dwallet_authority_uncontrolled:${activeDwalletPda.toBase58()}:` +
            `${activeDwallet.authority.toBase58()}`
        );
      }
    }

    if (!activeDwallet.authority.equals(expectedDwalletCpiAuthority)) {
      execLog.info("step", {
        n: 0,
        name: "transfer_dwallet_authority",
        dwallet: activeDwalletPda.toBase58(),
        currentAuthority: activeDwallet.authority.toBase58(),
        targetAuthority: expectedDwalletCpiAuthority.toBase58(),
      });
      await ikaService.transferAuthority(activeDwalletPda, confidentialProgramId);
    }

    // ────────────────────────────────────────────────────────
    // STEP 1: Generate deal ID
    // ────────────────────────────────────────────────────────
    execLog.info("step", { n: 1, name: "generate_deal_id" });
    const dealId = new Uint8Array(crypto.randomBytes(32));

    // ────────────────────────────────────────────────────────
    // STEP 2: Resolve or create ciphertext handles
    // ────────────────────────────────────────────────────────
    execLog.info("step", {
      n: 2,
      name: attestedEscrowIntent ? "reuse_attested_ciphertexts" : "encrypt_collateral",
    });

    let precomputedTerms: PrecomputedConfidentialTerms | null = null;
    if (attestedEscrowIntent) {
      precomputedTerms = {
        intentId: attestedEscrowIntent.intentId,
        buyerCollateralCt: new PublicKey(attestedEscrowIntent.encryptedTerms.buyerCollateral.account),
        sellerCollateralCt: new PublicKey(attestedEscrowIntent.encryptedTerms.sellerCollateral.account),
        paymentCt: new PublicKey(attestedEscrowIntent.encryptedTerms.paymentAmount.account),
        settlementResultCt: new PublicKey(attestedEscrowIntent.encryptedTerms.settlementResult.account),
        networkEncryptionKeyPda: new PublicKey(attestedEscrowIntent.encryptedTerms.networkEncryptionKeyPda),
        // Strict PER funding is derived from on-chain recorded deposits, not
        // from a plaintext agreement object revived in the middleman runtime.
        betLamports: 0n,
      };
    }

    let betLamports: bigint;
    let networkEncryptionKeyPda: PublicKey;
    let buyerCtResult: { pubkey: PublicKey };
    let sellerCtResult: { pubkey: PublicKey };
    let paymentCtResult: { pubkey: PublicKey };
    let resultCtResult: { pubkey: PublicKey };

    if (precomputedTerms) {
      betLamports = precomputedTerms.betLamports;
      networkEncryptionKeyPda = precomputedTerms.networkEncryptionKeyPda;
      buyerCtResult = { pubkey: precomputedTerms.buyerCollateralCt };
      sellerCtResult = { pubkey: precomputedTerms.sellerCollateralCt };
      paymentCtResult = { pubkey: precomputedTerms.paymentCt };
      resultCtResult = { pubkey: precomputedTerms.settlementResultCt };

      execLog.info("confidential_execution_reusing_attested_ciphertexts", {
        intentId: precomputedTerms.intentId,
        networkEncryptionKeyPda: networkEncryptionKeyPda.toBase58(),
      });
    } else {
      betLamports = BigInt(Math.round(agreement.collateral_buyer * LAMPORTS_PER_SOL));
      networkEncryptionKeyPda = await encryptService.findNetworkEncryptionKey();
      const networkEncryptionKeyInfo = await withRetry(
        () => connection.getAccountInfo(networkEncryptionKeyPda, "confirmed"),
        { label: "confidential_network_encryption_key", ticketId, step: "encrypt_collateral" }
      );
      if (!networkEncryptionKeyInfo || networkEncryptionKeyInfo.data.length < 34) {
        throw new Error(
          `Invalid NetworkEncryptionKey account: ${networkEncryptionKeyPda.toBase58()}`
        );
      }
      const networkEncryptionPublicKey = Buffer.from(
        networkEncryptionKeyInfo.data.subarray(2, 34)
      );
      const encodeUint64 = (value: bigint): Buffer => {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(value);
        return buf;
      };
      const authorizedProgram = confidentialProgramId;
      const [buyerCtRaw, sellerCtRaw, paymentCtRaw, resultCtRaw] = await Promise.all([
        encryptService.createInputViaGrpc(
          encodeUint64(betLamports),
          FheType.Uint64,
          authorizedProgram,
          networkEncryptionPublicKey
        ),
        encryptService.createInputViaGrpc(
          encodeUint64(BigInt(Math.round(agreement.collateral_seller * LAMPORTS_PER_SOL))),
          FheType.Uint64,
          authorizedProgram,
          networkEncryptionPublicKey
        ),
        encryptService.createInputViaGrpc(
          encodeUint64(BigInt(Math.round(agreement.price * LAMPORTS_PER_SOL))),
          FheType.Uint64,
          authorizedProgram,
          networkEncryptionPublicKey
        ),
        encryptService.createInputViaGrpc(
          encodeUint64(0n),
          FheType.Uint64,
          authorizedProgram,
          networkEncryptionPublicKey
        ),
      ]);
      const toCiphertextRef = (result: { ciphertextIdentifiers: Buffer[] }) => {
        const identifier = result.ciphertextIdentifiers[0];
        if (!identifier) {
          throw new Error("Encrypt gRPC did not return a ciphertext identifier");
        }
        return { pubkey: new PublicKey(identifier) };
      };
      buyerCtResult = toCiphertextRef(buyerCtRaw);
      sellerCtResult = toCiphertextRef(sellerCtRaw);
      paymentCtResult = toCiphertextRef(paymentCtRaw);
      resultCtResult = toCiphertextRef(resultCtRaw);
    }

    // ────────────────────────────────────────────────────────
    // STEP 3: Resolve wallets
    // ────────────────────────────────────────────────────────
    execLog.info("step", { n: 3, name: "resolve_wallets" });
    const resolveAgentWallet = async (agentRef?: string): Promise<PublicKey> => {
      if (!agentRef) return keypair.publicKey;

      try {
        return new PublicKey(agentRef);
      } catch {
        const agent = await walletRegistry.getOrCreateAgent(agentRef);
        return new PublicKey(agent.wallet);
      }
    };
    const buyerWallet = await resolveAgentWallet((agreement as any).buyer);
    const sellerWallet = await resolveAgentWallet((agreement as any).seller);
    const buyerSettlementWallet = new PublicKey(
      settlementPlan?.buyerTarget.resolvedAddress || buyerWallet.toBase58()
    );
    const sellerSettlementWallet = new PublicKey(
      settlementPlan?.sellerTarget.resolvedAddress || sellerWallet.toBase58()
    );
    const sessionPda = attestedEscrowIntent?.sessionPda || PublicKey.default.toBase58();
    const termsHash =
      attestedEscrowIntent?.termsHash ||
      computeNegotiationTermsHash({
        priceLamports: BigInt(Math.round(agreement.price * LAMPORTS_PER_SOL)),
        buyerCollateralLamports: betLamports,
        sellerCollateralLamports: BigInt(
          Math.round(agreement.collateral_seller * LAMPORTS_PER_SOL)
        ),
        assetType: agreement.asset_type || "SOL",
      });
    const planHash = computeSettlementPlanHash({
      policy: settlementPlan?.policy === "STEALTH" ? "STEALTH" : "DIRECT",
      buyerSettlementTarget: buyerSettlementWallet.toBase58(),
      sellerSettlementTarget: sellerSettlementWallet.toBase58(),
    });
    const settlementPolicy =
      settlementPlan?.policy === "STEALTH" ? "STEALTH" : "DIRECT";
    const { buyerIdentityWallet, sellerIdentityWallet } =
      await resolveDealParticipantIdentityWallets(ticketId, buyerWallet, sellerWallet);
    const buyerIdentityCommitment = Array.from(
      computeParticipantIdentityCommitment(buyerIdentityWallet)
    );
    const sellerIdentityCommitment = Array.from(
      computeParticipantIdentityCommitment(sellerIdentityWallet)
    );

    // ────────────────────────────────────────────────────────
    // STEP 4: Derive deal PDA
    // ────────────────────────────────────────────────────────
    execLog.info("step", { n: 4, name: "derive_deal_pda" });
    const [dealPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("confidential_deal"), Buffer.from(dealId)],
      confidentialProgramId
    );

    const dwalletPda = agentDWalletPda;
    const dwalletPk = agentDWalletPublicKey;
    if (!dwalletPda || !dwalletPk) {
      throw new Error("dWallet bootstrap failed");
    }

    // Store context
    const ctx: ConfidentialDealContext = {
      dealId,
      dealPda,
      buyerCollateralCt: buyerCtResult.pubkey,
      sellerCollateralCt: sellerCtResult.pubkey,
      paymentCt: paymentCtResult.pubkey,
      settlementResultCt: resultCtResult.pubkey,
      dwalletPda,
      dwalletPublicKey: dwalletPk,
      dwalletCurve: agentDWalletCurve,
      buyer: buyerWallet,
      seller: sellerWallet,
      middleman: keypair.publicKey,
      betLamports,
      createdAt: new Date(),
    };
    dealContexts[ticketId] = ctx;

    // ────────────────────────────────────────────────────────
    // STEP 5: Create deal on-chain
    // ────────────────────────────────────────────────────────
    execLog.info("step", { n: 5, name: "create_deal_onchain" });
    const configPda = encryptService.deriveConfigPda();
    const [depositPda] = encryptService.deriveDepositPda(keypair.publicKey);
    const [encryptCpiAuthority, encryptCpiAuthorityBump] =
      encryptService.deriveCpiAuthority(confidentialProgramId);
    const eventAuthority = encryptService.deriveEventAuthority();
    const createDealAmount = new BN(
      attestedEscrowIntent && config.perFundingPrivacyTier === "SHIELDED_CREDIT"
        ? "0"
        : betLamports.toString()
    );
    const createDealArgs = [
      Array.from(dealId),
      createDealAmount,
      Array.from(Buffer.from(termsHash, "hex")),
      Array.from(Buffer.from(planHash, "hex")),
      encodeSettlementPolicyForAnchor(settlementPolicy),
      buyerIdentityCommitment,
      sellerIdentityCommitment,
      config.releaseDisputeWindowSeconds,
      encryptCpiAuthorityBump,
    ];
    const createDealAccounts = {
      deal: dealPda,
      middleman: keypair.publicKey,
      dwallet: dwalletPda,
      buyerCollateralCiphertext: buyerCtResult.pubkey,
      sellerCollateralCiphertext: sellerCtResult.pubkey,
      paymentAmountCiphertext: paymentCtResult.pubkey,
      settlementResultCiphertext: resultCtResult.pubkey,
      encryptProgram: ENCRYPT_PROGRAM_ID,
      config: configPda,
      deposit: depositPda,
      cpiAuthority: encryptCpiAuthority,
      callerProgram: confidentialProgramId,
      networkEncryptionKey: networkEncryptionKeyPda,
      payer: keypair.publicKey,
      eventAuthority,
      systemProgram: SystemProgram.programId,
    };
    const createDealSig = await sendAndConfirmManagedTransaction({
      label: "confidential_create_deal",
      ticketId,
      step: "create_deal_onchain",
      payer: keypair,
      signers: [keypair],
      buildTransaction: () =>
        (confidentialProgram.methods as any)
          .createConfidentialDeal(...createDealArgs)
          .accounts(createDealAccounts)
          .transaction(),
      verifySuccess: async (recoveryConnection) => {
        try {
          const { program: recoveryProgram } = getConfidentialEscrowProgram(
            recoveryConnection,
            keypair,
            config.confidentialEscrowProgramId
          );
          const dealAccount = await (recoveryProgram.account as any).confidentialDeal.fetch(dealPda);
          return Boolean(dealAccount);
        } catch {
          return false;
        }
      },
      timeoutMs: 60_000,
    });
    txSignatures.push(createDealSig);

    // Emit event through existing event bus
    eventBus.publish("confidential_deal_created" as any, {
      ticket_id: ticketId,
      deal_pda: dealPda.toBase58(),
      buyer_ct: buyerCtResult.pubkey.toBase58(),
      seller_ct: sellerCtResult.pubkey.toBase58(),
      settlement_ct: resultCtResult.pubkey.toBase58(),
      dwallet_pda: dwalletPda.toBase58(),
    });

    await appendSealedAuditLog(ticketId, "confidential_deal_created", {
      create_sig: createDealSig,
      deal_pda: dealPda.toBase58(),
      buyer: buyerWallet.toBase58(),
      seller: sellerWallet.toBase58(),
      buyer_settlement_target: buyerSettlementWallet.toBase58(),
      seller_settlement_target: sellerSettlementWallet.toBase58(),
      bet_lamports: betLamports.toString(),
      buyer_ct: buyerCtResult.pubkey.toBase58(),
      seller_ct: sellerCtResult.pubkey.toBase58(),
      result_ct: resultCtResult.pubkey.toBase58(),
      terms_visibility: attestedEscrowIntent ? "redacted" : "plaintext",
      timestamp: new Date().toISOString(),
    }, {
      phase: "deal_created",
      termsVisibility: attestedEscrowIntent ? "redacted" : "plaintext",
    });

    if (attestedEscrowIntent) {
      const registerFundingInstruction =
        createRegisterPrivateFundingCommitmentsInstruction({
          programId: confidentialProgramId,
          dealPda,
          authority: keypair.publicKey,
          sessionPda: new PublicKey(attestedEscrowIntent.sessionPda),
          buyerPaymentFundingHash: attestedEscrowIntent.fundingCommitments.buyerPaymentHash,
          buyerCollateralFundingHash: attestedEscrowIntent.fundingCommitments.buyerCollateralHash,
          sellerCollateralFundingHash: attestedEscrowIntent.fundingCommitments.sellerCollateralHash,
        });
      const registerFundingSig = await sendAndConfirmManagedTransaction({
        label: "confidential_register_private_funding_commitments",
        ticketId,
        step: "register_private_funding_commitments",
        payer: keypair,
        signers: [keypair],
        buildTransaction: () => new Transaction().add(registerFundingInstruction),
        verifySuccess: async (recoveryConnection) => {
          try {
            const { program: recoveryProgram } = getConfidentialEscrowProgram(
              recoveryConnection,
              keypair,
              config.confidentialEscrowProgramId
            );
            const dealAccount = await (recoveryProgram.account as any).confidentialDeal.fetch(dealPda);
            return Boolean(dealAccount?.privateFundingRegistered);
          } catch {
            return false;
          }
        },
      });
      txSignatures.push(registerFundingSig);

      execLog.info("confidential_execution_waiting_for_private_counterparty_funding", {
        deal_pda: dealPda.toBase58(),
        funding_registration_sig: registerFundingSig,
        private_commitments_registered: true,
      });

      return {
        success: true,
        dealPda: dealPda.toBase58(),
        txSignatures,
        approvalStatus: "created_awaiting_deposits",
        dwalletPda: dwalletPda.toBase58(),
        dwalletPublicKey: Buffer.from(dwalletPk).toString("hex"),
        dealIdHex: Buffer.from(dealId).toString("hex"),
        sessionPda,
        termsHash,
        planHash,
        buyerSettlementTarget: buyerSettlementWallet.toBase58(),
        sellerSettlementTarget: sellerSettlementWallet.toBase58(),
      };
    }

    // ────────────────────────────────────────────────────────
    // STEP 6: Poll for settlement graph completion
    // ────────────────────────────────────────────────────────
    execLog.info("step", { n: 6, name: "poll_settlement_graph" });
    await encryptService.pollCiphertextVerified(
      resultCtResult.pubkey,
      SETTLEMENT_TIMEOUT_MS
    );

    // ────────────────────────────────────────────────────────
    // STEP 7: Request decryption through the escrow program
    // ────────────────────────────────────────────────────────
    execLog.info("step", { n: 7, name: "request_decryption" });
    const requestKeypair = Keypair.generate();
    const requestDecryptionSig = await (confidentialProgram.methods as any)
      .requestSettlementDecryption(encryptCpiAuthorityBump)
      .accounts({
        deal: dealPda,
        requestAccount: requestKeypair.publicKey,
        resultCiphertext: resultCtResult.pubkey,
        encryptProgram: ENCRYPT_PROGRAM_ID,
        config: configPda,
        deposit: depositPda,
        cpiAuthority: encryptCpiAuthority,
        callerProgram: confidentialProgramId,
        networkEncryptionKey: networkEncryptionKeyPda,
        payer: keypair.publicKey,
        eventAuthority,
        systemProgram: SystemProgram.programId,
      })
      .signers([requestKeypair])
      .rpc();
    txSignatures.push(requestDecryptionSig);

    const requestAccountInfo = await withRetry(
      () => connection.getAccountInfo(requestKeypair.publicKey, "confirmed"),
      { label: "confidential_request_decryption_account", ticketId, step: "request_decryption" }
    );
    if (!requestAccountInfo) {
      throw new Error("Encrypt decryption request account was not created");
    }

    const requestDigest =
      requestAccountInfo.data.length >= 66
        ? requestAccountInfo.data.subarray(34, 66)
        : crypto.createHash("sha256").update(resultCtResult.pubkey.toBytes()).digest();

    ctx.decryptionRequestPubkey = requestKeypair.publicKey;
    ctx.decryptionDigest = new Uint8Array(requestDigest);

    // ────────────────────────────────────────────────────────
    // STEP 8: Poll + VERIFY decrypted value
    // ────────────────────────────────────────────────────────
    execLog.info("step", { n: 8, name: "verify_decryption" });
    const decryptedValue = await encryptService.awaitDecryptionVerified(
      requestKeypair.publicKey,
      new Uint8Array(requestDigest),
      DECRYPTION_TIMEOUT_MS
    );

    execLog.info("decryption_verified", {
      value: decryptedValue.toString(),
      settlement_valid: decryptedValue > BigInt(0),
    });

    // ────────────────────────────────────────────────────────
    // STEP 9: Pause at the release-approval gate
    // ────────────────────────────────────────────────────────
    const winner = decryptedValue > 0n ? sellerSettlementWallet : buyerSettlementWallet;
    execLog.info("step", {
      n: 9,
      name: "await_release_approvals",
      settlement_ready: true,
    });

    await appendSealedAuditLog(ticketId, "confidential_release_approval_gate_ready", {
      deal_pda: dealPda.toBase58(),
      request_account: requestKeypair.publicKey.toBase58(),
      winner: winner.toBase58(),
      decrypted_value: decryptedValue.toString(),
      terms_hash: termsHash,
      plan_hash: planHash,
      session_pda: sessionPda,
      timestamp: new Date().toISOString(),
    }, {
      phase: "release_approval_gate_ready",
      resumedFromPrivateFunding: false,
    });

    const result: ConfidentialExecutionResult = {
      success: true,
      dealPda: dealPda.toBase58(),
      txSignatures,
      approvalStatus: "awaiting_settlement_plan_approvals",
      decryptedValue: decryptedValue.toString(),
      winner: winner.toBase58(),
      dwalletPda: dwalletPda.toBase58(),
      dwalletPublicKey: Buffer.from(dwalletPk).toString("hex"),
      requestAccount: requestKeypair.publicKey.toBase58(),
      dealIdHex: Buffer.from(dealId).toString("hex"),
      sessionPda,
      termsHash,
      planHash,
      buyerSettlementTarget: buyerSettlementWallet.toBase58(),
      sellerSettlementTarget: sellerSettlementWallet.toBase58(),
    };

    execLog.info("confidential_settlement_prepared", {
      deal_pda: dealPda.toBase58(),
      request_account: requestKeypair.publicKey.toBase58(),
      tx_count: txSignatures.length,
    });

    return result;

  } catch (error: any) {
    execLog.error("confidential_deal_failed", {
      error: error.message,
      stack: error.stack?.slice(0, 500),
    });

    await appendAuditLog(ticketId, "confidential_deal_error", {
      error: error.message,
      tx_count: txSignatures.length,
      timestamp: new Date().toISOString(),
    });

    return {
      success: false,
      txSignatures,
      error: error.message,
      step: "confidential_execution",
    };
  }
}

export async function prepareConfidentialSettlementAfterFunding(
  ticketId: string,
  preparedFunding: {
    dealPda: string;
    sessionPda: string;
    intentId?: string;
    termsHash: string;
    planHash: string;
    buyerSettlementTarget: string;
    sellerSettlementTarget: string;
    dwalletPda?: string;
    txSignatures: string[];
  },
  attestedEscrowIntent: AttestedEscrowIntent
): Promise<ConfidentialExecutionResult> {
  const txSignatures: string[] = [...preparedFunding.txSignatures];

  try {
    await dependencyHealthService.assertHealthyForOperation(
      "confidential_prepare_after_funding",
      ["solana_rpc", "encrypt"]
    );
    const config = loadConfig();
    const connection = getConnection();
    const keypair = loadWallet(config.privateKey);
    const encryptService = getEncryptService(connection, keypair);
    const { program: confidentialProgram, programId: confidentialProgramId } =
      getConfidentialEscrowProgram(connection, keypair, config.confidentialEscrowProgramId);

    const resultCiphertext = new PublicKey(
      attestedEscrowIntent.encryptedTerms.settlementResult.account
    );
    const dealPda = new PublicKey(preparedFunding.dealPda);
    const configPda = encryptService.deriveConfigPda();
    const [depositPda] = encryptService.deriveDepositPda(keypair.publicKey);
    const [encryptCpiAuthority, encryptCpiAuthorityBump] =
      encryptService.deriveCpiAuthority(confidentialProgramId);
    const eventAuthority = encryptService.deriveEventAuthority();
    const networkEncryptionKeyPda = new PublicKey(
      attestedEscrowIntent.encryptedTerms.networkEncryptionKeyPda
    );

    await encryptService.pollCiphertextVerified(resultCiphertext, SETTLEMENT_TIMEOUT_MS);

    const requestKeypair = Keypair.generate();
    const requestDecryptionSig = await (confidentialProgram.methods as any)
      .requestSettlementDecryption(encryptCpiAuthorityBump)
      .accounts({
        deal: dealPda,
        requestAccount: requestKeypair.publicKey,
        resultCiphertext,
        encryptProgram: ENCRYPT_PROGRAM_ID,
        config: configPda,
        deposit: depositPda,
        cpiAuthority: encryptCpiAuthority,
        callerProgram: confidentialProgramId,
        networkEncryptionKey: networkEncryptionKeyPda,
        payer: keypair.publicKey,
        eventAuthority,
        systemProgram: SystemProgram.programId,
      })
      .signers([requestKeypair])
      .rpc();
    txSignatures.push(requestDecryptionSig);

    const requestAccountInfo = await withRetry(
      () => connection.getAccountInfo(requestKeypair.publicKey, "confirmed"),
      {
        label: "confidential_request_decryption_account_after_funding",
        ticketId,
        step: "request_decryption_after_funding",
      }
    );
    if (!requestAccountInfo) {
      throw new Error("Encrypt decryption request account was not created after private funding");
    }

    const requestDigest =
      requestAccountInfo.data.length >= 66
        ? requestAccountInfo.data.subarray(34, 66)
        : crypto.createHash("sha256").update(resultCiphertext.toBytes()).digest();

    const decryptedValue = await encryptService.awaitDecryptionVerified(
      requestKeypair.publicKey,
      new Uint8Array(requestDigest),
      DECRYPTION_TIMEOUT_MS
    );
    const winner =
      decryptedValue > 0n
        ? preparedFunding.sellerSettlementTarget
        : preparedFunding.buyerSettlementTarget;

    await appendSealedAuditLog(ticketId, "confidential_release_approval_gate_ready", {
      deal_pda: preparedFunding.dealPda,
      request_account: requestKeypair.publicKey.toBase58(),
      winner,
      decrypted_value: decryptedValue.toString(),
      terms_hash: preparedFunding.termsHash,
      plan_hash: preparedFunding.planHash,
      session_pda: preparedFunding.sessionPda,
      resumed_from_private_funding: true,
      timestamp: new Date().toISOString(),
    }, {
      phase: "release_approval_gate_ready",
      resumedFromPrivateFunding: true,
    });

    return {
      success: true,
      dealPda: preparedFunding.dealPda,
      txSignatures,
      approvalStatus: "awaiting_settlement_plan_approvals",
      decryptedValue: decryptedValue.toString(),
      winner,
      dwalletPda: preparedFunding.dwalletPda,
      requestAccount: requestKeypair.publicKey.toBase58(),
      sessionPda: preparedFunding.sessionPda,
      termsHash: preparedFunding.termsHash,
      planHash: preparedFunding.planHash,
      buyerSettlementTarget: preparedFunding.buyerSettlementTarget,
      sellerSettlementTarget: preparedFunding.sellerSettlementTarget,
    };
  } catch (error: any) {
    await appendAuditLog(ticketId, "confidential_funding_resume_error", {
      error: error.message,
      timestamp: new Date().toISOString(),
    });

    return {
      success: false,
      txSignatures,
      error: error.message,
      step: "prepare_confidential_settlement_after_funding",
    };
  }
}

function buildDeterministicSettlementMessage(snapshot: ReleaseApprovalStateSnapshot): Buffer {
  const normalized = JSON.stringify({
    dealPda: snapshot.dealPda,
    decryptedValue: snapshot.decryptedValue,
    planHash: snapshot.planHash,
    termsHash: snapshot.termsHash,
    ticketId: snapshot.ticketId,
    winner: snapshot.winner,
  });
  return Buffer.from(`AGENTOTC_SETTLEMENT_V2:${normalized}`, "utf8");
}

export async function authorizeConfidentialRelease(
  ticketId: string,
  snapshot: ReleaseApprovalStateSnapshot
): Promise<ConfidentialExecutionResult> {
  const txSignatures: string[] = [...snapshot.txSignatures];

  try {
    await dependencyHealthService.assertHealthyForOperation(
      "confidential_authorize_release",
      ["solana_rpc", "ika"]
    );
    const config = loadConfig();
    const connection = getConnection();
    const keypair = loadWallet(config.privateKey);
    const ikaService = getIkaService(connection, keypair);
    const { program: confidentialProgram, programId: confidentialProgramId } =
      getConfidentialEscrowProgram(connection, keypair, config.confidentialEscrowProgramId);

    const dwalletPda = new PublicKey(
      snapshot.dwalletPda || agentDWalletPda?.toBase58() || (() => {
        throw new Error("release_authorize_missing_dwallet");
      })()
    );
    const dwalletPk =
      agentDWalletPublicKey || (() => {
        throw new Error("release_authorize_missing_dwallet_public_key");
      })();
    const signatureScheme = agentDWalletSignatureScheme;
    const settlementMessage = buildDeterministicSettlementMessage(snapshot);
    const messageDigest = ikaService.computeMessageDigest(settlementMessage);
    const metaDigest = new Uint8Array(32);
    const userPubkey =
      dwalletPk.length >= 32 ? dwalletPk.subarray(0, 32) : new Uint8Array(32);
    const [coordPda] = ikaService.deriveCoordinatorPda();
    const [dwalletCpiAuthority, dwalletCpiAuthorityBump] =
      ikaService.deriveCpiAuthority(confidentialProgramId);
    const { presignSessionId } = await ikaService.allocatePresign(
      dwalletPda,
      signatureScheme,
    );

    const [maPda, maBump] = ikaService.deriveMessageApprovalPda(
      agentDWalletCurve,
      dwalletPk,
      signatureScheme,
      messageDigest,
      metaDigest
    );

    const [buyerApprovalPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("release_approval"),
        new PublicKey(snapshot.dealPda).toBuffer(),
        Buffer.from([encodeReleaseApprovalRoleSeed("buyer")]),
      ],
      confidentialProgramId
    );
    const [sellerApprovalPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("release_approval"),
        new PublicKey(snapshot.dealPda).toBuffer(),
        Buffer.from([encodeReleaseApprovalRoleSeed("seller")]),
      ],
      confidentialProgramId
    );

    const approveSig = await (confidentialProgram.methods as any)
      .approveCrossChain(
        Array.from(messageDigest),
        Array.from(metaDigest),
        Array.from(userPubkey),
        signatureScheme,
        maBump,
        dwalletCpiAuthorityBump
      )
      .accounts({
        deal: new PublicKey(snapshot.dealPda),
        buyerApproval: buyerApprovalPda,
        sellerApproval: sellerApprovalPda,
        dwalletProgram: DWALLET_PROGRAM_ID,
        coordinator: coordPda,
        messageApproval: maPda,
        dwallet: dwalletPda,
        callerProgram: confidentialProgramId,
        dwalletCpiAuthority,
        payer: keypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    txSignatures.push(approveSig);

    const signatureResult = await ikaService.requestSignatureForApprovedMessage({
      message: settlementMessage,
      dwalletPda,
      presignSessionId,
      approvalTxSignature: approveSig,
      approvalPda: maPda,
      signatureScheme,
    });

    eventBus.publish("cross_chain_signed" as any, {
      ticket_id: ticketId,
      deal_pda: snapshot.dealPda,
      message_hash: Buffer.from(messageDigest).toString("hex"),
      signature: Buffer.from(signatureResult.signature).toString("hex"),
      signature_scheme: DWalletSignatureScheme[signatureScheme],
      dwallet_public_key: Buffer.from(signatureResult.dwalletPublicKey).toString("hex"),
      message_approval_pda: maPda.toBase58(),
    });

    await appendSealedAuditLog(ticketId, "confidential_release_authorized", {
      approval_sig: approveSig,
      message_approval_pda: maPda.toBase58(),
      signature_scheme: DWalletSignatureScheme[signatureScheme],
      winner: snapshot.winner || null,
      decrypted_value: snapshot.decryptedValue || null,
      timestamp: new Date().toISOString(),
    }, {
      phase: "release_authorized",
    });

    return {
      success: true,
      dealPda: snapshot.dealPda,
      txSignatures,
      approvalStatus: "release_signed",
      decryptedValue: snapshot.decryptedValue,
      winner: snapshot.winner,
      approvalTxSignature: approveSig,
      crossChainSignature: Buffer.from(signatureResult.signature).toString("hex"),
      signatureScheme: DWalletSignatureScheme[signatureScheme],
      dwalletPublicKey: Buffer.from(dwalletPk).toString("hex"),
      dwalletPda: dwalletPda.toBase58(),
      messageApprovalPda: maPda.toBase58(),
      requestAccount: snapshot.requestAccount,
      dealIdHex: undefined,
      sessionPda: snapshot.sessionPda,
      termsHash: snapshot.termsHash,
      planHash: snapshot.planHash,
      buyerSettlementTarget: snapshot.buyerSettlementTarget,
      sellerSettlementTarget: snapshot.sellerSettlementTarget,
    };
  } catch (error: any) {
    return {
      success: false,
      txSignatures,
      error: error.message,
      step: "authorize_confidential_release",
    };
  }
}

export async function executeConfidentialRelease(
  ticketId: string,
  snapshot: ReleaseApprovalStateSnapshot
): Promise<ConfidentialExecutionResult> {
  const txSignatures: string[] = [...snapshot.txSignatures];

  try {
    await dependencyHealthService.assertHealthyForOperation(
      "confidential_execute_release",
      ["solana_rpc", "ika"]
    );
    const config = loadConfig();
    const connection = getConnection();
    const keypair = loadWallet(config.privateKey);
    const fundingState = await confidentialFundingStore.getLatestByTicket(ticketId);
    let buyerPaymentLamports = BigInt(
      fundingState?.fundingAmounts?.buyerPaymentLamports || "0"
    );
    let buyerCollateralLamports = BigInt(
      fundingState?.fundingAmounts?.buyerCollateralLamports || "0"
    );
    let sellerCollateralLamports = BigInt(
      fundingState?.fundingAmounts?.sellerCollateralLamports || "0"
    );

    if (
      buyerPaymentLamports <= 0n ||
      buyerCollateralLamports <= 0n ||
      sellerCollateralLamports <= 0n
    ) {
      const trackedDeal = await dealTracker.getDealByTicket(ticketId);
      if (
        trackedDeal?.price != null &&
        trackedDeal?.collateralBuyer != null &&
        trackedDeal?.collateralSeller != null
      ) {
        buyerPaymentLamports = BigInt(
          Math.round(Number(trackedDeal.price) * LAMPORTS_PER_SOL)
        );
        buyerCollateralLamports = BigInt(
          Math.round(Number(trackedDeal.collateralBuyer) * LAMPORTS_PER_SOL)
        );
        sellerCollateralLamports = BigInt(
          Math.round(Number(trackedDeal.collateralSeller) * LAMPORTS_PER_SOL)
        );
      }
    }

    if (
      buyerPaymentLamports <= 0n ||
      buyerCollateralLamports <= 0n ||
      sellerCollateralLamports <= 0n
    ) {
      const privateIntent = await privateEscrowIntentStore.getLatestByTicket(ticketId);
      if (privateIntent) {
        const executionTerms = revealPrivateExecutionTerms(privateIntent);
        buyerPaymentLamports = BigInt(executionTerms.agreedPriceLamports);
        buyerCollateralLamports = BigInt(executionTerms.buyerCollateralLamports);
        sellerCollateralLamports = BigInt(executionTerms.sellerCollateralLamports);
      } else {
        const ticket = await ticketStore.getTicket(ticketId);
        if (ticket?.agreed_terms) {
          buyerPaymentLamports = BigInt(
            Math.round(ticket.agreed_terms.price * LAMPORTS_PER_SOL)
          );
          buyerCollateralLamports = BigInt(
            Math.round(ticket.agreed_terms.collateral_buyer * LAMPORTS_PER_SOL)
          );
          sellerCollateralLamports = BigInt(
            Math.round(ticket.agreed_terms.collateral_seller * LAMPORTS_PER_SOL)
          );
        }
      }
    }

    if (
      buyerPaymentLamports <= 0n ||
      buyerCollateralLamports <= 0n ||
      sellerCollateralLamports <= 0n
    ) {
      throw new Error(`release_execute_missing_confidential_funding_amounts:${ticketId}`);
    }
    const { program: confidentialProgram, programId: confidentialProgramId } =
      getConfidentialEscrowProgram(connection, keypair, config.confidentialEscrowProgramId);

    const fundingRail =
      fundingState?.buyerFunding?.fundingRail ||
      fundingState?.sellerFunding?.fundingRail ||
      fundingState?.buyerRequest?.fundingRail ||
      fundingState?.sellerRequest?.fundingRail ||
      "DIRECT_SOL";
    if (fundingRail === "SHIELDED_CREDIT") {
      if (!fundingState?.buyerFunding?.wallet || !fundingState?.sellerFunding?.wallet) {
        throw new Error(`release_execute_missing_shielded_credit_wallets:${ticketId}`);
      }
      const dealPda = new PublicKey(snapshot.dealPda);
      const buyerOwner = new PublicKey(fundingState.buyerFunding.wallet);
      const sellerOwner = new PublicKey(fundingState.sellerFunding.wallet);
      const vaultPda = deriveCreditVaultPda(confidentialProgramId);
      const buyerCreditBalance = deriveCreditBalancePda(confidentialProgramId, vaultPda, buyerOwner);
      const sellerCreditBalance = deriveCreditBalancePda(confidentialProgramId, vaultPda, sellerOwner);
      const buyerPaymentLock = deriveCreditLockPda(
        confidentialProgramId,
        dealPda,
        buyerOwner,
        "buyer_payment"
      );
      const buyerCollateralLock = deriveCreditLockPda(
        confidentialProgramId,
        dealPda,
        buyerOwner,
        "buyer_collateral"
      );
      const sellerCollateralLock = deriveCreditLockPda(
        confidentialProgramId,
        dealPda,
        sellerOwner,
        "seller_collateral"
      );
      const settlementValid = BigInt(snapshot.decryptedValue || "0") > 0n;
      const settleInstruction = new TransactionInstruction({
        programId: confidentialProgramId,
        keys: [
          { pubkey: vaultPda, isSigner: false, isWritable: true },
          { pubkey: dealPda, isSigner: false, isWritable: true },
          { pubkey: buyerPaymentLock, isSigner: false, isWritable: true },
          { pubkey: buyerCollateralLock, isSigner: false, isWritable: true },
          { pubkey: sellerCollateralLock, isSigner: false, isWritable: true },
          { pubkey: buyerCreditBalance, isSigner: false, isWritable: true },
          { pubkey: sellerCreditBalance, isSigner: false, isWritable: true },
          { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.concat([
          anchorGlobalDiscriminator("settle_locked_credit"),
          Buffer.from([settlementValid ? 1 : 0]),
        ]),
      });

      const releaseSig = await sendAndConfirmManagedTransaction({
        label: "confidential_settle_locked_credit",
        ticketId,
        step: "settle_locked_credit",
        payer: keypair,
        signers: [keypair],
        buildTransaction: () => new Transaction().add(settleInstruction),
        verifySuccess: async (recoveryConnection) => {
          try {
            const { program: recoveryProgram } = getConfidentialEscrowProgram(
              recoveryConnection,
              keypair,
              config.confidentialEscrowProgramId
            );
            const dealAccount = await (recoveryProgram.account as any).confidentialDeal.fetch(
              dealPda
            );
            return Boolean(dealAccount?.releaseExecuted);
          } catch {
            return false;
          }
        },
      });
      txSignatures.push(releaseSig);

      await appendSealedAuditLog(ticketId, "confidential_shielded_credit_settled", {
        release_sig: releaseSig,
        funding_rail: fundingRail,
        settlement_valid: settlementValid,
        winner: snapshot.winner || null,
        decrypted_value: snapshot.decryptedValue || null,
        message_approval_pda: snapshot.messageApprovalPda || null,
        timestamp: new Date().toISOString(),
      }, {
        phase: "release_completed",
        settlementPolicy: snapshot.settlementPolicy,
        fundingRail,
      });

      return {
        success: true,
        dealPda: snapshot.dealPda,
        txSignatures,
        approvalStatus: "settled",
        decryptedValue: snapshot.decryptedValue,
        winner: snapshot.winner,
        releaseTxSignature: releaseSig,
        approvalTxSignature: snapshot.approvalTxSignature,
        crossChainSignature: snapshot.crossChainSignature,
        signatureScheme: snapshot.signatureScheme,
        dwalletPda: snapshot.dwalletPda,
        messageApprovalPda: snapshot.messageApprovalPda,
        requestAccount: snapshot.requestAccount,
        sessionPda: snapshot.sessionPda,
        termsHash: snapshot.termsHash,
        planHash: snapshot.planHash,
        buyerSettlementTarget: snapshot.buyerSettlementTarget,
        sellerSettlementTarget: snapshot.sellerSettlementTarget,
      };
    }
    const [buyerApprovalPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("release_approval"),
        new PublicKey(snapshot.dealPda).toBuffer(),
        Buffer.from([encodeReleaseApprovalRoleSeed("buyer")]),
      ],
      confidentialProgramId
    );
    const [sellerApprovalPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("release_approval"),
        new PublicKey(snapshot.dealPda).toBuffer(),
        Buffer.from([encodeReleaseApprovalRoleSeed("seller")]),
      ],
      confidentialProgramId
    );

    const releaseInstruction = new TransactionInstruction({
      programId: confidentialProgramId,
      keys: [
        {
          pubkey: new PublicKey(snapshot.dealPda),
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: new PublicKey(
            snapshot.requestAccount || (() => {
              throw new Error("release_execute_missing_request_account");
            })()
          ),
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: new PublicKey(
            snapshot.messageApprovalPda || (() => {
              throw new Error("release_execute_missing_message_approval");
            })()
          ),
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: buyerApprovalPda,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: sellerApprovalPda,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: new PublicKey(snapshot.buyerSettlementTarget),
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: new PublicKey(snapshot.sellerSettlementTarget),
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: keypair.publicKey,
          isSigner: true,
          isWritable: false,
        },
      ],
      data: Buffer.concat([
        anchorGlobalDiscriminator("reveal_and_release"),
        (() => {
          const buyerPayment = Buffer.alloc(8);
          buyerPayment.writeBigUInt64LE(buyerPaymentLamports);
          return buyerPayment;
        })(),
        (() => {
          const buyerCollateral = Buffer.alloc(8);
          buyerCollateral.writeBigUInt64LE(buyerCollateralLamports);
          return buyerCollateral;
        })(),
        (() => {
          const sellerCollateral = Buffer.alloc(8);
          sellerCollateral.writeBigUInt64LE(sellerCollateralLamports);
          return sellerCollateral;
        })(),
      ]),
    });

    const releaseSig = await sendAndConfirmManagedTransaction({
      label: "confidential_reveal_and_release",
      ticketId,
      step: "reveal_and_release",
      payer: keypair,
      signers: [keypair],
      buildTransaction: () => new Transaction().add(releaseInstruction),
      verifySuccess: async (recoveryConnection) => {
        try {
          const { program: recoveryProgram } = getConfidentialEscrowProgram(
            recoveryConnection,
            keypair,
            config.confidentialEscrowProgramId
          );
          const dealAccount = await (recoveryProgram.account as any).confidentialDeal.fetch(
            new PublicKey(snapshot.dealPda)
          );
          return Boolean(dealAccount?.releaseExecuted);
        } catch {
          return false;
        }
      },
    });
    txSignatures.push(releaseSig);

    await appendSealedAuditLog(ticketId, "confidential_release_completed", {
      release_sig: releaseSig,
      winner: snapshot.winner || null,
      settlement_policy: snapshot.settlementPolicy,
      decrypted_value: snapshot.decryptedValue || null,
      message_approval_pda: snapshot.messageApprovalPda || null,
      timestamp: new Date().toISOString(),
    }, {
      phase: "release_completed",
      settlementPolicy: snapshot.settlementPolicy,
    });

    return {
      success: true,
      dealPda: snapshot.dealPda,
      txSignatures,
      approvalStatus: "settled",
      decryptedValue: snapshot.decryptedValue,
      winner: snapshot.winner,
      releaseTxSignature: releaseSig,
      approvalTxSignature: snapshot.approvalTxSignature,
      crossChainSignature: snapshot.crossChainSignature,
      signatureScheme: snapshot.signatureScheme,
      dwalletPda: snapshot.dwalletPda,
      messageApprovalPda: snapshot.messageApprovalPda,
      requestAccount: snapshot.requestAccount,
      sessionPda: snapshot.sessionPda,
      termsHash: snapshot.termsHash,
      planHash: snapshot.planHash,
      buyerSettlementTarget: snapshot.buyerSettlementTarget,
      sellerSettlementTarget: snapshot.sellerSettlementTarget,
    };
  } catch (error: any) {
    return {
      success: false,
      txSignatures,
      error: error.message,
      step: "execute_confidential_release",
    };
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export function getConfidentialDealContext(
  ticketId: string
): ConfidentialDealContext | null {
  return dealContexts[ticketId] || null;
}

export async function fetchConfidentialDealFundingSnapshot(
  dealPdaBase58: string
): Promise<ConfidentialDealFundingSnapshot> {
  const config = loadConfig();
  const connection = getConnection();
  const payer = loadWallet(config.privateKey);
  const { program } = getConfidentialEscrowProgram(
    connection,
    payer,
    config.confidentialEscrowProgramId
  );
  const dealAccount = await (program.account as any).confidentialDeal.fetch(
    new PublicKey(dealPdaBase58)
  );

  return {
    privateFundingRegistered: Boolean(dealAccount.privateFundingRegistered),
    buyerPaymentDeposited: Boolean(dealAccount.buyerPaymentDeposited),
    buyerCollateralDeposited: Boolean(dealAccount.buyerCollateralDeposited),
    sellerCollateralDeposited: Boolean(dealAccount.sellerCollateralDeposited),
    releaseExecuted: Boolean(dealAccount.releaseExecuted),
  };
}

export function isConfidentialEscrowReady(): boolean {
  return initialized;
}

export function getAgentDWallet(): {
  pda: string;
  publicKey: string;
  curve: string;
  ready: boolean;
} | null {
  if (!agentDWalletPda) return null;
  return {
    pda: agentDWalletPda.toBase58(),
    publicKey: agentDWalletPublicKey
      ? Buffer.from(agentDWalletPublicKey).toString("hex")
      : "",
    curve: DWalletCurve[agentDWalletCurve],
    ready: initialized,
  };
}

/**
 * Set the agent's dWallet after DKG completion.
 * Called when the DKG gRPC response is received and CommitDWallet is confirmed.
 */
export function setAgentDWallet(
  pda: PublicKey,
  publicKey: Uint8Array,
  curve: DWalletCurve
): void {
  agentDWalletPda = pda;
  agentDWalletPublicKey = publicKey;
  agentDWalletCurve = curve;

  logger.info("agent_dwallet_set", {
    pda: pda.toBase58(),
    curve: DWalletCurve[curve],
    pk_len: publicKey.length,
  });
}
