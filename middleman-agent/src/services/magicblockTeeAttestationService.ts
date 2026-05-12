import crypto from "crypto";
import { sha512 } from "@noble/hashes/sha2";
import { getCollateral, Quote, verify } from "@phala/dcap-qvl";
import nacl from "tweetnacl";

type FastQuoteResponse = {
  quote?: string;
  challenge?: string;
  pubkey?: string;
  signature?: string;
  error?: string;
};

export interface VerifiedTeeRemoteAttestation {
  verificationApi: "fast-quote";
  verifiedAt: string;
  challengeBase64: string;
  quoteBase64: string;
  quoteSha256: string;
  teePubkeyBase64: string;
  teeSignatureBase64: string;
}

const PHALA_PCCS_URL = "https://pccs.phala.network/tdx/certification/v4";

function decodeBase64Bytes(value: string, label: string): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`tee_attestation_invalid_${label}`);
  }
  return Buffer.from(value, "base64");
}

async function verifyRawQuote(rawQuote: Uint8Array): Promise<Quote> {
  const quoteCollateral = await getCollateral(PHALA_PCCS_URL, rawQuote);
  const now = Math.floor(Date.now() / 1000);
  verify(rawQuote, quoteCollateral, now);
  return Quote.parse(rawQuote);
}

function verifyFastQuoteBinding(
  response: Required<Pick<FastQuoteResponse, "challenge" | "pubkey" | "signature">>,
  parsedQuote: Quote,
  challengeBytes: Buffer
): void {
  const msgBytes = decodeBase64Bytes(response.challenge, "challenge");
  if (!msgBytes.equals(challengeBytes)) {
    throw new Error("tee_attestation_challenge_mismatch");
  }

  const publicKeyBytes = decodeBase64Bytes(response.pubkey, "pubkey");
  if (publicKeyBytes.length !== 32) {
    throw new Error(`tee_attestation_invalid_pubkey_length:${publicKeyBytes.length}`);
  }

  const signatureBytes = decodeBase64Bytes(response.signature, "signature");
  const signatureValid = nacl.sign.detached.verify(
    challengeBytes,
    signatureBytes,
    publicKeyBytes
  );
  if (!signatureValid) {
    throw new Error("tee_attestation_invalid_signature");
  }

  const td10 = parsedQuote.report.asTd10();
  if (!td10) {
    throw new Error("tee_attestation_unsupported_quote_report");
  }

  const reportData = Buffer.from(td10.reportData);
  if (reportData.length !== 64) {
    throw new Error(`tee_attestation_invalid_report_data_length:${reportData.length}`);
  }

  const publicKeyHash = Buffer.from(sha512(Uint8Array.from(publicKeyBytes)));
  if (!reportData.subarray(0, 64).equals(publicKeyHash)) {
    throw new Error("tee_attestation_report_data_mismatch");
  }
}

export async function fetchAndVerifyTeeRemoteAttestation(
  rpcUrl: string
): Promise<VerifiedTeeRemoteAttestation> {
  const challengeBytes = crypto.randomBytes(64);
  const challengeBase64 = challengeBytes.toString("base64");
  const response = await fetch(
    `${rpcUrl}/fast-quote?challenge=${encodeURIComponent(challengeBase64)}`
  );
  const payload = (await response.json()) as FastQuoteResponse;

  if (response.status !== 200 || !payload.quote || !payload.challenge || !payload.pubkey || !payload.signature) {
    throw new Error(payload.error || "tee_attestation_fetch_failed");
  }

  const rawQuote = Uint8Array.from(decodeBase64Bytes(payload.quote, "quote"));
  const parsedQuote = await verifyRawQuote(rawQuote);
  verifyFastQuoteBinding(
    {
      challenge: payload.challenge,
      pubkey: payload.pubkey,
      signature: payload.signature,
    },
    parsedQuote,
    challengeBytes
  );

  return {
    verificationApi: "fast-quote",
    verifiedAt: new Date().toISOString(),
    challengeBase64,
    quoteBase64: payload.quote,
    quoteSha256: crypto.createHash("sha256").update(Buffer.from(rawQuote)).digest("hex"),
    teePubkeyBase64: payload.pubkey,
    teeSignatureBase64: payload.signature,
  };
}
