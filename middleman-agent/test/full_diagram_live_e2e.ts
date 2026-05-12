import path from "path";
import os from "os";
import fs from "fs";
import net from "net";
import dotenv from "dotenv";
import axios from "axios";
import nacl from "tweetnacl";
import {
  AnchorProvider,
  BN,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ConnectionMagicRouter,
  PERMISSION_PROGRAM_ID,
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { loadConfig } from "../src/config";
import { createDealPipeline } from "../src/services/dealPipeline";
import {
  executeConfidentialDeal,
  getConfidentialDealContext,
  initConfidentialEscrow,
  isConfidentialEscrowReady,
} from "../src/services/confidentialExecutionService";
import {
  PER_TEE_RPC_URL,
  PER_TEE_VALIDATOR_DEVNET,
} from "../src/services/magicblockPerContract";
import { MeridianClient } from "../src/sdk/meridianClient";
import {
  MeridianClient as AgentSdkClient,
  type RollupTerms,
} from "../agents/sdk/MeridianClient";
import {
  PrivateNegotiationService,
  waitForPermissionActivationWithFallback,
} from "../src/services/privateNegotiationService";
import { buildPrivateEscrowIntentFromBundle } from "../src/services/perEscrowIntentService";
import { buildPrivateHandoffBundleFromTerms } from "../src/services/privateHandoffBundleBuilder";
import { prepareSettlementAddressPlan as basePrepareSettlementAddressPlan } from "../src/services/settlementAddressService";
import { UmbraService } from "../src/services/umbraService";
import { releaseApprovalService } from "../src/services/releaseApprovalService";
import { confidentialFundingService } from "../src/services/confidentialFundingService";
import { eventBus } from "../src/services/eventBus";
import type {
  AttestedEscrowIntent,
  DealPipelineContext,
  DealPipelineStage,
  PipelineStageStatus,
  PrivateHandoffProofState,
  SettlementAddressPlan,
  StealthSettlementPreparation,
  VerificationSummary,
} from "../src/types/dealPipeline";
import { createNegotiationVerifier } from "../src/services/zerionVerificationService";
import { dependencyHealthService } from "../src/services/dependencyHealthService";
import { rpcManager } from "../src/utils/rpcManager";
import { sleep, withRetry } from "../src/utils/retry";
import { circuitBreaker } from "../src/utils/circuitBreaker";
import { loadWallet } from "../src/solana/wallet";
import { walletRegistry } from "../src/state/walletRegistry";
import { ticketStore } from "../src/state/ticketStore";
import { settlementTargetStore } from "../src/state/settlementTargetStore";
import { rewardTargetStore } from "../src/state/rewardTargetStore";
import { confidentialIdentityStore } from "../src/state/confidentialIdentityStore";
import { prisma } from "../src/lib/prisma";
import { startWsGateway, stopWsGateway } from "../src/gateway/wsServer";
import { initAgentMessageListener } from "../src/listeners/agentMessageListener";
import negotiationIdl from "../src/idl/magicblock_negotiation.json";
import escrowConfidentialIdl from "../../escrow/target/idl/escrow_confidential.json";

dotenv.config({ path: path.join(__dirname, "../.env") });
process.env.ENABLE_CONFIDENTIAL_ESCROW = "true";
if (process.env.DIAGRAM_E2E_WS_PORT) {
  process.env.WS_PORT = process.env.DIAGRAM_E2E_WS_PORT;
}

const config = loadConfig();
const payer = loadWallet(config.privateKey);
const NEGOTIATION_PROGRAM_ID = new PublicKey((negotiationIdl as any).address);
const NETWORK = config.network === "mainnet-beta" ? "mainnet" : "devnet";
const SPONSOR_KEYPAIR_PATH =
  process.env.DIAGRAM_E2E_SPONSOR_KEYPAIR_PATH ??
  path.join(os.homedir(), ".config/solana/id.json");
const PER_AUTH_CACHE_PATH = path.join(os.tmpdir(), "air-otc-per-auth-cache.json");
const OPERATOR_MIN_BUFFER_LAMPORTS = Math.ceil(0.15 * LAMPORTS_PER_SOL);
const UMBRA_REGISTRATION_MIN_LAMPORTS = Math.ceil(0.03 * LAMPORTS_PER_SOL);

type StageEntry = {
  stage: DealPipelineStage;
  status: PipelineStageStatus;
  details?: Record<string, unknown>;
};

type LivePipelineHarness = {
  pipeline: ReturnType<typeof createDealPipeline>;
  stages: StageEntry[];
  approvalClients?: LiveApprovalClients;
  cleanup(): void;
};

type LiveConfidentialDealState = {
  dealPda: string;
  buyerPlanApproved: boolean;
  sellerPlanApproved: boolean;
  releaseAuthorized: boolean;
  releaseExecuted: boolean;
  buyerSettlementTarget: string;
  sellerSettlementTarget: string;
};

type ApprovalMode = "both" | "buyer_only" | "none";
type RouteScope = "both" | "public_only" | "private_only";
type DeliveryEvent = {
  role: "buyer" | "seller";
  ticketId: string;
  requestKind: string;
  requestId: string;
};
type LiveApprovalClients = {
  buyer: AgentSdkClient;
  seller: AgentSdkClient;
  deliveries: DeliveryEvent[];
  privacyWallets?: {
    buyer: {
      settlementWallet: string;
      rewardWallet: string;
      fundingWallet: string;
    };
    seller: {
      settlementWallet: string;
      rewardWallet: string;
      fundingWallet: string;
    };
  };
  disconnect(): void;
};

let sponsorWalletCache: Keypair | undefined | null;
let wsGatewayStarted = false;
let agentMessageListenerStarted = false;
const perAuthTokenCache = new Map<string, { token: string; expiresAt: number }>();

function loadPersistedPerAuthCache(): void {
  try {
    if (!fs.existsSync(PER_AUTH_CACHE_PATH)) {
      return;
    }
    const raw = fs.readFileSync(PER_AUTH_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, { token: string; expiresAt: number }>;
    for (const [wallet, entry] of Object.entries(parsed)) {
      if (
        entry &&
        typeof entry.token === "string" &&
        entry.token.length > 0 &&
        typeof entry.expiresAt === "number" &&
        Number.isFinite(entry.expiresAt)
      ) {
        perAuthTokenCache.set(wallet, entry);
      }
    }
  } catch (error) {
    console.warn(`  Skipping invalid PER auth token cache at ${PER_AUTH_CACHE_PATH}: ${String(error)}`);
  }
}

function persistPerAuthCache(): void {
  const serialized = JSON.stringify(Object.fromEntries(perAuthTokenCache.entries()), null, 2);
  fs.writeFileSync(PER_AUTH_CACHE_PATH, serialized, "utf8");
}

loadPersistedPerAuthCache();

function deriveSessionPda(sessionId: bigint): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(sessionId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("session"), buf],
    NEGOTIATION_PROGRAM_ID
  );
  return pda;
}

function randomTicketId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function getBaseConnection(): Connection {
  return rpcManager.getConnection("confirmed");
}

function getBaseProgram(connection: Connection): Program {
  return new Program(
    negotiationIdl as any,
    new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" })
  );
}

function getConfidentialProgram(connection: Connection): Program {
  return new Program(
    escrowConfidentialIdl as any,
    new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" })
  );
}

function getProgramForConnection(connection: any, wallet: Keypair = payer): Program {
  return new Program(
    negotiationIdl as any,
    new AnchorProvider(connection, new Wallet(wallet), { commitment: "confirmed" })
  );
}

async function fetchConfidentialDealState(
  ticketId: string
): Promise<LiveConfidentialDealState | null> {
  const context = getConfidentialDealContext(ticketId);
  if (!context) {
    return null;
  }

  const account = (await withRetry(
    () => {
      const connection = getBaseConnection();
      const program = getConfidentialProgram(connection);
      return (program.account as any).confidentialDeal.fetch(context.dealPda);
    },
    {
      label: "diagram_fetch_confidential_deal",
      step: "fetch_confidential_deal",
    }
  )) as any;

  const settlementTargets = await settlementTargetStore.getLatestByTicket(ticketId);
  if (!settlementTargets) {
    throw new Error(`Missing settlement targets for confidential ticket ${ticketId}`);
  }

  return {
    dealPda: context.dealPda.toBase58(),
    buyerPlanApproved: Boolean(account.buyerPlanApproved),
    sellerPlanApproved: Boolean(account.sellerPlanApproved),
    releaseAuthorized: Boolean(account.releaseAuthorized),
    releaseExecuted: Boolean(account.releaseExecuted),
    buyerSettlementTarget: settlementTargets.buyerSettlementWallet,
    sellerSettlementTarget: settlementTargets.sellerSettlementWallet,
  };
}

async function waitForConfidentialDealState(
  ticketId: string,
  predicate: (state: LiveConfidentialDealState) => boolean,
  label: string,
  timeoutMs = 45_000,
  intervalMs = 500
): Promise<LiveConfidentialDealState> {
  const deadline = Date.now() + timeoutMs;
  let latest = await fetchConfidentialDealState(ticketId);

  while (Date.now() < deadline) {
    if (latest && predicate(latest)) {
      return latest;
    }
    await sleep(intervalMs);
    latest = await fetchConfidentialDealState(ticketId);
  }

  throw new Error(
    `${label} confidential deal state did not reach expectation. Latest state: ${JSON.stringify(
      latest
    )}`
  );
}

function normalizeSessionStatus(status: unknown): string {
  if (!status || typeof status !== "object") {
    return "unknown";
  }

  return Object.keys(status as Record<string, unknown>)[0] || "unknown";
}

async function fetchSessionAccount(connection: any, sessionPda: PublicKey): Promise<any> {
  return withRetry(
    () => {
      const program = getProgramForConnection(connection);
      return (program.account as any).session.fetch(sessionPda);
    },
    {
      label: "diagram_per_fetch_session",
      step: "fetch_session_account",
    }
  );
}

async function sendAndConfirmWithStatusCheck(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  context: {
    label: string;
    ticketId: string;
    step: string;
    sessionPda?: PublicKey;
  }
): Promise<string> {
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
  tx.feePayer = signers[0]?.publicKey ?? payer.publicKey;
  tx.sign(...signers);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
  });

  try {
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );

    if (confirmation.value.err) {
      throw new Error(
        `${context.label} transaction ${signature} failed: ${JSON.stringify(
          confirmation.value.err
        )}`
      );
    }

    return signature;
  } catch (error) {
    try {
      const statuses = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = statuses.value[0];
      console.warn(
        `  ${context.label} status after confirmation failure: ${JSON.stringify({
          signature,
          confirmationStatus: status?.confirmationStatus ?? null,
          confirmations: status?.confirmations ?? null,
          slot: status?.slot ?? null,
          err: status?.err ?? null,
          sessionPda: context.sessionPda?.toBase58() ?? null,
          ticketId: context.ticketId,
        })}`
      );

      if (
        status &&
        !status.err &&
        (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")
      ) {
        return signature;
      }
    } catch (statusError) {
      console.warn(
        `  ${context.label} status lookup failed for ${signature}: ${String(statusError)}`
      );
    }
    throw error;
  }
}

async function fetchPrivateHandoffProofFromSession(
  connection: any,
  sessionPda: PublicKey
): Promise<PrivateHandoffProofState> {
  const account = await fetchSessionAccount(connection, sessionPda);
  const termsHash = Buffer.from(account.termsHash ?? []).toString("hex");

  return {
    sessionPda: sessionPda.toBase58(),
    buyer: new PublicKey(account.buyerParticipant).toBase58(),
    seller: new PublicKey(account.sellerParticipant).toBase58(),
    status: normalizeSessionStatus(account.status),
    termsHash,
    buyerPaymentFundingHash: Buffer.from(account.buyerPaymentFundingHash ?? []).toString("hex"),
    buyerCollateralFundingHash: Buffer.from(account.buyerCollateralFundingHash ?? []).toString("hex"),
    sellerCollateralFundingHash: Buffer.from(account.sellerCollateralFundingHash ?? []).toString("hex"),
    buyerCollateralCiphertext: new PublicKey(account.buyerCollateralCiphertext).toBase58(),
    sellerCollateralCiphertext: new PublicKey(account.sellerCollateralCiphertext).toBase58(),
    paymentAmountCiphertext: new PublicKey(account.paymentAmountCiphertext).toBase58(),
    settlementResultCiphertext: new PublicKey(account.settlementResultCiphertext).toBase58(),
    networkEncryptionKeyPda: new PublicKey(account.networkEncryptionKey).toBase58(),
    proofRecordedAt: new Date(
      Number(account.proofRecordedAt?.toString?.() ?? account.proofRecordedAt ?? 0) * 1000
    ).toISOString(),
  };
}

async function recordPrivateHandoffProofOnTee(
  sessionId: bigint,
  authorityConnection: any,
  intent: AttestedEscrowIntent
): Promise<string> {
  const program = getProgramForConnection(authorityConnection);
  return withRetry(
    () =>
      (program.methods as any)
        .recordPrivateHandoffProof(
          new BN(sessionId.toString()),
          new PublicKey(intent.buyer),
          new PublicKey(intent.seller),
          Array.from(Buffer.from(intent.termsHash, "hex")),
          Array.from(Buffer.from(intent.fundingCommitments.buyerPaymentHash, "hex")),
          Array.from(Buffer.from(intent.fundingCommitments.buyerCollateralHash, "hex")),
          Array.from(Buffer.from(intent.fundingCommitments.sellerCollateralHash, "hex")),
          new PublicKey(intent.encryptedTerms.buyerCollateral.account),
          new PublicKey(intent.encryptedTerms.sellerCollateral.account),
          new PublicKey(intent.encryptedTerms.paymentAmount.account),
          new PublicKey(intent.encryptedTerms.settlementResult.account),
          new PublicKey(intent.encryptedTerms.networkEncryptionKeyPda)
        )
        .accounts({
          payer: payer.publicKey,
        })
        .rpc(),
    {
      label: "diagram_per_record_private_handoff_proof",
      step: "record_private_handoff_proof",
    }
  );
}

function loadSponsorWallet(): Keypair | null {
  if (sponsorWalletCache !== undefined) {
    return sponsorWalletCache;
  }

  if (!fs.existsSync(SPONSOR_KEYPAIR_PATH)) {
    sponsorWalletCache = null;
    return sponsorWalletCache;
  }

  try {
    const secretKey = Uint8Array.from(
      JSON.parse(fs.readFileSync(SPONSOR_KEYPAIR_PATH, "utf8"))
    );
    const sponsor = Keypair.fromSecretKey(secretKey);
    sponsorWalletCache = sponsor.publicKey.equals(payer.publicKey) ? null : sponsor;
    return sponsorWalletCache;
  } catch (error) {
    throw new Error(
      `Failed to load sponsor keypair from ${SPONSOR_KEYPAIR_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function selectFundingWallet(
  target: PublicKey,
  requiredLamports: number
): Promise<Keypair> {
  const payerBalance = await withRetry(
    () => getBaseConnection().getBalance(payer.publicKey, "confirmed"),
    { label: "diagram_e2e_get_payer_balance", step: "fund_wallet" }
  );

  if (!payer.publicKey.equals(target) && payerBalance >= requiredLamports) {
    return payer;
  }

  const sponsor = loadSponsorWallet();
  if (!sponsor) {
    throw new Error(
      `Operator wallet ${payer.publicKey.toBase58()} is underfunded and no sponsor keypair is available at ${SPONSOR_KEYPAIR_PATH}.`
    );
  }

  const sponsorBalance = await withRetry(
    () => getBaseConnection().getBalance(sponsor.publicKey, "confirmed"),
    { label: "diagram_e2e_get_sponsor_balance", step: "fund_wallet" }
  );

  if (sponsorBalance < requiredLamports) {
    throw new Error(
      `Sponsor wallet ${sponsor.publicKey.toBase58()} has ${sponsorBalance} lamports, below the required ${requiredLamports} lamports.`
    );
  }

  return sponsor;
}

async function topUpWallet(
  target: PublicKey,
  minimumLamports: number,
  reason = "fund_wallet"
): Promise<void> {
  const current = await withRetry(
    () => getBaseConnection().getBalance(target, "confirmed"),
    { label: "diagram_e2e_get_balance", step: reason }
  );

  if (current >= minimumLamports) {
    return;
  }

  const needed = minimumLamports - current;
  const fundingWallet = await selectFundingWallet(target, needed + 50_000);
  const signature = await withRetry(
    () =>
      sendAndConfirmTransaction(
        getBaseConnection(),
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: fundingWallet.publicKey,
            toPubkey: target,
            lamports: needed,
          })
        ),
        [fundingWallet],
        { commitment: "confirmed" }
      ),
    { label: "diagram_e2e_top_up_wallet", step: reason }
  );

  console.log(
    `  funded ${target.toBase58()} with ${needed / LAMPORTS_PER_SOL} SOL from ${fundingWallet.publicKey.toBase58()} (${signature})`
  );
}

async function ensureUmbraRegistration(participant: Keypair): Promise<void> {
  await topUpWallet(
    participant.publicKey,
    UMBRA_REGISTRATION_MIN_LAMPORTS,
    "umbra_registration"
  );
  const service = new UmbraService(
    participant.secretKey,
    config.solanaRpcUrl,
    NETWORK
  );
  await service.initClient();
  await service.ensureRegistered();
}

function createVerifier() {
  return createNegotiationVerifier({
    getConnection: () => getBaseConnection(),
    withRetry,
    loadConfig: () => loadConfig(),
    httpGet: axios.get.bind(axios),
    validateEconomicSafety: async () => ({
      valid: true,
      errors: [],
      warnings: [],
    }),
  });
}

async function getAuthTokenFor(keypair: Keypair): Promise<string> {
  const cacheKey = keypair.publicKey.toBase58();
  const cached = perAuthTokenCache.get(cacheKey);
  if (cached && cached.expiresAt - 60_000 > Date.now()) {
    return cached.token;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const auth = await getAuthToken(
        PER_TEE_RPC_URL,
        keypair.publicKey,
        async (message: Uint8Array) => nacl.sign.detached(message, keypair.secretKey)
      );
      perAuthTokenCache.set(cacheKey, auth);
      persistPerAuthCache();
      return auth.token;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const transientAuthFailure =
        lower.includes("failed to authenticate") ||
        lower.includes("too many open files") ||
        lower.includes("scorechain client") ||
        lower.includes("no native root ca certificates") ||
        lower.includes("timeout") ||
        lower.includes("unavailable");
      if (!transientAuthFailure || attempt === 4) {
        throw error;
      }
      console.warn(
        `  PER auth token retry for ${cacheKey} attempt ${attempt}/4: ${message}`
      );
      await sleep(1_500 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function submitReleaseApprovalFromRequest(
  ticketId: string,
  signer: Keypair,
  request: {
    requestId: string;
    messageBase64: string;
  }
): Promise<void> {
  const agent = await walletRegistry.getOrCreateAgent(signer.publicKey.toBase58());
  const signature = nacl.sign.detached(
    Buffer.from(request.messageBase64, "base64"),
    signer.secretKey
  );

  await releaseApprovalService.processAgentResponse({
    version: "1.0",
    type: "RELEASE_APPROVAL_RESPONSE",
    ticket_id: ticketId,
    agent_id: agent.id,
    timestamp: Date.now(),
    requestId: request.requestId,
    signatureBase64: Buffer.from(signature).toString("base64"),
  });
}

async function registerLiveTicketRow(params: {
  ticketId: string;
  buyer: string;
  seller: string;
  rollupMode: "ER" | "PER";
  tokenMint?: string;
  decimals?: number;
}): Promise<void> {
  await ticketStore.createTicket({
    ticket_id: params.ticketId,
    offer_id: params.ticketId,
    buyer: params.buyer,
    seller: params.seller,
    status: "active",
    rollup_mode: params.rollupMode,
    tokenMint: params.tokenMint,
    decimals: params.decimals,
    created_at: new Date().toISOString(),
  });
}

async function prepareLiveTicketTargets(params: {
  ticketId: string;
  buyer: Keypair;
  seller: Keypair;
  privacyWallets?: LiveApprovalClients["privacyWallets"];
}): Promise<void> {
  const existingSettlement = await settlementTargetStore.getLatestByTicket(params.ticketId);
  if (!existingSettlement) {
    const generatedBuyerSettlementWallet = params.privacyWallets?.buyer.settlementWallet
      ? null
      : Keypair.generate();
    const generatedSellerSettlementWallet = params.privacyWallets?.seller.settlementWallet
      ? null
      : Keypair.generate();

    if (generatedBuyerSettlementWallet) {
      await ensureUmbraRegistration(generatedBuyerSettlementWallet);
    }
    if (generatedSellerSettlementWallet) {
      await ensureUmbraRegistration(generatedSellerSettlementWallet);
    }

    await settlementTargetStore.save({
      ticketId: params.ticketId,
      buyerWallet: params.buyer.publicKey.toBase58(),
      sellerWallet: params.seller.publicKey.toBase58(),
      buyerSettlementWallet:
        params.privacyWallets?.buyer.settlementWallet ??
        generatedBuyerSettlementWallet!.publicKey.toBase58(),
      sellerSettlementWallet:
        params.privacyWallets?.seller.settlementWallet ??
        generatedSellerSettlementWallet!.publicKey.toBase58(),
      source: "test_context",
      recordedAt: new Date().toISOString(),
      notes: ["Harness-backed live diagram proof prepared fresh per-deal Umbra settlement wallets."],
    });
  }

  const existingReward = await rewardTargetStore.getLatestByTicket(params.ticketId);
  if (!existingReward) {
    await rewardTargetStore.save({
      ticketId: params.ticketId,
      buyerWallet: params.buyer.publicKey.toBase58(),
      sellerWallet: params.seller.publicKey.toBase58(),
      buyerRewardWallet:
        params.privacyWallets?.buyer.rewardWallet ?? Keypair.generate().publicKey.toBase58(),
      sellerRewardWallet:
        params.privacyWallets?.seller.rewardWallet ?? Keypair.generate().publicKey.toBase58(),
      source: "test_context",
      recordedAt: new Date().toISOString(),
      notes: ["Harness-backed live diagram proof prepared fresh per-deal reward wallets."],
    });
  }

  const existingConfidentialIdentities = await confidentialIdentityStore.getLatestByTicket(params.ticketId);
  if (!existingConfidentialIdentities) {
    await confidentialIdentityStore.save({
      ticketId: params.ticketId,
      buyerWallet: params.buyer.publicKey.toBase58(),
      sellerWallet: params.seller.publicKey.toBase58(),
      buyerFundingWallet:
        params.privacyWallets?.buyer.fundingWallet ?? Keypair.generate().publicKey.toBase58(),
      sellerFundingWallet:
        params.privacyWallets?.seller.fundingWallet ?? Keypair.generate().publicKey.toBase58(),
      source: "test_context",
      recordedAt: new Date().toISOString(),
      notes: [
        "Harness-backed live diagram proof prepared fresh per-deal confidential signer wallets.",
      ],
    });
  }
}

async function cleanupLiveTicketRow(ticketId: string): Promise<void> {
  await prisma.$transaction([
    prisma.message.deleteMany({ where: { ticketId } }),
    prisma.negotiation.deleteMany({ where: { ticketId } }),
    prisma.vectorMemory.deleteMany({ where: { ticketId } }),
    prisma.outboundMessage.deleteMany({ where: { ticketId } }),
    prisma.executionContext.deleteMany({ where: { ticketId } }),
    prisma.decisionLog.deleteMany({ where: { ticketId } }),
    prisma.ticket.deleteMany({ where: { id: ticketId } }),
  ]);
}

async function ensureWsGatewayStarted(): Promise<void> {
  if (wsGatewayStarted) {
    return;
  }
  if (!process.env.WS_PORT) {
    process.env.WS_PORT = String(await findFreePort());
  }
  startWsGateway();
  wsGatewayStarted = true;
  if (!agentMessageListenerStarted) {
    initAgentMessageListener();
    agentMessageListenerStarted = true;
  }
  await sleep(100);
}

function attachHarnessPipelineBridges(
  ticketId: string,
  pipeline: ReturnType<typeof createDealPipeline>
): () => void {
  const onFundingSubmitted = async (payload: any) => {
    if (payload.ticketId !== ticketId) {
      return;
    }

    try {
      await confidentialFundingService.processAgentSubmission(payload);
    } catch (error) {
      console.error(
        `[Live Diagram E2E] funding submission bridge failed for ${ticketId}: ${String(error)}`
      );
    }
  };

  const onFundingCompleted = async (payload: any) => {
    if (payload.ticketId !== ticketId) {
      return;
    }

    try {
      await pipeline.continueConfidentialSettlementAfterFunding(payload.ticketId);
    } catch (error) {
      console.error(
        `[Live Diagram E2E] funding resume bridge failed for ${ticketId}: ${String(error)}`
      );
    }
  };

  eventBus.subscribe("confidential_funding_submitted", onFundingSubmitted);
  eventBus.subscribe("confidential_funding_completed", onFundingCompleted);

  return () => {
    eventBus.unsubscribe("confidential_funding_submitted", onFundingSubmitted);
    eventBus.unsubscribe("confidential_funding_completed", onFundingCompleted);
  };
}

function buildWsUrl(): string {
  return `ws://127.0.0.1:${process.env.WS_PORT || "3001"}`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to resolve free WebSocket port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function connectLiveApprovalClients(
  ticketId: string,
  buyer: Keypair,
  seller: Keypair,
  approvalMode: ApprovalMode,
  privateMode: boolean,
  privateTerms?: RollupTerms
): Promise<LiveApprovalClients> {
  await ensureWsGatewayStarted();

  const deliveries: DeliveryEvent[] = [];
  const wsUrl = buildWsUrl();
  const buyerClient = new AgentSdkClient({
    apiUrl: "http://127.0.0.1:3000",
    wsUrl,
    keypair: buyer,
    rpcUrl: config.solanaRpcUrl,
    privateMode,
  });
  const sellerClient = new AgentSdkClient({
    apiUrl: "http://127.0.0.1:3000",
    wsUrl,
    keypair: seller,
    rpcUrl: config.solanaRpcUrl,
    privateMode,
  });

  const attach = (
    client: AgentSdkClient,
    role: "buyer" | "seller",
    autoApproveSettlementPlan: boolean
  ) => {
    if (autoApproveSettlementPlan) {
      client.setAutoApprovalPolicy({
        allowedAssets: ["SOL"],
        maxPrice: 10,
        maxCollateral: 10,
        requireStealthSettlement: true,
      });
    }

    client.on("release_approval_request", (request: any) => {
      deliveries.push({
        role,
        ticketId: request.ticketId,
        requestKind: request.requestKind,
        requestId: request.requestId,
      });

      if (role === "buyer" && request.requestKind === "BUYER_RELEASE_CONFIRMATION") {
        void client.approveRelease(request.ticketId).catch((error: unknown) => {
          console.error(`[Live Approval E2E] buyer release confirmation failed: ${String(error)}`);
        });
      }
    });

    client.on("confidential_funding_request", (request: any) => {
      deliveries.push({
        role,
        ticketId: request.ticketId,
        requestKind: request.requestKind,
        requestId: request.requestId,
      });

      void client.fundConfidentialDeal(request.ticketId).catch((error: unknown) => {
        console.error(`[Live Approval E2E] ${role} confidential funding failed: ${String(error)}`);
      });
    });
  };

  attach(buyerClient, "buyer", approvalMode === "both" || approvalMode === "buyer_only");
  attach(sellerClient, "seller", approvalMode === "both");

  if (privateMode && privateTerms) {
    buyerClient.rememberPrivateTerms(ticketId, privateTerms);
    sellerClient.rememberPrivateTerms(ticketId, privateTerms);
  }

  const privacyWallets = {
    buyer: await buyerClient.prepareDirectTicketPrivacyWallets(ticketId),
    seller: await sellerClient.prepareDirectTicketPrivacyWallets(ticketId),
  };

  await Promise.all([buyerClient.connect(), sellerClient.connect()]);

  return {
    buyer: buyerClient,
    seller: sellerClient,
    deliveries,
    privacyWallets,
    disconnect: () => {
      buyerClient.disconnect();
      sellerClient.disconnect();
    },
  };
}

async function waitForReleaseApprovalState(
  ticketId: string,
  predicate: (
    state: Awaited<ReturnType<typeof releaseApprovalService.getLatestState>>
  ) => boolean,
  timeoutMs = 60_000,
  intervalMs = 500
) {
  const deadline = Date.now() + timeoutMs;
  let latest = await releaseApprovalService.getLatestState(ticketId);

  while (Date.now() < deadline) {
    if (predicate(latest)) {
      return latest;
    }
    await sleep(intervalMs);
    latest = await releaseApprovalService.getLatestState(ticketId);
  }

  return latest;
}

async function waitForHarnessStage(
  harness: LivePipelineHarness,
  predicate: (entry: StageEntry) => boolean,
  label: string,
  timeoutMs = Math.max(120_000, (config.releaseDisputeWindowSeconds + 45) * 1000),
  intervalMs = 500
): Promise<StageEntry> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const matched = [...harness.stages].reverse().find(predicate);
    if (matched) {
      return matched;
    }

    const failed = [...harness.stages]
      .reverse()
      .find((entry) => entry.stage === "failed" || entry.status === "failed");
    if (failed) {
      throw new Error(`${label} reached failed stage: ${JSON.stringify(failed)}`);
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `${label} did not reach the expected stage before timeout. Seen stages: ${harness.stages
      .map((entry) => `${entry.stage}:${entry.status}`)
      .join(", ")}`
  );
}

function assertExpectedApprovalDeliveries(
  label: string,
  approvalClients: LiveApprovalClients | undefined,
  ticketId: string,
  approvalMode: ApprovalMode
): void {
  if (!approvalClients) {
    return;
  }

  const events = approvalClients.deliveries.filter((entry) => entry.ticketId === ticketId);
  const buyerSettlementPlan = events.filter(
    (entry) => entry.role === "buyer" && entry.requestKind === "SETTLEMENT_PLAN"
  ).length;
  const sellerSettlementPlan = events.filter(
    (entry) => entry.role === "seller" && entry.requestKind === "SETTLEMENT_PLAN"
  ).length;
  const buyerReleaseConfirmation = events.filter(
    (entry) => entry.role === "buyer" && entry.requestKind === "BUYER_RELEASE_CONFIRMATION"
  ).length;

  if (buyerSettlementPlan < 1) {
    throw new Error(`${label} buyer never received the settlement-plan request over WebSocket`);
  }
  if (sellerSettlementPlan < 1) {
    throw new Error(`${label} seller never received the settlement-plan request over WebSocket`);
  }
  if (approvalMode === "both" && buyerReleaseConfirmation < 1) {
    throw new Error(
      `${label} buyer never received the final release-confirmation request over WebSocket`
    );
  }
  if (approvalMode === "buyer_only" && buyerReleaseConfirmation !== 0) {
    throw new Error(
      `${label} should not produce a buyer release-confirmation request before seller approval`
    );
  }
}

async function buildHarness(
  ticketId: string,
  ticket: {
    buyer: string;
    seller: string;
    rollup_mode: "ER" | "PER";
    tokenMint?: string;
    decimals?: number;
  },
  extra: {
    finalizePrivateTicket?: () => Promise<string | null>;
    fetchLivePrivateHandoffProof?: () => Promise<PrivateHandoffProofState>;
    approvalSigners?: {
      buyer: Keypair;
      seller: Keypair;
    };
    approvalClients?: LiveApprovalClients;
    approvalMode?: ApprovalMode;
  } = {}
): Promise<LivePipelineHarness> {
  // This file is a harness-backed live proof. It uses real WebSocket delivery,
  // live vendor services, and on-chain assertions, but it still injects an
  // in-memory pipeline shell instead of booting the full frontend/api runtime.
  const stages: StageEntry[] = [];
  let latestStage: StageEntry | null = null;
  let rememberedTerms: any = null;
  let latestPrivateIntent: AttestedEscrowIntent | null = null;
  const verifier = createVerifier();

  const approvalServiceHarness = {
    initializeApprovalRequests: async (
      context: DealPipelineContext,
      prepared: any,
      settlementPlan: SettlementAddressPlan,
      attestedEscrowIntent?: AttestedEscrowIntent
    ) => {
      const snapshot = await releaseApprovalService.initializeApprovalRequests(
        context,
        prepared,
        settlementPlan,
        attestedEscrowIntent
      );

      if (extra.approvalClients || !extra.approvalSigners) {
        return snapshot;
      }

      const approvalMode = extra.approvalMode || "both";
      const approvals: Array<["buyer" | "seller", Keypair]> =
        approvalMode === "both"
          ? [
              ["buyer", extra.approvalSigners.buyer],
              ["seller", extra.approvalSigners.seller],
            ]
          : approvalMode === "buyer_only"
            ? [["buyer", extra.approvalSigners.buyer]]
            : [];

      for (const [role, signer] of approvals) {
        const request = role === "buyer" ? snapshot.buyerRequest : snapshot.sellerRequest;
        await submitReleaseApprovalFromRequest(context.ticketId, signer, request);
      }
      let latestState =
        (await releaseApprovalService.getLatestState(context.ticketId)) || snapshot;

      if (approvalMode === "both" && latestState.buyerReleaseRequest) {
        await submitReleaseApprovalFromRequest(
          context.ticketId,
          extra.approvalSigners.buyer,
          latestState.buyerReleaseRequest
        );
        latestState =
          (await releaseApprovalService.getLatestState(context.ticketId)) || latestState;
      }

      return latestState;
    },
    getLatestState: (ticketId: string) => releaseApprovalService.getLatestState(ticketId),
    maybeAuthorizeRelease: (ticketId: string, state?: any) =>
      releaseApprovalService.maybeAuthorizeRelease(ticketId, state),
    markReleaseSigned: (...args: Parameters<typeof releaseApprovalService.markReleaseSigned>) =>
      releaseApprovalService.markReleaseSigned(...args),
    markReleaseExecuted: (...args: Parameters<typeof releaseApprovalService.markReleaseExecuted>) =>
      releaseApprovalService.markReleaseExecuted(...args),
  };

  const pipeline = createDealPipeline({
    loadConfig: () => ({
      ...loadConfig(),
      enableConfidentialEscrow: true,
    }),
    ticketStore: {
      getTicket: async (requestedTicketId: string) => {
        if (requestedTicketId !== ticketId) return undefined;
        return {
          ticket_id: ticketId,
          offer_id: ticketId,
          buyer: ticket.buyer,
          seller: ticket.seller,
          status: "active",
          rollup_mode: ticket.rollup_mode,
          tokenMint: ticket.tokenMint,
          decimals: ticket.decimals,
          created_at: new Date().toISOString(),
          agreed_terms: rememberedTerms,
        };
      },
      recordNegotiatedTerms: async (_ticketId: string, terms: any) => {
        rememberedTerms = terms;
      },
    },
    dealTracker: {
      initDeal: async () =>
        ({
        id: ticketId,
        ticketId,
        buyerId: ticket.buyer,
        sellerId: ticket.seller,
        middlemanId: "system",
        price: 0,
        collateralBuyer: 0,
        collateralSeller: 0,
        status: "pending_execution",
        timeout: new Date(Date.now() + 30 * 60 * 1000),
        createdAt: new Date(),
        dealIdOnChain: null,
        tokenMint: null,
        decimals: null,
        termsHash: null,
        termsNonce: null,
        termsRevealed: false,
        tradeMode: "Normal",
      } as any),
      storeOnChainId: async () => undefined,
      updateStatus: async () => undefined,
    },
    getPrivacyStatus: async () => ({
      isPrivacyMode: true,
      privacyProtocol: ticket.rollup_mode === "PER" ? "MAGICBLOCK_PER" : "UMBRA",
      termsHash: null,
      termsRevealed: true,
      canReveal: false,
    }),
    pipelineStateStore: {
      markStage: async (_ticketId: string, stage: DealPipelineStage, status: PipelineStageStatus, details?: Record<string, unknown>) => {
        latestStage = { stage, status, details };
        stages.push({ stage, status, details });
      },
      markRouteSelected: async (_ticketId: string, context: DealPipelineContext) => {
        latestStage = {
          stage: "route_selected",
          status: "confirmed",
          details: {
            route: context.route,
            executionPolicy: context.executionPolicy,
            settlementPolicy: context.settlementPolicy,
          },
        };
        stages.push(latestStage);
      },
      getLatestStage: async () =>
        latestStage
          ? {
              ticketId,
              stage: latestStage.stage,
              status: latestStage.status,
              createdAt: new Date().toISOString(),
            }
          : null,
    },
    privateEscrowIntentStore: {
      save: async (intent: AttestedEscrowIntent) => {
        latestPrivateIntent = intent;
      },
      getLatestByTicket: async (requestedTicketId: string) =>
        latestPrivateIntent?.ticketId === requestedTicketId ? latestPrivateIntent : null,
      getByIntentId: async (requestedTicketId: string, intentId: string) =>
        latestPrivateIntent?.ticketId === requestedTicketId &&
        latestPrivateIntent.intentId === intentId
          ? latestPrivateIntent
          : null,
      updateStatus: async (_ticketId: string, intentId: string, next: any) => {
        if (!latestPrivateIntent || latestPrivateIntent.intentId !== intentId) {
          return null;
        }
        latestPrivateIntent = {
          ...latestPrivateIntent,
          status: next.status ?? latestPrivateIntent.status,
          dealPda: next.dealPda ?? latestPrivateIntent.dealPda,
          updatedAt: next.updatedAt || new Date().toISOString(),
        };
        return latestPrivateIntent;
      },
    },
    eventBus: {
      publish: () => undefined,
    },
    appendAuditLog: async () => undefined,
    executeCreateDealPhase: async () => {
      throw new Error("Full diagram live E2E should not route through standard escrow");
    },
    isConfidentialEscrowReady,
    initConfidentialEscrow,
    executeConfidentialDeal,
    verifyNegotiationForExecution: async (context: DealPipelineContext): Promise<VerificationSummary> =>
      verifier.verifyNegotiationForExecution(context),
    prepareSettlementAddressPlan: basePrepareSettlementAddressPlan,
    prepareStealthSettlement: async (
      context: DealPipelineContext,
      settlementPlan: SettlementAddressPlan
    ): Promise<StealthSettlementPreparation> => ({
      dealId: `${context.ticketId}-stealth-deal`,
      settlementId: `${context.ticketId}-stealth-channel`,
      mint: settlementPlan.assetMint || "unknown",
      phase: "READY",
      created: true,
    }),
    executeStealthSettlement: async () => {
      throw new Error("Confidential route should resolve stealth targets, not run the standard Umbra settlement branch");
    },
    activateStandardEscrowLifecycle: async () => ({
      phase: "created_awaiting_deposits",
      watcherAttached: true,
      depositInstructionsPublished: true,
    }),
    releaseApprovalService: approvalServiceHarness,
    magicBlockSessions: {
      finalizePrivateTicket: async () => {
        if (!extra.finalizePrivateTicket) return null;
        return extra.finalizePrivateTicket();
      },
      completeTicketSession: () => undefined,
      fetchLivePrivateHandoffProof: async () => {
        if (!extra.fetchLivePrivateHandoffProof) {
          throw new Error(
            "Full diagram live E2E harness did not provide a PER private-handoff proof fetch"
          );
        }
        return extra.fetchLivePrivateHandoffProof();
      },
    },
  });

  const detachBridges = attachHarnessPipelineBridges(ticketId, pipeline);

  return {
    pipeline,
    stages,
    approvalClients: extra.approvalClients,
    cleanup: detachBridges,
  };
}

async function finalizeBlockedApprovalRoute(
  ticketId: string,
  harness: LivePipelineHarness,
  buyer: Keypair,
  seller: Keypair,
  resumeAfterApproval?: () => Promise<{ success: boolean; status: string }>
): Promise<void> {
  const approvalState = await releaseApprovalService.getLatestState(ticketId);
  if (!approvalState) {
    throw new Error(`approval state missing for blocked route ${ticketId}`);
  }

  if (harness.approvalClients) {
    await harness.approvalClients.seller.approveRelease(ticketId);
    const sellerApprovedState = await waitForReleaseApprovalState(
      ticketId,
      (state) => Boolean(state?.sellerApproval?.active && state?.buyerReleaseRequest),
      60_000,
      500
    );
    if (!sellerApprovedState?.sellerApproval?.active) {
      throw new Error(`seller approval was not recorded during blocked-route cleanup for ${ticketId}`);
    }
    const buyerReleaseState = await waitForReleaseApprovalState(
      ticketId,
      (state) => Boolean(state?.buyerReleaseConfirmed || state?.releaseAuthorized),
      60_000,
      500
    );
    if (!buyerReleaseState?.buyerReleaseConfirmed && !buyerReleaseState?.releaseAuthorized) {
      throw new Error(
        `buyer release confirmation was not recorded during blocked-route cleanup for ${ticketId}`
      );
    }
  } else {
    await submitReleaseApprovalFromRequest(ticketId, seller, approvalState.sellerRequest);
    const postSellerApproval = await releaseApprovalService.getLatestState(ticketId);
    if (!postSellerApproval?.buyerReleaseRequest) {
      throw new Error(`buyer release confirmation request missing for ${ticketId}`);
    }
    await submitReleaseApprovalFromRequest(
      ticketId,
      buyer,
      postSellerApproval.buyerReleaseRequest
    );
  }
  const resumed = await waitForSettlement(
    resumeAfterApproval
      ? resumeAfterApproval
      : () => harness.pipeline.continueConfidentialRelease(ticketId),
    `blocked-route cleanup ${ticketId}`
  );
  if (!resumed.success || resumed.status !== "settled") {
    throw new Error(`blocked-route cleanup failed to settle: ${JSON.stringify(resumed)}`);
  }
}

async function assertBlockedAtApprovalGate(
  label: string,
  ticketId: string,
  result: any,
  harness: LivePipelineHarness
): Promise<void> {
  if (!result.success || result.status !== "awaiting_settlement_plan_approvals") {
    throw new Error(
      `${label} should be blocked at awaiting_settlement_plan_approvals, got ${JSON.stringify(result)}`
    );
  }

  const approvalState = await waitForReleaseApprovalState(
    ticketId,
    (state) => Boolean(state?.buyerApproval?.active) || !harness.approvalClients,
    harness.approvalClients ? 60_000 : 5_000,
    harness.approvalClients ? 500 : 250
  );
  if (!approvalState) {
    throw new Error(`${label} approval state missing`);
  }
  if (!approvalState.buyerApproval?.active) {
    const deliveries =
      harness.approvalClients?.deliveries
        .filter((entry) => entry.ticketId === ticketId)
        .map((entry) => `${entry.role}:${entry.requestKind}:${entry.requestId}`)
        .join(", ") || "none";
    throw new Error(
      `${label} buyer approval was not recorded within timeout. Delivered requests: ${deliveries}`
    );
  }
  if (approvalState.sellerApproval?.active) {
    throw new Error(`${label} seller approval should not be active`);
  }
  if (approvalState.releaseAuthorized) {
    throw new Error(`${label} release should not be authorized`);
  }

  const dealState = await waitForConfidentialDealState(
    ticketId,
    (state) => state.buyerPlanApproved && !state.releaseExecuted,
    `${label} blocked approval gate`
  );
  if (!dealState.buyerPlanApproved) {
    throw new Error(`${label} buyer plan approval did not reach the on-chain deal state`);
  }
  if (dealState.sellerPlanApproved) {
    throw new Error(`${label} seller plan approval should not be active on-chain`);
  }
  if (dealState.releaseAuthorized) {
    throw new Error(`${label} release became authorized on-chain before seller approval`);
  }
  if (dealState.releaseExecuted) {
    throw new Error(`${label} release executed before both approvals`);
  }

  console.log(`  ${label} blocked at awaiting_settlement_plan_approvals as expected.`);
  console.log(`  Buyer approval active:  ${approvalState.buyerApproval?.active ? "yes" : "no"}`);
  console.log(`  Seller approval active: ${approvalState.sellerApproval?.active ? "yes" : "no"}`);
  console.log(`  Buyer plan approval on-chain:  ${dealState.buyerPlanApproved ? "yes" : "no"}`);
  console.log(`  Seller plan approval on-chain: ${dealState.sellerPlanApproved ? "yes" : "no"}`);
  console.log(`  Release executed on-chain:     ${dealState.releaseExecuted ? "yes" : "no"}`);
}

async function waitForSettlement(
  resume: () => Promise<{ success: boolean; status: string }>,
  label: string,
  timeoutMs = Math.max(120_000, (config.releaseDisputeWindowSeconds + 45) * 1000)
): Promise<{ success: boolean; status: string }> {
  let latest = await resume();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!latest.success || latest.status === "settled") {
      return latest;
    }
    if (
      latest.status !== "created_awaiting_deposits" &&
      latest.status !== "awaiting_settlement_plan_approvals" &&
      latest.status !== "awaiting_buyer_release_confirmation" &&
      latest.status !== "seller_dispute_window" &&
      latest.status !== "release_authorized" &&
      latest.status !== "release_signed"
    ) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    latest = await resume();
  }
  throw new Error(`${label} did not settle before timeout: ${JSON.stringify(latest)}`);
}

async function runPublicRoute(
  approvalMode: ApprovalMode,
  options: { cleanupBlockedRoute?: boolean } = {}
): Promise<void> {
  console.log("───────────────────────────────────────────────────────");
  console.log("  Harness-backed Public Route — SDK -> ER -> balance-readiness -> Encrypt -> Anchor -> IKA -> Settlement");
  console.log("───────────────────────────────────────────────────────");

  const sponsorBuyer = loadSponsorWallet();
  const buyer = sponsorBuyer ?? Keypair.generate();
  const seller = payer;
  if (buyer.publicKey.equals(seller.publicKey)) {
    throw new Error("Public route requires distinct buyer and seller counterparties");
  }
  if (sponsorBuyer) {
    console.log(`  Using registered sponsor wallet ${buyer.publicKey.toBase58()} as buyer counterparty.`);
  } else {
    await ensureUmbraRegistration(buyer);
  }

  const ticketId = randomTicketId("diagram-public");
  const client = new MeridianClient({
    privateMode: false,
    connection: getBaseConnection(),
    payer,
  });

  const open = await client.openSession(
    ticketId,
    undefined,
    [buyer.publicKey.toBase58(), seller.publicKey.toBase58()]
  );
  console.log(`  ER session opened: ${open.sessionPda.toBase58()}`);

  const erConnection = client.getSessionConnection(ticketId);
  const session = client.getSession(ticketId);
  if (!erConnection || !session) {
    throw new Error("ER session did not become active");
  }

  const erProgram = new Program(
    negotiationIdl as any,
    new AnchorProvider(erConnection as any, new Wallet(buyer), { commitment: "confirmed" })
  );

  const agreedPriceLamports = 3_000_000;
  const buyerCollateralLamports = 1_000_000;
  const sellerCollateralLamports = 2_000_000;

  const negotiateSig = await (erProgram.methods as any)
    .negotiateTerms(
      new BN(agreedPriceLamports),
      "SOL",
      new BN(buyerCollateralLamports),
      new BN(sellerCollateralLamports)
    )
    .accountsPartial({
      session: session.sessionPda,
    })
    .rpc();
  console.log(`  ER negotiateTerms: ${negotiateSig}`);

  const close = await client.closeSession(ticketId);
  console.log(`  ER commit: ${close.commitSignature}`);

  const committed = await client.fetchCommittedTerms(ticketId);
  if (committed.status !== "consensusReached") {
    throw new Error(`ER committed status mismatch: ${committed.status}`);
  }

  const harness = await buildHarness(ticketId, {
    buyer: buyer.publicKey.toBase58(),
    seller: seller.publicKey.toBase58(),
    rollup_mode: "ER",
  }, {
    approvalClients: await connectLiveApprovalClients(
      ticketId,
      buyer,
      seller,
      approvalMode,
      false
    ),
    approvalSigners: {
      buyer,
      seller,
    },
    approvalMode,
  });
  await registerLiveTicketRow({
    ticketId,
    buyer: buyer.publicKey.toBase58(),
    seller: seller.publicKey.toBase58(),
    rollupMode: "ER",
  });
  await ticketStore.recordNegotiatedTerms(ticketId, {
    price: agreedPriceLamports / LAMPORTS_PER_SOL,
    collateral_buyer: buyerCollateralLamports / LAMPORTS_PER_SOL,
    collateral_seller: sellerCollateralLamports / LAMPORTS_PER_SOL,
    asset_type: "SOL",
  });
  await prepareLiveTicketTargets({
    ticketId,
    buyer,
    seller,
    privacyWallets: harness.approvalClients?.privacyWallets,
  });

  try {
    const result = await harness.pipeline.start({
      ticketId,
      buyer: buyer.publicKey.toBase58(),
      seller: seller.publicKey.toBase58(),
      price: agreedPriceLamports / LAMPORTS_PER_SOL,
      collateralBuyer: buyerCollateralLamports / LAMPORTS_PER_SOL,
      collateralSeller: sellerCollateralLamports / LAMPORTS_PER_SOL,
      assetType: "SOL",
      confidence: 100,
      rollupMode: "ER",
      negotiationSource: "ER",
    });

    if (approvalMode === "buyer_only") {
      await assertBlockedAtApprovalGate("Public pipeline", ticketId, result, harness);
      assertExpectedApprovalDeliveries(
        "Public pipeline",
        harness.approvalClients,
        ticketId,
        approvalMode
      );
      if (options.cleanupBlockedRoute === false) {
        console.log("  Public blocked-route proof completed without cleanup.");
        return;
      }
      await finalizeBlockedApprovalRoute(ticketId, harness, buyer, seller);
      console.log("  Public blocked-route cleanup settled after seller approval.");
      return;
    }

    if (!result.success || result.status === "failed") {
      throw new Error(`Public pipeline failed before settlement: ${result.error || result.status}`);
    }

    const publicFinalResult =
      result.status === "settled"
        ? result
        : await waitForSettlement(
            () => harness.pipeline.continueConfidentialRelease(ticketId),
            `public route ${ticketId}`
          );

    if (!publicFinalResult.success || publicFinalResult.status !== "settled") {
      throw new Error(`Public pipeline did not settle successfully: ${JSON.stringify(publicFinalResult)}`);
    }

    assertExpectedApprovalDeliveries(
      "Public pipeline",
      harness.approvalClients,
      ticketId,
      approvalMode
    );

    const stageNames = harness.stages.map((entry) => entry.stage);
    for (const requiredStage of [
      "verified",
      "settlement_address_ready",
      "stealth_settlement_ready",
      "encrypted",
      "release_pending",
      "release_signed",
      "settled",
    ] satisfies DealPipelineStage[]) {
      if (!stageNames.includes(requiredStage)) {
        throw new Error(`Public pipeline missing stage ${requiredStage}`);
      }
    }

    const dealState = await waitForConfidentialDealState(
      ticketId,
      (state) => state.releaseExecuted,
      `public route ${ticketId} release execution`
    );

    if (!dealState.releaseExecuted) {
      throw new Error("Public pipeline did not execute the confidential release on-chain");
    }

    console.log(`  Public pipeline settled via Umbra private payout route.`);
    console.log(`  Buyer receiver wallet:  ${dealState.buyerSettlementTarget}`);
    console.log(`  Seller receiver wallet: ${dealState.sellerSettlementTarget}`);
  } finally {
    harness.cleanup();
    harness.approvalClients?.disconnect();
    await cleanupLiveTicketRow(ticketId);
  }
}

async function setupPrivateSession(ticketId: string, buyer: Keypair, seller: Keypair) {
  const privateService = new PrivateNegotiationService(getBaseConnection(), payer);
  const teeVerified = await withRetry(
    () => privateService.verifyTeeIntegrity({ throwOnError: true }),
    { label: "diagram_per_verify_tee_integrity", ticketId, step: "verify_tee_integrity" }
  );
  if (!teeVerified) {
    throw new Error("TEE integrity verification failed");
  }

  const sessionId = BigInt(Math.floor(Math.random() * 1_000_000_000));
  const sessionPda = deriveSessionPda(sessionId);
  const permissionPda = permissionPdaFromAccount(sessionPda);

  const initSig = await withRetry(
    () => {
      const baseProgram = getBaseProgram(getBaseConnection());
      return (baseProgram.methods as any)
        .initializeSession(new BN(sessionId.toString()))
        .accountsPartial({
          session: sessionPda,
          buyer: payer.publicKey,
        })
        .rpc();
    },
    { label: "diagram_per_init_session", ticketId, step: "initialize_session" }
  );
  console.log(`  PER initializeSession: ${initSig}`);

  const createPermissionSig = await withRetry(
    () => {
      const baseProgram = getBaseProgram(getBaseConnection());
      return (baseProgram.methods as any)
        .createPrivatePermission(
          new BN(sessionId.toString()),
          buyer.publicKey,
          seller.publicKey
        )
        .accounts({
          payer: payer.publicKey,
          permission: permissionPda,
          permissionProgram: PERMISSION_PROGRAM_ID,
        })
        .rpc();
    },
    { label: "diagram_per_create_permission", ticketId, step: "create_permission" }
  );
  console.log(`  PER createPrivatePermission: ${createPermissionSig}`);

  const delegateSessionSig = await withRetry(
    () => {
      const baseProgram = getBaseProgram(getBaseConnection());
      return (baseProgram.methods as any)
        .delegateSession()
        .accountsPartial({
          payer: payer.publicKey,
          validator: PER_TEE_VALIDATOR_DEVNET,
          session: sessionPda,
        })
        .rpc();
    },
    { label: "diagram_per_delegate_session", ticketId, step: "delegate_session" }
  );
  console.log(`  PER delegateSession: ${delegateSessionSig}`);

  const delegatePermissionSig = await withRetry(
    () => privateService.delegateToTee(sessionId, sessionPda),
    { label: "diagram_per_delegate_permission", ticketId, step: "delegate_permission" }
  );
  console.log(`  PER delegatePermission: ${delegatePermissionSig}`);

  const permissionActivation = await waitForPermissionActivationWithFallback({
    rpcUrl: PER_TEE_RPC_URL,
    sessionPda,
    timeoutMs: 30_000,
    allowL1ConfirmedFallback: true,
  });
  if (!permissionActivation.active) {
    throw new Error("PER permission did not become active on TEE");
  }
  if (permissionActivation.degraded) {
    console.log(
      `  PER permission status endpoint unavailable; proceeding on L1 confirmation (${permissionActivation.lastError || "unknown"})`
    );
  }

  const buyerToken = await getAuthTokenFor(buyer);
  const serverToken = await getAuthTokenFor(payer);

  const buyerRouter = new ConnectionMagicRouter(`${PER_TEE_RPC_URL}?token=${buyerToken}`, {
    commitment: "confirmed",
  });
  const authorityConnection = new ConnectionMagicRouter(
    `${PER_TEE_RPC_URL}?token=${serverToken}`,
    {
      commitment: "confirmed",
    }
  );
  const buyerProgram = new Program(
    negotiationIdl as any,
    new AnchorProvider(buyerRouter as any, new Wallet(buyer), { commitment: "confirmed" })
  );
  const agreedPriceLamports = 3_000_000;
  const buyerCollateralLamports = 1_000_000;
  const sellerCollateralLamports = 2_000_000;

  const negotiateSig = await withRetry(
    async () => {
      const ix = await (buyerProgram.methods as any)
        .negotiateTerms(
          new BN(agreedPriceLamports),
          "SOL",
          new BN(buyerCollateralLamports),
          new BN(sellerCollateralLamports)
        )
        .accountsPartial({
          session: sessionPda,
        })
        .instruction();

      return sendAndConfirmWithStatusCheck(
        buyerRouter as unknown as Connection,
        new Transaction().add(ix),
        [buyer],
        {
          label: "diagram_per_negotiate_terms",
          ticketId,
          step: "negotiate_terms",
          sessionPda,
        }
      );
    },
    { label: "diagram_per_negotiate_terms", ticketId, step: "negotiate_terms" }
  );
  console.log(`  PER negotiateTerms: ${negotiateSig}`);

  return {
    sessionId,
    sessionPda,
    authorityConnection,
    agreedPriceLamports,
    buyerCollateralLamports,
    sellerCollateralLamports,
  };
}

async function runPrivateRoute(
  approvalMode: ApprovalMode,
  options: { cleanupBlockedRoute?: boolean } = {}
): Promise<void> {
  console.log("───────────────────────────────────────────────────────");
  console.log("  Harness-backed Private Route — PER -> balance-readiness -> Encrypt -> Anchor -> IKA -> Stealth Settlement");
  console.log("───────────────────────────────────────────────────────");

  const sponsorBuyer = loadSponsorWallet();
  const buyer = sponsorBuyer ?? Keypair.generate();
  const seller = payer;
  if (buyer.publicKey.equals(seller.publicKey)) {
    throw new Error("Private route requires distinct buyer and seller counterparties");
  }
  if (sponsorBuyer) {
    console.log(
      `  Using registered sponsor wallet ${buyer.publicKey.toBase58()} as buyer counterparty for the private route.`
    );
  } else {
    await ensureUmbraRegistration(buyer);
    console.log(`  Using fresh buyer counterparty ${buyer.publicKey.toBase58()} for the private route.`);
  }

  const ticketId = randomTicketId("diagram-private");
  const privateSession = await setupPrivateSession(ticketId, buyer, seller);
  const harness = await buildHarness(
    ticketId,
    {
      buyer: buyer.publicKey.toBase58(),
      seller: seller.publicKey.toBase58(),
      rollup_mode: "PER",
    },
    {
      approvalClients: await connectLiveApprovalClients(
        ticketId,
        buyer,
        seller,
        approvalMode,
        true,
        {
          priceLamports: privateSession.agreedPriceLamports,
          quantity: 1,
          assetMint: "SOL",
          collateralBuyer: privateSession.buyerCollateralLamports / LAMPORTS_PER_SOL,
          collateralSeller: privateSession.sellerCollateralLamports / LAMPORTS_PER_SOL,
        }
      ),
      finalizePrivateTicket: async () => {
        const privateService = new PrivateNegotiationService(getBaseConnection(), payer);
        const { commitSig } = await privateService.commitAndClose(
          privateSession.sessionId,
          privateSession.sessionPda,
          privateSession.authorityConnection
        );
        return commitSig;
      },
      fetchLivePrivateHandoffProof: async () =>
        fetchPrivateHandoffProofFromSession(
          privateSession.authorityConnection,
          privateSession.sessionPda
        ),
      approvalSigners: {
        buyer,
        seller,
      },
      approvalMode,
    }
  );
  await registerLiveTicketRow({
    ticketId,
    buyer: buyer.publicKey.toBase58(),
    seller: seller.publicKey.toBase58(),
    rollupMode: "PER",
  });
  await ticketStore.recordNegotiatedTerms(ticketId, {
    price: privateSession.agreedPriceLamports / LAMPORTS_PER_SOL,
    collateral_buyer: privateSession.buyerCollateralLamports / LAMPORTS_PER_SOL,
    collateral_seller: privateSession.sellerCollateralLamports / LAMPORTS_PER_SOL,
    asset_type: "SOL",
  });
  await prepareLiveTicketTargets({
    ticketId,
    buyer,
    seller,
    privacyWallets: harness.approvalClients?.privacyWallets,
  });

  const handoffBundle = await buildPrivateHandoffBundleFromTerms({
    connection: getBaseConnection(),
    payer,
    authorizedProgram: new PublicKey(config.confidentialEscrowProgramId),
    sessionPda: privateSession.sessionPda.toBase58(),
    assetMint: "SOL",
    assetSymbol: "SOL",
    priceLamports: BigInt(privateSession.agreedPriceLamports),
    buyerCollateralLamports: BigInt(privateSession.buyerCollateralLamports),
    sellerCollateralLamports: BigInt(privateSession.sellerCollateralLamports),
    status: "consensusReached",
  });

  const intent = await buildPrivateEscrowIntentFromBundle({
    ticketId,
    buyer: buyer.publicKey.toBase58(),
    seller: seller.publicKey.toBase58(),
    bundle: handoffBundle,
  });
  const proofWriteSig = await recordPrivateHandoffProofOnTee(
    privateSession.sessionId,
    privateSession.authorityConnection,
    intent
  );
  const proof = await fetchPrivateHandoffProofFromSession(
    privateSession.authorityConnection,
    privateSession.sessionPda
  );

  if (
    proof.sessionPda !== intent.sessionPda ||
    proof.buyer !== intent.buyer ||
    proof.seller !== intent.seller ||
    proof.termsHash !== intent.termsHash ||
    proof.buyerPaymentFundingHash !== intent.fundingCommitments.buyerPaymentHash ||
    proof.buyerCollateralFundingHash !== intent.fundingCommitments.buyerCollateralHash ||
    proof.sellerCollateralFundingHash !== intent.fundingCommitments.sellerCollateralHash ||
    proof.buyerCollateralCiphertext !== intent.encryptedTerms.buyerCollateral.account ||
    proof.sellerCollateralCiphertext !== intent.encryptedTerms.sellerCollateral.account ||
    proof.paymentAmountCiphertext !== intent.encryptedTerms.paymentAmount.account ||
    proof.settlementResultCiphertext !== intent.encryptedTerms.settlementResult.account ||
    proof.networkEncryptionKeyPda !== intent.encryptedTerms.networkEncryptionKeyPda
  ) {
    throw new Error("Private route wrote a proof that does not match the attested escrow intent");
  }

  console.log(`  PER recordPrivateHandoffProof: ${proofWriteSig}`);
  try {
    const result = await harness.pipeline.startFromPrivateEscrowIntent(intent);

    if (approvalMode === "buyer_only") {
      const blockedResult =
        result.status === "awaiting_settlement_plan_approvals"
          ? result
          : ((await waitForHarnessStage(
              harness,
              (entry) => entry.stage === "awaiting_settlement_plan_approvals",
              `private blocked route ${ticketId}`
            )),
            {
              success: true,
              stage: "awaiting_settlement_plan_approvals",
              route: "CONFIDENTIAL_ESCROW",
              status: "awaiting_settlement_plan_approvals",
            });
      await assertBlockedAtApprovalGate("Private pipeline", ticketId, blockedResult, harness);
      assertExpectedApprovalDeliveries(
        "Private pipeline",
        harness.approvalClients,
        ticketId,
        approvalMode
      );
      if (options.cleanupBlockedRoute === false) {
        console.log("  Private blocked-route proof completed without cleanup.");
        return;
      }
      await finalizeBlockedApprovalRoute(
        ticketId,
        harness,
        buyer,
        seller,
        () => harness.pipeline.continueConfidentialRelease(ticketId)
      );
      console.log("  Private blocked-route cleanup settled after seller approval.");
      return;
    }

    if (result.status === "created_awaiting_deposits") {
      const nextStage = await waitForHarnessStage(
        harness,
        (entry) =>
          entry.stage === "awaiting_settlement_plan_approvals" ||
          entry.stage === "awaiting_buyer_release_confirmation" ||
          entry.stage === "seller_dispute_window" ||
          entry.stage === "release_authorized" ||
          entry.stage === "release_signed" ||
          entry.stage === "settled",
        `private route ${ticketId}`
      );

      if (nextStage.stage === "settled") {
        const dealState = await waitForConfidentialDealState(
          ticketId,
          (state) => state.releaseExecuted,
          `private route ${ticketId} early settle`
        );

        if (!dealState.releaseExecuted) {
          throw new Error(
            "Private pipeline reported settled without executing the confidential release on-chain"
          );
        }
      }
    }

    if (!result.success || result.status === "failed") {
      throw new Error(`Private pipeline failed before settlement: ${result.error || result.status}`);
    }

    const privateFinalResult =
      result.status === "settled"
        ? result
        : await waitForSettlement(
            () => harness.pipeline.continueConfidentialRelease(ticketId),
            `private route ${ticketId}`
          );

    if (!privateFinalResult.success || privateFinalResult.status !== "settled") {
      throw new Error(`Private pipeline did not settle successfully: ${JSON.stringify(privateFinalResult)}`);
    }

    assertExpectedApprovalDeliveries(
      "Private pipeline",
      harness.approvalClients,
      ticketId,
      approvalMode
    );

    const stageNames = harness.stages.map((entry) => entry.stage);
    for (const requiredStage of [
      "verified",
      "settlement_address_ready",
      "stealth_settlement_ready",
      "encrypted",
      "release_pending",
      "release_signed",
      "settled",
    ] satisfies DealPipelineStage[]) {
      if (!stageNames.includes(requiredStage)) {
        throw new Error(`Private pipeline missing stage ${requiredStage}`);
      }
    }

    const dealState = await waitForConfidentialDealState(
      ticketId,
      (state) => state.releaseExecuted,
      `private route ${ticketId} release execution`
    );

    if (!dealState.releaseExecuted) {
      throw new Error("Private pipeline did not execute the confidential release on-chain");
    }

    const sessionAccount = (await withRetry(
      () => (getBaseProgram(getBaseConnection()).account as any).session.fetch(privateSession.sessionPda),
      {
        label: "diagram_private_fetch_final_session",
        ticketId,
        step: "fetch_final_session",
      }
    )) as any;
    const scrubbed =
      BigInt(sessionAccount.agreedPrice?.toString() || "0") === 0n &&
      (sessionAccount.agreedAsset || "") === "" &&
      BigInt(sessionAccount.buyerCollateral?.toString() || "0") === 0n &&
      BigInt(sessionAccount.sellerCollateral?.toString() || "0") === 0n;

    if (!scrubbed) {
      throw new Error("Private pipeline did not scrub L1 session state after confidential handoff");
    }

    console.log(`  Private pipeline settled via Umbra private payout route.`);
    console.log(`  Buyer receiver wallet:  ${dealState.buyerSettlementTarget}`);
    console.log(`  Seller receiver wallet: ${dealState.sellerSettlementTarget}`);
    console.log(`  Final L1 status:        ${JSON.stringify(sessionAccount.status)}`);
  } finally {
    harness.cleanup();
    harness.approvalClients?.disconnect();
    await cleanupLiveTicketRow(ticketId);
  }
}

function isTransientInfraError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.message}\n${error.stack || ""}`
      : String(error);
  return (
    message.includes("14 UNAVAILABLE") ||
    message.includes("ETIMEDOUT") ||
    message.includes("ECONNRESET") ||
    message.includes("No connection established") ||
    message.includes("circuit breaker OPEN") ||
    message.includes("client error (Connect)") ||
    message.includes("500 Internal Server Error") ||
    message.includes("Too many open files") ||
    message.includes("tcp open error") ||
    message.includes("TransactionExpiredTimeoutError") ||
    message.includes("Transaction was not confirmed in 30.00 seconds") ||
    message.includes("unknown if it succeeded or failed")
  );
}

async function runRouteWithRetries(
  label: string,
  runner: () => Promise<void>,
  maxAttempts = 3
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      circuitBreaker.reset();
      await runner();
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientInfraError(error) || attempt === maxAttempts) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `  ${label} hit transient infra failure on attempt ${attempt}/${maxAttempts}: ${message}`
      );
      circuitBreaker.reset();
      await sleep(3_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function parseCliOptions(): { approvalMode: ApprovalMode; routeScope: RouteScope } {
  const args = process.argv.slice(2).map((value) => value.toLowerCase());
  let approvalMode: ApprovalMode = "both";
  let routeScope: RouteScope = "both";

  for (const arg of args) {
    if (arg === "both" || arg === "buyer_only" || arg === "none") {
      approvalMode = arg;
      continue;
    }
    if (arg === "public_only" || arg === "private_only") {
      routeScope = arg;
      continue;
    }
    throw new Error(`Unsupported full_diagram_live_e2e option: ${arg}`);
  }

  return { approvalMode, routeScope };
}

async function main() {
  const { approvalMode, routeScope } = parseCliOptions();
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  Harness-backed Live Confidential Pipeline Proof");
  console.log("  ER/PER -> balance-readiness -> stealth addressing -> Encrypt -> Anchor -> IKA -> settlement");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  Operator: ${payer.publicKey.toBase58()}`);
  console.log(`  RPC:      ${rpcManager.getCurrentEndpoint()}`);
  console.log(`  Network:  ${config.network}`);
  console.log(`  Approval: ${approvalMode}`);
  console.log(`  Scope:    ${routeScope}`);
  console.log("");

  try {
    const requiredDependencies =
      routeScope === "private_only"
        ? ["solana_rpc", "magicblock_tee", "magicblock_auth", "encrypt", "ika"]
        : routeScope === "public_only"
          ? ["solana_rpc", "encrypt", "ika"]
          : ["solana_rpc", "magicblock_tee", "magicblock_auth", "encrypt", "ika"];
    const dependencySnapshot = await dependencyHealthService.assertHealthyForOperation(
      "full_diagram_live_e2e",
      requiredDependencies as any
    );
    console.log(`  Dependency health: ${dependencySnapshot.overallStatus}`);

    await topUpWallet(
      payer.publicKey,
      OPERATOR_MIN_BUFFER_LAMPORTS,
      "operator_buffer"
    );

    if (!isConfidentialEscrowReady()) {
      await initConfidentialEscrow();
    }

    if (routeScope !== "private_only") {
      await runRouteWithRetries("Public route", () =>
        runPublicRoute(approvalMode, {
          cleanupBlockedRoute: routeScope === "both",
        })
      );
    }
    if (routeScope === "both") {
      console.log("");
      await sleep(2_000);
    }
    if (routeScope !== "public_only") {
      await runRouteWithRetries("Private route", () =>
        runPrivateRoute(approvalMode, {
          cleanupBlockedRoute: routeScope === "both",
        }),
        5
      );
    }

    console.log("");
    console.log("✅ Full diagram live E2E passed.");
  } finally {
    if (wsGatewayStarted) {
      stopWsGateway();
      wsGatewayStarted = false;
    }
  }
}

main().catch((error) => {
  console.error("❌ Full diagram live E2E failed:", error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
