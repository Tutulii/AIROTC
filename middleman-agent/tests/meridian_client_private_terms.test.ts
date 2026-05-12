import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { MeridianClient } from "../agents/sdk/MeridianClient";
import type { ConfidentialFundingRequestEnvelope } from "../src/protocol/confidentialFundingProtocol";
import type { ReleaseApprovalRequestEnvelope } from "../src/protocol/releaseApprovalProtocol";

function createClient() {
  return new MeridianClient({
    apiUrl: "http://localhost:3000",
    wsUrl: "ws://localhost:3001",
    keypair: Keypair.generate(),
    privateMode: true,
    strictOpaquePerMode: true,
    persistLocalState: false,
  });
}

function createErClient() {
  return new MeridianClient({
    apiUrl: "http://localhost:3000",
    wsUrl: "ws://localhost:3001",
    keypair: Keypair.generate(),
    privateMode: false,
    strictOpaquePerMode: true,
    persistLocalState: false,
  });
}

describe("MeridianClient private-term hydration", () => {
  it("hydrates redacted PER release requests from the local private term cache", () => {
    const client = createClient() as any;
    client.storePrivateTerms("ticket-1", {
      assetMint: "SOL",
      priceLamports: 5_000_000_000,
      collateralBuyer: 2,
      collateralSeller: 2,
      quantity: 1,
    });

    const request: ReleaseApprovalRequestEnvelope = {
      requestId: "ticket-1:buyer:1",
      ticketId: "ticket-1",
      role: "buyer",
      requestKind: "SETTLEMENT_PLAN",
      summary: {
        ticketId: "ticket-1",
        role: "buyer",
        counterparty: "seller-wallet",
        asset: "SOL",
        price: 0,
        buyerCollateral: 0,
        sellerCollateral: 0,
        settlementMode: "Stealth settlement",
        actionLabel: "Approve settlement plan",
        expiresAt: new Date().toISOString(),
        redacted: true,
        localTermsRequired: true,
      },
      payload: {
        version: 1,
        action: "APPROVE_SETTLEMENT",
        ticketIdHash: "a".repeat(64),
        dealPda: Keypair.generate().publicKey.toBase58(),
        sessionPda: Keypair.generate().publicKey.toBase58(),
        intentIdHash: "b".repeat(64),
        role: "buyer",
        route: "CONFIDENTIAL_ESCROW",
        settlementPolicy: "STEALTH",
        termsHash: "c".repeat(64),
        planHash: "d".repeat(64),
        nonce: "1",
        expiresAt: String(Date.now() + 60_000),
        timestamp: String(Date.now()),
      },
      messageBase64: "",
      issuedAt: new Date().toISOString(),
    };

    const hydrated = client.hydrateReleaseRequestFromLocalTerms(request);
    expect(hydrated.summary).toMatchObject({
      asset: "SOL",
      price: 5,
      buyerCollateral: 2,
      sellerCollateral: 2,
      redacted: false,
      localTermsRequired: false,
    });
  });

  it("hydrates redacted PER funding requests from the local private term cache", () => {
    const client = createClient() as any;
    client.storePrivateTerms("ticket-2", {
      assetMint: "USDC",
      priceLamports: 7_000_000_000,
      collateralBuyer: 1.25,
      collateralSeller: 1.5,
      quantity: 1,
    });

    const request: ConfidentialFundingRequestEnvelope = {
      requestId: "ticket-2:buyer:funding:1",
      ticketId: "ticket-2",
      role: "buyer",
      requestKind: "BUYER_FUNDING",
      summary: {
        ticketId: "ticket-2",
        role: "buyer",
        counterparty: "seller-wallet",
        asset: "USDC",
        buyerPayment: 0,
        buyerCollateral: 0,
        sellerCollateral: 0,
        settlementMode: "Stealth settlement",
        actionLabel: "Fund confidential escrow",
        expiresAt: new Date().toISOString(),
        redacted: true,
        localTermsRequired: true,
      },
      dealPda: Keypair.generate().publicKey.toBase58(),
      sessionPda: Keypair.generate().publicKey.toBase58(),
      termsHash: "e".repeat(64),
      instructions: [
        { fundingRole: "buyer_payment", fundingHash: "f".repeat(64) },
        { fundingRole: "buyer_collateral", fundingHash: "0".repeat(64) },
      ],
      issuedAt: new Date().toISOString(),
    };

    const hydrated = client.hydrateFundingRequestFromLocalTerms(request);
    expect(hydrated.summary).toMatchObject({
      asset: "USDC",
      buyerPayment: 7,
      buyerCollateral: 1.25,
      sellerCollateral: 1.5,
      redacted: false,
      localTermsRequired: false,
    });
  });

  it("fails closed on buyer receipt confirmation when no signed release request exists in strict PER mode", async () => {
    const client = createClient();
    await expect(client.confirmReceipt("ticket-3")).rejects.toThrow(
      "Strict opaque PER mode requires a signed buyer release request"
    );
  });

  it("completes private agreement with one high-level helper", async () => {
    const client = createClient();
    const submitSpy = vi.spyOn(client, "submitRollupTerms").mockResolvedValue();
    const finalizeSpy = vi
      .spyOn(client, "finalizeRollupConsensus")
      .mockRejectedValueOnce(new Error("both parties must submit terms first"))
      .mockResolvedValueOnce();

    const run = client.completePrivateAgreement(
      "ticket-4",
      {
        assetMint: "SOL",
        priceSol: 5,
        buyerCollateralSol: 2,
        sellerCollateralSol: 2,
      },
      {
        waitForSessionTimeoutMs: 1_000,
        finalizeTimeoutMs: 1_000,
        finalizeRetryMs: 1,
      }
    );

    client.emit("rollup_session_ready", { ticketId: "ticket-4", rollupMode: "PER" });
    await run;

    expect(submitSpy).toHaveBeenCalledWith({
      assetMint: "SOL",
      priceLamports: 5_000_000_000,
      quantity: 1,
      collateralBuyer: 2,
      collateralSeller: 2,
    });
    expect(finalizeSpy).toHaveBeenCalledTimes(2);
  });

  it("waits for a confidential funding request before auto-funding", async () => {
    const client = createClient();
    const fundSpy = vi.spyOn(client, "fundConfidentialDeal").mockResolvedValue();

    const run = client.autoFundPrivateDeal("ticket-5", { timeoutMs: 1_000 });
    client.emit("confidential_funding_request", { ticketId: "ticket-5" });
    await run;

    expect(fundSpy).toHaveBeenCalledWith("ticket-5");
  });

  it("provisions and reuses direct-ticket privacy wallets", async () => {
    const client = createClient() as any;
    vi.spyOn(client, "createFreshSettlementWallet").mockImplementation(async () => {
      client.settlementWallets.set("settlement-wallet", {
        address: "settlement-wallet",
        secretKeyBase58: "settlement-secret",
        createdAt: new Date().toISOString(),
        referenceKind: "direct_ticket",
      });
      return "settlement-wallet";
    });
    vi.spyOn(client, "createFreshRewardWallet").mockImplementation(() => {
      client.rewardWallets.set("reward-wallet", {
        address: "reward-wallet",
        secretKeyBase58: "reward-secret",
        createdAt: new Date().toISOString(),
        referenceKind: "direct_ticket",
      });
      return "reward-wallet";
    });
    vi.spyOn(client, "createFreshFundingWallet").mockImplementation(() => {
      client.fundingWallets.set("funding-wallet", {
        address: "funding-wallet",
        secretKeyBase58: "funding-secret",
        createdAt: new Date().toISOString(),
        referenceKind: "direct_ticket",
      });
      return "funding-wallet";
    });

    const first = await client.prepareDirectTicketPrivacyWallets("ticket-direct");
    const second = await client.prepareDirectTicketPrivacyWallets("ticket-direct");

    expect(first).toEqual({
      settlementWallet: "settlement-wallet",
      rewardWallet: "reward-wallet",
      fundingWallet: "funding-wallet",
    });
    expect(second).toEqual(first);
    expect(client.createFreshSettlementWallet).toHaveBeenCalledTimes(1);
    expect(client.createFreshRewardWallet).toHaveBeenCalledTimes(1);
    expect(client.createFreshFundingWallet).toHaveBeenCalledTimes(1);
  });

  it("waits for buyer release confirmation before confirming private delivery", async () => {
    const client = createClient();
    const confirmSpy = vi.spyOn(client, "confirmReceipt").mockResolvedValue();

    const run = client.confirmPrivateDelivery("ticket-6", { timeoutMs: 1_000 });
    client.emit("release_approval_request", {
      ticketId: "ticket-6",
      requestKind: "BUYER_RELEASE_CONFIRMATION",
    });
    await run;

    expect(confirmSpy).toHaveBeenCalledWith("ticket-6");
  });

  it("emits phase_changed for structured confidential funding requests", () => {
    const client = createClient() as any;
    const phaseSpy = vi.fn();
    client.on("phase_changed", phaseSpy);

    client.handleMessage({
      type: "CONFIDENTIAL_FUNDING_REQUEST",
      phase: "awaiting_confidential_funding",
      payload: {
        requestId: "ticket-7:buyer:funding:1",
        ticketId: "ticket-7",
        role: "buyer",
        requestKind: "BUYER_FUNDING",
        summary: {
          ticketId: "ticket-7",
          role: "buyer",
          counterparty: "seller-wallet",
          asset: "SOL",
          buyerPayment: 0,
          buyerCollateral: 0,
          sellerCollateral: 0,
          settlementMode: "Stealth settlement",
          actionLabel: "Fund confidential escrow",
          expiresAt: new Date().toISOString(),
          redacted: true,
          localTermsRequired: true,
        },
        dealPda: Keypair.generate().publicKey.toBase58(),
        sessionPda: Keypair.generate().publicKey.toBase58(),
        termsHash: "a".repeat(64),
        instructions: [
          { fundingRole: "buyer_payment", fundingHash: "b".repeat(64) },
        ],
        issuedAt: new Date().toISOString(),
      },
    });

    expect(phaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "ticket-7",
        phase: "awaiting_confidential_funding",
      })
    );
  });

  it("emits phase_changed for structured release approval requests", () => {
    const client = createClient() as any;
    const phaseSpy = vi.fn();
    client.on("phase_changed", phaseSpy);

    client.handleMessage({
      type: "RELEASE_APPROVAL_REQUEST",
      phase: "awaiting_buyer_release_confirmation",
      payload: {
        requestId: "ticket-8:buyer:release:2",
        ticketId: "ticket-8",
        role: "buyer",
        requestKind: "BUYER_RELEASE_CONFIRMATION",
        summary: {
          ticketId: "ticket-8",
          role: "buyer",
          counterparty: "seller-wallet",
          asset: "SOL",
          price: 0,
          buyerCollateral: 0,
          sellerCollateral: 0,
          settlementMode: "Stealth settlement",
          actionLabel: "Confirm final release",
          expiresAt: new Date().toISOString(),
          redacted: true,
          localTermsRequired: true,
        },
        payload: {
          version: 1,
          action: "CONFIRM_RELEASE",
          ticketIdHash: "c".repeat(64),
          dealPda: Keypair.generate().publicKey.toBase58(),
          sessionPda: Keypair.generate().publicKey.toBase58(),
          intentIdHash: "d".repeat(64),
          role: "buyer",
          route: "CONFIDENTIAL_ESCROW",
          settlementPolicy: "STEALTH",
          termsHash: "e".repeat(64),
          planHash: "f".repeat(64),
          nonce: "2",
          expiresAt: String(Date.now() + 60_000),
          timestamp: String(Date.now()),
        },
        messageBase64: "",
        issuedAt: new Date().toISOString(),
      },
    });

    expect(phaseSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "ticket-8",
        phase: "awaiting_buyer_release_confirmation",
      })
    );
  });

  it("treats a concurrent ER consensus finalize race as complete once the ticket advances", async () => {
    const client = createErClient() as any;
    const finalizeSpy = vi
      .spyOn(client, "finalizeRollupConsensus")
      .mockRejectedValueOnce(
        new Error(
          "Simulation failed. Message: transaction verification error: Error processing Instruction 0: instruction modified data of a read-only account."
        )
      );

    setTimeout(() => {
      client.ticketPhases.set("ticket-er", "confidential_encrypting");
    }, 0);

    await expect(
      client.finalizeConsensusWithRetry(
        "ticket-er",
        {
          assetMint: "SOL",
          priceLamports: 100_000_000,
          quantity: 1,
          collateralBuyer: 0.02,
          collateralSeller: 0.02,
        },
        {
          timeoutMs: 1_000,
          retryMs: 1,
        }
      )
    ).resolves.toBeUndefined();

    expect(finalizeSpy).toHaveBeenCalledTimes(1);
  });
});
