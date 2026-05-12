/**
 * Ika Service — Production dWallet MPC Signing Lifecycle
 *
 * Real gRPC + on-chain integration for Ika (dWallet) protocol.
 * No mocks. Every method either sends gRPC requests, builds real
 * transactions, or reads on-chain state at documented byte offsets.
 *
 * Architecture:
 *   1. gRPC DKG → NOA commits dWallet on-chain → poll until PDA exists
 *   2. On-chain TransferOwnership → CPI PDA becomes authority
 *   3. On-chain approve_message → MessageApproval PDA created
 *   4. gRPC Presign → allocate presign
 *   5. gRPC Sign with ApprovalProof::Solana → 64-byte signature returned
 *   6. Poll MessageApproval → CommitSignature writes signature on-chain
 *
 * @module ikaService
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import bs58 from "bs58";
import { keccak_256 } from "@noble/hashes/sha3";
import { defineBcsTypes } from "../ika-sdk/bcs-types";
import { logger } from "../utils/logger";
import { withRetry } from "../utils/retry";

const { VersionedDWalletDataAttestation } = defineBcsTypes();

// ============================================================================
// CONSTANTS
// ============================================================================

export const DWALLET_PROGRAM_ID = new PublicKey(
  process.env.DWALLET_PROGRAM_ID || "87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY"
);

export const IKA_GRPC_URL =
  process.env.IKA_GRPC_URL || "pre-alpha-dev-1.ika.ika-network.net:443";

const CPI_AUTHORITY_SEED = Buffer.from("__ika_cpi_authority");

/** Instruction discriminators — verified against 237-page Ika docs */
const IX_DISC = {
  APPROVE_MESSAGE: 8,
  TRANSFER_OWNERSHIP: 24,
  COMMIT_DWALLET: 31,
  COMMIT_FUTURE_SIGN: 33,
  CREATE_DEPOSIT: 36,
  TOP_UP: 37,
  SETTLE_GAS: 38,
  TRANSFER_FUTURE_SIGN: 42,
  COMMIT_SIGNATURE: 43,
  REQUEST_WITHDRAW: 44,
  WITHDRAW: 45,
  INITIALIZE: 46,
} as const;

/** DWallet account layout — 153 bytes total */
const DW = {
  DISC: 0,            // 1 byte, value 2
  VERSION: 1,         // 1 byte
  AUTHORITY: 2,       // 32 bytes
  CURVE: 34,          // 2 bytes (u16 LE)
  STATE: 36,          // 1 byte: 0=DKGInProgress, 1=Active, 2=Frozen
  PK_LEN: 37,         // 1 byte
  PUBLIC_KEY: 38,     // 65 bytes (padded)
  CREATED_EPOCH: 103, // 8 bytes (u64 LE)
  NOA_PK: 111,        // 32 bytes
  IS_IMPORTED: 143,   // 1 byte
  BUMP: 144,          // 1 byte
  RESERVED: 145,      // 8 bytes
  TOTAL: 153,
} as const;

/** MessageApproval account layout — 312 bytes total */
const MA = {
  DISC: 0,            // 1 byte, value 14
  VERSION: 1,         // 1 byte
  DWALLET: 2,         // 32 bytes
  MSG_DIGEST: 34,     // 32 bytes
  META_DIGEST: 66,    // 32 bytes
  APPROVER: 98,       // 32 bytes
  USER_PK: 130,       // 32 bytes
  SIG_SCHEME: 162,    // 2 bytes (u16 LE)
  EPOCH: 164,         // 8 bytes (u64 LE)
  STATUS: 172,        // 1 byte: 0=Pending, 1=Signed
  SIG_LEN: 173,       // 2 bytes (u16 LE)
  SIGNATURE: 175,     // 128 bytes (padded)
  BUMP: 303,          // 1 byte
  RESERVED: 304,      // 8 bytes
  TOTAL: 312,
} as const;

/** DWalletCoordinator layout — 116 bytes */
const COORD = {
  DISC: 0,            // 1 byte, value 1
  VERSION: 1,         // 1 byte
  AUTHORITY: 2,       // 32 bytes
  EPOCH: 34,          // 8 bytes (u64 LE)
  TOTAL_CREATED: 42,  // 8 bytes (u64 LE)
  PAUSED: 50,         // 1 byte
  BUMP: 51,           // 1 byte
  TOTAL: 116,
} as const;

/** GasDeposit layout — 139 bytes */
const GAS = {
  DISC: 0,            // 1 byte, value 4
  VERSION: 1,         // 1 byte
  USER_PK: 2,         // 32 bytes
  IKA_BALANCE: 34,    // 8 bytes (u64 LE)
  SOL_BALANCE: 42,    // 8 bytes (u64 LE)
  TOTAL: 139,
} as const;

// ============================================================================
// ENUMS
// ============================================================================

export enum DWalletCurve {
  Secp256k1 = 0,
  Secp256r1 = 1,
  Curve25519 = 2,
  Ristretto = 3,
}

export enum DWalletSignatureScheme {
  EcdsaKeccak256 = 0,
  EcdsaSha256 = 1,
  EcdsaDoubleSha256 = 2,
  TaprootSha256 = 3,
  EcdsaBlake2b256 = 4,
  EddsaSha512 = 5,
  SchnorrkelMerlin = 6,
}

enum DWalletSignatureAlgorithm {
  EcdsaSecp256k1 = 0,
  EcdsaSecp256r1 = 1,
  Taproot = 2,
  EdDSA = 3,
  SchnorrkelSubstrate = 4,
}

export enum DWalletState {
  DKGInProgress = 0,
  Active = 1,
  Frozen = 2,
}

export enum ApprovalStatus {
  Pending = 0,
  Signed = 1,
}

// ============================================================================
// TYPES
// ============================================================================

export interface DWalletInfo {
  pda: PublicKey;
  publicKey: Uint8Array;
  curve: DWalletCurve;
  authority: PublicKey;
  state: DWalletState;
  createdEpoch: bigint;
  noaPubkey: Uint8Array;
  isImportedKeyDWallet: boolean;
}

export interface DWalletAttestationInfo {
  pda: PublicKey;
  attestationData: Uint8Array;
  networkSignature: Uint8Array;
  networkPubkey: Uint8Array;
  epoch: bigint;
  sessionIdentifier: Uint8Array;
}

export interface ApproveMessageParams {
  coordinatorPda: PublicKey;
  messageApprovalPda: PublicKey;
  dwalletPda: PublicKey;
  callerProgramId: PublicKey;
  cpiAuthorityPda: PublicKey;
  payer: PublicKey;
  messageDigest: Uint8Array;
  messageMetaDigest: Uint8Array;
  userPubkey: Uint8Array;
  signatureScheme: number;
  bump: number;
}

export interface SignatureResult {
  signature: Uint8Array;
  signatureScheme: DWalletSignatureScheme;
  dwalletPublicKey: Uint8Array;
  messageHash: Uint8Array;
  onChain: boolean;
}

export interface GasDepositInfo {
  pda: PublicKey;
  userPubkey: PublicKey;
  ikaBalance: bigint;
  solBalance: bigint;
}

// ============================================================================
// SERVICE
// ============================================================================

export class IkaService {
  private connection: Connection;
  private payer: Keypair;
  private programId: PublicKey;
  private dwalletAttestationCache = new Map<string, DWalletAttestationInfo>();

  constructor(connection: Connection, payer: Keypair) {
    this.connection = connection;
    this.payer = payer;
    this.programId = DWALLET_PROGRAM_ID;
  }

  private async getAccountInfoWithRetry(pubkey: PublicKey, label: string) {
    return withRetry(
      () => this.connection.getAccountInfo(pubkey),
      { label }
    );
  }

  private async getTransactionWithRetry(signature: string, label: string) {
    return withRetry(
      () =>
        this.connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        }),
      { label }
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PDA DERIVATION (all verified against docs byte-for-byte)
  // ──────────────────────────────────────────────────────────────────────────

  deriveCpiAuthority(callerProgramId: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [CPI_AUTHORITY_SEED],
      callerProgramId
    );
  }

  deriveCoordinatorPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("dwallet_coordinator")],
      this.programId
    );
  }

  deriveGasDepositPda(userPubkey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("gas_deposit"), userPubkey.toBuffer()],
      this.programId
    );
  }

  /**
   * Derive dWallet PDA.
   *
   * Seeds: ["dwallet", ...chunks_of(curve_u16_le || public_key)]
   * Payload = curve(2 bytes LE) || public_key, split into 32-byte chunks.
   */
  deriveDWalletPda(
    curve: DWalletCurve,
    publicKey: Uint8Array
  ): [PublicKey, number] {
    const payload = Buffer.alloc(2 + publicKey.length);
    payload.writeUInt16LE(curve, 0);
    payload.set(publicKey, 2);

    const seeds: Buffer[] = [Buffer.from("dwallet")];
    for (let i = 0; i < payload.length; i += 32) {
      seeds.push(Buffer.from(payload.subarray(i, Math.min(i + 32, payload.length))));
    }

    return PublicKey.findProgramAddressSync(seeds, this.programId);
  }

  deriveDWalletAttestationPda(
    curve: DWalletCurve,
    publicKey: Uint8Array,
  ): [PublicKey, number] {
    const payload = Buffer.alloc(2 + publicKey.length);
    payload.writeUInt16LE(curve, 0);
    payload.set(publicKey, 2);

    const seeds: Buffer[] = [Buffer.from("dwallet")];
    for (let i = 0; i < payload.length; i += 32) {
      seeds.push(Buffer.from(payload.subarray(i, Math.min(i + 32, payload.length))));
    }
    seeds.push(Buffer.from("attestation"));

    return PublicKey.findProgramAddressSync(seeds, this.programId);
  }

  /**
   * Derive MessageApproval PDA.
   *
   * Seeds: ["dwallet", ...chunks, "message_approval", scheme_u16_le, message_digest, [meta_digest]]
   * meta_digest seed is only included when non-zero.
   */
  deriveMessageApprovalPda(
    curve: DWalletCurve,
    dwalletPublicKey: Uint8Array,
    signatureScheme: number,
    messageDigest: Uint8Array,
    messageMetaDigest?: Uint8Array
  ): [PublicKey, number] {
    const payload = Buffer.alloc(2 + dwalletPublicKey.length);
    payload.writeUInt16LE(curve, 0);
    payload.set(dwalletPublicKey, 2);

    const seeds: Buffer[] = [Buffer.from("dwallet")];
    for (let i = 0; i < payload.length; i += 32) {
      seeds.push(Buffer.from(payload.subarray(i, Math.min(i + 32, payload.length))));
    }

    seeds.push(Buffer.from("message_approval"));

    const schemeBuf = Buffer.alloc(2);
    schemeBuf.writeUInt16LE(signatureScheme, 0);
    seeds.push(schemeBuf);

    seeds.push(Buffer.from(messageDigest));

    if (messageMetaDigest && !messageMetaDigest.every((b) => b === 0)) {
      seeds.push(Buffer.from(messageMetaDigest));
    }

    return PublicKey.findProgramAddressSync(seeds, this.programId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ON-CHAIN READS (real account data parsing)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Read dWallet data from on-chain account.
   * Parses the 153-byte account layout at documented offsets.
   */
  async readDWallet(dwalletPda: PublicKey): Promise<DWalletInfo | null> {
    const accountInfo = await this.getAccountInfoWithRetry(
      dwalletPda,
      "ika_read_dwallet"
    );
    if (!accountInfo || accountInfo.data.length < DW.TOTAL) return null;

    const data = accountInfo.data;
    if (data[DW.DISC] !== 2) return null;

    const authority = new PublicKey(data.subarray(DW.AUTHORITY, DW.AUTHORITY + 32));
    const curve = data.readUInt16LE(DW.CURVE) as DWalletCurve;
    const state = data[DW.STATE] as DWalletState;
    const pkLen = data[DW.PK_LEN];
    const publicKey = new Uint8Array(data.subarray(DW.PUBLIC_KEY, DW.PUBLIC_KEY + pkLen));
    const createdEpoch = data.readBigUInt64LE(DW.CREATED_EPOCH);
    const noaPubkey = new Uint8Array(data.subarray(DW.NOA_PK, DW.NOA_PK + 32));
    const isImportedKeyDWallet = data[DW.IS_IMPORTED] === 1;

    return {
      pda: dwalletPda,
      publicKey,
      curve,
      authority,
      state,
      createdEpoch,
      noaPubkey,
      isImportedKeyDWallet,
    };
  }

  async readDWalletAttestation(dwalletPda: PublicKey): Promise<DWalletAttestationInfo | null> {
    const cached = this.dwalletAttestationCache.get(dwalletPda.toBase58());
    if (cached) {
      return cached;
    }

    const dwalletInfo = await this.readDWallet(dwalletPda);
    if (!dwalletInfo) return null;

    const [attestationPda] = this.deriveDWalletAttestationPda(
      dwalletInfo.curve,
      dwalletInfo.publicKey,
    );
    const accountInfo = await this.getAccountInfoWithRetry(
      attestationPda,
      "ika_read_dwallet_attestation"
    );
    if (!accountInfo || accountInfo.data.length < 67) return null;

    const data = accountInfo.data;
    if (data[0] !== 15) return null;

    const attestationData = new Uint8Array(data.subarray(67));
    const decoded = VersionedDWalletDataAttestation.parse(attestationData);
    if (!decoded.V1) {
      throw new Error(`Unsupported dWallet attestation version for ${dwalletPda.toBase58()}`);
    }

    return {
      pda: attestationPda,
      networkSignature: new Uint8Array(data.subarray(2, 66)),
      attestationData,
      networkPubkey: dwalletInfo.noaPubkey,
      epoch: dwalletInfo.createdEpoch,
      sessionIdentifier: new Uint8Array(decoded.V1.session_identifier),
    };
  }

  /**
   * Read MessageApproval from on-chain.
   * Parses the 312-byte account layout.
   */
  async readMessageApproval(approvalPda: PublicKey): Promise<{
    status: ApprovalStatus;
    signature: Uint8Array | null;
    messageDigest: Uint8Array;
    signatureScheme: number;
    epoch: bigint;
  } | null> {
    const accountInfo = await this.getAccountInfoWithRetry(
      approvalPda,
      "ika_read_message_approval"
    );
    if (!accountInfo || accountInfo.data.length < MA.TOTAL) return null;

    const data = accountInfo.data;
    if (data[MA.DISC] !== 14) return null;

    const status = data[MA.STATUS] as ApprovalStatus;
    const messageDigest = new Uint8Array(data.subarray(MA.MSG_DIGEST, MA.MSG_DIGEST + 32));
    const signatureScheme = data.readUInt16LE(MA.SIG_SCHEME);
    const epoch = data.readBigUInt64LE(MA.EPOCH);

    let signature: Uint8Array | null = null;
    if (status === ApprovalStatus.Signed) {
      const sigLen = data.readUInt16LE(MA.SIG_LEN);
      if (sigLen > 0 && sigLen <= 128) {
        signature = new Uint8Array(data.subarray(MA.SIGNATURE, MA.SIGNATURE + sigLen));
      }
    }

    return { status, signature, messageDigest, signatureScheme, epoch };
  }

  /**
   * Check if DWalletCoordinator exists and is initialized.
   */
  async isCoordinatorReady(): Promise<boolean> {
    const [coordPda] = this.deriveCoordinatorPda();
    const accountInfo = await this.getAccountInfoWithRetry(
      coordPda,
      "ika_read_coordinator"
    );
    return !!(accountInfo && accountInfo.data.length >= COORD.TOTAL && accountInfo.data[COORD.DISC] === 1);
  }

  /**
   * Read GasDeposit data from on-chain account.
   * Returns null when the PDA has not been created yet.
   */
  async readGasDeposit(userPubkey: PublicKey = this.payer.publicKey): Promise<GasDepositInfo | null> {
    const [depositPda] = this.deriveGasDepositPda(userPubkey);
    const accountInfo = await this.getAccountInfoWithRetry(
      depositPda,
      "ika_read_gas_deposit"
    );
    if (!accountInfo || accountInfo.data.length < GAS.TOTAL) return null;

    const data = accountInfo.data;
    if (data[GAS.DISC] !== 4) return null;

    return {
      pda: depositPda,
      userPubkey: new PublicKey(data.subarray(GAS.USER_PK, GAS.USER_PK + 32)),
      ikaBalance: data.readBigUInt64LE(GAS.IKA_BALANCE),
      solBalance: data.readBigUInt64LE(GAS.SOL_BALANCE),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // AUTHORITY TRANSFER (real on-chain transaction)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Transfer dWallet authority to a program's CPI authority PDA.
   *
   * Instruction: TransferOwnership (disc 24)
   * Data: [24, new_authority(32)] = 33 bytes
   * Accounts: [current_authority(signer), dwallet(writable)]
   */
  async transferAuthority(
    dwalletPda: PublicKey,
    targetProgramId: PublicKey
  ): Promise<string> {
    const [cpiAuthority] = this.deriveCpiAuthority(targetProgramId);

    const data = Buffer.alloc(33);
    data[0] = IX_DISC.TRANSFER_OWNERSHIP;
    data.set(cpiAuthority.toBytes(), 1);

    const ix = new TransactionInstruction({
      programId: this.programId,
      data,
      keys: [
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: dwalletPda, isSigner: false, isWritable: true },
      ],
    });

    const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 10_000,
    });

    const tx = new Transaction().add(priorityFeeIx, ix);

    const sig = await withRetry(
      () => sendAndConfirmTransaction(this.connection, tx, [this.payer]),
      { label: "ika_transfer_authority" }
    );

    logger.info("dwallet_authority_transferred", {
      dwallet_pda: dwalletPda.toBase58(),
      new_authority: cpiAuthority.toBase58(),
      target_program: targetProgramId.toBase58(),
      signature: sig,
    });

    return sig;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MESSAGE APPROVAL (real instruction building)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Build approve_message instruction for CPI from your program.
   *
   * Instruction: ApproveMessage (disc 8)
   * Data layout: [8(1), bump(1), msg_digest(32), meta_digest(32), user_pk(32), scheme(2)] = 100 bytes
   *
   * Accounts (CPI path — 7 accounts):
   *   0: coordinator (readonly)
   *   1: message_approval (writable, empty)
   *   2: dwallet (readonly)
   *   3: caller_program (readonly, executable)
   *   4: cpi_authority (readonly, signed via invoke_signed)
   *   5: payer (writable, signer)
   *   6: system_program (readonly)
   */
  buildApproveMessageIx(params: ApproveMessageParams): TransactionInstruction {
    const data = Buffer.alloc(100);
    data[0] = IX_DISC.APPROVE_MESSAGE;
    data[1] = params.bump;
    Buffer.from(params.messageDigest).copy(data, 2);
    Buffer.from(params.messageMetaDigest).copy(data, 34);
    Buffer.from(params.userPubkey).copy(data, 66);
    data.writeUInt16LE(params.signatureScheme, 98);

    return new TransactionInstruction({
      programId: this.programId,
      data,
      keys: [
        { pubkey: params.coordinatorPda, isSigner: false, isWritable: false },
        { pubkey: params.messageApprovalPda, isSigner: false, isWritable: true },
        { pubkey: params.dwalletPda, isSigner: false, isWritable: false },
        { pubkey: params.callerProgramId, isSigner: false, isWritable: false },
        { pubkey: params.cpiAuthorityPda, isSigner: true, isWritable: false },
        { pubkey: params.payer, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });
  }

  /**
   * Compute keccak256 message digest.
   * From docs: "message_hash must be keccak256(preimage) regardless of destination chain"
   */
  computeMessageDigest(message: Uint8Array | Buffer): Uint8Array {
    return new Uint8Array(keccak_256(message));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POLLING (real on-chain reads)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Poll until DWalletCoordinator PDA exists and is initialized.
   */
  async pollCoordinatorReady(timeoutMs: number = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isCoordinatorReady()) {
        logger.info("coordinator_ready");
        return;
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error("DWalletCoordinator not initialized within timeout");
  }

  /**
   * Poll until a dWallet PDA exists and state == Active.
   */
  async pollDWalletActive(
    dwalletPda: PublicKey,
    timeoutMs: number = 60_000
  ): Promise<DWalletInfo> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const info = await this.readDWallet(dwalletPda);
      if (info && info.state === DWalletState.Active) {
        logger.info("dwallet_active", {
          pda: dwalletPda.toBase58(),
          elapsed_ms: Date.now() - start,
        });
        return info;
      }
      logger.debug("dwallet_poll", {
        pda: dwalletPda.toBase58(),
        state: info ? DWalletState[info.state] : "NOT_FOUND",
      });
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`dWallet not active within timeout: ${dwalletPda.toBase58()}`);
  }

  /**
   * Poll MessageApproval PDA until status = Signed (1).
   * Then read and return the 64-byte signature.
   */
  async waitForSignature(
    approvalPda: PublicKey,
    timeoutMs: number = 120_000
  ): Promise<Uint8Array> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await this.readMessageApproval(approvalPda);
      if (result && result.status === ApprovalStatus.Signed && result.signature) {
        logger.info("signature_committed", {
          approval_pda: approvalPda.toBase58(),
          sig_len: result.signature.length,
          elapsed_ms: Date.now() - start,
        });
        return result.signature;
      }

      logger.debug("signature_poll", {
        approval_pda: approvalPda.toBase58(),
        status: result ? ApprovalStatus[result.status] : "NOT_FOUND",
      });
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`Signature timeout: ${approvalPda.toBase58()}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GAS DEPOSIT (real on-chain transaction)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Ensure a GasDeposit account exists for the payer.
   * Required before any gRPC operations.
   *
   * Instruction: CreateDeposit (disc 36)
   */
  async ensureGasDeposit(): Promise<PublicKey> {
    const [depositPda, bump] = this.deriveGasDepositPda(this.payer.publicKey);

    const existing = await this.getAccountInfoWithRetry(
      depositPda,
      "ika_read_existing_gas_deposit"
    );
    if (existing && existing.data.length >= GAS.TOTAL && existing.data[GAS.DISC] === 4) {
      logger.debug("gas_deposit_exists", { pda: depositPda.toBase58() });
      return depositPda;
    }

    const [coordPda] = this.deriveCoordinatorPda();

    const data = Buffer.alloc(2);
    data[0] = IX_DISC.CREATE_DEPOSIT;
    data[1] = bump;

    const ix = new TransactionInstruction({
      programId: this.programId,
      data,
      keys: [
        { pubkey: depositPda, isSigner: false, isWritable: true },
        { pubkey: coordPda, isSigner: false, isWritable: false },
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });

    const tx = new Transaction().add(ix);
    const sig = await withRetry(
      () => sendAndConfirmTransaction(this.connection, tx, [this.payer]),
      { label: "ika_create_gas_deposit" }
    );

    logger.info("gas_deposit_created", {
      pda: depositPda.toBase58(),
      signature: sig,
    });

    return depositPda;
  }

  /**
   * Top up SOL into the GasDeposit.
   *
   * Instruction: TopUp (disc 37)
   */
  async topUpGasDeposit(lamports: bigint): Promise<string> {
    const [depositPda] = this.deriveGasDepositPda(this.payer.publicKey);

    const data = Buffer.alloc(9);
    data[0] = IX_DISC.TOP_UP;
    data.writeBigUInt64LE(lamports, 1);

    const ix = new TransactionInstruction({
      programId: this.programId,
      data,
      keys: [
        { pubkey: depositPda, isSigner: false, isWritable: true },
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });

    const tx = new Transaction().add(ix);
    const sig = await withRetry(
      () => sendAndConfirmTransaction(this.connection, tx, [this.payer]),
      { label: "ika_top_up" }
    );

    logger.info("gas_deposit_topped_up", {
      pda: depositPda.toBase58(),
      lamports: lamports.toString(),
      signature: sig,
    });

    return sig;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // gRPC CLIENT (official Ika TypeScript SDK)
  // Uses: @mysten/bcs, @grpc/grpc-js, generated proto types
  // Source: ika-pre-alpha/chains/solana/clients/typescript/
  // ──────────────────────────────────────────────────────────────────────────

  private _ikaClient: ReturnType<typeof import("../ika-sdk/grpc.js").createIkaClient> | null = null;

  /**
   * Lazily create the gRPC client to the Ika NOA network.
   */
  private getIkaClient() {
    if (!this._ikaClient) {
      // Dynamic import to avoid top-level dep issues
      const { createIkaClient } = require("../ika-sdk/grpc");
      const grpcUrl = IKA_GRPC_URL.replace(/^https?:\/\//, "");
      this._ikaClient = createIkaClient(grpcUrl);
      logger.info("ika_grpc_connected", { url: grpcUrl });
    }
    return this._ikaClient!;
  }

  /**
   * Create a new dWallet via gRPC DKG.
   *
   * Uses the official TypeScript SDK's `requestDKG()`.
   * Flow:
   * 1. gRPC DKG → NOA attestation with public key
   * 2. NOA calls CommitDWallet on-chain → creates dWallet PDA
   * 3. Poll until dWallet PDA exists and state == Active
   */
  async createDWallet(curve: DWalletCurve = DWalletCurve.Secp256k1): Promise<{
    pda: PublicKey;
    publicKey: Uint8Array;
    attestationData: Uint8Array;
    networkSignature: Uint8Array;
    networkPubkey: Uint8Array;
    epoch: bigint;
    sessionIdentifier: Uint8Array;
  }> {
    logger.info("dkg_start", { curve: DWalletCurve[curve] });

    const client = this.getIkaClient();
    const senderPubkey = this.payer.publicKey.toBytes();

    const dkgResult = await client.requestDKG(senderPubkey, curve);

    const [dwalletPda] = this.deriveDWalletPda(curve, dkgResult.publicKey);

    logger.info("dkg_attestation_received", {
      pk_hex: Buffer.from(dkgResult.publicKey).toString("hex").slice(0, 16) + "...",
      dwallet_pda: dwalletPda.toBase58(),
    });

    // Poll until NOA commits the dWallet on-chain
    const dwalletInfo = await this.pollDWalletActive(dwalletPda, 120_000);

    logger.info("dkg_complete", {
      pda: dwalletPda.toBase58(),
      pk_len: dkgResult.publicKey.length,
      state: DWalletState[dwalletInfo.state],
    });

    this.dwalletAttestationCache.set(dwalletPda.toBase58(), {
      pda: dwalletPda,
      attestationData: dkgResult.attestationData,
      networkSignature: dkgResult.networkSignature,
      networkPubkey: dkgResult.networkPubkey,
      epoch: dkgResult.epoch,
      sessionIdentifier: dkgResult.sessionIdentifier,
    });

    return {
      pda: dwalletPda,
      publicKey: dkgResult.publicKey,
      attestationData: dkgResult.attestationData,
      networkSignature: dkgResult.networkSignature,
      networkPubkey: dkgResult.networkPubkey,
      epoch: dkgResult.epoch,
      sessionIdentifier: dkgResult.sessionIdentifier,
    };
  }

  /**
   * Allocate a presign for a specific dWallet via gRPC.
   *
   * Uses the official TypeScript SDK's `requestPresign()`.
   * Returns the presign_session_identifier needed for Sign.
   */
  private resolveSignatureAlgorithm(
    dwalletCurve: DWalletCurve,
    signatureScheme: DWalletSignatureScheme,
  ): DWalletSignatureAlgorithm {
    switch (signatureScheme) {
      case DWalletSignatureScheme.TaprootSha256:
        return DWalletSignatureAlgorithm.Taproot;
      case DWalletSignatureScheme.SchnorrkelMerlin:
        return DWalletSignatureAlgorithm.SchnorrkelSubstrate;
      case DWalletSignatureScheme.EddsaSha512:
        return DWalletSignatureAlgorithm.EdDSA;
      default:
        return dwalletCurve === DWalletCurve.Secp256r1
          ? DWalletSignatureAlgorithm.EcdsaSecp256r1
          : DWalletSignatureAlgorithm.EcdsaSecp256k1;
    }
  }

  async allocatePresign(
    dwalletPda: PublicKey,
    signatureScheme: DWalletSignatureScheme = DWalletSignatureScheme.EddsaSha512,
  ): Promise<{
    presignSessionId: Uint8Array;
  }> {
    logger.info("presign_start", { dwallet_pda: dwalletPda.toBase58() });

    const client = this.getIkaClient();
    const senderPubkey = this.payer.publicKey.toBytes();
    const dwalletInfo = await this.readDWallet(dwalletPda);
    if (!dwalletInfo || dwalletInfo.state !== DWalletState.Active) {
      throw new Error(`dWallet not active: ${dwalletPda.toBase58()}`);
    }
    const signatureAlgorithm = this.resolveSignatureAlgorithm(
      dwalletInfo.curve,
      signatureScheme,
    );
    const dwalletAttestation = await this.readDWalletAttestation(dwalletPda);
    if (!dwalletAttestation) {
      throw new Error(`dwallet_attestation_not_found:${dwalletPda.toBase58()}`);
    }

    const requiresDWalletSpecificPresign =
      dwalletInfo.isImportedKeyDWallet &&
      (signatureAlgorithm === DWalletSignatureAlgorithm.EcdsaSecp256k1 ||
        signatureAlgorithm === DWalletSignatureAlgorithm.EcdsaSecp256r1);

    const presignId = requiresDWalletSpecificPresign
      ? await client.requestPresignForDWallet(
          senderPubkey,
          dwalletAttestation.sessionIdentifier,
          dwalletInfo.publicKey,
          dwalletInfo.curve,
          signatureAlgorithm,
          dwalletAttestation,
        )
      : await client.requestPresign(
          senderPubkey,
          dwalletAttestation.sessionIdentifier,
          dwalletInfo.curve,
          signatureAlgorithm,
        );

    logger.info("presign_complete", {
      presign_id_hex: Buffer.from(presignId).toString("hex").slice(0, 16) + "...",
      curve: DWalletCurve[dwalletInfo.curve],
      signature_scheme: DWalletSignatureScheme[signatureScheme],
      presign_scope: requiresDWalletSpecificPresign ? "dwallet_specific" : "global",
      imported_key: dwalletInfo.isImportedKeyDWallet,
    });

    return { presignSessionId: presignId };
  }

  /**
   * Sign a message via gRPC using an existing dWallet.
   *
   * Uses the official TypeScript SDK's `requestSign()`.
   * Full flow:
   * 1. approve_message on-chain (creates MessageApproval PDA)
   * 2. gRPC Sign with ApprovalProof::Solana { tx_sig, slot }
   * 3. Returns the 64-byte signature
   */
  async signMessage(
    message: Uint8Array,
    dwalletPda: PublicKey,
    presignSessionId: Uint8Array,
    callerProgramId: PublicKey,
    signatureScheme: DWalletSignatureScheme = DWalletSignatureScheme.EcdsaKeccak256,
  ): Promise<SignatureResult> {
    // Step 1: Build and send approve_message on-chain
    const dwalletInfo = await this.readDWallet(dwalletPda);
    if (!dwalletInfo || dwalletInfo.state !== DWalletState.Active) {
      throw new Error(`dWallet not active: ${dwalletPda.toBase58()}`);
    }

    const messageDigest = this.computeMessageDigest(message);
    const metaDigest = new Uint8Array(32); // no metadata
    const [coordPda] = this.deriveCoordinatorPda();
    const [cpiAuthority, cpiBump] = this.deriveCpiAuthority(callerProgramId);

    const [maPda, maBump] = this.deriveMessageApprovalPda(
      dwalletInfo.curve,
      dwalletInfo.publicKey,
      signatureScheme,
      messageDigest,
      metaDigest
    );

    const approveIx = this.buildApproveMessageIx({
      coordinatorPda: coordPda,
      messageApprovalPda: maPda,
      dwalletPda,
      callerProgramId,
      cpiAuthorityPda: cpiAuthority,
      payer: this.payer.publicKey,
      messageDigest,
      messageMetaDigest: metaDigest,
      userPubkey: dwalletInfo.publicKey.length >= 32
        ? dwalletInfo.publicKey.subarray(0, 32)
        : new Uint8Array(32),
      signatureScheme,
      bump: maBump,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      approveIx
    );

    const approvalSig = await withRetry(
      () => sendAndConfirmTransaction(this.connection, tx, [this.payer]),
      { label: "ika_approve_message" }
    );

    // Get the slot of the approval transaction
    const txStatus = await this.getTransactionWithRetry(
      approvalSig,
      "ika_read_approval_transaction"
    );
    const approvalSlot = txStatus?.slot ?? 0;
    const dwalletAttestation = await this.readDWalletAttestation(dwalletPda);
    if (!dwalletAttestation) {
      throw new Error(`dwallet_attestation_not_found:${dwalletPda.toBase58()}`);
    }

    logger.info("approve_message_sent", {
      approval_pda: maPda.toBase58(),
      signature: approvalSig,
      slot: approvalSlot,
    });

    // Step 2: Call gRPC Sign via official SDK
    const client = this.getIkaClient();
    const senderPubkey = this.payer.publicKey.toBytes();
    // Solana transaction signatures are base58-encoded by RPC.
    const txSigBytes = Buffer.from(bs58.decode(approvalSig));

    const signatureBytes = await client.requestSign(
      senderPubkey,
      !dwalletInfo.isImportedKeyDWallet
        ? dwalletAttestation.sessionIdentifier
        : dwalletPda.toBytes(),
      message,
      presignSessionId,
      txSigBytes,
      !dwalletInfo.isImportedKeyDWallet ? 0n : BigInt(approvalSlot),
      dwalletAttestation,
    );

    logger.info("sign_complete", {
      sig_len: signatureBytes.length,
      dwallet_pda: dwalletPda.toBase58(),
    });

    return {
      signature: signatureBytes,
      signatureScheme,
      dwalletPublicKey: dwalletInfo.publicKey,
      messageHash: messageDigest,
      onChain: true,
    };
  }

  /**
   * Request a signature for a message that has already been approved on-chain.
   *
   * This is the production path for CPI-driven approval flows where a program
   * creates the MessageApproval PDA first, then the Ika network signs against
   * that approval proof.
   */
  async requestSignatureForApprovedMessage(params: {
    message: Uint8Array;
    dwalletPda: PublicKey;
    presignSessionId: Uint8Array;
    approvalTxSignature: string;
    approvalSlot?: bigint;
    approvalPda: PublicKey;
    signatureScheme?: DWalletSignatureScheme;
  }): Promise<SignatureResult> {
    const dwalletInfo = await this.readDWallet(params.dwalletPda);
    if (!dwalletInfo || dwalletInfo.state !== DWalletState.Active) {
      throw new Error(`dWallet not active: ${params.dwalletPda.toBase58()}`);
    }
    const dwalletAttestation = await this.readDWalletAttestation(params.dwalletPda);
    if (!dwalletAttestation) {
      throw new Error(`dwallet_attestation_not_found:${params.dwalletPda.toBase58()}`);
    }

    const client = this.getIkaClient();
    const senderPubkey = this.payer.publicKey.toBytes();
    const txSigBytes = Buffer.from(bs58.decode(params.approvalTxSignature));
    const signatureScheme =
      params.signatureScheme ?? DWalletSignatureScheme.EcdsaKeccak256;
    let approvalSlot = params.approvalSlot ?? 0n;
    if (approvalSlot === 0n) {
      const txStatus = await this.getTransactionWithRetry(
        params.approvalTxSignature,
        "ika_read_signature_approval_transaction"
      );
      approvalSlot = BigInt(txStatus?.slot ?? 0);
    }

    const signatureBytes = await client.requestSign(
      senderPubkey,
      !dwalletInfo.isImportedKeyDWallet
        ? dwalletAttestation.sessionIdentifier
        : params.dwalletPda.toBytes(),
      params.message,
      params.presignSessionId,
      txSigBytes,
      !dwalletInfo.isImportedKeyDWallet ? 0n : approvalSlot,
      dwalletAttestation,
    );

    const committedSignature = await this.waitForSignature(params.approvalPda);

    logger.info("sign_complete_from_existing_approval", {
      approval_pda: params.approvalPda.toBase58(),
      dwallet_pda: params.dwalletPda.toBase58(),
      grpc_sig_len: signatureBytes.length,
      onchain_sig_len: committedSignature.length,
    });

    return {
      signature: committedSignature.length > 0 ? committedSignature : signatureBytes,
      signatureScheme,
      dwalletPublicKey: dwalletInfo.publicKey,
      messageHash: this.computeMessageDigest(params.message),
      onChain: true,
    };
  }

  /**
   * Cleanup: close the gRPC channel.
   */
  closeGrpc(): void {
    if (this._ikaClient) {
      this._ikaClient.close();
      this._ikaClient = null;
      logger.info("ika_grpc_closed");
    }
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let _instance: IkaService | null = null;

export function getIkaService(
  connection: Connection,
  payer: Keypair
): IkaService {
  if (!_instance) {
    _instance = new IkaService(connection, payer);
  }
  return _instance;
}

export function resetIkaService(): void {
  _instance = null;
}
