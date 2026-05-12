/**
 * Encrypt gRPC client — real protobuf wire format.
 *
 * Uses @grpc/proto-loader to load encrypt_service.proto at runtime.
 * This ensures proper protobuf binary encoding on the wire,
 * not JSON serialization.
 *
 * Official source:
 *   Proto: encrypt-pre-alpha/proto/encrypt_service.proto
 *   Client: encrypt-pre-alpha/chains/solana/clients/typescript/src/grpc.ts
 *   Package: encrypt.v1
 *   Service: EncryptService
 *   RPCs: CreateInput, ReadCiphertext
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as path from "path";
import * as fs from "fs";

// ============================================================================
// LAZY PROTO LOADING (deferred until first use)
// ============================================================================

function resolveProtoPath(): string {
  const candidates = [
    path.join(__dirname, "proto", "encrypt_service.proto"),
    path.join(process.cwd(), "dist", "proto", "encrypt_service.proto"),
    path.join(process.cwd(), "src", "encrypt-sdk", "proto", "encrypt_service.proto"),
    path.join(process.cwd(), "..", "middleman-agent", "src", "encrypt-sdk", "proto", "encrypt_service.proto"),
  ];

  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error(
      `encrypt_service.proto not found. Tried: ${candidates.join(", ")}`
    );
  }

  return match;
}

let _EncryptServiceClient: any = null;

function getEncryptServiceClient(): any {
  if (_EncryptServiceClient) return _EncryptServiceClient;

  const protoPath = resolveProtoPath();

  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,      // camelCase field names
    longs: String,        // represent uint64 as string (avoid precision loss)
    enums: String,        // represent enums as strings
    defaults: true,       // include default values
    oneofs: true,
  });

  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
  const encryptV1 = (protoDescriptor.encrypt as any).v1;
  _EncryptServiceClient = encryptV1.EncryptService;
  return _EncryptServiceClient;
}

// ============================================================================
// PUBLIC TYPES (match official SDK exactly)
// ============================================================================

/** Chain identifier (matches proto enum). */
export const Chain = {
  Solana: 0,  // encrypt.v1.Chain.SOLANA = 0
} as const;
export type Chain = number;

/** Encrypted input for createInput. */
export interface EncryptedInput {
  ciphertextBytes: Buffer | Uint8Array;
  fheType: number;
}

// ── CreateInput ──

export interface CreateInputParams {
  chain: Chain;
  inputs: EncryptedInput[];
  proof?: Buffer;
  authorized: Buffer;
  networkEncryptionPublicKey: Buffer;
}

export interface CreateInputResult {
  ciphertextIdentifiers: Buffer[];
}

// ── ReadCiphertext ──

export interface ReadCiphertextParams {
  /** BCS-serialized ReadCiphertextMessage. */
  message: Buffer;
  /** Ed25519 signature over `message`. Not required for public ciphertexts. */
  signature: Buffer;
  /** Public key of the signer (32 bytes). */
  signer: Buffer;
}

export interface ReadCiphertextResult {
  /** Production: re-encrypted ciphertext. Mock: plaintext bytes. */
  value: Buffer;
  /** FHE type discriminator. */
  fheType: number;
  /** On-chain digest. */
  digest: Buffer;
}

/**
 * BCS-encode a ReadCiphertextMessage.
 *
 * BCS format: chain(u8) + ciphertext_identifier(vec) + reencryption_key(vec) + epoch(u64)
 * where vec = ULEB128 length prefix + bytes.
 *
 * Source: encrypt-pre-alpha/chains/solana/clients/typescript/src/grpc.ts
 */
export function encodeReadCiphertextMessage(
  chain: number,
  ciphertextIdentifier: Uint8Array,
  reencryptionKey: Uint8Array,
  epoch: bigint
): Buffer {
  const ctIdLen = ciphertextIdentifier.length;
  const rekeyLen = reencryptionKey.length;
  const totalLen = 1 + 1 + ctIdLen + 1 + rekeyLen + 8;
  const buf = Buffer.alloc(totalLen);
  let offset = 0;

  buf[offset++] = chain;
  buf[offset++] = ctIdLen; // ULEB128 (works for len < 128)
  Buffer.from(ciphertextIdentifier).copy(buf, offset);
  offset += ctIdLen;
  buf[offset++] = rekeyLen;
  Buffer.from(reencryptionKey).copy(buf, offset);
  offset += rekeyLen;
  buf.writeBigUInt64LE(epoch, offset);

  return buf;
}

/** gRPC endpoint for the Encrypt pre-alpha on Solana devnet. */
export const DEVNET_PRE_ALPHA_GRPC_URL =
  "pre-alpha-dev-1.encrypt.ika-network.net:443";

/**
 * Create a gRPC client connected to the Encrypt executor.
 *
 * Uses real protobuf binary encoding via @grpc/proto-loader.
 * Defaults to the pre-alpha devnet endpoint (TLS).
 * Pass `"localhost:50051"` for local dev.
 */
export function createEncryptClient(
  grpcUrl: string = DEVNET_PRE_ALPHA_GRPC_URL
) {
  const isLocal =
    grpcUrl.startsWith("localhost") || grpcUrl.startsWith("127.0.0.1");
  const creds = isLocal
    ? grpc.credentials.createInsecure()
    : grpc.credentials.createSsl();

  const ServiceClient = getEncryptServiceClient();
  const client = new ServiceClient(grpcUrl, creds);

  return {
    /**
     * Submit encrypted inputs and get back their on-chain identifiers.
     * Wire format: protobuf binary (CreateInputRequest → CreateInputResponse)
     */
    createInput(params: CreateInputParams): Promise<CreateInputResult> {
      return new Promise((resolve, reject) => {
        client.createInput(
          {
            chain: params.chain,
            inputs: params.inputs.map((inp) => ({
              ciphertextBytes: Buffer.from(inp.ciphertextBytes),
              fheType: inp.fheType,
            })),
            proof: params.proof ?? Buffer.alloc(0),
            authorized: Buffer.from(params.authorized),
            networkEncryptionPublicKey: Buffer.from(
              params.networkEncryptionPublicKey
            ),
          },
          (err: grpc.ServiceError | null, response: any) => {
            if (err) reject(err);
            else
              resolve({
                ciphertextIdentifiers: (response.ciphertextIdentifiers || []).map(
                  (id: any) => Buffer.from(id)
                ),
              });
          }
        );
      });
    },

    /**
     * Read a ciphertext off-chain.
     * Wire format: protobuf binary (ReadCiphertextRequest → ReadCiphertextResponse)
     *
     * For public ciphertexts: signature/signer can be zero-filled.
     * For private ciphertexts: signature must be valid ed25519 over `message`.
     *
     * Use `encodeReadCiphertextMessage()` to build the BCS message.
     */
    readCiphertext(params: ReadCiphertextParams): Promise<ReadCiphertextResult> {
      return new Promise((resolve, reject) => {
        client.readCiphertext(
          {
            message: params.message,
            signature: params.signature,
            signer: params.signer,
          },
          (err: grpc.ServiceError | null, response: any) => {
            if (err) reject(err);
            else
              resolve({
                value: Buffer.from(response.value || []),
                fheType: response.fheType ?? 0,
                digest: Buffer.from(response.digest || []),
              });
          }
        );
      });
    },

    /** Gracefully close the gRPC channel. */
    close() {
      client.close();
    },
  };
}
