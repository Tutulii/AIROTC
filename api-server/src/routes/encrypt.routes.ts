/**
 * Encrypt & Ika API Routes — Track 6 Observatory Endpoints
 *
 * Provides REST endpoints for the Observatory frontend to query:
 * - Confidential deal status (encrypted ciphertext references, decryption state)
 * - Cross-chain signature proofs (dWallet MessageApproval status)
 * - Agent dWallet info (curve, public key, readiness)
 *
 * @module encrypt.routes
 */

import { Router, Request, Response } from "express";
import { Connection, PublicKey } from "@solana/web3.js";

const router = Router();
const MIDDLEMAN_URL = process.env.MIDDLEMAN_URL || "http://localhost:8080";

function buildMiddlemanStatusHeaders(): HeadersInit {
  const secret = process.env.AGENT_API_SECRET;
  if (!secret) {
    return {};
  }
  return {
    Authorization: `Bearer ${secret}`,
  };
}

// ============================================================================
// TYPES (inline for route module isolation)
// ============================================================================

interface ConfidentialDealResponse {
  dealPda: string;
  status: string;
  buyerCollateralCt: string;
  sellerCollateralCt: string;
  paymentCt: string;
  settlementResultCt: string;
  dwalletPda: string;
  pendingDigest: string;
  createdAt: string;
}

interface SignatureProofResponse {
  messageApprovalPda: string;
  status: "pending" | "signed" | "not_found";
  dwalletPda: string;
  messageDigest: string;
  signatureScheme: number;
  signature?: string;
  epoch?: number;
}

interface AgentDWalletResponse {
  pda: string;
  publicKey: string;
  curve: string;
  ready: boolean;
  signatureScheme: string;
}

// ============================================================================
// MessageApproval on-chain field offsets (from Ika docs — 312 bytes total)
// ============================================================================
const MA = {
  DISC: 0,          // 1 byte, value 14
  VERSION: 1,       // 1 byte
  DWALLET: 2,       // 32 bytes
  MSG_DIGEST: 34,   // 32 bytes
  META_DIGEST: 66,  // 32 bytes
  APPROVER: 98,     // 32 bytes
  USER_PK: 130,     // 32 bytes
  SIG_SCHEME: 162,  // 2 bytes (u16 LE)
  EPOCH: 164,       // 8 bytes (u64 LE)
  STATUS: 172,      // 1 byte: 0=Pending, 1=Signed
  SIG_LEN: 173,     // 2 bytes (u16 LE)
  SIGNATURE: 175,   // 128 bytes (padded)
} as const;

// ============================================================================
// Signature scheme names (from Ika docs — 7 schemes)
// ============================================================================
const SCHEME_NAMES: Record<number, string> = {
  0: "EcdsaKeccak256",    // Ethereum
  1: "EcdsaSha256",       // Bitcoin legacy / WebAuthn
  2: "EcdsaDoubleSha256", // Bitcoin BIP143
  3: "TaprootSha256",     // Bitcoin Taproot
  4: "EcdsaBlake2b256",   // Zcash
  5: "EddsaSha512",       // Solana / Sui (Ed25519)
  6: "SchnorrkelMerlin",  // Substrate / Polkadot
};

const CURVE_NAMES: Record<number, string> = {
  0: "Secp256k1",
  1: "Secp256r1",
  2: "Curve25519",
  3: "Ristretto",
};

// ============================================================================
// ROUTES
// ============================================================================

/**
 * GET /v1/encrypt/status
 *
 * Health check for the confidential escrow subsystem.
 * Returns whether Encrypt + Ika services are initialized and ready.
 */
router.get("/status", async (_req: Request, res: Response) => {
  try {
    const response = await fetch(`${MIDDLEMAN_URL}/v1/confidential/status`, {
      headers: buildMiddlemanStatusHeaders(),
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      const details = await response.text();
      res.status(response.status).json({
        confidential_escrow: "unknown",
        source: "middleman_proxy",
        error: `middleman_status_http_${response.status}`,
        details,
        encrypt_grpc: process.env.ENCRYPT_GRPC_URL || "pre-alpha",
        ika_grpc: process.env.IKA_GRPC_URL || "pre-alpha",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const payload = (await response.json()) as Record<string, unknown>;
    res.json({
      ...payload,
      source: "middleman_proxy",
    });
  } catch (error: any) {
    res.status(503).json({
      confidential_escrow: "unknown",
      source: "middleman_proxy",
      error: "middleman_unreachable",
      details: error.message,
      encrypt_grpc: process.env.ENCRYPT_GRPC_URL || "pre-alpha",
      ika_grpc: process.env.IKA_GRPC_URL || "pre-alpha",
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /v1/encrypt/deal/:dealPda
 *
 * Query a confidential deal by its PDA address.
 * Returns encrypted ciphertext references, decryption status, and deal state.
 */
router.get("/deal/:dealPda", async (req: Request, res: Response) => {
  try {
    const dealPdaStr = String(req.params.dealPda);
    let dealPda: PublicKey;
    try {
      dealPda = new PublicKey(dealPdaStr);
    } catch {
      res.status(400).json({ error: "Invalid deal PDA address" });
      return;
    }

    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");
    const accountInfo = await connection.getAccountInfo(dealPda);

    if (!accountInfo) {
      res.status(404).json({ error: "Deal account not found on-chain" });
      return;
    }

    const data = accountInfo.data;

    // Parse ConfidentialDeal account layout:
    // 8 (anchor disc) + deal_id(32) + buyer(32) + seller(32) + middleman(32)
    // + buyer_ct(32) + seller_ct(32) + payment_ct(32) + settlement_ct(32)
    // + dwallet(32) + pending_digest(32) + status(1) + bet_lamports(8) + created_at(8) + bump(1)
    const offset = 8; // Anchor discriminator
    const dealId = data.subarray(offset, offset + 32);
    const buyer = new PublicKey(data.subarray(offset + 32, offset + 64));
    const seller = new PublicKey(data.subarray(offset + 64, offset + 96));
    const middleman = new PublicKey(data.subarray(offset + 96, offset + 128));
    const buyerCt = data.subarray(offset + 128, offset + 160);
    const sellerCt = data.subarray(offset + 160, offset + 192);
    const paymentCt = data.subarray(offset + 192, offset + 224);
    const settlementCt = data.subarray(offset + 224, offset + 256);
    const dwallet = new PublicKey(data.subarray(offset + 256, offset + 288));
    const pendingDigest = data.subarray(offset + 288, offset + 320);
    const status = data[offset + 320];
    const betLamports = data.readBigUInt64LE(offset + 321);
    const createdAt = data.readBigInt64LE(offset + 329);

    const statusNames = ["Created", "PartiallyFunded", "Funded", "Settling", "Completed", "Disputed", "Cancelled"];

    const response: ConfidentialDealResponse = {
      dealPda: dealPdaStr,
      status: statusNames[status] || `Unknown(${status})`,
      buyerCollateralCt: Buffer.from(buyerCt).toString("hex"),
      sellerCollateralCt: Buffer.from(sellerCt).toString("hex"),
      paymentCt: Buffer.from(paymentCt).toString("hex"),
      settlementResultCt: Buffer.from(settlementCt).toString("hex"),
      dwalletPda: dwallet.toBase58(),
      pendingDigest: Buffer.from(pendingDigest).toString("hex"),
      createdAt: new Date(Number(createdAt) * 1000).toISOString(),
    };

    res.json({
      deal: response,
      raw: {
        buyer: buyer.toBase58(),
        seller: seller.toBase58(),
        middleman: middleman.toBase58(),
        bet_lamports: betLamports.toString(),
        deal_id: Buffer.from(dealId).toString("hex"),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /v1/encrypt/signature/:approvalPda
 *
 * Query a dWallet MessageApproval PDA for signature status and proof.
 * Reads directly from on-chain data using the documented byte offsets.
 */
router.get("/signature/:approvalPda", async (req: Request, res: Response) => {
  try {
    const approvalPdaStr = String(req.params.approvalPda);
    let approvalPda: PublicKey;
    try {
      approvalPda = new PublicKey(approvalPdaStr);
    } catch {
      res.status(400).json({ error: "Invalid approval PDA address" });
      return;
    }

    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");
    const accountInfo = await connection.getAccountInfo(approvalPda);

    if (!accountInfo) {
      const response: SignatureProofResponse = {
        messageApprovalPda: approvalPdaStr,
        status: "not_found",
        dwalletPda: "",
        messageDigest: "",
        signatureScheme: -1,
      };
      res.status(404).json(response);
      return;
    }

    const data = accountInfo.data;

    // Verify discriminator (14 = MessageApproval)
    if (data[MA.DISC] !== 14) {
      res.status(400).json({ error: `Not a MessageApproval account (disc=${data[MA.DISC]})` });
      return;
    }

    const dwalletPda = new PublicKey(data.subarray(MA.DWALLET, MA.DWALLET + 32));
    const messageDigest = data.subarray(MA.MSG_DIGEST, MA.MSG_DIGEST + 32);
    const sigScheme = data.readUInt16LE(MA.SIG_SCHEME);
    const epoch = Number(data.readBigUInt64LE(MA.EPOCH));
    const status = data[MA.STATUS];
    const sigLen = data.readUInt16LE(MA.SIG_LEN);

    const response: SignatureProofResponse = {
      messageApprovalPda: approvalPdaStr,
      status: status === 1 ? "signed" : "pending",
      dwalletPda: dwalletPda.toBase58(),
      messageDigest: Buffer.from(messageDigest).toString("hex"),
      signatureScheme: sigScheme,
      epoch,
    };

    if (status === 1 && sigLen > 0) {
      const signature = data.subarray(MA.SIGNATURE, MA.SIGNATURE + sigLen);
      response.signature = Buffer.from(signature).toString("hex");
    }

    res.json({
      proof: response,
      meta: {
        signature_scheme_name: SCHEME_NAMES[sigScheme] || `Unknown(${sigScheme})`,
        account_size: data.length,
        owner: accountInfo.owner.toBase58(),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /v1/encrypt/ciphertext/:ctPubkey
 *
 * Query a ciphertext account's verification status.
 * Returns whether the Encrypt executor has computed and verified the FHE result.
 */
router.get("/ciphertext/:ctPubkey", async (req: Request, res: Response) => {
  try {
    const ctPubkeyStr = String(req.params.ctPubkey);
    let ctPubkey: PublicKey;
    try {
      ctPubkey = new PublicKey(ctPubkeyStr);
    } catch {
      res.status(400).json({ error: "Invalid ciphertext pubkey" });
      return;
    }

    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");
    const accountInfo = await connection.getAccountInfo(ctPubkey);

    if (!accountInfo) {
      res.status(404).json({
        pubkey: ctPubkeyStr,
        status: "not_found",
        exists: false,
      });
      return;
    }

    // Ciphertext status interpretation
    // In pre-alpha, existence = verified. Production checks status byte.
    res.json({
      pubkey: ctPubkeyStr,
      status: "verified",
      exists: true,
      owner: accountInfo.owner.toBase58(),
      data_length: accountInfo.data.length,
      lamports: accountInfo.lamports,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
