import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (payload: any) => unknown>();
  return {
    handlers,
    subscribe: vi.fn((event: string, handler: (payload: any) => unknown) => {
      handlers.set(event, handler);
    }),
    publish: vi.fn(),
    openForTicket: vi.fn(),
    recordPrivateHandoffProof: vi.fn(),
    fetchLivePrivateHandoffProof: vi.fn(),
    fetchCommittedTerms: vi.fn(),
    completeTicketSession: vi.fn(),
    getTicket: vi.fn(),
    buildPrivateEscrowIntentFromBundle: vi.fn(),
    savePrivateIntent: vi.fn(),
    getLatestPrivateIntent: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      withContext: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    },
  };
});

vi.mock("../src/services/eventBus", () => ({
  eventBus: {
    subscribe: mocks.subscribe,
    publish: mocks.publish,
  },
}));

vi.mock("../src/services/magicBlockSessionManager", () => ({
  magicBlockSessions: {
    openForTicket: mocks.openForTicket,
    recordPrivateHandoffProof: mocks.recordPrivateHandoffProof,
    fetchLivePrivateHandoffProof: mocks.fetchLivePrivateHandoffProof,
    fetchCommittedTerms: mocks.fetchCommittedTerms,
    completeTicketSession: mocks.completeTicketSession,
  },
}));

vi.mock("../src/state/ticketStore", () => ({
  ticketStore: {
    getTicket: mocks.getTicket,
  },
}));

vi.mock("../src/services/perEscrowIntentService", () => ({
  buildPrivateEscrowIntentFromBundle: mocks.buildPrivateEscrowIntentFromBundle,
}));

vi.mock("../src/state/privateEscrowIntentStore", () => ({
  privateEscrowIntentStore: {
    save: mocks.savePrivateIntent,
    getLatestByTicket: mocks.getLatestPrivateIntent,
  },
}));

vi.mock("../src/utils/logger", () => ({
  logger: mocks.logger,
}));

describe("rollupListener integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.getLatestPrivateIntent.mockResolvedValue(null);
  });

  async function loadListener() {
    vi.resetModules();
    return await import("../src/listeners/rollupListener");
  }

  it("opens a rollup session on negotiation_ready and notifies the agents", async () => {
    const { initRollupListener } = await loadListener();
    mocks.openForTicket.mockResolvedValue({ success: true });

    initRollupListener();
    const handler = mocks.handlers.get("negotiation_ready");
    expect(handler).toBeTypeOf("function");

    await handler?.({
      ticketId: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      rollupMode: "ER",
    });

    expect(mocks.openForTicket).toHaveBeenCalledWith(
      "ticket-1",
      ["buyer-wallet", "seller-wallet"],
      "ER"
    );
    expect(mocks.publish).toHaveBeenCalledWith("middleman_response", {
      ticket_id: "ticket-1",
      content: "ER negotiation session is live. Submit terms through the rollup session now.",
      phase: "rollup_negotiation",
      timestamp: expect.any(String),
    });
  });

  it("promotes committed ER consensus into agreement_detected on the app pipeline boundary", async () => {
    const { initRollupListener } = await loadListener();
    mocks.getTicket.mockResolvedValue({
      id: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      rollup_mode: "ER",
    });
    mocks.fetchCommittedTerms.mockResolvedValue({
      agreedPriceLamports: 1500000000n,
      agreedAsset: "SOL",
      buyerCollateralLamports: 250000000n,
      sellerCollateralLamports: 350000000n,
      status: "consensusReached",
      sessionPda: "session-pda",
    });

    initRollupListener();
    const handler = mocks.handlers.get("rollup_consensus_reached");

    await handler?.({
      ticketId: "ticket-1",
      agentId: "buyer-wallet",
    });

    expect(mocks.fetchCommittedTerms).toHaveBeenCalledWith("ticket-1");
    expect(mocks.completeTicketSession).toHaveBeenCalledWith("ticket-1");
    expect(mocks.publish).toHaveBeenCalledWith("agreement_detected", {
      ticketId: "ticket-1",
      price: 1.5,
      collateral_buyer: 0.25,
      collateral_seller: 0.35,
      asset_type: "SOL",
      confidence: 100,
      buyer: "buyer-wallet",
      seller: "seller-wallet",
    });
  });

  it("promotes a PER handoff bundle into a durable private escrow intent without prematurely closing the session", async () => {
    const { initRollupListener } = await loadListener();
    mocks.getTicket.mockResolvedValue({
      id: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      rollup_mode: "PER",
    });
    mocks.buildPrivateEscrowIntentFromBundle.mockResolvedValue({
      intentId: "intent-1",
      ticketId: "ticket-1",
      rollupMode: "PER",
      negotiationSource: "PER",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      sessionPda: "tee-session-pda",
      assetMint: "So11111111111111111111111111111111111111112",
      assetSymbol: "SOL",
      fundingCommitments: {
        buyerPaymentHash: "a".repeat(64),
        buyerCollateralHash: "b".repeat(64),
        sellerCollateralHash: "c".repeat(64),
      },
      encryptedTerms: {
        buyerCollateral: { account: "buyer-ct" },
        sellerCollateral: { account: "seller-ct" },
        paymentAmount: { account: "payment-ct" },
        settlementResult: { account: "result-ct" },
        networkEncryptionKeyPda: "network-key",
      },
      termsHash: "hash-1",
      status: "consensus_confirmed",
    });
    mocks.recordPrivateHandoffProof.mockResolvedValue("proof-write-sig");
    mocks.fetchLivePrivateHandoffProof.mockResolvedValue({
      sessionPda: "tee-session-pda",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      status: "confidentialHandoff",
      termsHash: "hash-1",
      buyerPaymentFundingHash: "a".repeat(64),
      buyerCollateralFundingHash: "b".repeat(64),
      sellerCollateralFundingHash: "c".repeat(64),
      buyerCollateralCiphertext: "buyer-ct",
      sellerCollateralCiphertext: "seller-ct",
      paymentAmountCiphertext: "payment-ct",
      settlementResultCiphertext: "result-ct",
      networkEncryptionKeyPda: "network-key",
      proofRecordedAt: new Date().toISOString(),
    });

    initRollupListener();
    const handler = mocks.handlers.get("private_handoff_bundle_ready");

    await handler?.({
      ticketId: "ticket-1",
      agentId: "buyer-wallet",
      bundle: {
        version: 1,
        sessionPda: "tee-session-pda",
        assetMint: "So11111111111111111111111111111111111111112",
        assetSymbol: "SOL",
        termsHash: "hash-1",
        fundingCommitments: {
          buyerPaymentHash: "a".repeat(64),
          buyerCollateralHash: "b".repeat(64),
          sellerCollateralHash: "c".repeat(64),
        },
        encryptedTerms: {
          buyerCollateral: { identifierHex: "01", account: "buyer-ct", fheType: 1 },
          sellerCollateral: { identifierHex: "02", account: "seller-ct", fheType: 1 },
          paymentAmount: { identifierHex: "03", account: "payment-ct", fheType: 1 },
          settlementResult: { identifierHex: "04", account: "result-ct", fheType: 1 },
          networkEncryptionKeyPda: "network-key",
        },
      },
    });

    expect(mocks.buildPrivateEscrowIntentFromBundle).toHaveBeenCalledWith({
      ticketId: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      bundle: expect.objectContaining({
        sessionPda: "tee-session-pda",
      }),
    });
    expect(mocks.recordPrivateHandoffProof).toHaveBeenCalledWith(
      "ticket-1",
      expect.objectContaining({
        intentId: "intent-1",
      })
    );
    expect(mocks.fetchLivePrivateHandoffProof).toHaveBeenCalledWith("ticket-1");
    expect(mocks.savePrivateIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: "intent-1",
      })
    );
    expect(mocks.completeTicketSession).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith("private_escrow_intent_ready", {
      ticketId: "ticket-1",
      intentId: "intent-1",
      rollupMode: "PER",
      negotiationSource: "PER",
      sessionPda: "tee-session-pda",
      termsHash: "hash-1",
      assetMint: "So11111111111111111111111111111111111111112",
      status: "consensus_confirmed",
    });
  });

  it("ignores duplicate PER handoff bundles for the same session and terms hash", async () => {
    const { initRollupListener } = await loadListener();
    mocks.getTicket.mockResolvedValue({
      id: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      rollup_mode: "PER",
    });
    mocks.getLatestPrivateIntent.mockResolvedValue({
      intentId: "intent-existing",
      ticketId: "ticket-1",
      rollupMode: "PER",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      sessionPda: "tee-session-pda",
      termsHash: "hash-1",
    });

    initRollupListener();
    const handler = mocks.handlers.get("private_handoff_bundle_ready");

    await handler?.({
      ticketId: "ticket-1",
      agentId: "seller-wallet",
      bundle: {
        version: 1,
        sessionPda: "tee-session-pda",
        assetMint: "So11111111111111111111111111111111111111112",
        assetSymbol: "SOL",
        termsHash: "hash-1",
        fundingCommitments: {
          buyerPaymentHash: "a".repeat(64),
          buyerCollateralHash: "b".repeat(64),
          sellerCollateralHash: "c".repeat(64),
        },
        encryptedTerms: {
          buyerCollateral: { identifierHex: "01", account: "buyer-ct-2", fheType: 1 },
          sellerCollateral: { identifierHex: "02", account: "seller-ct-2", fheType: 1 },
          paymentAmount: { identifierHex: "03", account: "payment-ct-2", fheType: 1 },
          settlementResult: { identifierHex: "04", account: "result-ct-2", fheType: 1 },
          networkEncryptionKeyPda: "network-key-2",
        },
      },
    });

    expect(mocks.buildPrivateEscrowIntentFromBundle).not.toHaveBeenCalled();
    expect(mocks.recordPrivateHandoffProof).not.toHaveBeenCalled();
    expect(mocks.savePrivateIntent).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalledWith(
      "private_escrow_intent_ready",
      expect.anything()
    );
  });
});
