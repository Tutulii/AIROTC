import path from "path";
import dotenv from "dotenv";
import { Keypair } from "@solana/web3.js";
import {
  createTorqueEventService,
  type TorqueIngestPayload,
} from "../../src/services/torqueEventService";
import type { DealPipelineStageChangedEvent } from "../../src/types/events";
import { loadConfig } from "../../src/config";
import { TORQUE_EVENT_NAME } from "../../src/services/torqueRewardPolicy";

dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

type StoredDelivery = {
  id: string;
  idempotencyKey: string;
  ticketId: string;
  eventName: string;
  participantRole: string;
  userPubkey: string;
  payload: TorqueIngestPayload;
  payloadHash: string;
  schemaVersion: number;
  status: string;
  attemptCount: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function createMemoryTorqueDeliveryModel() {
  const records = new Map<string, StoredDelivery>();
  let counter = 0;

  return {
    records,
    async upsert({ where, update, create }: any) {
      const existing = records.get(where.idempotencyKey);
      if (existing) {
        const next: StoredDelivery = {
          ...existing,
          ...update,
          updatedAt: new Date(),
        };
        records.set(where.idempotencyKey, next);
        return next;
      }

      const createdRecord: StoredDelivery = {
        id: `delivery-${++counter}`,
        status: "queued",
        attemptCount: 0,
        lastError: null,
        lastAttemptAt: null,
        nextAttemptAt: null,
        deliveredAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...create,
      };
      records.set(where.idempotencyKey, createdRecord);
      return createdRecord;
    },
    async findMany({ where, orderBy, take }: any) {
      const now = where.OR?.[1]?.nextAttemptAt?.lte as Date | undefined;
      const allowedStatuses = new Set(where.status?.in || []);
      const ticketId = where.ticketId as string | undefined;
      const items = Array.from(records.values()).filter((record) => {
        if (ticketId && record.ticketId !== ticketId) {
          return false;
        }
        if (allowedStatuses.size > 0 && !allowedStatuses.has(record.status)) {
          return false;
        }
        if (!record.nextAttemptAt) {
          return true;
        }
        return now ? record.nextAttemptAt <= now : true;
      });

      items.sort((left, right) => {
        const createdDiff = left.createdAt.getTime() - right.createdAt.getTime();
        if (createdDiff !== 0) {
          return createdDiff;
        }
        return left.id.localeCompare(right.id);
      });

      return items.slice(0, take || items.length);
    },
    async update({ where, data }: any) {
      const key = Array.from(records.keys()).find(
        (idempotencyKey) => records.get(idempotencyKey)?.id === where.id
      );
      if (!key) {
        throw new Error(`Missing delivery record ${where.id}`);
      }
      const current = records.get(key)!;
      const next: StoredDelivery = {
        ...current,
        ...data,
        updatedAt: new Date(),
      };
      records.set(key, next);
      return next;
    },
  };
}

function buildSettledEvent(ticketId: string): DealPipelineStageChangedEvent {
  return {
    ticketId,
    stage: "settled",
    status: "confirmed",
    route: "CONFIDENTIAL_ESCROW",
    executionPolicy: "CONFIDENTIAL",
    settlementPolicy: "STEALTH",
    negotiationSource: "PER",
  };
}

function requireConfiguredRuntime(): void {
  const config = loadConfig();
  if (!config.enableTorqueEvents) {
    throw new Error("ENABLE_TORQUE_EVENTS must be true for hosted proof");
  }
  if (!config.torqueEventApiKey) {
    throw new Error("TORQUE_EVENT_API_KEY must be configured for hosted proof");
  }
}

async function main(): Promise<void> {
  requireConfiguredRuntime();

  const buyerRewardWallet = Keypair.generate().publicKey.toBase58();
  const sellerRewardWallet = Keypair.generate().publicKey.toBase58();
  const deliveryModel = createMemoryTorqueDeliveryModel();
  const ticketId = `torque-live-${Date.now()}`;

  const service = createTorqueEventService({
    eventBus: { subscribe() {}, unsubscribe() {} } as any,
    loadConfig,
    rewardTargetStore: {
      getLatestByTicket: async () => ({
        ticketId,
        buyerWallet: "buyer-internal-wallet-redacted",
        sellerWallet: "seller-internal-wallet-redacted",
        buyerRewardWallet,
        sellerRewardWallet,
        source: "test_context",
        recordedAt: new Date().toISOString(),
        notes: ["Hosted runtime proof against live Torque ingest."],
      }),
    },
    ticketStore: {
      getTicket: async () => ({
        ticket_id: ticketId,
        offer_id: "synthetic-offer",
        buyer: "buyer-internal-wallet-redacted",
        seller: "seller-internal-wallet-redacted",
        status: "completed",
        rollup_mode: "PER",
        created_at: new Date().toISOString(),
      }),
    },
    privateEscrowIntentStore: {
      getLatestByTicket: async () => ({
        ticketId,
        intentId: `intent-${ticketId}`,
        rollupMode: "PER",
        negotiationSource: "PER",
        buyer: "buyer-internal-wallet-redacted",
        seller: "seller-internal-wallet-redacted",
        sessionPda: `session-${ticketId}`,
        assetMint: "So11111111111111111111111111111111111111112",
        termsHash: "8c77b2da667d184bd8d08ef2dd778aa258700f8d7a74952ae1f181d41d51f4f3",
        fundingCommitments: {
          buyerPaymentHash: "buyer-payment-commitment",
          buyerCollateralHash: "buyer-collateral-commitment",
          sellerCollateralHash: "seller-collateral-commitment",
        },
        encryptedTerms: {
          buyerCollateral: { identifierHex: "01", account: "buyer-ct", fheType: 4 },
          sellerCollateral: { identifierHex: "02", account: "seller-ct", fheType: 4 },
          paymentAmount: { identifierHex: "03", account: "payment-ct", fheType: 4 },
          settlementResult: { identifierHex: "04", account: "result-ct", fheType: 4 },
          networkEncryptionKeyPda: "network-encryption-key",
        },
        evidence: {
          kind: "magicblock_per_live_state",
          teeRpcUrl: "https://devnet-tee.magicblock.app",
          sessionPda: `session-${ticketId}`,
          observedAt: new Date().toISOString(),
          verifierWallet: "verifier-wallet",
          integrityVerified: true,
          sourceEvent: "ROLLUP_CONSENSUS_REACHED",
          termsHash: "8c77b2da667d184bd8d08ef2dd778aa258700f8d7a74952ae1f181d41d51f4f3",
          remoteAttestation: {
            verificationApi: "fast-quote",
            verifiedAt: new Date().toISOString(),
            challengeBase64: "challenge",
            quoteBase64: "quote",
            quoteSha256: "quote-sha256",
          },
        },
        executionTerms: {
          agreedPriceLamports: "10000000000",
          agreedAsset: "SOL",
          buyerCollateralLamports: "1000000000",
          sellerCollateralLamports: "1000000000",
          observedStatus: "consensusReached",
        },
        status: "consensus_confirmed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    },
    confidentialFundingStore: {
      getLatestByTicket: async () => ({
        ticketId,
        dealPda: `deal-${ticketId}`,
        sessionPda: `session-${ticketId}`,
        intentId: `intent-${ticketId}`,
        buyerWallet: "buyer-internal-wallet-redacted",
        sellerWallet: "seller-internal-wallet-redacted",
        buyerSettlementTarget: "buyer-stealth-wallet-redacted",
        sellerSettlementTarget: "seller-stealth-wallet-redacted",
        dwalletPda: "dwallet-redacted",
        termsHash: "8c77b2da667d184bd8d08ef2dd778aa258700f8d7a74952ae1f181d41d51f4f3",
        planHash: "plan-hash-redacted",
        requestIssuedAt: new Date().toISOString(),
        buyerRequest: {
          requestId: `buyer-request-${ticketId}`,
          ticketId,
          role: "buyer",
          requestKind: "BUYER_FUNDING",
          summary: {
            ticketId,
            role: "buyer",
            counterparty: "seller-internal-wallet-redacted",
            asset: "SOL",
            buyerPayment: 10,
            buyerCollateral: 1,
            sellerCollateral: 1,
            settlementMode: "Stealth settlement",
            actionLabel: "Fund buyer obligation",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            redacted: true,
            localTermsRequired: false,
          },
          dealPda: `deal-${ticketId}`,
          sessionPda: `session-${ticketId}`,
          intentId: `intent-${ticketId}`,
          termsHash: "8c77b2da667d184bd8d08ef2dd778aa258700f8d7a74952ae1f181d41d51f4f3",
          instructions: [],
          issuedAt: new Date().toISOString(),
        },
        sellerRequest: {
          requestId: `seller-request-${ticketId}`,
          ticketId,
          role: "seller",
          requestKind: "SELLER_FUNDING",
          summary: {
            ticketId,
            role: "seller",
            counterparty: "buyer-internal-wallet-redacted",
            asset: "SOL",
            buyerPayment: 10,
            buyerCollateral: 1,
            sellerCollateral: 1,
            settlementMode: "Stealth settlement",
            actionLabel: "Fund seller collateral",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            redacted: true,
            localTermsRequired: false,
          },
          dealPda: `deal-${ticketId}`,
          sessionPda: `session-${ticketId}`,
          intentId: `intent-${ticketId}`,
          termsHash: "8c77b2da667d184bd8d08ef2dd778aa258700f8d7a74952ae1f181d41d51f4f3",
          instructions: [],
          issuedAt: new Date().toISOString(),
        },
        fundingAmounts: {
          buyerPaymentLamports: "10000000000",
          buyerCollateralLamports: "1000000000",
          sellerCollateralLamports: "1000000000",
        },
        allFundingRecorded: true,
        txSignatures: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    },
    dealTracker: {
      getDealByTicket: async () => null,
    },
    fetchConfidentialDealFundingSnapshot: async () => undefined as any,
    prisma: {
      torqueEventDelivery: deliveryModel as any,
    } as any,
    fetchImpl: fetch,
    now: () => new Date(),
    logger: console as any,
  });

  await service.handleStageChanged(buildSettledEvent(ticketId));
  await service.processPendingDeliveries();

  const records = Array.from(deliveryModel.records.values());
  if (records.length !== 2) {
    throw new Error(`Expected 2 Torque delivery records, received ${records.length}`);
  }

  const failed = records.filter((record) => record.status !== "sent");
  if (failed.length > 0) {
    throw new Error(
      `Hosted runtime proof failed: ${failed
        .map((record) => `${record.participantRole}:${record.status}:${record.lastError || "unknown"}`)
        .join(", ")}`
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        ticketId,
        participantCount: records.length,
        eventName: TORQUE_EVENT_NAME,
        userPubkeys: records.map((record) => record.userPubkey),
        deliveredAt: records.map((record) => record.deliveredAt?.toISOString() || null),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
