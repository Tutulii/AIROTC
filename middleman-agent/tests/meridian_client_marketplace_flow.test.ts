import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { MeridianClient } from "../agents/sdk/MeridianClient";

describe("MeridianClient marketplace PER flow", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates, lists, and accepts PER offers through the external agent SDK surface", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { id: "offer-1" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "offer-1",
              asset: "SOL",
              price: 5,
              amount: 1,
              mode: "sell",
              collateral: 2,
              status: "active",
              rollupMode: "PER",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ticket: { id: "ticket-1" },
        }),
      });

    const client = new MeridianClient({
      apiUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3001",
      keypair: Keypair.generate(),
      privateMode: true,
      strictOpaquePerMode: true,
    });
    vi.spyOn(client as any, "createFreshSettlementWallet")
      .mockImplementationOnce(async () => "fresh-offer-wallet")
      .mockImplementationOnce(async () => "fresh-accept-wallet");
    vi.spyOn(client as any, "createFreshRewardWallet")
      .mockImplementationOnce(() => "fresh-offer-reward-wallet")
      .mockImplementationOnce(() => "fresh-accept-reward-wallet");

    const offerId = await client.createOffer({
      asset: "SOL",
      side: "sell",
      amount: 1,
      price: 5,
      collateral: 2,
    });
    const offers = await client.getOffers({ asset: "SOL", side: "sell" });
    const ticketId = await client.acceptOffer(offerId);

    expect(offerId).toBe("offer-1");
    expect(offers).toEqual([
      expect.objectContaining({
        id: "offer-1",
        rollupMode: "PER",
      }),
    ]);
    expect(ticketId).toBe("ticket-1");

    const createBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(createBody.rollupMode).toBe("PER");
    expect(createBody.privateMode).toBe(true);
    expect(createBody.settlementWallet).toBe("fresh-offer-wallet");
    expect(createBody.rewardWallet).toBe("fresh-offer-reward-wallet");

    const acceptBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(acceptBody.rollupMode).toBe("PER");
    expect(acceptBody.privateMode).toBe(true);
    expect(acceptBody.settlementWallet).toBe("fresh-accept-wallet");
    expect(acceptBody.rewardWallet).toBe("fresh-accept-reward-wallet");
  });

  it("persists reward wallets separately from settlement wallets for marketplace flows", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { id: "offer-1" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ticket: { id: "ticket-1" },
        }),
      });

    const stateFilePath = path.join(
      os.tmpdir(),
      `meridian-client-marketplace-state-${Date.now()}.json`
    );

    try {
      const client = new MeridianClient({
        apiUrl: "http://localhost:3000",
        wsUrl: "ws://localhost:3001",
        keypair: Keypair.generate(),
        privateMode: true,
        strictOpaquePerMode: true,
        stateFilePath,
      });
      vi.spyOn(client as any, "createFreshSettlementWallet")
        .mockImplementationOnce(async () => {
          (client as any).settlementWallets.set("fresh-offer-wallet", {
            address: "fresh-offer-wallet",
            secretKeyBase58: "settlement-secret-1",
            createdAt: new Date().toISOString(),
            referenceKind: "offer_creator",
            reference: "settlement:offer_creator",
          });
          (client as any).persistLocalState();
          return "fresh-offer-wallet";
        })
        .mockImplementationOnce(async () => {
          (client as any).settlementWallets.set("fresh-accept-wallet", {
            address: "fresh-accept-wallet",
            secretKeyBase58: "settlement-secret-2",
            createdAt: new Date().toISOString(),
            referenceKind: "offer_accepter",
            reference: "settlement:offer_accepter",
          });
          (client as any).persistLocalState();
          return "fresh-accept-wallet";
        });
      vi.spyOn(client as any, "createFreshRewardWallet")
        .mockImplementationOnce(() => {
          (client as any).rewardWallets.set("fresh-offer-reward-wallet", {
            address: "fresh-offer-reward-wallet",
            secretKeyBase58: "reward-secret-1",
            createdAt: new Date().toISOString(),
            referenceKind: "offer_creator",
            reference: "reward:offer_creator",
          });
          (client as any).persistLocalState();
          return "fresh-offer-reward-wallet";
        })
        .mockImplementationOnce(() => {
          (client as any).rewardWallets.set("fresh-accept-reward-wallet", {
            address: "fresh-accept-reward-wallet",
            secretKeyBase58: "reward-secret-2",
            createdAt: new Date().toISOString(),
            referenceKind: "offer_accepter",
            reference: "reward:offer_accepter",
          });
          (client as any).persistLocalState();
          return "fresh-accept-reward-wallet";
        });

      await client.createOffer({
        asset: "SOL",
        side: "sell",
        amount: 1,
        price: 5,
        collateral: 2,
      });
      await client.acceptOffer("offer-1");

      const restored = new MeridianClient({
        apiUrl: "http://localhost:3000",
        wsUrl: "ws://localhost:3001",
        keypair: (client as any).config.keypair,
        privateMode: true,
        strictOpaquePerMode: true,
        stateFilePath,
      });

      expect(Array.from((restored as any).settlementWallets.keys())).toEqual([
        "fresh-offer-wallet",
        "fresh-accept-wallet",
      ]);
      expect(Array.from((restored as any).rewardWallets.keys())).toEqual([
        "fresh-offer-reward-wallet",
        "fresh-accept-reward-wallet",
      ]);
    } finally {
      fs.rmSync(stateFilePath, { force: true });
    }
  });
});
