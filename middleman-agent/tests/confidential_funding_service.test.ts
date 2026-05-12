import crypto from "crypto";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createConfidentialFundingService } from "../src/services/confidentialFundingService";
import type { ConfidentialFundingStateSnapshot } from "../src/protocol/confidentialFundingProtocol";

const DEPOSIT_ENCRYPTED_DISCRIMINATOR = crypto
  .createHash("sha256")
  .update("global:deposit_encrypted", "utf8")
  .digest()
  .subarray(0, 8);
const LOCK_CREDIT_FOR_DEAL_DISCRIMINATOR = crypto
  .createHash("sha256")
  .update("global:lock_credit_for_deal", "utf8")
  .digest()
  .subarray(0, 8);

function makeFundingTransaction(input: {
  dealPda: string;
  depositor: string;
  programId: string;
  roleCode: number;
  corruptDiscriminator?: boolean;
}) {
  const accountKeys = [
    new PublicKey(input.dealPda),
    new PublicKey(input.depositor),
    SystemProgram.programId,
    new PublicKey(input.programId),
  ];
  const data = Buffer.concat([
    input.corruptDiscriminator
      ? Buffer.from("0000000000000000", "hex")
      : DEPOSIT_ENCRYPTED_DISCRIMINATOR,
    Buffer.from([input.roleCode]),
    Buffer.alloc(8),
  ]);

  return {
    meta: { err: null },
    transaction: {
      message: {
        compiledInstructions: [
          {
            programIdIndex: 3,
            accountKeyIndexes: [0, 1, 2],
            data: bs58.encode(data),
          },
        ],
        getAccountKeys() {
          return {
            get(index: number) {
              return accountKeys[index] || null;
            },
            staticAccountKeys: accountKeys,
          };
        },
      },
    },
  };
}

function makeShieldedCreditLockTransaction(input: {
  vaultPda: string;
  creditBalancePda: string;
  creditLockPda: string;
  dealPda: string;
  owner: string;
  programId: string;
  roleCode: number;
  amountLamports?: bigint;
  corruptDiscriminator?: boolean;
}) {
  const accountKeys = [
    new PublicKey(input.vaultPda),
    new PublicKey(input.creditBalancePda),
    new PublicKey(input.creditLockPda),
    new PublicKey(input.dealPda),
    new PublicKey(input.owner),
    SystemProgram.programId,
    new PublicKey(input.programId),
  ];
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(input.amountLamports || 1n);
  const data = Buffer.concat([
    input.corruptDiscriminator
      ? DEPOSIT_ENCRYPTED_DISCRIMINATOR
      : LOCK_CREDIT_FOR_DEAL_DISCRIMINATOR,
    Buffer.from([input.roleCode]),
    amount,
  ]);

  return {
    meta: { err: null },
    transaction: {
      message: {
        compiledInstructions: [
          {
            programIdIndex: 6,
            accountKeyIndexes: [0, 1, 2, 3, 4, 5],
            data: bs58.encode(data),
          },
        ],
        getAccountKeys() {
          return {
            get(index: number) {
              return accountKeys[index] || null;
            },
            staticAccountKeys: accountKeys,
          };
        },
      },
    },
  };
}

function buildSnapshot(input: {
  ticketId: string;
  dealPda: string;
  buyerWallet: string;
  sellerWallet: string;
}): ConfidentialFundingStateSnapshot {
  return {
    ticketId: input.ticketId,
    dealPda: input.dealPda,
    sessionPda: "session-pda",
    buyerWallet: input.buyerWallet,
    sellerWallet: input.sellerWallet,
    buyerFundingWallet: undefined,
    sellerFundingWallet: undefined,
    buyerSettlementTarget: "buyer-target",
    sellerSettlementTarget: "seller-target",
    termsHash: "a".repeat(64),
    planHash: "b".repeat(64),
    requestIssuedAt: new Date().toISOString(),
    buyerRequest: {
      requestId: `${input.ticketId}:buyer:funding:1`,
      ticketId: input.ticketId,
      role: "buyer",
      requestKind: "BUYER_FUNDING",
      summary: {
        ticketId: input.ticketId,
        role: "buyer",
        counterparty: input.sellerWallet,
        asset: "SOL",
        buyerPayment: 0,
        buyerCollateral: 0,
        sellerCollateral: 0,
        settlementMode: "Stealth settlement",
        actionLabel: "Fund confidential escrow",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        redacted: true,
        localTermsRequired: true,
      },
      dealPda: input.dealPda,
      sessionPda: "session-pda",
      termsHash: "a".repeat(64),
      instructions: [
        { fundingRole: "buyer_payment", fundingHash: "c".repeat(64) },
        { fundingRole: "buyer_collateral", fundingHash: "d".repeat(64) },
      ],
      issuedAt: new Date().toISOString(),
    },
    sellerRequest: {
      requestId: `${input.ticketId}:seller:funding:1`,
      ticketId: input.ticketId,
      role: "seller",
      requestKind: "SELLER_FUNDING",
      summary: {
        ticketId: input.ticketId,
        role: "seller",
        counterparty: input.buyerWallet,
        asset: "SOL",
        buyerPayment: 0,
        buyerCollateral: 0,
        sellerCollateral: 0,
        settlementMode: "Stealth settlement",
        actionLabel: "Fund confidential escrow",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        redacted: true,
        localTermsRequired: true,
      },
      dealPda: input.dealPda,
      sessionPda: "session-pda",
      termsHash: "a".repeat(64),
      instructions: [{ fundingRole: "seller_collateral", fundingHash: "e".repeat(64) }],
      issuedAt: new Date().toISOString(),
    },
    allFundingRecorded: false,
    txSignatures: [],
    updatedAt: new Date().toISOString(),
  };
}

describe("confidentialFundingService", () => {
  it("delivers redacted PER funding requests through the durable structured outbox path", async () => {
    const dealPda = new PublicKey(new Uint8Array(32).fill(21)).toBase58();
    const buyerWallet = new PublicKey(new Uint8Array(32).fill(22)).toBase58();
    const sellerWallet = new PublicKey(new Uint8Array(32).fill(23)).toBase58();
    const deliverStructuredToAgent = vi.fn().mockResolvedValue(undefined);
    const createInitial = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn();
    const programId = new PublicKey(new Uint8Array(32).fill(24)).toBase58();
    const expectedVault = PublicKey.findProgramAddressSync(
      [Buffer.from("credit_vault")],
      new PublicKey(programId)
    )[0].toBase58();

    const service = createConfidentialFundingService({
      loadConfig: () =>
        ({
          confidentialEscrowProgramId: programId,
          perFundingPrivacyTier: "SHIELDED_CREDIT",
          perStrictOpaqueMode: true,
          perAllowDirectSolUnsafe: false,
        } as any),
      getConnection: vi.fn() as any,
      walletRegistry: {
        getOrCreateAgent: vi
          .fn()
          .mockResolvedValueOnce({ id: "buyer-agent" })
          .mockResolvedValueOnce({ id: "seller-agent" }),
        getAgentById: vi.fn(),
      } as any,
      eventBus: { publish } as any,
      deliverStructuredToAgent,
      store: {
        createInitial,
        getLatestByTicket: vi.fn(),
        recordFunding: vi.fn(),
      } as any,
      confidentialIdentityStore: { getLatestByTicket: vi.fn().mockResolvedValue(null) } as any,
      prisma: { ticket: { findUnique: vi.fn().mockResolvedValue(null) } } as any,
    });

    await service.initializeFundingRequests(
      {
        ticketId: "ticket-init-1",
        buyer: buyerWallet,
        seller: sellerWallet,
        price: 0,
        collateralBuyer: 0,
        collateralSeller: 0,
        assetType: "SOL",
        tokenMint: "So11111111111111111111111111111111111111112",
        confidence: 100,
        rollupMode: "PER",
        negotiationSource: "PER",
        termsVisibility: "REDACTED",
        route: "CONFIDENTIAL_ESCROW",
        executionPolicy: "CONFIDENTIAL",
        settlementPolicy: "STEALTH",
        routeReason: "test",
      },
      {
        ticketId: "ticket-init-1",
        dealPda,
        sessionPda: "session-pda",
        termsHash: "a".repeat(64),
        planHash: "b".repeat(64),
        buyerSettlementTarget: "buyer-target",
        sellerSettlementTarget: "seller-target",
        txSignatures: [],
      },
      {
        intentId: "intent-1",
        ticketId: "ticket-init-1",
        buyer: buyerWallet,
        seller: sellerWallet,
        assetMint: "So11111111111111111111111111111111111111112",
        quantity: "1",
        termsHash: "a".repeat(64),
        encryptedTerms: {
          buyerCollateralHandle: "buyer-ct",
          sellerCollateralHandle: "seller-ct",
          paymentHandle: "payment-ct",
        },
        fundingCommitments: {
          buyerPaymentHash: "c".repeat(64),
          buyerCollateralHash: "d".repeat(64),
          sellerCollateralHash: "e".repeat(64),
        },
        evidence: {
          source: "TEE_ATTESTED_HANDOFF",
          attestationDoc: "doc",
          attestationDigest: "digest",
          sourceSessionPda: "session-pda",
          handoffRecordedAt: new Date().toISOString(),
        },
      } as any
    );

    expect(createInitial).toHaveBeenCalledTimes(1);
    expect(createInitial).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerRequest: expect.objectContaining({
          version: 2,
          fundingRail: "SHIELDED_CREDIT",
          vaultPda: expectedVault,
        }),
        sellerRequest: expect.objectContaining({
          version: 2,
          fundingRail: "SHIELDED_CREDIT",
          vaultPda: expectedVault,
        }),
      })
    );
    expect(deliverStructuredToAgent).toHaveBeenCalledTimes(2);
    expect(deliverStructuredToAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: "buyer-agent",
        ticketId: "ticket-init-1",
        phase: "awaiting_confidential_funding",
        payload: expect.objectContaining({
          type: "CONFIDENTIAL_FUNDING_REQUEST",
          payload: expect.objectContaining({
            summary: expect.objectContaining({
              redacted: true,
              localTermsRequired: true,
            }),
          }),
        }),
      })
    );
    expect(deliverStructuredToAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agentId: "seller-agent",
        ticketId: "ticket-init-1",
        phase: "awaiting_confidential_funding",
      })
    );
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("accepts only deposit_encrypted transactions for the expected buyer funding roles", async () => {
    const dealPda = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
    const buyerWallet = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
    const sellerWallet = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
    const programId = new PublicKey(new Uint8Array(32).fill(4)).toBase58();
    const snapshot = buildSnapshot({
      ticketId: "ticket-1",
      dealPda,
      buyerWallet,
      sellerWallet,
    });
    const txBySig = new Map<string, any>([
      [
        "buyer-payment-sig",
        makeFundingTransaction({
          dealPda,
          depositor: buyerWallet,
          programId,
          roleCode: 0,
        }),
      ],
      [
        "buyer-collateral-sig",
        makeFundingTransaction({
          dealPda,
          depositor: buyerWallet,
          programId,
          roleCode: 1,
        }),
      ],
    ]);

    const service = createConfidentialFundingService({
      loadConfig: () => ({ confidentialEscrowProgramId: programId } as any),
      getConnection: () =>
        ({
          getTransaction: vi.fn(async (signature: string) => txBySig.get(signature) || null),
        } as any),
      walletRegistry: {
        getAgentById: vi.fn().mockResolvedValue({ wallet: buyerWallet }),
        getOrCreateAgent: vi.fn(),
      } as any,
      eventBus: { publish: vi.fn() } as any,
      deliverStructuredToAgent: vi.fn().mockResolvedValue(undefined) as any,
      store: {
        createInitial: vi.fn(),
        getLatestByTicket: vi.fn().mockResolvedValue(snapshot),
        recordFunding: vi.fn().mockResolvedValue({
          ...snapshot,
          buyerFunding: {
            agentId: "agent-buyer",
            wallet: buyerWallet,
            transactionSignatures: ["buyer-payment-sig", "buyer-collateral-sig"],
            recordedAt: new Date().toISOString(),
            active: true,
          },
          updatedAt: new Date().toISOString(),
        }),
      } as any,
      confidentialIdentityStore: { getLatestByTicket: vi.fn().mockResolvedValue(null) } as any,
      prisma: { ticket: { findUnique: vi.fn() } } as any,
    });

    const next = await service.processAgentSubmission({
      ticketId: "ticket-1",
      agentId: "agent-buyer",
      requestId: snapshot.buyerRequest.requestId,
      transactionSignatures: ["buyer-payment-sig", "buyer-collateral-sig"],
    });

    expect(next?.buyerFunding?.wallet).toBe(buyerWallet);
  });

  it("verifies deposits against the per-deal confidential funding wallet instead of the long-lived agent wallet", async () => {
    const dealPda = new PublicKey(new Uint8Array(32).fill(31)).toBase58();
    const buyerWallet = new PublicKey(new Uint8Array(32).fill(32)).toBase58();
    const sellerWallet = new PublicKey(new Uint8Array(32).fill(33)).toBase58();
    const buyerFundingWallet = new PublicKey(new Uint8Array(32).fill(34)).toBase58();
    const programId = new PublicKey(new Uint8Array(32).fill(35)).toBase58();
    const snapshot = {
      ...buildSnapshot({
        ticketId: "ticket-funding-wallet-1",
        dealPda,
        buyerWallet,
        sellerWallet,
      }),
      buyerFundingWallet,
    };
    const txBySig = new Map<string, any>([
      [
        "buyer-payment-sig",
        makeFundingTransaction({
          dealPda,
          depositor: buyerFundingWallet,
          programId,
          roleCode: 0,
        }),
      ],
      [
        "buyer-collateral-sig",
        makeFundingTransaction({
          dealPda,
          depositor: buyerFundingWallet,
          programId,
          roleCode: 1,
        }),
      ],
    ]);

    const service = createConfidentialFundingService({
      loadConfig: () => ({ confidentialEscrowProgramId: programId } as any),
      getConnection: () =>
        ({
          getTransaction: vi.fn(async (signature: string) => txBySig.get(signature) || null),
        } as any),
      walletRegistry: {
        getAgentById: vi.fn().mockResolvedValue({ wallet: buyerWallet }),
        getOrCreateAgent: vi.fn(),
      } as any,
      eventBus: { publish: vi.fn() } as any,
      deliverStructuredToAgent: vi.fn().mockResolvedValue(undefined) as any,
      store: {
        createInitial: vi.fn(),
        getLatestByTicket: vi.fn().mockResolvedValue(snapshot),
        recordFunding: vi.fn().mockResolvedValue({
          ...snapshot,
          buyerFunding: {
            agentId: "agent-buyer",
            wallet: buyerFundingWallet,
            transactionSignatures: ["buyer-payment-sig", "buyer-collateral-sig"],
            recordedAt: new Date().toISOString(),
            active: true,
          },
          updatedAt: new Date().toISOString(),
        }),
      } as any,
      confidentialIdentityStore: { getLatestByTicket: vi.fn().mockResolvedValue(null) } as any,
      prisma: { ticket: { findUnique: vi.fn() } } as any,
    });

    const next = await service.processAgentSubmission({
      ticketId: snapshot.ticketId,
      agentId: "agent-buyer",
      requestId: snapshot.buyerRequest.requestId,
      transactionSignatures: ["buyer-payment-sig", "buyer-collateral-sig"],
    });

    expect(next?.buyerFunding?.wallet).toBe(buyerFundingWallet);
  });

  it("accepts shielded credit lock transactions and rejects direct deposits for strict PER requests", async () => {
    const dealPda = new PublicKey(new Uint8Array(32).fill(41)).toBase58();
    const buyerWallet = new PublicKey(new Uint8Array(32).fill(42)).toBase58();
    const sellerWallet = new PublicKey(new Uint8Array(32).fill(43)).toBase58();
    const vaultPda = new PublicKey(new Uint8Array(32).fill(44)).toBase58();
    const creditBalancePda = new PublicKey(new Uint8Array(32).fill(45)).toBase58();
    const buyerPaymentLockPda = new PublicKey(new Uint8Array(32).fill(46)).toBase58();
    const buyerCollateralLockPda = new PublicKey(new Uint8Array(32).fill(47)).toBase58();
    const programId = new PublicKey(new Uint8Array(32).fill(48)).toBase58();
    const snapshot = {
      ...buildSnapshot({
        ticketId: "ticket-shielded-credit-1",
        dealPda,
        buyerWallet,
        sellerWallet,
      }),
      buyerRequest: {
        ...buildSnapshot({
          ticketId: "ticket-shielded-credit-1",
          dealPda,
          buyerWallet,
          sellerWallet,
        }).buyerRequest,
        version: 2 as const,
        fundingRail: "SHIELDED_CREDIT" as const,
        vaultPda,
      },
    };
    const txBySig = new Map<string, any>([
      [
        "buyer-payment-lock-sig",
        makeShieldedCreditLockTransaction({
          vaultPda,
          creditBalancePda,
          creditLockPda: buyerPaymentLockPda,
          dealPda,
          owner: buyerWallet,
          programId,
          roleCode: 0,
          amountLamports: 123n,
        }),
      ],
      [
        "buyer-collateral-lock-sig",
        makeShieldedCreditLockTransaction({
          vaultPda,
          creditBalancePda,
          creditLockPda: buyerCollateralLockPda,
          dealPda,
          owner: buyerWallet,
          programId,
          roleCode: 1,
          amountLamports: 77n,
        }),
      ],
      [
        "legacy-direct-deposit-sig",
        makeShieldedCreditLockTransaction({
          vaultPda,
          creditBalancePda,
          creditLockPda: buyerCollateralLockPda,
          dealPda,
          owner: buyerWallet,
          programId,
          roleCode: 1,
          corruptDiscriminator: true,
        }),
      ],
    ]);
    const recordFunding = vi.fn().mockResolvedValue({
      ...snapshot,
      buyerFunding: {
        agentId: "agent-buyer",
        wallet: buyerWallet,
        fundingRail: "SHIELDED_CREDIT",
        transactionSignatures: ["buyer-payment-lock-sig", "buyer-collateral-lock-sig"],
        observedFundingRoleAmounts: {
          buyer_payment: "123",
          buyer_collateral: "77",
        },
        recordedAt: new Date().toISOString(),
        active: true,
      },
      updatedAt: new Date().toISOString(),
    });

    const service = createConfidentialFundingService({
      loadConfig: () =>
        ({
          confidentialEscrowProgramId: programId,
          perFundingPrivacyTier: "SHIELDED_CREDIT",
          perStrictOpaqueMode: true,
          perAllowDirectSolUnsafe: false,
        } as any),
      getConnection: () =>
        ({
          getTransaction: vi.fn(async (signature: string) => txBySig.get(signature) || null),
        } as any),
      walletRegistry: {
        getAgentById: vi.fn().mockResolvedValue({ wallet: buyerWallet }),
        getOrCreateAgent: vi.fn(),
      } as any,
      eventBus: { publish: vi.fn() } as any,
      deliverStructuredToAgent: vi.fn().mockResolvedValue(undefined) as any,
      store: {
        createInitial: vi.fn(),
        getLatestByTicket: vi.fn().mockResolvedValue(snapshot),
        recordFunding,
      } as any,
      confidentialIdentityStore: { getLatestByTicket: vi.fn().mockResolvedValue(null) } as any,
      prisma: { ticket: { findUnique: vi.fn() } } as any,
    });

    await expect(
      service.processAgentSubmission({
        ticketId: snapshot.ticketId,
        agentId: "agent-buyer",
        requestId: snapshot.buyerRequest.requestId,
        transactionSignatures: ["buyer-payment-lock-sig", "legacy-direct-deposit-sig"],
      })
    ).rejects.toThrow("confidential_funding_wrong_instruction");

    const next = await service.processAgentSubmission({
      ticketId: snapshot.ticketId,
      agentId: "agent-buyer",
      requestId: snapshot.buyerRequest.requestId,
      transactionSignatures: ["buyer-payment-lock-sig", "buyer-collateral-lock-sig"],
    });

    expect(next?.buyerFunding?.fundingRail).toBe("SHIELDED_CREDIT");
    expect(recordFunding).toHaveBeenCalledWith(
      snapshot.ticketId,
      "buyer",
      expect.objectContaining({
        fundingRail: "SHIELDED_CREDIT",
        observedFundingRoleAmounts: {
          buyer_payment: "123",
          buyer_collateral: "77",
        },
      })
    );
  });

  it("rejects funding submissions that do not invoke deposit_encrypted for the expected deal", async () => {
    const dealPda = new PublicKey(new Uint8Array(32).fill(11)).toBase58();
    const buyerWallet = new PublicKey(new Uint8Array(32).fill(12)).toBase58();
    const sellerWallet = new PublicKey(new Uint8Array(32).fill(13)).toBase58();
    const programId = new PublicKey(new Uint8Array(32).fill(14)).toBase58();
    const snapshot = buildSnapshot({
      ticketId: "ticket-2",
      dealPda,
      buyerWallet,
      sellerWallet,
    });
    const invalidTx = makeFundingTransaction({
      dealPda,
      depositor: buyerWallet,
      programId,
      roleCode: 0,
      corruptDiscriminator: true,
    });

    const service = createConfidentialFundingService({
      loadConfig: () => ({ confidentialEscrowProgramId: programId } as any),
      getConnection: () =>
        ({
          getTransaction: vi.fn(async () => invalidTx),
        } as any),
      walletRegistry: {
        getAgentById: vi.fn().mockResolvedValue({ wallet: buyerWallet }),
        getOrCreateAgent: vi.fn(),
      } as any,
      eventBus: { publish: vi.fn() } as any,
      deliverStructuredToAgent: vi.fn().mockResolvedValue(undefined) as any,
      store: {
        createInitial: vi.fn(),
        getLatestByTicket: vi.fn().mockResolvedValue(snapshot),
        recordFunding: vi.fn(),
      } as any,
      confidentialIdentityStore: { getLatestByTicket: vi.fn().mockResolvedValue(null) } as any,
      prisma: { ticket: { findUnique: vi.fn() } } as any,
    });

    await expect(
      service.processAgentSubmission({
        ticketId: "ticket-2",
        agentId: "agent-buyer",
        requestId: snapshot.sellerRequest.requestId,
        transactionSignatures: ["bad-sig"],
      })
    ).rejects.toThrow("confidential_funding_wrong_agent");

    await expect(
      service.processAgentSubmission({
        ticketId: "ticket-2",
        agentId: "agent-buyer",
        requestId: snapshot.buyerRequest.requestId,
        transactionSignatures: ["bad-sig", "bad-sig-2"],
      })
    ).rejects.toThrow("confidential_funding_wrong_instruction");
  });
});
