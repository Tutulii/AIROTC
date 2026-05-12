import crypto from "crypto";
import { PublicKey } from "@solana/web3.js";
import { loadConfig } from "../config";
import { getConnection } from "../solana/connection";
import { loadWallet } from "../solana/wallet";
import { logger } from "../utils/logger";
import { PER_TEE_RPC_URL } from "./magicblockPerContract";
import type {
  AttestedEscrowIntent,
} from "../types/dealPipeline";
import { MeridianOtcGuard } from "./meridianOtcGuard";
import { fetchAndVerifyTeeRemoteAttestation } from "./magicblockTeeAttestationService";
import type { PerPrivateHandoffBundle } from "../protocol/privateHandoffProtocol";
import { buildPrivateHandoffBundleFromTerms } from "./privateHandoffBundleBuilder";

interface BuildPrivateEscrowIntentInput {
  ticketId: string;
  buyer: string;
  seller: string;
  liveTerms: {
    sessionPda: string;
    agreedPriceLamports: bigint;
    agreedAsset: string;
    buyerCollateralLamports: bigint;
    sellerCollateralLamports: bigint;
    status: string;
  };
  commitSignature?: string;
}

function normalizeAssetMint(asset: string): string {
  return (
    MeridianOtcGuard.normalizeSupportedAsset(asset) ||
    (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset) ? asset : "") ||
    asset
  );
}

export async function buildPrivateEscrowIntent(
  input: BuildPrivateEscrowIntentInput
): Promise<AttestedEscrowIntent> {
  const config = loadConfig();
  if (config.perStrictOpaqueMode) {
    throw new Error(
      "per_strict_opaque_mode_violation:live_terms_intent_builder_disabled"
    );
  }
  const connection = getConnection();
  const payer = loadWallet(config.privateKey);
  const bundle = await buildPrivateHandoffBundleFromTerms({
    connection,
    payer,
    authorizedProgram: new PublicKey(config.confidentialEscrowProgramId),
    sessionPda: input.liveTerms.sessionPda,
    assetMint: input.liveTerms.agreedAsset,
    assetSymbol: input.liveTerms.agreedAsset,
    priceLamports: input.liveTerms.agreedPriceLamports,
    buyerCollateralLamports: input.liveTerms.buyerCollateralLamports,
    sellerCollateralLamports: input.liveTerms.sellerCollateralLamports,
    status: input.liveTerms.status,
  });

  return buildPrivateEscrowIntentFromBundle({
    ticketId: input.ticketId,
    buyer: input.buyer,
    seller: input.seller,
    bundle,
    commitSignature: input.commitSignature,
  });
}

interface BuildPrivateEscrowIntentFromBundleInput {
  ticketId: string;
  buyer: string;
  seller: string;
  bundle: PerPrivateHandoffBundle;
  commitSignature?: string;
}

export async function buildPrivateEscrowIntentFromBundle(
  input: BuildPrivateEscrowIntentFromBundleInput
): Promise<AttestedEscrowIntent> {
  const config = loadConfig();
  const payer = loadWallet(config.privateKey);
  const remoteAttestation = await fetchAndVerifyTeeRemoteAttestation(PER_TEE_RPC_URL);
  const timestamp = new Date().toISOString();
  const intentId = crypto.randomUUID();

  const intent: AttestedEscrowIntent = {
    intentId,
    ticketId: input.ticketId,
    rollupMode: "PER",
    negotiationSource: "PER",
    buyer: input.buyer,
    seller: input.seller,
    sessionPda: input.bundle.sessionPda,
    assetMint: normalizeAssetMint(input.bundle.assetMint),
    assetSymbol: input.bundle.assetSymbol,
    handoffBundleVersion: input.bundle.version,
    termsNonceHex: input.bundle.termsNonceHex,
    termsHash: input.bundle.termsHash,
    fundingCommitments: input.bundle.fundingCommitments,
    encryptedTerms: input.bundle.encryptedTerms,
    evidence: {
      kind: "magicblock_per_live_state",
      teeRpcUrl: PER_TEE_RPC_URL,
      sessionPda: input.bundle.sessionPda,
      observedAt: timestamp,
      verifierWallet: payer.publicKey.toBase58(),
      integrityVerified: true,
      sourceEvent: "ROLLUP_CONSENSUS_REACHED",
      termsHash: input.bundle.termsHash,
      commitSignature: input.commitSignature,
      remoteAttestation,
    },
    status: "consensus_confirmed",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  logger.info("per_attested_escrow_intent_created_from_bundle", {
    ticket_id: intent.ticketId,
    intentId: intent.intentId,
    sessionPda: intent.sessionPda,
    assetMint: intent.assetMint,
    termsHash: intent.termsHash,
  });

  return intent;
}
