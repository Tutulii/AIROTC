import crypto from "crypto";
import { loadConfig } from "../config";
import { loadWallet } from "../solana/wallet";
import type {
  AttestedEscrowIntent,
  PrivateExecutionTermsSnapshot,
  SealedPrivateExecutionTerms,
} from "../types/dealPipeline";

const KEY_LABEL = "AIR_OTC_PER_EXECUTION_TERMS_V1";
const IV_BYTES = 12;

function deriveEncryptionKey(explicitKey?: Buffer): Buffer {
  if (explicitKey) {
    if (explicitKey.length !== 32) {
      throw new Error("private_execution_terms_key_override_must_be_32_bytes");
    }
    return explicitKey;
  }
  const explicit = process.env.PRIVATE_EXECUTION_TERMS_KEY?.trim();
  if (explicit) {
    if (/^[0-9a-fA-F]{64}$/.test(explicit)) {
      return Buffer.from(explicit, "hex");
    }

    const decoded = Buffer.from(explicit, "base64");
    if (decoded.length !== 32) {
      throw new Error("PRIVATE_EXECUTION_TERMS_KEY must be 32 bytes in base64 or 64 hex characters");
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

function buildAad(input: {
  ticketId: string;
  intentId: string;
  sessionPda: string;
  termsHash: string;
}): Buffer {
  return Buffer.from(
    `${input.ticketId}:${input.intentId}:${input.sessionPda}:${input.termsHash}`,
    "utf8"
  );
}

function digestSnapshot(snapshot: PrivateExecutionTermsSnapshot): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(snapshot), "utf8")
    .digest("hex");
}

export function sealPrivateExecutionTerms(input: {
  ticketId: string;
  intentId: string;
  sessionPda: string;
  termsHash: string;
  executionTerms: PrivateExecutionTermsSnapshot;
}, keyOverride?: Buffer): SealedPrivateExecutionTerms {
  const key = deriveEncryptionKey(keyOverride);
  const nonce = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(
    buildAad({
      ticketId: input.ticketId,
      intentId: input.intentId,
      sessionPda: input.sessionPda,
      termsHash: input.termsHash,
    })
  );

  const plaintext = Buffer.from(JSON.stringify(input.executionTerms), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: "aes-256-gcm",
    nonceBase64: nonce.toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
    authTagBase64: authTag.toString("base64"),
    digestHex: digestSnapshot(input.executionTerms),
  };
}

export function revealPrivateExecutionTerms(
  intent: Pick<
    AttestedEscrowIntent,
    "ticketId" | "intentId" | "sessionPda" | "termsHash" | "sealedExecutionTerms" | "executionTerms"
  >
,
  keyOverride?: Buffer
): PrivateExecutionTermsSnapshot {
  if (intent.executionTerms) {
    return intent.executionTerms;
  }

  if (!intent.sealedExecutionTerms) {
    throw new Error(`private_execution_terms_missing:${intent.intentId}`);
  }

  const sealed = intent.sealedExecutionTerms;
  if (sealed.version !== 1 || sealed.algorithm !== "aes-256-gcm") {
    throw new Error(`private_execution_terms_unsupported:${intent.intentId}`);
  }

  const key = deriveEncryptionKey(keyOverride);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.nonceBase64, "base64")
  );
  decipher.setAAD(
    buildAad({
      ticketId: intent.ticketId,
      intentId: intent.intentId,
      sessionPda: intent.sessionPda,
      termsHash: intent.termsHash,
    })
  );
  decipher.setAuthTag(Buffer.from(sealed.authTagBase64, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertextBase64, "base64")),
    decipher.final(),
  ]);
  const executionTerms = JSON.parse(plaintext.toString("utf8")) as PrivateExecutionTermsSnapshot;

  const digestHex = digestSnapshot(executionTerms);
  if (digestHex !== sealed.digestHex) {
    throw new Error(`private_execution_terms_digest_mismatch:${intent.intentId}`);
  }

  return executionTerms;
}
