import crypto from "crypto";
import { loadConfig } from "../config";
import { loadWallet } from "../solana/wallet";

const KEY_LABEL = "AIR_OTC_PRIVATE_METADATA_V1";
const IV_BYTES = 12;

export interface SealedPrivateMetadataPayload {
  version: 1;
  algorithm: "aes-256-gcm";
  nonceBase64: string;
  ciphertextBase64: string;
  authTagBase64: string;
  digestHex: string;
}

export interface SealedPrivateMetadataEnvelope {
  version: 1;
  kind: string;
  ticketId: string;
  sealed: SealedPrivateMetadataPayload;
  metadata?: Record<string, unknown>;
}

function deriveEncryptionKey(explicitKey?: Buffer): Buffer {
  if (explicitKey) {
    if (explicitKey.length !== 32) {
      throw new Error("private_metadata_key_override_must_be_32_bytes");
    }
    return explicitKey;
  }

  const explicit = process.env.PRIVATE_METADATA_SEAL_KEY?.trim();
  if (explicit) {
    if (/^[0-9a-fA-F]{64}$/.test(explicit)) {
      return Buffer.from(explicit, "hex");
    }

    const decoded = Buffer.from(explicit, "base64");
    if (decoded.length !== 32) {
      throw new Error(
        "PRIVATE_METADATA_SEAL_KEY must be 32 bytes in base64 or 64 hex characters"
      );
    }
    return decoded;
  }

  const fallback = process.env.PRIVATE_EXECUTION_TERMS_KEY?.trim();
  if (fallback) {
    if (/^[0-9a-fA-F]{64}$/.test(fallback)) {
      return Buffer.from(fallback, "hex");
    }

    const decoded = Buffer.from(fallback, "base64");
    if (decoded.length !== 32) {
      throw new Error(
        "PRIVATE_EXECUTION_TERMS_KEY must be 32 bytes in base64 or 64 hex characters"
      );
    }
    return decoded;
  }

  const config = loadConfig();
  const wallet = loadWallet(config.privateKey);
  return crypto
    .createHash("sha256")
    .update(Buffer.from(wallet.secretKey))
    .update(KEY_LABEL, "utf8")
    .digest();
}

function digestPayload(payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function buildAad(input: { kind: string; ticketId: string }): Buffer {
  return Buffer.from(`${input.kind}:${input.ticketId}`, "utf8");
}

export function sealPrivateMetadata<T>(
  input: {
    kind: string;
    ticketId: string;
    payload: T;
    metadata?: Record<string, unknown>;
  },
  keyOverride?: Buffer
): SealedPrivateMetadataEnvelope {
  const key = deriveEncryptionKey(keyOverride);
  const nonce = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(buildAad({ kind: input.kind, ticketId: input.ticketId }));

  const plaintext = Buffer.from(JSON.stringify(input.payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    kind: input.kind,
    ticketId: input.ticketId,
    sealed: {
      version: 1,
      algorithm: "aes-256-gcm",
      nonceBase64: nonce.toString("base64"),
      ciphertextBase64: ciphertext.toString("base64"),
      authTagBase64: authTag.toString("base64"),
      digestHex: digestPayload(input.payload),
    },
    metadata: input.metadata,
  };
}

export function revealPrivateMetadata<T>(
  envelope: SealedPrivateMetadataEnvelope,
  keyOverride?: Buffer
): T {
  if (envelope.version !== 1 || envelope.sealed.version !== 1) {
    throw new Error(`private_metadata_unsupported_version:${envelope.kind}`);
  }
  if (envelope.sealed.algorithm !== "aes-256-gcm") {
    throw new Error(`private_metadata_unsupported_algorithm:${envelope.kind}`);
  }

  const key = deriveEncryptionKey(keyOverride);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.sealed.nonceBase64, "base64")
  );
  decipher.setAAD(buildAad({ kind: envelope.kind, ticketId: envelope.ticketId }));
  decipher.setAuthTag(Buffer.from(envelope.sealed.authTagBase64, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.sealed.ciphertextBase64, "base64")),
    decipher.final(),
  ]);

  const payload = JSON.parse(plaintext.toString("utf8")) as T;
  const digestHex = digestPayload(payload);
  if (digestHex !== envelope.sealed.digestHex) {
    throw new Error(`private_metadata_digest_mismatch:${envelope.kind}`);
  }

  return payload;
}

export function isSealedPrivateMetadataEnvelope(
  value: unknown,
  expectedKind?: string
): value is SealedPrivateMetadataEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SealedPrivateMetadataEnvelope>;
  if (
    candidate.version !== 1 ||
    typeof candidate.kind !== "string" ||
    typeof candidate.ticketId !== "string" ||
    !candidate.sealed ||
    typeof candidate.sealed !== "object"
  ) {
    return false;
  }

  if (expectedKind && candidate.kind !== expectedKind) {
    return false;
  }

  const sealed = candidate.sealed as Partial<SealedPrivateMetadataPayload>;
  return (
    sealed.version === 1 &&
    sealed.algorithm === "aes-256-gcm" &&
    typeof sealed.nonceBase64 === "string" &&
    typeof sealed.ciphertextBase64 === "string" &&
    typeof sealed.authTagBase64 === "string" &&
    typeof sealed.digestHex === "string"
  );
}

export function computePrivateMetadataLookupHash(
  label: string,
  value: string,
  keyOverride?: Buffer
): string {
  const key = deriveEncryptionKey(keyOverride);
  return crypto
    .createHmac("sha256", key)
    .update(`${label}:${value}`, "utf8")
    .digest("hex");
}
