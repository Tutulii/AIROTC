import { describe, expect, it, vi } from "vitest";
import { createDealPipeline } from "../src/services/dealPipeline";
import { resolvePipelineRoute } from "../src/services/pipelineRouting";
import type { PrivacyStatus } from "../src/services/privacyService";
import type { Ticket } from "../src/types/ticket";

const baseTicket: Ticket = {
  ticket_id: "ticket-1",
  offer_id: "offer-1",
  buyer: "buyer-wallet",
  seller: "seller-wallet",
  status: "active",
  rollup_mode: "ER",
  created_at: new Date().toISOString(),
};

const standardTicket: Ticket = {
  ...baseTicket,
  rollup_mode: "NONE",
};

const noPrivacy: PrivacyStatus = {
  isPrivacyMode: false,
  privacyProtocol: "NONE",
  termsHash: null,
  termsRevealed: false,
  canReveal: false,
};

describe("pipelineRouting", () => {
  it("routes PER negotiations into the unified confidential stealth path", () => {
    const selection = resolvePipelineRoute({
      outcome: {
        ticketId: "ticket-1",
        buyer: "buyer-wallet",
        seller: "seller-wallet",
        price: 1.5,
        collateralBuyer: 0.25,
        collateralSeller: 0.35,
        assetType: "SOL",
        confidence: 100,
        rollupMode: "PER",
        negotiationSource: "PER",
      },
      privacy: noPrivacy,
      enableConfidentialEscrow: true,
    });

    expect(selection.route).toBe("CONFIDENTIAL_ESCROW");
    expect(selection.executionPolicy).toBe("CONFIDENTIAL");
    expect(selection.settlementPolicy).toBe("STEALTH");
  });

  it("rejects strict PER routing when confidential escrow is disabled", () => {
    expect(() =>
      resolvePipelineRoute({
        outcome: {
          ticketId: "ticket-1",
          buyer: "buyer-wallet",
          seller: "seller-wallet",
          price: 0,
          collateralBuyer: 0,
          collateralSeller: 0,
          assetType: "SOL",
          confidence: 100,
          rollupMode: "PER",
          negotiationSource: "PER",
          termsVisibility: "REDACTED",
        },
        privacy: noPrivacy,
        enableConfidentialEscrow: false,
      })
    ).toThrow("per_strict_opaque_requires_confidential_escrow_enabled");
  });

  it("routes ER negotiations into the unified confidential stealth path", () => {
    const selection = resolvePipelineRoute({
      outcome: {
        ticketId: "ticket-1",
        buyer: "buyer-wallet",
        seller: "seller-wallet",
        price: 1.5,
        collateralBuyer: 0.25,
        collateralSeller: 0.35,
        assetType: "SOL",
        confidence: 100,
        rollupMode: "ER",
        negotiationSource: "ER",
      },
      privacy: noPrivacy,
      enableConfidentialEscrow: true,
    });

    expect(selection.route).toBe("CONFIDENTIAL_ESCROW");
    expect(selection.executionPolicy).toBe("CONFIDENTIAL");
    expect(selection.settlementPolicy).toBe("STEALTH");
  });

  it("preserves stealth settlement routing for standalone Umbra privacy mode", () => {
    const selection = resolvePipelineRoute({
      outcome: {
        ticketId: "ticket-1",
        buyer: "buyer-wallet",
        seller: "seller-wallet",
        price: 1.5,
        collateralBuyer: 0.25,
        collateralSeller: 0.35,
        assetType: "SOL",
        confidence: 100,
        rollupMode: "NONE",
        negotiationSource: "OFFCHAIN",
      },
      privacy: {
        isPrivacyMode: true,
        privacyProtocol: "UMBRA",
        termsHash: "hash",
        termsRevealed: false,
        canReveal: false,
      },
      enableConfidentialEscrow: false,
    });

    expect(selection.route).toBe("STANDARD_ESCROW");
    expect(selection.settlementPolicy).toBe("STEALTH");
  });
});

describe("dealPipeline", () => {
  it("dispatches standard escrow through a single orchestrator path for non-rollup direct deals", async () => {
    const deps = {
      loadConfig: () =>
        ({
          enableConfidentialEscrow: true,
        } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(standardTicket),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue(noPrivacy),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue(null),
      },
      eventBus: {
        publish: vi.fn(),
      },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn().mockResolvedValue({
        success: true,
        dealPda: "deal-pda-1",
        tx: "tx-1",
      }),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn(),
      verifyNegotiationForExecution: vi.fn().mockResolvedValue({
        verificationLevel: "onchain_balance_check",
        verificationScope: "balance_readiness",
        assetMint: "So11111111111111111111111111111111111111112",
        availableAmountRaw: "999999999",
        checkedAt: new Date().toISOString(),
        reason: "seller_sol_balance_meets_execution_threshold",
      }),
      prepareSettlementAddressPlan: vi.fn().mockResolvedValue({
        policy: "DIRECT",
        resolution: "resolved",
        assetMint: "So11111111111111111111111111111111111111112",
        buyerTarget: {
          role: "buyer",
          strategy: "DIRECT_WALLET",
          baseWallet: "buyer-wallet",
          resolvedAddress: "buyer-wallet",
          status: "resolved",
        },
        sellerTarget: {
          role: "seller",
          strategy: "DIRECT_WALLET",
          baseWallet: "seller-wallet",
          resolvedAddress: "seller-wallet",
          status: "resolved",
        },
        notes: ["Settlement uses public wallet destinations for both participants."],
      }),
      prepareStealthSettlement: vi.fn(),
      executeStealthSettlement: vi.fn(),
      activateStandardEscrowLifecycle: vi.fn().mockResolvedValue({
        phase: "awaiting_deposits",
        depositInstructionsPublished: true,
        watcherAttached: true,
      }),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockResolvedValue(undefined),
        completeTicketSession: vi.fn(),
      },
    };

    const pipeline = createDealPipeline(deps as any);
    const outcome = await pipeline.buildNegotiationOutcome({
      ticketId: "ticket-1",
      price: 1.5,
      collateral_buyer: 0.25,
      collateral_seller: 0.35,
      asset_type: "SOL",
      confidence: 100,
      buyer: "buyer-wallet",
      seller: "seller-wallet",
    });

    const result = await pipeline.start(outcome);

    expect(result.success).toBe(true);
    expect(result.route).toBe("STANDARD_ESCROW");
    expect(result.status).toBe("created_awaiting_deposits");
    expect(deps.ticketStore.recordNegotiatedTerms).toHaveBeenCalledWith(
      "ticket-1",
      expect.objectContaining({
        price: 1.5,
        collateral_buyer: 0.25,
        collateral_seller: 0.35,
        asset_type: "SOL",
      })
    );
    expect(deps.verifyNegotiationForExecution).toHaveBeenCalledTimes(1);
    expect(deps.prepareSettlementAddressPlan).toHaveBeenCalledTimes(1);
    expect(deps.executeCreateDealPhase).toHaveBeenCalledTimes(1);
    expect(deps.activateStandardEscrowLifecycle).toHaveBeenCalledTimes(1);
    expect(deps.pipelineStateStore.markStage).toHaveBeenCalledWith(
      "ticket-1",
      "verified",
      "confirmed",
      expect.objectContaining({ verificationLevel: "onchain_balance_check" })
    );
    expect(deps.pipelineStateStore.markStage).toHaveBeenCalledWith(
      "ticket-1",
      "settlement_address_ready",
      "confirmed",
      expect.objectContaining({ resolution: "resolved" })
    );
    expect(deps.pipelineStateStore.markStage).toHaveBeenCalledWith(
      "ticket-1",
      "escrow_created",
      "confirmed",
      expect.objectContaining({ dealPda: "deal-pda-1" })
    );
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      "ticket-1",
      "deal_pipeline_completed",
      expect.objectContaining({
        route: "STANDARD_ESCROW",
        status: "created_awaiting_deposits",
        success: true,
      })
    );
  });

  it("dispatches SPORT equal-stake escrow with protocol dust collateral for the current on-chain ABI", async () => {
    const sportTicket: Ticket = {
      ...standardTicket,
      ticket_id: "ticket-sport",
      rollup_mode: "SPORT",
    };
    const deps = {
      loadConfig: () =>
        ({
          enableConfidentialEscrow: true,
        } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(sportTicket),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue(noPrivacy),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue(null),
      },
      eventBus: {
        publish: vi.fn(),
      },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn().mockResolvedValue({
        success: true,
        dealPda: "sport-deal-pda",
        tx: "sport-create-tx",
      }),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn(),
      verifyNegotiationForExecution: vi.fn().mockResolvedValue({
        verificationLevel: "onchain_balance_check",
        verificationScope: "balance_readiness",
        checkedAt: new Date().toISOString(),
        reason: "sport_equal_stake_ready",
      }),
      prepareSettlementAddressPlan: vi.fn().mockResolvedValue({
        policy: "DIRECT",
        resolution: "resolved",
        assetMint: "So11111111111111111111111111111111111111112",
        buyerTarget: {
          role: "buyer",
          strategy: "DIRECT_WALLET",
          baseWallet: "buyer-wallet",
          resolvedAddress: "buyer-wallet",
          status: "resolved",
        },
        sellerTarget: {
          role: "seller",
          strategy: "DIRECT_WALLET",
          baseWallet: "seller-wallet",
          resolvedAddress: "seller-wallet",
          status: "resolved",
        },
        notes: [],
      }),
      prepareStealthSettlement: vi.fn(),
      executeStealthSettlement: vi.fn(),
      activateStandardEscrowLifecycle: vi.fn().mockResolvedValue({
        phase: "awaiting_deposits",
        depositInstructionsPublished: true,
        watcherAttached: true,
      }),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockResolvedValue(undefined),
        completeTicketSession: vi.fn(),
      },
    };

    const pipeline = createDealPipeline(deps as any);
    const result = await pipeline.start({
      ticketId: "ticket-sport",
      price: 3,
      collateralBuyer: 0.000000001,
      collateralSeller: 3,
      assetType: "SOL",
      confidence: 100,
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      rollupMode: "SPORT",
      negotiationSource: "OFFCHAIN",
    });

    expect(result.success).toBe(true);
    expect(result.route).toBe("STANDARD_ESCROW");
    expect(deps.executeCreateDealPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "ticket-sport",
        price: 3,
        collateral_buyer: 0.000000001,
        collateral_seller: 3,
      })
    );
    expect(deps.activateStandardEscrowLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "ticket-sport",
        price: 3,
        collateralBuyer: 0.000000001,
        collateralSeller: 3,
      })
    );
  });

  it("keeps confidential success green even when PER close/finalize remains pending", async () => {
    const deps = {
      loadConfig: () =>
        ({
          enableConfidentialEscrow: true,
        } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue({
          ...baseTicket,
          rollup_mode: "PER",
        }),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue(noPrivacy),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue(null),
      },
      eventBus: {
        publish: vi.fn(),
      },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn(),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn().mockResolvedValue({
        success: true,
        dealPda: "conf-deal-pda",
        txSignatures: ["sig-1", "sig-2"],
      }),
      verifyNegotiationForExecution: vi.fn().mockResolvedValue({
        verificationLevel: "onchain_balance_check",
        verificationScope: "balance_readiness",
        assetMint: "So11111111111111111111111111111111111111112",
        availableAmountRaw: "999999999",
        checkedAt: new Date().toISOString(),
        reason: "seller_sol_balance_meets_execution_threshold",
      }),
      prepareSettlementAddressPlan: vi.fn().mockResolvedValue({
        policy: "STEALTH",
        resolution: "resolved",
        assetMint: "So11111111111111111111111111111111111111112",
        buyerTarget: {
          role: "buyer",
          strategy: "UMBRA_STEALTH",
          baseWallet: "buyer-wallet",
          resolvedAddress: "buyer-stealth-wallet",
          status: "resolved",
        },
        sellerTarget: {
          role: "seller",
          strategy: "UMBRA_STEALTH",
          baseWallet: "seller-wallet",
          resolvedAddress: "seller-stealth-wallet",
          status: "resolved",
        },
        notes: ["Umbra registration verified for both counterparties."],
      }),
      prepareStealthSettlement: vi.fn().mockResolvedValue({
        dealId: "ticket-1",
        settlementId: "settlement-1",
        mint: "So11111111111111111111111111111111111111112",
        phase: "PENDING",
        created: true,
      }),
      executeStealthSettlement: vi.fn(),
      activateStandardEscrowLifecycle: vi.fn(),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockRejectedValue(new Error("close later")),
        completeTicketSession: vi.fn(),
      },
    };

    const pipeline = createDealPipeline(deps as any);
    const outcome = await pipeline.buildNegotiationOutcome({
      ticketId: "ticket-1",
      price: 1.5,
      collateral_buyer: 0.25,
      collateral_seller: 0.35,
      asset_type: "SOL",
      confidence: 100,
      buyer: "buyer-wallet",
      seller: "seller-wallet",
    });

    const result = await pipeline.start(outcome);

    expect(result.success).toBe(true);
    expect(result.route).toBe("CONFIDENTIAL_ESCROW");
    expect(result.status).toBe("confidential_pending_session_close");
    expect(deps.executeConfidentialDeal).toHaveBeenCalledTimes(1);
    expect(deps.prepareStealthSettlement).toHaveBeenCalledTimes(1);
    expect(deps.executeConfidentialDeal).toHaveBeenCalledWith(
      "ticket-1",
      expect.objectContaining({
        ticketId: "ticket-1",
      }),
      expect.objectContaining({
        policy: "STEALTH",
        buyerTarget: expect.objectContaining({
          resolvedAddress: "buyer-stealth-wallet",
        }),
        sellerTarget: expect.objectContaining({
          resolvedAddress: "seller-stealth-wallet",
        }),
      }),
      undefined
    );
    expect(deps.pipelineStateStore.markStage).toHaveBeenCalledWith(
      "ticket-1",
      "encrypted",
      "confirmed",
      expect.objectContaining({ dealPda: "conf-deal-pda", txCount: 2 })
    );
    expect(deps.pipelineStateStore.markStage).toHaveBeenCalledWith(
      "ticket-1",
      "stealth_settlement_ready",
      "confirmed",
      expect.objectContaining({ settlementId: "settlement-1" })
    );
  });

  it("marks confidential deals as settled when release and cross-chain signing complete", async () => {
    const deps = {
      loadConfig: () =>
        ({
          enableConfidentialEscrow: true,
        } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue({
          ...baseTicket,
          rollup_mode: "PER",
        }),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue(noPrivacy),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue(null),
      },
      eventBus: {
        publish: vi.fn(),
      },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn(),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn().mockResolvedValue({
        success: true,
        dealPda: "conf-deal-pda",
        txSignatures: ["sig-1", "sig-2", "sig-3"],
        decryptedValue: "42",
        winner: "seller-stealth-wallet",
        releaseTxSignature: "release-sig",
        approvalTxSignature: "approve-sig",
        crossChainSignature: "deadbeef",
        messageApprovalPda: "approval-pda",
        signatureScheme: "EddsaSha512",
      }),
      verifyNegotiationForExecution: vi.fn().mockResolvedValue({
        verificationLevel: "onchain_balance_check",
        provider: "SOLANA_RPC",
        verificationScope: "balance_readiness",
        sellerWallet: "seller-wallet",
        assetMint: "So11111111111111111111111111111111111111112",
        availableAmountRaw: "999999999",
        checkedAt: new Date().toISOString(),
        reason: "seller_sol_balance_meets_execution_threshold",
      }),
      prepareSettlementAddressPlan: vi.fn().mockResolvedValue({
        policy: "STEALTH",
        resolution: "resolved",
        assetMint: "So11111111111111111111111111111111111111112",
        buyerTarget: {
          role: "buyer",
          strategy: "UMBRA_STEALTH",
          baseWallet: "buyer-wallet",
          resolvedAddress: "buyer-stealth-wallet",
          status: "resolved",
        },
        sellerTarget: {
          role: "seller",
          strategy: "UMBRA_STEALTH",
          baseWallet: "seller-wallet",
          resolvedAddress: "seller-stealth-wallet",
          status: "resolved",
        },
        notes: [],
      }),
      prepareStealthSettlement: vi.fn().mockResolvedValue({
        dealId: "ticket-1",
        settlementId: "settlement-1",
        mint: "So11111111111111111111111111111111111111112",
        phase: "PENDING",
        created: true,
      }),
      executeStealthSettlement: vi.fn(),
      activateStandardEscrowLifecycle: vi.fn(),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockResolvedValue("commit-sig"),
        completeTicketSession: vi.fn(),
      },
    };

    const pipeline = createDealPipeline(deps as any);
    const outcome = await pipeline.buildNegotiationOutcome({
      ticketId: "ticket-1",
      price: 1.5,
      collateral_buyer: 0.25,
      collateral_seller: 0.35,
      asset_type: "SOL",
      confidence: 100,
      buyer: "buyer-wallet",
      seller: "seller-wallet",
    });

    const result = await pipeline.start(outcome);

    expect(result.success).toBe(true);
    expect(result.stage).toBe("settled");
    expect(result.status).toBe("settled");
    expect(deps.pipelineStateStore.markStage).toHaveBeenCalledWith(
      "ticket-1",
      "release_pending",
      "confirmed",
      expect.objectContaining({
        releaseTxSignature: "release-sig",
        winner: "seller-stealth-wallet",
      })
    );
    expect(deps.pipelineStateStore.markStage).toHaveBeenCalledWith(
      "ticket-1",
      "release_signed",
      "confirmed",
      expect.objectContaining({
        approvalTxSignature: "approve-sig",
      })
    );
    expect(deps.pipelineStateStore.markStage).toHaveBeenCalledWith(
      "ticket-1",
      "settled",
      "confirmed",
      expect.objectContaining({
        crossChainSignature: "deadbeef",
      })
    );
  });

  it("preserves settled state when PER settlement succeeds but session finalization must retry later", async () => {
    const deps = {
      loadConfig: () =>
        ({
          enableConfidentialEscrow: true,
        } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue({
          ...baseTicket,
          rollup_mode: "PER",
        }),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue(noPrivacy),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue(null),
      },
      eventBus: {
        publish: vi.fn(),
      },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn(),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn().mockResolvedValue({
        success: true,
        dealPda: "conf-deal-pda",
        txSignatures: ["sig-1", "sig-2", "sig-3"],
        decryptedValue: "42",
        winner: "seller-stealth-wallet",
        releaseTxSignature: "release-sig",
        approvalTxSignature: "approve-sig",
        crossChainSignature: "deadbeef",
        messageApprovalPda: "approval-pda",
        signatureScheme: "EddsaSha512",
      }),
      verifyNegotiationForExecution: vi.fn().mockResolvedValue({
        verificationLevel: "onchain_balance_check",
        provider: "SOLANA_RPC",
        verificationScope: "balance_readiness",
        sellerWallet: "seller-wallet",
        assetMint: "So11111111111111111111111111111111111111112",
        availableAmountRaw: "999999999",
        checkedAt: new Date().toISOString(),
        reason: "seller_sol_balance_meets_execution_threshold",
      }),
      prepareSettlementAddressPlan: vi.fn().mockResolvedValue({
        policy: "STEALTH",
        resolution: "resolved",
        assetMint: "So11111111111111111111111111111111111111112",
        buyerTarget: {
          role: "buyer",
          strategy: "UMBRA_STEALTH",
          baseWallet: "buyer-wallet",
          resolvedAddress: "buyer-stealth-wallet",
          status: "resolved",
        },
        sellerTarget: {
          role: "seller",
          strategy: "UMBRA_STEALTH",
          baseWallet: "seller-wallet",
          resolvedAddress: "seller-stealth-wallet",
          status: "resolved",
        },
        notes: [],
      }),
      prepareStealthSettlement: vi.fn().mockResolvedValue({
        dealId: "ticket-1",
        settlementId: "settlement-1",
        mint: "So11111111111111111111111111111111111111112",
        phase: "PENDING",
        created: true,
      }),
      executeStealthSettlement: vi.fn(),
      activateStandardEscrowLifecycle: vi.fn(),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockRejectedValue(new Error("close later")),
        completeTicketSession: vi.fn(),
      },
    };

    const pipeline = createDealPipeline(deps as any);
    const outcome = await pipeline.buildNegotiationOutcome({
      ticketId: "ticket-1",
      price: 1.5,
      collateral_buyer: 0.25,
      collateral_seller: 0.35,
      asset_type: "SOL",
      confidence: 100,
      buyer: "buyer-wallet",
      seller: "seller-wallet",
    });

    const result = await pipeline.start(outcome);

    expect(result.success).toBe(true);
    expect(result.stage).toBe("settled");
    expect(result.status).toBe("settled_pending_session_close");
    expect(deps.dealTracker.updateStatus).toHaveBeenCalledWith(
      "ticket-1",
      "settled_pending_session_close"
    );
    expect(deps.eventBus.publish).toHaveBeenCalledWith("deal_executed", {
      ticket_id: "ticket-1",
      status: "settled_pending_session_close",
    });
  });

  it("fails before dispatch when seller verification does not pass", async () => {
    const deps = {
      loadConfig: () =>
        ({
          enableConfidentialEscrow: true,
        } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(standardTicket),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue(noPrivacy),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue(null),
      },
      eventBus: {
        publish: vi.fn(),
      },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn(),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn(),
      verifyNegotiationForExecution: vi.fn().mockRejectedValue(new Error("seller balance missing")),
      prepareSettlementAddressPlan: vi.fn(),
      prepareStealthSettlement: vi.fn(),
      executeStealthSettlement: vi.fn(),
      activateStandardEscrowLifecycle: vi.fn(),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockResolvedValue(undefined),
        completeTicketSession: vi.fn(),
      },
    };

    const pipeline = createDealPipeline(deps as any);
    const outcome = await pipeline.buildNegotiationOutcome({
      ticketId: "ticket-1",
      price: 1.5,
      collateral_buyer: 0.25,
      collateral_seller: 0.35,
      asset_type: "SOL",
      confidence: 100,
      buyer: "buyer-wallet",
      seller: "seller-wallet",
    });

    await expect(pipeline.start(outcome)).rejects.toThrow("seller balance missing");
    expect(deps.executeCreateDealPhase).not.toHaveBeenCalled();
    expect(deps.executeConfidentialDeal).not.toHaveBeenCalled();
    expect(deps.pipelineStateStore.markStage).toHaveBeenCalledWith(
      "ticket-1",
      "failed",
      "failed",
      expect.objectContaining({ failedStage: "verified", error: "seller balance missing" })
    );
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      "ticket-1",
      "deal_pipeline_failed",
      expect.objectContaining({
        error: "seller balance missing",
      })
    );
  });

  it("rejects invalid outcomes before dispatch with a clear invariant error", async () => {
    const deps = {
      loadConfig: () =>
        ({
          enableConfidentialEscrow: true,
        } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(standardTicket),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue(noPrivacy),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue(null),
      },
      eventBus: {
        publish: vi.fn(),
      },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn(),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn(),
      verifyNegotiationForExecution: vi.fn(),
      prepareSettlementAddressPlan: vi.fn(),
      prepareStealthSettlement: vi.fn(),
      executeStealthSettlement: vi.fn(),
      activateStandardEscrowLifecycle: vi.fn(),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockResolvedValue(undefined),
        completeTicketSession: vi.fn(),
      },
    };

    const pipeline = createDealPipeline(deps as any);

    await expect(
      pipeline.start({
        ticketId: "ticket-1",
        buyer: "buyer-wallet",
        seller: "buyer-wallet",
        price: 0,
        collateralBuyer: 0.25,
        collateralSeller: 0.35,
        assetType: "SOL",
        confidence: 100,
        rollupMode: "ER",
        negotiationSource: "ER",
      })
    ).rejects.toThrow("invalid_pipeline_outcome");

    expect(deps.verifyNegotiationForExecution).not.toHaveBeenCalled();
    expect(deps.executeCreateDealPhase).not.toHaveBeenCalled();
    expect(deps.executeConfidentialDeal).not.toHaveBeenCalled();
    expect(deps.appendAuditLog).toHaveBeenCalledWith(
      "ticket-1",
      "deal_pipeline_failed",
      expect.objectContaining({
        error: expect.stringContaining("invalid_pipeline_outcome"),
      })
    );
  });

  it("can resume a stored ticket outcome without a fresh agreement event", async () => {
    const deps = {
      loadConfig: () =>
        ({
          enableConfidentialEscrow: true,
        } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue({
          ...standardTicket,
          agreed_terms: {
            price: 2.25,
            collateral_buyer: 0.5,
            collateral_seller: 0.75,
            asset_type: "SOL",
          },
        }),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue(noPrivacy),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue(null),
      },
      eventBus: {
        publish: vi.fn(),
      },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn().mockResolvedValue({
        success: true,
        dealPda: "deal-pda-resume",
        tx: "tx-resume",
      }),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn(),
      verifyNegotiationForExecution: vi.fn().mockResolvedValue({
        verificationLevel: "onchain_balance_check",
        verificationScope: "balance_readiness",
        checkedAt: new Date().toISOString(),
        reason: "resume_ok",
      }),
      prepareSettlementAddressPlan: vi.fn().mockResolvedValue({
        policy: "DIRECT",
        resolution: "resolved",
        assetMint: "So11111111111111111111111111111111111111112",
        buyerTarget: {
          role: "buyer",
          strategy: "DIRECT_WALLET",
          baseWallet: "buyer-wallet",
          resolvedAddress: "buyer-wallet",
          status: "resolved",
        },
        sellerTarget: {
          role: "seller",
          strategy: "DIRECT_WALLET",
          baseWallet: "seller-wallet",
          resolvedAddress: "seller-wallet",
          status: "resolved",
        },
        notes: [],
      }),
      prepareStealthSettlement: vi.fn(),
      executeStealthSettlement: vi.fn(),
      activateStandardEscrowLifecycle: vi.fn().mockResolvedValue({
        phase: "awaiting_deposits",
        depositInstructionsPublished: true,
        watcherAttached: true,
      }),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockResolvedValue(undefined),
        completeTicketSession: vi.fn(),
      },
    };

    const pipeline = createDealPipeline(deps as any);
    const result = await pipeline.resumeTicket("ticket-1");

    expect(result.success).toBe(true);
    expect(deps.executeCreateDealPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "ticket-1",
        price: 2.25,
        collateral_buyer: 0.5,
        collateral_seller: 0.75,
        asset_type: "SOL",
      })
    );
  });

  it("initializes confidential funding requests when a PER intent creates escrow without backend plaintext terms", async () => {
    const privateIntent = {
      intentId: "intent-1",
      ticketId: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      sessionPda: "11111111111111111111111111111111",
      assetMint: "So11111111111111111111111111111111111111112",
      assetSymbol: "SOL",
      termsHash: "a".repeat(64),
      fundingCommitments: {
        buyerPaymentHash: "b".repeat(64),
        buyerCollateralHash: "c".repeat(64),
        sellerCollateralHash: "d".repeat(64),
      },
      encryptedTerms: {
        buyerCollateral: { identifierHex: "11".repeat(32), account: "buyer-ct", fheType: 8 },
        sellerCollateral: { identifierHex: "22".repeat(32), account: "seller-ct", fheType: 8 },
        paymentAmount: { identifierHex: "33".repeat(32), account: "payment-ct", fheType: 8 },
        settlementResult: { identifierHex: "44".repeat(32), account: "result-ct", fheType: 8 },
        networkEncryptionKeyPda: "network-key",
      },
      evidence: {
        kind: "magicblock_per_live_state",
        teeRpcUrl: "https://tee",
        sessionPda: "11111111111111111111111111111111",
        observedAt: new Date().toISOString(),
        verifierWallet: "verifier",
        integrityVerified: true,
        sourceEvent: "ROLLUP_CONSENSUS_REACHED",
        termsHash: "a".repeat(64),
        remoteAttestation: {
          verificationApi: "fast-quote",
          verifiedAt: new Date().toISOString(),
          challengeBase64: "YQ==",
          quoteBase64: "Yg==",
          quoteSha256: "e".repeat(64),
        },
      },
      status: "consensus_confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const deps = {
      loadConfig: () => ({ enableConfidentialEscrow: true } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue({ ...baseTicket, rollup_mode: "PER" }),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      privateEscrowIntentStore: {
        updateStatus: vi.fn().mockResolvedValue(privateIntent),
        getLatestByTicket: vi.fn().mockResolvedValue(privateIntent),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue(noPrivacy),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue(null),
      },
      eventBus: { publish: vi.fn() },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn(),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn().mockResolvedValue({
        success: true,
        dealPda: "deal-pda-private",
        txSignatures: ["sig-create"],
        approvalStatus: "created_awaiting_deposits",
        sessionPda: privateIntent.sessionPda,
        termsHash: privateIntent.termsHash,
        planHash: "f".repeat(64),
        dwalletPda: "dwallet-pda",
        buyerSettlementTarget: "buyer-stealth",
        sellerSettlementTarget: "seller-stealth",
      }),
      prepareConfidentialSettlementAfterFunding: vi.fn(),
      confidentialFundingService: {
        initializeFundingRequests: vi.fn().mockResolvedValue(undefined),
        getLatestState: vi.fn().mockResolvedValue(null),
      },
      releaseApprovalService: {
        initializeApprovalRequests: vi.fn(),
        getLatestState: vi.fn(),
        maybeAuthorizeRelease: vi.fn(),
        markReleaseSigned: vi.fn(),
        markReleaseExecuted: vi.fn(),
      },
      authorizeConfidentialRelease: vi.fn(),
      executeConfidentialRelease: vi.fn(),
      verifyNegotiationForExecution: vi.fn().mockResolvedValue({
        verificationLevel: "policy_only",
        provider: "SOLANA_RPC",
        verificationScope: "balance_readiness",
        sellerWallet: "seller-wallet",
        checkedAt: new Date().toISOString(),
        reason: "redacted_private_terms",
      }),
      prepareSettlementAddressPlan: vi.fn().mockResolvedValue({
        policy: "STEALTH",
        resolution: "resolved",
        assetMint: privateIntent.assetMint,
        buyerTarget: {
          role: "buyer",
          strategy: "UMBRA_STEALTH",
          baseWallet: "buyer-wallet",
          resolvedAddress: "buyer-stealth",
          status: "resolved",
        },
        sellerTarget: {
          role: "seller",
          strategy: "UMBRA_STEALTH",
          baseWallet: "seller-wallet",
          resolvedAddress: "seller-stealth",
          status: "resolved",
        },
        notes: ["resolved"],
      }),
      prepareStealthSettlement: vi.fn().mockResolvedValue({
        dealId: "ticket-1",
        settlementId: "settlement-1",
        mint: privateIntent.assetMint,
        phase: "PENDING",
        created: true,
      }),
      executeStealthSettlement: vi.fn().mockResolvedValue({
        success: true,
        phase: "completed",
      }),
      activateStandardEscrowLifecycle: vi.fn(),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockResolvedValue(undefined),
        completeTicketSession: vi.fn(),
        fetchLiveTerms: vi.fn(),
        fetchLivePrivateHandoffProof: vi.fn().mockResolvedValue({
          sessionPda: privateIntent.sessionPda,
          buyer: privateIntent.buyer,
          seller: privateIntent.seller,
          status: "confidentialHandoff",
          termsHash: privateIntent.termsHash,
          buyerPaymentFundingHash: privateIntent.fundingCommitments.buyerPaymentHash,
          buyerCollateralFundingHash: privateIntent.fundingCommitments.buyerCollateralHash,
          sellerCollateralFundingHash: privateIntent.fundingCommitments.sellerCollateralHash,
          buyerCollateralCiphertext: privateIntent.encryptedTerms.buyerCollateral.account,
          sellerCollateralCiphertext: privateIntent.encryptedTerms.sellerCollateral.account,
          paymentAmountCiphertext: privateIntent.encryptedTerms.paymentAmount.account,
          settlementResultCiphertext: privateIntent.encryptedTerms.settlementResult.account,
          networkEncryptionKeyPda: privateIntent.encryptedTerms.networkEncryptionKeyPda,
          proofRecordedAt: new Date().toISOString(),
        }),
      },
    };

    const pipeline = createDealPipeline(deps as any);
    const result = await pipeline.startFromPrivateEscrowIntent(privateIntent as any);

    expect(result.success).toBe(true);
    expect(result.status).toBe("created_awaiting_deposits");
    expect(deps.executeConfidentialDeal).toHaveBeenCalledTimes(1);
    expect(deps.confidentialFundingService.initializeFundingRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "ticket-1",
        negotiationSource: "PER",
        termsVisibility: "REDACTED",
      }),
      expect.objectContaining({
        dealPda: "deal-pda-private",
        termsHash: privateIntent.termsHash,
      }),
      privateIntent
    );
  });

  it("resumes a PER deal from committed confidential funding without reloading plaintext terms", async () => {
    const privateIntent = {
      intentId: "intent-1",
      ticketId: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      sessionPda: "11111111111111111111111111111111",
      assetMint: "So11111111111111111111111111111111111111112",
      assetSymbol: "SOL",
      termsHash: "a".repeat(64),
      fundingCommitments: {
        buyerPaymentHash: "b".repeat(64),
        buyerCollateralHash: "c".repeat(64),
        sellerCollateralHash: "d".repeat(64),
      },
      encryptedTerms: {
        buyerCollateral: { identifierHex: "11".repeat(32), account: "buyer-ct", fheType: 8 },
        sellerCollateral: { identifierHex: "22".repeat(32), account: "seller-ct", fheType: 8 },
        paymentAmount: { identifierHex: "33".repeat(32), account: "payment-ct", fheType: 8 },
        settlementResult: { identifierHex: "44".repeat(32), account: "result-ct", fheType: 8 },
        networkEncryptionKeyPda: "network-key",
      },
      evidence: {
        kind: "magicblock_per_live_state",
        teeRpcUrl: "https://tee",
        sessionPda: "11111111111111111111111111111111",
        observedAt: new Date().toISOString(),
        verifierWallet: "verifier",
        integrityVerified: true,
        sourceEvent: "ROLLUP_CONSENSUS_REACHED",
        termsHash: "a".repeat(64),
        remoteAttestation: {
          verificationApi: "fast-quote",
          verifiedAt: new Date().toISOString(),
          challengeBase64: "YQ==",
          quoteBase64: "Yg==",
          quoteSha256: "e".repeat(64),
        },
      },
      status: "consensus_confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const deps = {
      loadConfig: () => ({ enableConfidentialEscrow: true } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue({ ...baseTicket, rollup_mode: "PER" }),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      privateEscrowIntentStore: {
        updateStatus: vi.fn().mockResolvedValue(privateIntent),
        getLatestByTicket: vi.fn().mockResolvedValue(privateIntent),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue(noPrivacy),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue({
          ticketId: "ticket-1",
          stage: "escrow_created",
          status: "confirmed",
          createdAt: new Date().toISOString(),
        }),
      },
      eventBus: { publish: vi.fn() },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn(),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn(),
      prepareConfidentialSettlementAfterFunding: vi.fn().mockResolvedValue({
        success: true,
        dealPda: "deal-pda-private",
        txSignatures: ["sig-fund", "sig-decrypt"],
        approvalStatus: "awaiting_settlement_plan_approvals",
        decryptedValue: "1",
        winner: "seller-stealth",
        requestAccount: "request-1",
        sessionPda: privateIntent.sessionPda,
        termsHash: privateIntent.termsHash,
        planHash: "f".repeat(64),
        dwalletPda: "dwallet-pda",
        buyerSettlementTarget: "buyer-stealth",
        sellerSettlementTarget: "seller-stealth",
      }),
      confidentialFundingService: {
        initializeFundingRequests: vi.fn(),
        getLatestState: vi.fn().mockResolvedValue({
          ticketId: "ticket-1",
          dealPda: "deal-pda-private",
          sessionPda: privateIntent.sessionPda,
          intentId: privateIntent.intentId,
          buyerWallet: "buyer-wallet",
          sellerWallet: "seller-wallet",
          buyerSettlementTarget: "buyer-stealth",
          sellerSettlementTarget: "seller-stealth",
          dwalletPda: "dwallet-pda",
          termsHash: privateIntent.termsHash,
          planHash: "f".repeat(64),
          requestIssuedAt: new Date().toISOString(),
          buyerRequest: { requestId: "buyer-funding-1" },
          sellerRequest: { requestId: "seller-funding-1" },
          buyerFunding: { active: true },
          sellerFunding: { active: true },
          allFundingRecorded: true,
          txSignatures: ["sig-create", "sig-fund"],
          updatedAt: new Date().toISOString(),
        }),
      },
      releaseApprovalService: {
        initializeApprovalRequests: vi.fn().mockResolvedValue({
          dealPda: "deal-pda-private",
          requestAccount: "request-1",
          termsHash: privateIntent.termsHash,
          planHash: "f".repeat(64),
          buyerRequest: { requestId: "buyer-release-1" },
          sellerRequest: { requestId: "seller-release-1" },
          buyerApproval: undefined,
          sellerApproval: undefined,
          buyerReleaseConfirmed: false,
          releaseAuthorized: false,
          txSignatures: ["sig-fund", "sig-decrypt"],
        }),
        getLatestState: vi.fn(),
        maybeAuthorizeRelease: vi.fn(),
        markReleaseSigned: vi.fn(),
        markReleaseExecuted: vi.fn(),
      },
      authorizeConfidentialRelease: vi.fn(),
      executeConfidentialRelease: vi.fn(),
      verifyNegotiationForExecution: vi.fn(),
      prepareSettlementAddressPlan: vi.fn(),
      prepareStealthSettlement: vi.fn(),
      executeStealthSettlement: vi.fn(),
      activateStandardEscrowLifecycle: vi.fn(),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockResolvedValue(undefined),
        completeTicketSession: vi.fn(),
        fetchLiveTerms: vi.fn(),
        fetchLivePrivateHandoffProof: vi.fn().mockResolvedValue({
          sessionPda: privateIntent.sessionPda,
          buyer: privateIntent.buyer,
          seller: privateIntent.seller,
          status: "confidentialHandoff",
          termsHash: privateIntent.termsHash,
          buyerPaymentFundingHash: privateIntent.fundingCommitments.buyerPaymentHash,
          buyerCollateralFundingHash: privateIntent.fundingCommitments.buyerCollateralHash,
          sellerCollateralFundingHash: privateIntent.fundingCommitments.sellerCollateralHash,
          buyerCollateralCiphertext: privateIntent.encryptedTerms.buyerCollateral.account,
          sellerCollateralCiphertext: privateIntent.encryptedTerms.sellerCollateral.account,
          paymentAmountCiphertext: privateIntent.encryptedTerms.paymentAmount.account,
          settlementResultCiphertext: privateIntent.encryptedTerms.settlementResult.account,
          networkEncryptionKeyPda: privateIntent.encryptedTerms.networkEncryptionKeyPda,
          proofRecordedAt: new Date().toISOString(),
        }),
      },
    };

    const pipeline = createDealPipeline(deps as any);
    const result = await pipeline.startFromPrivateEscrowIntent(privateIntent as any);

    expect(result.success).toBe(true);
    expect(result.status).toBe("awaiting_settlement_plan_approvals");
    expect(deps.executeConfidentialDeal).not.toHaveBeenCalled();
    expect(deps.prepareConfidentialSettlementAfterFunding).toHaveBeenCalledWith(
      "ticket-1",
      expect.objectContaining({
        dealPda: "deal-pda-private",
        termsHash: privateIntent.termsHash,
      }),
      privateIntent
    );
  });

  it("forces strict PER resume to use the private intent even if plaintext agreed terms exist on the ticket", async () => {
    const privateIntent = {
      intentId: "intent-1",
      ticketId: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      sessionPda: "11111111111111111111111111111111",
      assetMint: "So11111111111111111111111111111111111111112",
      assetSymbol: "SOL",
      termsHash: "a".repeat(64),
      fundingCommitments: {
        buyerPaymentHash: "b".repeat(64),
        buyerCollateralHash: "c".repeat(64),
        sellerCollateralHash: "d".repeat(64),
      },
      encryptedTerms: {
        buyerCollateral: { identifierHex: "11".repeat(32), account: "buyer-ct", fheType: 8 },
        sellerCollateral: { identifierHex: "22".repeat(32), account: "seller-ct", fheType: 8 },
        paymentAmount: { identifierHex: "33".repeat(32), account: "payment-ct", fheType: 8 },
        settlementResult: { identifierHex: "44".repeat(32), account: "result-ct", fheType: 8 },
        networkEncryptionKeyPda: "network-key",
      },
      evidence: {
        kind: "magicblock_per_live_state",
        teeRpcUrl: "https://tee",
        sessionPda: "11111111111111111111111111111111",
        observedAt: new Date().toISOString(),
        verifierWallet: "verifier",
        integrityVerified: true,
        sourceEvent: "ROLLUP_CONSENSUS_REACHED",
        termsHash: "a".repeat(64),
        remoteAttestation: {
          verificationApi: "fast-quote",
          verifiedAt: new Date().toISOString(),
          challengeBase64: "YQ==",
          quoteBase64: "Yg==",
          quoteSha256: "e".repeat(64),
        },
      },
      status: "consensus_confirmed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const deps = {
      loadConfig: () => ({ enableConfidentialEscrow: true, perStrictOpaqueMode: true } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue({
          ...baseTicket,
          rollup_mode: "PER",
          agreed_terms: {
            price: 9,
            collateral_buyer: 3,
            collateral_seller: 3,
            asset_type: "SOL",
          },
        }),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      privateEscrowIntentStore: {
        updateStatus: vi.fn().mockResolvedValue(privateIntent),
        getLatestByTicket: vi.fn().mockResolvedValue(privateIntent),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue(noPrivacy),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue(null),
      },
      eventBus: { publish: vi.fn() },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn(),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn().mockResolvedValue({
        success: true,
        dealPda: "deal-pda-private",
        txSignatures: ["sig-create"],
        approvalStatus: "created_awaiting_deposits",
        sessionPda: privateIntent.sessionPda,
        termsHash: privateIntent.termsHash,
        planHash: "f".repeat(64),
        dwalletPda: "dwallet-pda",
        buyerSettlementTarget: "buyer-stealth",
        sellerSettlementTarget: "seller-stealth",
      }),
      prepareConfidentialSettlementAfterFunding: vi.fn(),
      confidentialFundingService: {
        initializeFundingRequests: vi.fn().mockResolvedValue(undefined),
        getLatestState: vi.fn().mockResolvedValue(null),
      },
      releaseApprovalService: {
        initializeApprovalRequests: vi.fn(),
        getLatestState: vi.fn(),
        maybeAuthorizeRelease: vi.fn(),
        markReleaseSigned: vi.fn(),
        markReleaseExecuted: vi.fn(),
      },
      authorizeConfidentialRelease: vi.fn(),
      executeConfidentialRelease: vi.fn(),
      verifyNegotiationForExecution: vi.fn().mockResolvedValue({
        verificationLevel: "policy_only",
        provider: "SOLANA_RPC",
        verificationScope: "balance_readiness",
        sellerWallet: "seller-wallet",
        checkedAt: new Date().toISOString(),
        reason: "redacted_private_terms",
      }),
      prepareSettlementAddressPlan: vi.fn().mockResolvedValue({
        policy: "STEALTH",
        resolution: "resolved",
        assetMint: privateIntent.assetMint,
        buyerTarget: {
          role: "buyer",
          strategy: "UMBRA_STEALTH",
          baseWallet: "buyer-wallet",
          resolvedAddress: "buyer-stealth",
          status: "resolved",
        },
        sellerTarget: {
          role: "seller",
          strategy: "UMBRA_STEALTH",
          baseWallet: "seller-wallet",
          resolvedAddress: "seller-stealth",
          status: "resolved",
        },
        notes: ["resolved"],
      }),
      prepareStealthSettlement: vi.fn().mockResolvedValue({
        dealId: "ticket-1",
        settlementId: "settlement-1",
        mint: privateIntent.assetMint,
        phase: "PENDING",
        created: true,
      }),
      executeStealthSettlement: vi.fn().mockResolvedValue({
        success: true,
        phase: "completed",
      }),
      activateStandardEscrowLifecycle: vi.fn(),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockResolvedValue(undefined),
        completeTicketSession: vi.fn(),
        fetchLiveTerms: vi.fn(),
        fetchLivePrivateHandoffProof: vi.fn().mockResolvedValue({
          sessionPda: privateIntent.sessionPda,
          buyer: privateIntent.buyer,
          seller: privateIntent.seller,
          status: "confidentialHandoff",
          termsHash: privateIntent.termsHash,
          buyerPaymentFundingHash: privateIntent.fundingCommitments.buyerPaymentHash,
          buyerCollateralFundingHash: privateIntent.fundingCommitments.buyerCollateralHash,
          sellerCollateralFundingHash: privateIntent.fundingCommitments.sellerCollateralHash,
          buyerCollateralCiphertext: privateIntent.encryptedTerms.buyerCollateral.account,
          sellerCollateralCiphertext: privateIntent.encryptedTerms.sellerCollateral.account,
          paymentAmountCiphertext: privateIntent.encryptedTerms.paymentAmount.account,
          settlementResultCiphertext: privateIntent.encryptedTerms.settlementResult.account,
          networkEncryptionKeyPda: privateIntent.encryptedTerms.networkEncryptionKeyPda,
          proofRecordedAt: new Date().toISOString(),
        }),
      },
    };

    const pipeline = createDealPipeline(deps as any);
    const result = await pipeline.resumeTicket("ticket-1");

    expect(result.success).toBe(true);
    expect(result.status).toBe("created_awaiting_deposits");
    expect(deps.privateEscrowIntentStore.getLatestByTicket).toHaveBeenCalledWith("ticket-1");
    expect(deps.executeConfidentialDeal).toHaveBeenCalledWith(
      "ticket-1",
      expect.objectContaining({
        ticketId: "ticket-1",
        price: 0,
        collateral_buyer: 0,
        collateral_seller: 0,
        asset_type: "SOL",
      }),
      expect.any(Object),
      privateIntent
    );
  });

  it("skips duplicate standard dispatch when escrow already exists", async () => {
    const deps = {
      loadConfig: () =>
        ({
          enableConfidentialEscrow: true,
        } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(standardTicket),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue(noPrivacy),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue({
          ticketId: "ticket-1",
          stage: "escrow_created",
          status: "confirmed",
          createdAt: new Date().toISOString(),
        }),
      },
      eventBus: {
        publish: vi.fn(),
      },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn(),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn(),
      verifyNegotiationForExecution: vi.fn(),
      prepareSettlementAddressPlan: vi.fn(),
      prepareStealthSettlement: vi.fn(),
      executeStealthSettlement: vi.fn(),
      activateStandardEscrowLifecycle: vi.fn(),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockResolvedValue(undefined),
        completeTicketSession: vi.fn(),
      },
    };

    const pipeline = createDealPipeline(deps as any);
    const outcome = await pipeline.buildNegotiationOutcome({
      ticketId: "ticket-1",
      price: 1.5,
      collateral_buyer: 0.25,
      collateral_seller: 0.35,
      asset_type: "SOL",
      confidence: 100,
      buyer: "buyer-wallet",
      seller: "seller-wallet",
    });

    const result = await pipeline.start(outcome);

    expect(result.success).toBe(true);
    expect(result.status).toBe("created_awaiting_deposits");
    expect(deps.executeCreateDealPhase).not.toHaveBeenCalled();
  });

  it("creates a durable stealth settlement stage before standard escrow dispatch", async () => {
    const deps = {
      loadConfig: () =>
        ({
          enableConfidentialEscrow: false,
          enableLegacyUmbraStealthLifecycle: true,
        } as any),
      ticketStore: {
        getTicket: vi.fn().mockResolvedValue(standardTicket),
        recordNegotiatedTerms: vi.fn().mockResolvedValue(undefined),
      },
      dealTracker: {
        initDeal: vi.fn().mockResolvedValue(undefined),
        storeOnChainId: vi.fn().mockResolvedValue(undefined),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      },
      getPrivacyStatus: vi.fn().mockResolvedValue({
        isPrivacyMode: true,
        privacyProtocol: "UMBRA",
        termsHash: "hash",
        termsRevealed: false,
        canReveal: false,
      }),
      pipelineStateStore: {
        markStage: vi.fn().mockResolvedValue(undefined),
        markRouteSelected: vi.fn().mockResolvedValue(undefined),
        getLatestStage: vi.fn().mockResolvedValue(null),
      },
      eventBus: {
        publish: vi.fn(),
      },
      appendAuditLog: vi.fn().mockResolvedValue(undefined),
      executeCreateDealPhase: vi.fn().mockResolvedValue({
        success: true,
        dealPda: "deal-pda-stealth",
        tx: "tx-stealth",
      }),
      isConfidentialEscrowReady: vi.fn().mockReturnValue(true),
      initConfidentialEscrow: vi.fn().mockResolvedValue(undefined),
      executeConfidentialDeal: vi.fn(),
      verifyNegotiationForExecution: vi.fn().mockResolvedValue({
        verificationLevel: "onchain_balance_check",
        verificationScope: "balance_readiness",
        assetMint: "So11111111111111111111111111111111111111112",
        availableAmountRaw: "999999999",
        checkedAt: new Date().toISOString(),
        reason: "seller_sol_balance_meets_execution_threshold",
      }),
      prepareSettlementAddressPlan: vi.fn().mockResolvedValue({
        policy: "STEALTH",
        resolution: "resolved",
        assetMint: "So11111111111111111111111111111111111111112",
        buyerTarget: {
          role: "buyer",
          strategy: "UMBRA_STEALTH",
          baseWallet: "buyer-wallet",
          resolvedAddress: "buyer-wallet",
          status: "resolved",
        },
        sellerTarget: {
          role: "seller",
          strategy: "UMBRA_STEALTH",
          baseWallet: "seller-wallet",
          resolvedAddress: "seller-wallet",
          status: "resolved",
        },
        notes: ["Umbra registration verified."],
      }),
      prepareStealthSettlement: vi.fn().mockResolvedValue({
        dealId: "ticket-1",
        settlementId: "settlement-1",
        mint: "So11111111111111111111111111111111111111112",
        phase: "PENDING",
        created: true,
      }),
      executeStealthSettlement: vi.fn().mockResolvedValue({
        dealId: "ticket-1",
        settlementId: "settlement-1",
        phase: "COMPLETED",
        buyerShieldTx: "buyer-shield",
        sellerShieldTx: "seller-shield",
        settlementUtxoTx: "utxo-tx",
        claimTx: "claim-tx",
        buyerUnshieldTx: "buyer-unshield",
        sellerUnshieldTx: "seller-unshield",
      }),
      activateStandardEscrowLifecycle: vi.fn().mockResolvedValue({
        phase: "awaiting_deposits",
        depositInstructionsPublished: true,
        watcherAttached: true,
      }),
      magicBlockSessions: {
        finalizePrivateTicket: vi.fn().mockResolvedValue(undefined),
        completeTicketSession: vi.fn(),
      },
    };

    const pipeline = createDealPipeline(deps as any);
    const outcome = await pipeline.buildNegotiationOutcome({
      ticketId: "ticket-1",
      price: 1.5,
      collateral_buyer: 0.25,
      collateral_seller: 0.35,
      asset_type: "SOL",
      confidence: 100,
      buyer: "buyer-wallet",
      seller: "seller-wallet",
    });

    const result = await pipeline.start(outcome);

    expect(result.success).toBe(true);
    expect(result.route).toBe("STANDARD_ESCROW");
    expect(result.status).toBe("settled");
    expect(deps.prepareStealthSettlement).toHaveBeenCalledTimes(1);
    expect(deps.executeStealthSettlement).toHaveBeenCalledTimes(1);
    expect(deps.pipelineStateStore.markStage).toHaveBeenCalledWith(
      "ticket-1",
      "stealth_settlement_ready",
      "confirmed",
      expect.objectContaining({
        settlementId: "settlement-1",
        mint: "So11111111111111111111111111111111111111112",
      })
    );
    expect(deps.pipelineStateStore.markStage).toHaveBeenCalledWith(
      "ticket-1",
      "settled",
      "confirmed",
      expect.objectContaining({
        settlementId: "settlement-1",
        phase: "COMPLETED",
      })
    );
  });
});
