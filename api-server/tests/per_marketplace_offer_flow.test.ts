import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  agent: {
    upsert: vi.fn(),
  },
  offer: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
  ticket: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(),
};

vi.mock("../src/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/utils/validators", () => ({
  isUUID: vi.fn(() => true),
  assertParticipant: vi.fn(),
}));

vi.mock("../src/ws/socket", () => ({
  getIO: vi.fn(() => ({
    to: vi.fn(() => ({
      emit: vi.fn(),
    })),
  })),
}));

vi.mock("../src/services/webhook.service", () => ({
  webhookNewMessage: vi.fn(),
}));

function createResponseMock() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("PER marketplace offer flow", () => {
  beforeEach(() => {
    vi.resetModules();
    prismaMock.agent.upsert.mockReset();
    prismaMock.offer.create.mockReset();
    prismaMock.offer.findMany.mockReset();
    prismaMock.ticket.findMany.mockReset();
    prismaMock.$transaction.mockReset();
  });

  it("creates a PER marketplace offer when privateMode is enabled", async () => {
    prismaMock.agent.upsert.mockResolvedValue({ id: "agent-1", wallet: "seller-wallet" });
    prismaMock.offer.create.mockResolvedValue({
      id: "offer-1",
      asset: "SOL",
      price: 5,
      amount: 1,
      mode: "sell",
      collateral: 2,
      rollupMode: "PER",
      status: "active",
      creatorRewardWallet: "fresh-reward-wallet",
    });

    const { createOffer } = await import("../src/controllers/offersController");
    const req: any = {
      wallet: "seller-wallet",
      body: {
        asset: "SOL",
        price: 5,
        amount: 1,
        mode: "sell",
        collateral: 2,
        privateMode: true,
        rewardWallet: "F9QX5J7mnHZz7n2Y8X4S4kW3asAk3cX6mAZSE4hMQfJ2",
      },
    };
    const res = createResponseMock();

    await createOffer(req, res);

    expect(prismaMock.offer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rollupMode: "PER",
          creatorRewardWallet: "F9QX5J7mnHZz7n2Y8X4S4kW3asAk3cX6mAZSE4hMQfJ2",
        }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          rollupMode: "PER",
        }),
      })
    );
    expect(res.json).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          creatorRewardWallet: expect.anything(),
        }),
      })
    );
  });

  it("creates a Normal Mode marketplace offer without upgrading it to ER or PER", async () => {
    prismaMock.agent.upsert.mockResolvedValue({ id: "agent-1", wallet: "seller-wallet" });
    prismaMock.offer.create.mockResolvedValue({
      id: "offer-normal-1",
      asset: "SOL",
      price: 0.001,
      amount: 1,
      mode: "sell",
      collateral: 0.001,
      rollupMode: "NONE",
      status: "active",
    });

    const { createOffer } = await import("../src/controllers/offersController");
    const req: any = {
      wallet: "seller-wallet",
      body: {
        asset: "SOL",
        price: 0.001,
        amount: 1,
        mode: "sell",
        collateral: 0.001,
        rollupMode: "NONE",
      },
    };
    const res = createResponseMock();

    await createOffer(req, res);

    expect(prismaMock.offer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rollupMode: "NONE",
        }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          rollupMode: "NONE",
        }),
      })
    );
  });

  it("creates a SPORT offer and links it to an Arena match for TxLINE settlement", async () => {
    const now = new Date("2026-07-01T10:00:00.000Z");
    const tx = {
      agent: {
        upsert: vi.fn().mockResolvedValue({ id: "agent-1", wallet: "seller-wallet" }),
      },
      offer: {
        create: vi.fn().mockResolvedValue({
          id: "offer-sport-1",
          asset: "TXLINE:fixture-1:1X2_PARTICIPANT_RESULT:part1",
          price: 0.1,
          amount: 1,
          mode: "sell",
          collateral: 0,
          rollupMode: "SPORT",
          fixtureId: "fixture-1",
          marketType: "1X2_PARTICIPANT_RESULT",
          selection: "part1",
          status: "active",
          createdAt: now,
          updatedAt: now,
        }),
      },
      arenaFixture: {
        findUnique: vi.fn().mockResolvedValue({ fixtureId: "fixture-1" }),
      },
      arenaMatch: {
        create: vi.fn().mockImplementation(async ({ data }) => ({
          id: "match-sport-1",
          ...data,
          createdAt: now,
          updatedAt: now,
        })),
      },
    };
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(tx));

    const { createOffer } = await import("../src/controllers/offersController");
    const req: any = {
      wallet: "seller-wallet",
      body: {
        asset: "TXLINE:fixture-1:1X2_PARTICIPANT_RESULT:part1",
        price: 0.1,
        amount: 1,
        mode: "sell",
        rollupMode: "SPORT",
        fixtureId: "fixture-1",
        marketType: "1X2_PARTICIPANT_RESULT",
        selection: "part1",
      },
    };
    const res = createResponseMock();

    await createOffer(req, res);

    expect(tx.offer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rollupMode: "SPORT",
          collateral: 0,
          fixtureId: "fixture-1",
          marketType: "1X2_PARTICIPANT_RESULT",
          selection: "part1",
        }),
      })
    );
    expect(tx.arenaMatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          offerId: "offer-sport-1",
          fixtureId: "fixture-1",
          marketType: "1X2_PARTICIPANT_RESULT",
          selection: "part1",
          direction: "SELL_SELECTION",
          makerWallet: "seller-wallet",
          rollupMode: "SPORT",
          status: "offer_created",
          proof: expect.objectContaining({
            createdBy: "sport_offer",
            settlementSource: "txline",
          }),
        }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          id: "offer-sport-1",
          rollupMode: "SPORT",
          stake: 0.1,
          stakeModel: "equal_stake",
          fixtureId: "fixture-1",
        }),
        arenaMatch: expect.objectContaining({
          id: "match-sport-1",
          rollupMode: "SPORT",
          fixtureId: "fixture-1",
          offerId: "offer-sport-1",
        }),
      })
    );
    const responseBody = (res.json as any).mock.calls[0][0];
    expect(responseBody.data.collateral).toBeUndefined();
  });

  it("rejects SPORT offers without a fixture id", async () => {
    const { createOffer } = await import("../src/controllers/offersController");
    const req: any = {
      wallet: "seller-wallet",
      body: {
        asset: "TXLINE:missing-fixture",
        price: 0.1,
        amount: 1,
        mode: "sell",
        collateral: 0.3,
        rollupMode: "SPORT",
        selection: "part1",
      },
    };
    const res = createResponseMock();

    await createOffer(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "fixtureId is required for SPORT offers",
      })
    );
  });

  it("lists PER offers publicly for marketplace discovery", async () => {
    prismaMock.offer.findMany.mockResolvedValue([
      {
        id: "offer-1",
        asset: "SOL",
        price: 5,
        amount: 1,
        mode: "sell",
        collateral: 2,
        rollupMode: "PER",
        status: "active",
      },
    ]);

    const { getOffers } = await import("../src/controllers/offersController");
    const req: any = { query: {} };
    const res = createResponseMock();

    await getOffers(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: [
          expect.objectContaining({
            id: "offer-1",
            rollupMode: "PER",
          }),
        ],
      })
    );
  });

  it("creates a matched PER ticket that preserves marketplace buyer/seller roles", async () => {
    const tx = {
      offer: {
        findUnique: vi.fn().mockResolvedValue({
          id: "offer-1",
          status: "active",
          mode: "sell",
          rollupMode: "PER",
          ticket: null,
          creator: { wallet: "seller-wallet" },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      ticket: {
        create: vi.fn().mockResolvedValue({
          id: "ticket-1",
          buyer: "buyer-wallet",
          seller: "seller-wallet",
          status: "negotiating",
          rollupMode: "PER",
        }),
      },
    };
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(tx));

    const { acceptOfferService } = await import("../src/services/ticket.service");
    const ticket = await acceptOfferService("offer-1", "buyer-wallet");

    expect(tx.offer.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "offer-1" },
      })
    );
    expect(tx.offer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "offer-1", status: "active" },
        data: { status: "matched" },
      })
    );
    expect(tx.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          buyer: "buyer-wallet",
          seller: "seller-wallet",
          rollupMode: "PER",
        }),
      })
    );
    expect(ticket).toEqual(
      expect.objectContaining({
        id: "ticket-1",
        buyer: "buyer-wallet",
        seller: "seller-wallet",
        rollupMode: "PER",
      })
    );
  });

  it("creates accepted SPORT tickets directly in awaiting deposits", async () => {
    const tx = {
      offer: {
        findUnique: vi.fn().mockResolvedValue({
          id: "sport-offer-1",
          status: "active",
          mode: "sell",
          rollupMode: "SPORT",
          ticket: null,
          creator: { wallet: "seller-wallet" },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      ticket: {
        create: vi.fn().mockResolvedValue({
          id: "sport-ticket-1",
          buyer: "buyer-wallet",
          seller: "seller-wallet",
          status: "awaiting_deposits",
          rollupMode: "SPORT",
        }),
      },
    };
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(tx));

    const { acceptOfferService } = await import("../src/services/ticket.service");
    const ticket = await acceptOfferService("sport-offer-1", "buyer-wallet");

    expect(tx.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          buyer: "buyer-wallet",
          seller: "seller-wallet",
          status: "awaiting_deposits",
          rollupMode: "SPORT",
        }),
      })
    );
    expect(ticket).toEqual(
      expect.objectContaining({
        id: "sport-ticket-1",
        status: "awaiting_deposits",
        rollupMode: "SPORT",
      })
    );
  });

  it("lists non-terminal wallet tickets for agent recovery", async () => {
    const createdAt = new Date("2026-06-22T11:00:00.000Z");
    prismaMock.ticket.findMany.mockResolvedValue([
      {
        id: "ticket-1",
        buyer: "buyer-wallet",
        seller: "seller-wallet",
        status: "negotiating",
        rollupMode: "NONE",
        createdAt,
        offer: {
          id: "offer-1",
          mode: "sell",
          asset: "SOL",
          price: 0.001,
          collateral: 0.001,
          status: "matched",
        },
        messages: [
          {
            id: "message-1",
            sender: "buyer-wallet",
            content: "I propose price: 0.001 SOL.",
            createdAt,
          },
        ],
        _count: { messages: 3 },
      },
    ]);

    const { listTicketsForWalletService } = await import("../src/services/ticket.service");
    const tickets = await listTicketsForWalletService("buyer-wallet");

    expect(prismaMock.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ buyer: "buyer-wallet" }, { seller: "buyer-wallet" }],
          status: {
            notIn: ["completed", "cancelled", "disputed", "refunded"],
          },
        }),
      })
    );
    expect(tickets).toEqual([
      expect.objectContaining({
        id: "ticket-1",
        messageCount: 3,
        lastMessage: expect.objectContaining({
          content: "I propose price: 0.001 SOL.",
        }),
        offer: expect.objectContaining({
          price: 0.001,
          collateral: 0.001,
          privateTermsRedacted: false,
        }),
      }),
    ]);
    expect((tickets[0] as any).messages).toBeUndefined();
    expect((tickets[0] as any)._count).toBeUndefined();
  });

  it("rejects invalid reward wallets during PER offer creation", async () => {
    const { createOffer } = await import("../src/controllers/offersController");
    const req: any = {
      wallet: "seller-wallet",
      body: {
        asset: "SOL",
        price: 5,
        amount: 1,
        mode: "sell",
        collateral: 2,
        privateMode: true,
        rewardWallet: "not-a-wallet",
      },
    };
    const res = createResponseMock();

    await createOffer(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "rewardWallet must be a valid base58 Solana address",
      })
    );
  });
});
