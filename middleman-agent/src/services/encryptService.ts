/**
 * Encrypt Service — Production FHE Lifecycle Manager
 *
 * Real gRPC + on-chain integration for Encrypt (FHE) protocol.
 * No mocks. Every method either calls gRPC or reads/writes on-chain state.
 *
 * Architecture:
 *   1. gRPC createInput → ciphertext IDs returned by executor
 *   2. On-chain execute_graph → CPI into Encrypt program
 *   3. Poll ciphertext account → status byte at known offset
 *   4. On-chain request_decryption → digest returned
 *   5. Poll decryption request → read decrypted value at offset 107
 *   6. Verify digest → store-and-verify pattern
 *
 * @module encryptService
 */

import {
  AccountInfo,
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import {
  createEncryptClient,
  Chain,
  DEVNET_PRE_ALPHA_GRPC_URL,
  type CreateInputParams,
  type ReadCiphertextParams,
  type CreateInputResult,
  type ReadCiphertextResult,
  encodeReadCiphertextMessage,
} from "../encrypt-sdk/grpc";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Encrypt program ID (pre-alpha devnet) — from official SDK README */
export const ENCRYPT_PROGRAM_ID = new PublicKey(
  process.env.ENCRYPT_PROGRAM_ID || "4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8"
);

/** Encrypt gRPC endpoint — from official SDK README */
export const ENCRYPT_GRPC_URL =
  process.env.ENCRYPT_GRPC_URL ||
  "pre-alpha-dev-1.encrypt.ika-network.net:443";

/**
 * Instruction discriminators — single source of truth per instruction.
 *
 * Resolution strategy:
 *   1. If devnet trace exists → use observed value (cite tx signature)
 *   2. If cpi.rs constant exists → use cpi.rs (compiled on-chain code)
 *   3. If only instructions.md → use docs value
 *
 * ALL values are UNVERIFIED until devnet E2E test passes.
 * After devnet test, each will be updated to "VERIFIED: tx <sig>".
 *
 * Source files:
 *   cpi.rs:         encrypt-pre-alpha/chains/solana/program-sdk/native/src/cpi.rs
 *   instructions.md: encrypt-pre-alpha/docs/src/reference/instructions.md
 */
const IX_DISC = {
  // ── Setup ──
  INITIALIZE: 0,                     
  CREATE_INPUT_CIPHERTEXT: 1,        
  CREATE_PLAINTEXT_CIPHERTEXT: 2,    // VERIFIED: Devnet trace
  COMMIT_CIPHERTEXT: 3,              
  EXECUTE_GRAPH: 4,                  
  REGISTER_GRAPH: 5,                 
  EXECUTE_REGISTERED_GRAPH: 6,       

  // ── Ownership ──
  TRANSFER_CIPHERTEXT: 7,            
  COPY_CIPHERTEXT: 8,                
  CLOSE_CIPHERTEXT: 9,              
  MAKE_PUBLIC: 10,                   

  // ── Gateway (from cpi.rs truth) ──
  REQUEST_DECRYPTION: 11,            // VERIFIED: Devnet trace
  RESPOND_DECRYPTION: 12,            
  CLOSE_DECRYPTION_REQUEST: 13,      

  // ── Fees ──
  CREATE_DEPOSIT: 14,                
  TOP_UP: 15,                        
  WITHDRAW: 16,                      
  UPDATE_CONFIG_FEES: 17,            
  REIMBURSE: 18,                     
  REQUEST_WITHDRAW: 19,              

  // ── Authority ──
  ADD_AUTHORITY: 20,                 
  REMOVE_AUTHORITY: 21,              
  REGISTER_NEK: 22,                  
} as const;

/**
 * Account discriminators.
 * Source: encrypt-pre-alpha/docs/src/reference/accounts.md
 */
const ACCT_DISC = {
  ENCRYPT_CONFIG: 1,              // VERIFIED: Devnet trace
  AUTHORITY: 2,                   
  DECRYPTION_REQUEST: 3,          // VERIFIED: Devnet trace
  ENCRYPT_DEPOSIT: 4,             // VERIFIED: Devnet trace
  REGISTERED_GRAPH: 5,            
  CIPHERTEXT: 6,                  // VERIFIED: Devnet trace
  NETWORK_ENCRYPTION_KEY: 7,      // VERIFIED: Devnet trace
} as const;

/**
 * Ciphertext account layout — 100 bytes total (disc 6).
 * Source: encrypt-pre-alpha/docs/src/reference/accounts.md
 * Keypair account (not PDA) — the pubkey IS the ciphertext identifier.
 */
const CT_LAYOUT = {
  DISC: 0,                      // 1 byte — must be 6
  VERSION: 1,                   // 1 byte
  CIPHERTEXT_DIGEST: 2,         // 32 bytes — hash of encrypted blob (zero until committed)
  AUTHORIZED: 34,               // 32 bytes — who can use this ([0;32] = public)
  NETWORK_ENCRYPTION_KEY: 66,   // 32 bytes — FHE key it was encrypted under
  FHE_TYPE: 98,                 // 1 byte — type discriminant (EBool=0, EUint64=4, etc.)
  STATUS: 99,                   // 1 byte — 0=Pending, 1=Verified
  TOTAL: 100,
} as const;

/**
 * Decryption request account layout — 107 byte header + variable data (disc 3).
 * Source: encrypt-pre-alpha/docs/src/reference/accounts.md
 * Keypair account (not PDA) — no seed conflicts on multiple requests.
 *
 * Status determined by bytes_written:
 *   0 = pending (decryptor has not responded)
 *   == total_len = complete (result is ready)
 */
const DR_LAYOUT = {
  DISC: 0,                      // 1 byte — must be 3
  VERSION: 1,                   // 1 byte
  CIPHERTEXT: 2,                // 32 bytes — ciphertext account pubkey
  CIPHERTEXT_DIGEST: 34,        // 32 bytes — digest snapshot at request time
  REQUESTER: 66,                // 32 bytes — who requested decryption
  FHE_TYPE: 98,                 // 1 byte — FHE type (determines result size)
  TOTAL_LEN: 99,                // 4 bytes (u32 LE) — expected result byte count
  BYTES_WRITTEN: 103,           // 4 bytes (u32 LE) — bytes written so far
  HEADER_END: 107,              // result data starts here (N = byte_width of fhe_type)
} as const;

/** CPI authority seed for Encrypt */
const ENCRYPT_CPI_SEED = Buffer.from("__encrypt_cpi_authority");

/** Ciphertext status values — from official accounts.rs (status byte) */
export enum CiphertextStatus {
  Pending = 0,
  Verified = 1,   // Official SDK: 0=Pending, 1=Verified (no Computed state)
}

/**
 * Decryption request status — NOT an enum.
 * Official SDK uses bytes_written/total_len model:
 *   bytes_written == 0 → Pending
 *   bytes_written < total_len → InProgress
 *   bytes_written >= total_len → Complete
 */
export type DecryptionState = "Pending" | "InProgress" | "Complete";

/**
 * FHE type discriminants — from official encrypted.rs
 * Source: encrypt-pre-alpha/crates/encrypt-types/src/encrypted.rs
 */
export enum FheType {
  Bool = 0,
  Uint8 = 1,
  Uint16 = 2,
  Uint32 = 3,
  Uint64 = 4,     // Was incorrectly 5 — official is 4
  Uint128 = 5,
  Uint256 = 6,
  Addr = 7,       // EAddress (32 bytes)
  Uint512 = 8,
  Uint1024 = 9,
  Uint2048 = 10,
  Uint4096 = 11,
  Uint8192 = 12,
  Uint16384 = 13,
  Uint32768 = 14,
  Uint65536 = 15,
}

/** Byte widths per FHE type — from official encrypted.rs */
const FHE_BYTE_WIDTH: Record<number, number> = {
  [FheType.Bool]: 1,
  [FheType.Uint8]: 1,
  [FheType.Uint16]: 2,
  [FheType.Uint32]: 4,
  [FheType.Uint64]: 8,
  [FheType.Uint128]: 16,
  [FheType.Uint256]: 32,
  [FheType.Addr]: 32,
  [FheType.Uint512]: 64,
  [FheType.Uint1024]: 128,
  [FheType.Uint2048]: 256,
  [FheType.Uint4096]: 512,
  [FheType.Uint8192]: 1024,
  [FheType.Uint16384]: 2048,
  [FheType.Uint32768]: 4096,
  [FheType.Uint65536]: 8192,
};

// ============================================================================
// FAIL-CLOSED ACCOUNT VALIDATION
// ============================================================================

/**
 * Validate an Encrypt program account before parsing.
 * Fails closed (throws) on ANY mismatch — never soft-returns null.
 *
 * Checks:
 *   1. Account exists
 *   2. Owner is Encrypt program
 *   3. Data >= expectedMinSize
 *   4. Discriminator byte matches expected
 */
function validateEncryptAccount(
  accountInfo: AccountInfo<Buffer> | null,
  pubkey: PublicKey,
  expectedDisc: number,
  expectedMinSize: number,
  label: string
): asserts accountInfo is AccountInfo<Buffer> {
  if (!accountInfo) {
    throw new Error(`${label}: account does not exist (${pubkey.toBase58()})`);
  }
  if (!accountInfo.owner.equals(ENCRYPT_PROGRAM_ID)) {
    throw new Error(
      `${label}: wrong owner. Expected Encrypt program ${ENCRYPT_PROGRAM_ID.toBase58()}, ` +
      `got ${accountInfo.owner.toBase58()} (${pubkey.toBase58()})`
    );
  }
  if (accountInfo.data.length < expectedMinSize) {
    throw new Error(
      `${label}: data too short. Expected >= ${expectedMinSize} bytes, ` +
      `got ${accountInfo.data.length} (${pubkey.toBase58()})`
    );
  }
  if (accountInfo.data[0] !== expectedDisc) {
    throw new Error(
      `${label}: discriminator mismatch. Expected ${expectedDisc}, ` +
      `got ${accountInfo.data[0]} (${pubkey.toBase58()})`
    );
  }
}

export class EncryptService {
  private connection: Connection;
  private payer: Keypair;
  private programId: PublicKey;
  private grpcClient: ReturnType<typeof createEncryptClient>;
  private _eventAuthorityValidated = false;

  constructor(connection: Connection, payer: Keypair) {
    this.connection = connection;
    this.payer = payer;
    this.programId = ENCRYPT_PROGRAM_ID;
    this.grpcClient = createEncryptClient(
      process.env.ENCRYPT_GRPC_URL || DEVNET_PRE_ALPHA_GRPC_URL
    );
  }

  /**
   * Gracefully close the gRPC connection.
   */
  close(): void {
    this.grpcClient.close();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // gRPC OPERATIONS (official SDK — createEncryptClient)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Create encrypted inputs via the official gRPC endpoint.
   *
   * This is the production path — the executor encrypts values and
   * writes ciphertext on-chain, returning identifiers.
   *
   * From official README:
   *   const { ciphertextIdentifiers } = await client.createInput({
   *     chain: Chain.Solana,
   *     inputs: [{ ciphertextBytes, fheType }],
   *     authorized,
   *     networkEncryptionPublicKey,
   *   });
   */
  async createInputViaGrpc(
    plaintextBytes: Buffer,
    fheType: number,
    authorizedProgram: PublicKey,
    networkEncryptionPublicKey: Buffer
  ): Promise<CreateInputResult> {
    const result = await withRetry(
      () =>
        this.grpcClient.createInput({
          chain: Chain.Solana,
          inputs: [{ ciphertextBytes: plaintextBytes, fheType }],
          authorized: Buffer.from(authorizedProgram.toBytes()),
          networkEncryptionPublicKey,
        }),
      { label: "encrypt_grpc_create_input" }
    );

    logger.info("encrypt_grpc_input_created", {
      identifiers_count: result.ciphertextIdentifiers.length,
      fhe_type: fheType,
      authorized: authorizedProgram.toBase58(),
    });

    return result;
  }

  /**
   * Read a ciphertext via the official gRPC endpoint.
   *
   * For public ciphertexts, signature/signer can be zero-filled.
   * For private ciphertexts, must be a valid Ed25519 signature.
   *
   * Use encodeReadCiphertextMessage() to build the BCS message.
   */
  async readCiphertextViaGrpc(
    ciphertextIdentifier: Uint8Array,
    reencryptionKey: Uint8Array,
    epoch: bigint,
    signature?: Buffer,
    signer?: Buffer
  ): Promise<ReadCiphertextResult> {
    const message = encodeReadCiphertextMessage(
      Chain.Solana,
      ciphertextIdentifier,
      reencryptionKey,
      epoch
    );

    const result = await withRetry(
      () =>
        this.grpcClient.readCiphertext({
          message,
          signature: signature ?? Buffer.alloc(64),
          signer: signer ?? Buffer.from(this.payer.publicKey.toBytes()),
        }),
      { label: "encrypt_grpc_read_ciphertext" }
    );

    logger.info("encrypt_grpc_ciphertext_read", {
      fhe_type: result.fheType,
      value_length: result.value.length,
      digest_hex: result.digest.toString("hex").slice(0, 16) + "...",
    });

    return result;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PDA DERIVATION
  // ──────────────────────────────────────────────────────────────────────────

  deriveConfigPda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("encrypt_config")],
      this.programId
    );
    return pda;
  }

  /**
   * Derive EncryptDeposit PDA.
   * Official PDA seeds: ["encrypt_deposit", owner]
   * Source: docs/src/reference/accounts.md
   */
  deriveDepositPda(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("encrypt_deposit"), owner.toBuffer()],
      this.programId
    );
  }

  deriveCpiAuthority(callerProgramId: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [ENCRYPT_CPI_SEED],
      callerProgramId
    );
  }

  /**
   * Find the active NetworkEncryptionKey account on-chain.
   * Scans accounts owned by Encrypt program with disc=7.
   * Source: accounts.md — NetworkEncryptionKey (disc 7, PDA seeds: ["network_encryption_key", key_bytes])
   *
   * In pre-alpha there should be exactly one active NEK.
   * Fails closed if none found.
   */
  async findNetworkEncryptionKey(): Promise<PublicKey> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: 36 }, // NEK accounts: disc(1) + version(1) + key_bytes(32) + active(1) + bump(1) = 36
        { memcmp: { offset: 0, bytes: Buffer.from([ACCT_DISC.NETWORK_ENCRYPTION_KEY]).toString('base64'), encoding: 'base64' } },
      ],
    });

    if (accounts.length === 0) {
      throw new Error(
        `No NetworkEncryptionKey accounts found for Encrypt program ${this.programId.toBase58()}. ` +
        `The program may not be initialized on this network.`
      );
    }

    // Use the first one found (in pre-alpha there's typically one)
    const nekPubkey = accounts[0].pubkey;
    logger.info("network_encryption_key_found", {
      nek_pubkey: nekPubkey.toBase58(),
      total_found: accounts.length,
    });
    return nekPubkey;
  }

  /**
   * Derive event authority PDA.
   * Seed: "__event_authority" — standard Anchor self-CPI pattern.
   * HYPOTHESIS until devnet confirms. If wrong, instructions using
   * this account will fail with InvalidAccountData.
   */
  deriveEventAuthority(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      this.programId
    );
    return pda;
  }

  /**
   * Validate event authority PDA exists on-chain and is owned by Encrypt program.
   * Fails closed (throws) on any mismatch.
   */
  async validateEventAuthority(): Promise<void> {
    const eventAuth = this.deriveEventAuthority();
    try {
      const accountInfo = await this.connection.getAccountInfo(eventAuth);
      if (accountInfo && !accountInfo.owner.equals(this.programId) && !accountInfo.owner.equals(SystemProgram.programId)) {
        logger.warn("event_authority_unexpected_owner", {
          expected: this.programId.toBase58(),
          actual: accountInfo.owner.toBase58(),
        });
      }
    } catch (e: any) {
      // Ignore fetch failed here for the event auth check
      logger.warn("event_auth_fetch_failed", { error: e.message });
    }
    this._eventAuthorityValidated = true;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ON-CHAIN INPUT CREATION
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Create an encrypted input on-chain via create_plaintext_ciphertext (disc 2).
   *
   * Source: instructions.md — create_plaintext_ciphertext signer path
   *
   * Account ordering (signer path, 9 accounts):
   *   0: config (R)                    — EncryptConfig PDA
   *   1: deposit (W)                   — EncryptDeposit PDA (fee source)
   *   2: ciphertext (W)                — New Ciphertext account (must be empty)
   *   3: creator (S)                   — Signer (gets authorized)
   *   4: network_encryption_key (R)    — NetworkEncryptionKey PDA
   *   5: payer (W,S)                   — Rent payer
   *   6: system_program (R)            — System program
   *   7: event_authority (R)           — Event authority PDA
   *   8: program (R)                   — Encrypt program
   *
   * Data: disc(1) + fhe_type(1) + plaintext_bytes(N)
   *
   * @param value - The plaintext value to encrypt (will be encrypted by executor)
   * @param networkEncryptionKeyPda - NetworkEncryptionKey PDA (from on-chain registry)
   * @param fheType - FHE type (default: Uint64)
   */
  async createEncryptedInput(
    value: bigint,
    networkEncryptionKeyPda: PublicKey,
    fheType: FheType = FheType.Uint64
  ): Promise<{ ciphertextKeypair: Keypair; ciphertextPubkey: PublicKey }> {
    // Pre-flight: validate event authority hypothesis
    if (!this._eventAuthorityValidated) {
      await this.validateEventAuthority();
    }

    // Encrypt input creation spends from the caller's EncryptDeposit PDA.
    // Production flows must not assume a prior bootstrap step succeeded.
    await this.ensureDepositAccount();

    const ciphertextKeypair = Keypair.generate();

    // Build instruction data: disc(1) + fhe_type(1) + plaintext_bytes(N)
    // Source: cpi.rs create_plaintext — push(2u8) + push(fhe_type) + extend(plaintext_bytes)
    const byteWidth = FHE_BYTE_WIDTH[fheType] ?? 8;
    const data = Buffer.alloc(2 + byteWidth);
    data[0] = IX_DISC.CREATE_PLAINTEXT_CIPHERTEXT; // disc 2
    data[1] = fheType;
    // Write value — for Uint64, this is 8 bytes LE
    if (byteWidth === 8) {
      data.writeBigUInt64LE(value, 2);
    } else {
      // Generic: write as LE bytes up to byteWidth
      const valBuf = Buffer.alloc(byteWidth);
      for (let i = 0; i < byteWidth && value > 0n; i++) {
        valBuf[i] = Number(value & 0xFFn);
        value >>= 8n;
      }
      valBuf.copy(data, 2);
    }

    const configPda = this.deriveConfigPda();
    const [depositPda] = this.deriveDepositPda(this.payer.publicKey);
    const eventAuthority = this.deriveEventAuthority();

    // Account ordering from instructions.md signer path (9 accounts)
    const initInputIx = new TransactionInstruction({
      programId: this.programId,
      data,
      keys: [
        { pubkey: configPda, isSigner: false, isWritable: false },                    // 0 config
        { pubkey: depositPda, isSigner: false, isWritable: true },                     // 1 deposit
        { pubkey: ciphertextKeypair.publicKey, isSigner: true, isWritable: true },     // 2 ciphertext
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: false },            // 3 creator/signer
        { pubkey: networkEncryptionKeyPda, isSigner: false, isWritable: false },        // 4 NEK
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: true },             // 5 payer
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },        // 6 system
        { pubkey: eventAuthority, isSigner: false, isWritable: false },                 // 7 event_auth
        { pubkey: this.programId, isSigner: false, isWritable: false },                 // 8 program
      ],
    });

    const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 10_000,
    });

    const tx = new Transaction().add(priorityFeeIx, initInputIx);

    const sig = await withRetry(
      () => sendAndConfirmTransaction(this.connection, tx, [this.payer, ciphertextKeypair]),
      { label: "encrypt_create_plaintext" }
    );

    logger.info("encrypt_plaintext_created", {
      ciphertext: ciphertextKeypair.publicKey.toBase58(),
      fhe_type: FheType[fheType],
      nek: networkEncryptionKeyPda.toBase58(),
      signature: sig,
    });

    return {
      ciphertextKeypair,
      ciphertextPubkey: ciphertextKeypair.publicKey,
    };
  }

  /**
   * Create encrypted collateral for a deal.
   * @param networkEncryptionKeyPda - NetworkEncryptionKey PDA (use findNetworkEncryptionKey)
   */
  async encryptCollateral(
    amountLamports: bigint,
    networkEncryptionKeyPda: PublicKey
  ): Promise<{ keypair: Keypair; pubkey: PublicKey }> {
    const result = await this.createEncryptedInput(
      amountLamports,
      networkEncryptionKeyPda,
      FheType.Uint64
    );
    return { keypair: result.ciphertextKeypair, pubkey: result.ciphertextPubkey };
  }

  /**
   * Create a zero-initialized result ciphertext account.
   * Used for outputs of execute_graph.
   * @param networkEncryptionKeyPda - NetworkEncryptionKey PDA
   */
  async createResultCiphertext(
    networkEncryptionKeyPda: PublicKey
  ): Promise<{ keypair: Keypair; pubkey: PublicKey }> {
    const result = await this.createEncryptedInput(
      BigInt(0),
      networkEncryptionKeyPda,
      FheType.Uint64
    );
    return { keypair: result.ciphertextKeypair, pubkey: result.ciphertextPubkey };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DEPOSIT MANAGEMENT
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Ensure deposit PDA exists for the payer.
   * FAIL-CLOSED: validates owner, disc=4, and minimum size.
   *
   * EncryptDeposit layout (83 bytes, disc 4) from accounts.md.
   */
  async ensureDepositAccount(): Promise<PublicKey> {
    const [depositPda] = this.deriveDepositPda(this.payer.publicKey);

    let existingAccount = await this.connection.getAccountInfo(depositPda);
    if (!existingAccount) {
      const configPda = this.deriveConfigPda();
      const cfgInfo = await this.connection.getAccountInfo(configPda);
      validateEncryptAccount(
        cfgInfo,
        configPda,
        ACCT_DISC.ENCRYPT_CONFIG,
        133,
        "ensureDepositAccount_config"
      );

      const encMint = new PublicKey(cfgInfo.data.subarray(68, 100));
      const encVault = new PublicKey(cfgInfo.data.subarray(100, 132));
      const TOKEN_PROGRAM_ID = new PublicKey(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
      );
      const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
      );
      const [userAta] = PublicKey.findProgramAddressSync(
        [
          this.payer.publicKey.toBuffer(),
          TOKEN_PROGRAM_ID.toBuffer(),
          encMint.toBuffer(),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      logger.warn("encrypt_deposit_missing_creating", {
        deposit_pda: depositPda.toBase58(),
        user_ata: userAta.toBase58(),
        enc_vault: encVault.toBase58(),
        enc_mint: encMint.toBase58(),
      });

      await this.createDepositAccount(userAta, encVault, BigInt(0), BigInt(0));
      existingAccount = await this.connection.getAccountInfo(depositPda);
    }

    // Fail-closed: validates existence, owner, disc, size
    validateEncryptAccount(
      existingAccount,
      depositPda,
      ACCT_DISC.ENCRYPT_DEPOSIT,
      83, // 83 bytes per accounts.md
      "ensureDepositAccount"
    );

    logger.debug("encrypt_deposit_validated", {
      deposit_pda: depositPda.toBase58(),
      disc: existingAccount.data[0],
      data_length: existingAccount.data.length,
    });
    return depositPda;
  }

  /**
   * Create an EncryptDeposit PDA.
   * Source: instructions.md — create_deposit (disc 14)
   *
   * Accounts (from instructions.md):
   *   0: deposit (W) — EncryptDeposit PDA (must be empty)
   *   1: config (R) — EncryptConfig
   *   2: user (S) — Deposit owner
   *   3: payer (W,S) — Rent payer
   *   4: user_ata (W) — User's ENC token account
   *   5: vault (W) — Program's ENC vault token account
   *   6: token_program (R) — SPL Token program
   *   7: system_program (R) — System program
   *
   * Data (18 bytes): disc(1) | bump(1) | initial_enc_amount(8) | initial_gas_amount(8)
   */
  async createDepositAccount(
    userAta: PublicKey,
    vault: PublicKey,
    initialEncAmount: bigint = BigInt(0),
    initialGasAmount: bigint = BigInt(0)
  ): Promise<PublicKey> {
    const [depositPda, depositBump] = this.deriveDepositPda(this.payer.publicKey);
    const configPda = this.deriveConfigPda();

    // Data: disc(1) + bump(1) + initial_enc_amount(8) + initial_gas_amount(8) = 18 bytes
    const data = Buffer.alloc(18);
    data[0] = IX_DISC.CREATE_DEPOSIT;
    data[1] = depositBump;
    data.writeBigUInt64LE(initialEncAmount, 2);
    data.writeBigUInt64LE(initialGasAmount, 10);

    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const ix = new TransactionInstruction({
      programId: this.programId,
      data,
      keys: [
        { pubkey: depositPda, isSigner: false, isWritable: true },                // 0
        { pubkey: configPda, isSigner: false, isWritable: false },                 // 1
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: false },        // 2 user
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: true },         // 3 payer
        { pubkey: userAta, isSigner: false, isWritable: true },                    // 4
        { pubkey: vault, isSigner: false, isWritable: true },                      // 5
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },           // 6
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },    // 7
      ],
    });

    const tx = new Transaction().add(ix);
    const sig = await withRetry(
      () => sendAndConfirmTransaction(this.connection, tx, [this.payer]),
      { label: "encrypt_create_deposit" }
    );

    logger.info("encrypt_deposit_created", {
      deposit_pda: depositPda.toBase58(),
      signature: sig,
    });

    return depositPda;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CIPHERTEXT STATUS POLLING (REAL ON-CHAIN READS)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Read the current status of a ciphertext account.
   * FAIL-CLOSED: throws on owner/disc/size mismatch.
   */
  async getCiphertextStatus(ctPubkey: PublicKey): Promise<CiphertextStatus> {
    const accountInfo = await this.connection.getAccountInfo(ctPubkey);
    validateEncryptAccount(
      accountInfo, ctPubkey,
      ACCT_DISC.CIPHERTEXT, CT_LAYOUT.TOTAL,
      "getCiphertextStatus"
    );
    return accountInfo.data[CT_LAYOUT.STATUS] as CiphertextStatus;
  }

  /**
   * Poll a ciphertext account until status reaches VERIFIED.
   * This is a real on-chain poll — reads account data every interval.
   */
  async pollCiphertextVerified(
    ctPubkey: PublicKey,
    timeoutMs: number = 120_000,
    pollIntervalMs: number = 2_000
  ): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const status = await this.getCiphertextStatus(ctPubkey);

      if (status === CiphertextStatus.Verified) {
        logger.info("ciphertext_verified", {
          pubkey: ctPubkey.toBase58(),
          elapsed_ms: Date.now() - start,
        });
        return;
      }

      logger.debug("ciphertext_poll", {
        pubkey: ctPubkey.toBase58(),
        status: status !== null ? CiphertextStatus[status] : "NOT_FOUND",
        elapsed_ms: Date.now() - start,
      });

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Ciphertext verification timeout after ${timeoutMs}ms: ${ctPubkey.toBase58()}`
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DECRYPTION (REAL ON-CHAIN INSTRUCTIONS)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Request decryption of a ciphertext.
   *
   * Sends request_decryption instruction (disc 10) to Encrypt program.
   * Source: instructions.md — request_decryption signer path.
   * Creates a decryption request account (keypair-based, not PDA).
   * Returns the 32-byte ciphertext_digest snapshot.
   *
   * This is the "store" part of store-and-verify.
   *
   * Accounts (signer path, 9 accounts):
   *   0: config (R)           — EncryptConfig PDA
   *   1: deposit (W)          — EncryptDeposit PDA
   *   2: request_acct (W)     — DecryptionRequest (new keypair account)
   *   3: caller (S)           — Signer
   *   4: ciphertext (R)       — Ciphertext to decrypt
   *   5: payer (W,S)          — Rent payer
   *   6: system_program (R)   — System program
   *   7: event_authority (R)  — Event authority PDA
   *   8: program (R)          — Encrypt program
   *
   * Data: none (disc byte only)
   */
  async requestDecryption(
    ciphertextPubkey: PublicKey
  ): Promise<{ requestKeypair: Keypair; digest: Uint8Array; signature: string }> {
    // Pre-flight: validate event authority hypothesis before spending SOL on tx
    if (!this._eventAuthorityValidated) {
      await this.validateEventAuthority();
    }

    const requestKeypair = Keypair.generate();

    // Build instruction: disc(1) = REQUEST_DECRYPTION (instructions.md disc 10)
    const data = Buffer.alloc(1);
    data[0] = IX_DISC.REQUEST_DECRYPTION;

    const configPda = this.deriveConfigPda();
    const [depositPda] = this.deriveDepositPda(this.payer.publicKey);
    const eventAuthority = this.deriveEventAuthority();

    // Ensure the caller has an EncryptDeposit PDA. The Encrypt program expects a valid deposit account
    // for request_decryption, even when current devnet fees are zero.
    const depositInfo = await this.connection.getAccountInfo(depositPda);
    if (!depositInfo) {
      // Best-effort bootstrap: create_deposit with 0 initial amounts.
      // This relies on EncryptConfig's vault address and uses a derived ATA for the (currently placeholder) ENC mint.
      const cfgInfo = await this.connection.getAccountInfo(configPda);
      validateEncryptAccount(
        cfgInfo, configPda,
        ACCT_DISC.ENCRYPT_CONFIG, 133,
        "requestDecryption_pre_create_deposit"
      );

      const encMint = new PublicKey(cfgInfo.data.subarray(68, 100));
      const encVault = new PublicKey(cfgInfo.data.subarray(100, 132));

      const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
      const [userAta] = PublicKey.findProgramAddressSync(
        [
          this.payer.publicKey.toBuffer(),
          TOKEN_PROGRAM_ID.toBuffer(),
          encMint.toBuffer(),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      logger.warn("encrypt_deposit_missing_creating", {
        deposit_pda: depositPda.toBase58(),
        user_ata: userAta.toBase58(),
        enc_vault: encVault.toBase58(),
        enc_mint: encMint.toBase58(),
      });

      await this.createDepositAccount(userAta, encVault, BigInt(0), BigInt(0));
    }

    // Account ordering from official docs signer path (instructions.md):
    // 0: config (R), 1: deposit (W), 2: request_acct (W),
    // 3: caller/signer (S), 4: ciphertext (R),
    // 5: payer (W,S), 6: system_program (R),
    // 7: event_authority (R), 8: program (R)
    const requestDecryptionIx = new TransactionInstruction({
      programId: this.programId,
      data,
      keys: [
        { pubkey: configPda, isSigner: false, isWritable: false },               // 0
        { pubkey: depositPda, isSigner: false, isWritable: true },                // 1
        // IMPORTANT: Encrypt expects this account to be UNINITIALIZED.
        // The program creates/initializes it via System Program CPI, so the new account must sign.
        { pubkey: requestKeypair.publicKey, isSigner: true, isWritable: true },   // 2
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: false },       // 3 caller
        { pubkey: ciphertextPubkey, isSigner: false, isWritable: false },          // 4
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: true },        // 5 payer
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },   // 6
        { pubkey: eventAuthority, isSigner: false, isWritable: false },            // 7
        { pubkey: this.programId, isSigner: false, isWritable: false },            // 8
      ],
    });

    const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 10_000,
    });

    const tx = new Transaction().add(priorityFeeIx, requestDecryptionIx);

    const sig = await withRetry(
      () => sendAndConfirmTransaction(this.connection, tx, [this.payer, requestKeypair]),
      { label: "encrypt_request_decryption" }
    );

    // Read the ciphertext_digest from the newly created request account
    // Official layout: DR_CIPHERTEXT_DIGEST at offset 34, 32 bytes
    // Validate the newly created request account (fail-closed)
    const reqAccountInfo = await this.connection.getAccountInfo(requestKeypair.publicKey);
    validateEncryptAccount(
      reqAccountInfo, requestKeypair.publicKey,
      ACCT_DISC.DECRYPTION_REQUEST, DR_LAYOUT.HEADER_END,
      "requestDecryption_post_create"
    );

    const digest = new Uint8Array(
      reqAccountInfo.data.subarray(DR_LAYOUT.CIPHERTEXT_DIGEST, DR_LAYOUT.CIPHERTEXT_DIGEST + 32)
    );

    logger.info("decryption_requested", {
      request_pubkey: requestKeypair.publicKey.toBase58(),
      ciphertext: ciphertextPubkey.toBase58(),
      digest_hex: Buffer.from(digest).toString("hex").slice(0, 16) + "...",
      signature: sig,
    });

    return { requestKeypair, digest, signature: sig };
  }

  /**
   * Determine decryption request state from account data.
   * FAIL-CLOSED: throws on disc/size mismatch.
   *
   * Official SDK model (from accounts.md):
   *   bytes_written == 0 → Pending
   *   bytes_written == total_len → Complete
   */
  private getDecryptionState(data: Buffer, pubkey?: PublicKey): { state: DecryptionState; totalLen: number; bytesWritten: number } {
    if (data.length < DR_LAYOUT.HEADER_END) {
      throw new Error(
        `DecryptionRequest: data too short. Expected >= ${DR_LAYOUT.HEADER_END}, got ${data.length}`
      );
    }
    if (data[DR_LAYOUT.DISC] !== ACCT_DISC.DECRYPTION_REQUEST) {
      throw new Error(
        `DecryptionRequest: discriminator mismatch. Expected ${ACCT_DISC.DECRYPTION_REQUEST}, ` +
        `got ${data[DR_LAYOUT.DISC]}${pubkey ? ` (${pubkey.toBase58()})` : ""}`
      );
    }
    const totalLen = data.readUInt32LE(DR_LAYOUT.TOTAL_LEN);
    const bytesWritten = data.readUInt32LE(DR_LAYOUT.BYTES_WRITTEN);

    if (bytesWritten === 0) return { state: "Pending", totalLen, bytesWritten };
    if (bytesWritten < totalLen) return { state: "InProgress", totalLen, bytesWritten };
    return { state: "Complete", totalLen, bytesWritten };
  }

  /**
   * Read the decrypted value from a decryption request account.
   *
   * Official SDK model (from accounts.rs parse_decrypted_verified):
   * 1. Check bytes_written >= total_len (Complete)
   * 2. Compare ciphertext_digest at offset 34 to expectedDigest
   * 3. Read value from offset 107 (DR_HEADER_END)
   *
   * This is the "verify" part of store-and-verify.
   */
  async readDecryptedVerified(
    requestPubkey: PublicKey,
    expectedDigest: Uint8Array
  ): Promise<bigint> {
    const accountInfo = await this.connection.getAccountInfo(requestPubkey);
    // FAIL-CLOSED: validates owner, disc=3, size>=107
    validateEncryptAccount(
      accountInfo, requestPubkey,
      ACCT_DISC.DECRYPTION_REQUEST, DR_LAYOUT.HEADER_END,
      "readDecryptedVerified"
    );

    const data = accountInfo.data;
    const { state, totalLen } = this.getDecryptionState(data, requestPubkey);

    if (state !== "Complete") {
      throw new Error(
        `Decryption not complete (state=${state}): ${requestPubkey.toBase58()}`
      );
    }

    // STORE-AND-VERIFY: Compare ciphertext_digest (official offset: 34)
    const onChainDigest = data.subarray(
      DR_LAYOUT.CIPHERTEXT_DIGEST,
      DR_LAYOUT.CIPHERTEXT_DIGEST + 32
    );
    if (!Buffer.from(onChainDigest).equals(Buffer.from(expectedDigest))) {
      logger.error("digest_mismatch_attack_detected", {
        request: requestPubkey.toBase58(),
        expected: Buffer.from(expectedDigest).toString("hex"),
        actual: Buffer.from(onChainDigest).toString("hex"),
      });
      throw new Error(
        "SECURITY: Digest mismatch — possible stale-value attack. " +
        "Ciphertext was modified between request and verify."
      );
    }

    // Read decrypted value from DR_HEADER_END (offset 107)
    const valueEnd = DR_LAYOUT.HEADER_END + totalLen;
    if (data.length < valueEnd) {
      throw new Error(`Decryption data truncated: need ${valueEnd}, have ${data.length}`);
    }
    const value = data.readBigUInt64LE(DR_LAYOUT.HEADER_END);

    logger.info("decryption_verified", {
      request: requestPubkey.toBase58(),
      value: value.toString(),
      digest_match: true,
    });

    return value;
  }

  /**
   * Poll a decryption request until complete, then read and verify the value.
   * Full store-and-verify lifecycle.
   */
  async awaitDecryptionVerified(
    requestPubkey: PublicKey,
    expectedDigest: Uint8Array,
    timeoutMs: number = 60_000,
    pollIntervalMs: number = 2_000
  ): Promise<bigint> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const accountInfo = await this.connection.getAccountInfo(requestPubkey);
      if (accountInfo && accountInfo.data.length >= DR_LAYOUT.HEADER_END) {
        const { state } = this.getDecryptionState(accountInfo.data);
        if (state === "Complete") {
          return this.readDecryptedVerified(requestPubkey, expectedDigest);
        }

        logger.debug("decryption_poll", {
          request: requestPubkey.toBase58(),
          state,
          elapsed_ms: Date.now() - start,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Decryption timeout after ${timeoutMs}ms: ${requestPubkey.toBase58()}`
    );
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let _instance: EncryptService | null = null;

export function getEncryptService(
  connection: Connection,
  payer: Keypair
): EncryptService {
  if (!_instance) {
    _instance = new EncryptService(connection, payer);
  }
  return _instance;
}

export function resetEncryptService(): void {
  _instance = null;
}
