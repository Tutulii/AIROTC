import { beforeEach, describe, expect, it, vi } from "vitest";

const acceptOfferServiceMock = vi.fn();
const createMessageServiceMock = vi.fn();
const forwardOfferAcceptedMock = vi.fn();
const forwardMessageMock = vi.fn();
const attachSportTicketByOfferMock = vi.fn();
const prismaMock = {
  offer: {
    findUnique: vi.fn(),
  },
  ticket: {
    findUnique: vi.fn(),
  },
};
const webhooks = {
  dealMatched: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../src/services/ticket.service", () => ({
  acceptOfferService: acceptOfferServiceMock,
  getTicketByIdService: vi.fn(),
  createMessageService: createMessageServiceMock,
  getMessagesByTicketId: vi.fn(),
}));

vi.mock("../src/services/middlemanForwarder", () => ({
  middlemanForwarder: {
    forwardOfferAccepted: forwardOfferAcceptedMock,
    forwardMessage: forwardMessageMock,
  },
}));

vi.mock("../src/services/arena/sportSettlementEngine", () => ({
  attachSportTicketByOffer: attachSportTicketByOfferMock,
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/webhookDelivery", () => ({
  webhooks,
}));

function createResponseMock() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("Torque reward wallet marketplace bridge", () => {
  const buyerSettlementWallet = "So11111111111111111111111111111111111111112";
  const sellerSettlementWallet = "Hp6RbB21KrKQEaKvqAZPLHYYVDFKNJaiRtzE1494dpmx";
  const buyerRewardWallet = "BuTf7gVrjD2wzKe4Tu1Ny2m7gC9SY65fRCY7gHnBgLqj";
  const sellerRewardWallet = "87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY";
  const buyerFundingWallet = "5Q544fKrFoe6tsajM7Qh1JUVQh2ET6Yf2nRk1U67VuvK";
  const sellerFundingWallet = "An9qpA3Xtf9iSmhS7qKrw3gKfYxWy4nVsG6fFQzLmqne";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("forwards buyer and seller reward wallets to the middleman bridge", async () => {
    prismaMock.offer.findUnique.mockResolvedValue({
      id: "offer-1",
      mode: "buy",
      asset: "SOL",
      price: 5,
      amount: 1,
      collateral: 2,
      rollupMode: "PER",
      creatorSettlementWallet: buyerSettlementWallet,
      creatorRewardWallet: buyerRewardWallet,
      creatorFundingWallet: buyerFundingWallet,
      tokenMint: null,
    });
    acceptOfferServiceMock.mockResolvedValue({
      id: "ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      status: "negotiating",
      rollupMode: "PER",
    });
    forwardOfferAcceptedMock.mockResolvedValue({
      success: true,
      middlemanTicketId: "ticket-1",
    });

    const { acceptOffer } = await import("../src/controllers/ticket.controller");
    const req: any = {
      params: { id: "offer-1" },
      wallet: "seller-wallet",
      body: {
        settlementWallet: sellerSettlementWallet,
        rewardWallet: sellerRewardWallet,
        fundingWallet: sellerFundingWallet,
      },
    };
    const res = createResponseMock();

    await acceptOffer(req, res);

    expect(forwardOfferAcceptedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "ticket-1",
        buyerRewardWallet,
        sellerRewardWallet,
        buyerFundingWallet,
        sellerFundingWallet,
        buyerSettlementWallet,
        sellerSettlementWallet,
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects partial reward-wallet configurations before ticket creation", async () => {
    prismaMock.offer.findUnique.mockResolvedValue({
      id: "offer-1",
      mode: "buy",
      creatorRewardWallet: buyerRewardWallet,
    });

    const { acceptOffer } = await import("../src/controllers/ticket.controller");
    const req: any = {
      params: { id: "offer-1" },
      wallet: "seller-wallet",
      body: {
        settlementWallet: sellerSettlementWallet,
      },
    };
    const res = createResponseMock();

    await acceptOffer(req, res);

    expect(acceptOfferServiceMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error:
          "Fresh per-deal reward wallets must be supplied by both counterparties together or omitted entirely.",
      })
    );
  });

  it("returns deterministic SPORT escrow instructions after accepting an offer", async () => {
    prismaMock.offer.findUnique.mockResolvedValue({
      id: "sport-offer-1",
      mode: "sell",
      asset: "TXLINE:18179549:1X2:part1",
      price: 0.1,
      amount: 4,
      collateral: 0,
      rollupMode: "SPORT",
      creatorSettlementWallet: sellerSettlementWallet,
      creatorRewardWallet: null,
      creatorFundingWallet: null,
      tokenMint: null,
    });
    acceptOfferServiceMock.mockResolvedValue({
      id: "sport-ticket-1",
      buyer: "buyer-wallet",
      seller: "seller-wallet",
      status: "awaiting_deposits",
      rollupMode: "SPORT",
    });
    forwardOfferAcceptedMock.mockResolvedValue({
      success: true,
      middlemanTicketId: "sport-ticket-1",
      phase: "awaiting_deposits",
      dealPda: "escrow-pda-1",
      depositInstructions: {
        escrowPda: "escrow-pda-1",
        buyer: {
          wallet: "buyer-wallet",
          stake: 4,
          payment: 4,
          collateral: 0,
          total: 4,
        },
        seller: {
          wallet: "seller-wallet",
          stake: 4,
          collateral: 0,
          total: 4,
        },
      },
    });
    attachSportTicketByOfferMock.mockResolvedValue({
      match: { id: "arena-match-1", escrowPda: "escrow-pda-1" },
    });

    const { acceptOffer } = await import("../src/controllers/ticket.controller");
    const req: any = {
      params: { id: "sport-offer-1" },
      wallet: "buyer-wallet",
      body: {},
    };
    const res = createResponseMock();

    await acceptOffer(req, res);

    expect(forwardOfferAcceptedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "sport-ticket-1",
        rollupMode: "SPORT",
        price: 0.1,
        amount: 4,
        collateral: 0,
      })
    );
    expect(attachSportTicketByOfferMock).toHaveBeenCalledWith({
      offerId: "sport-offer-1",
      ticketId: "sport-ticket-1",
      escrowPda: "escrow-pda-1",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        sportEscrow: expect.objectContaining({
          mathOnly: true,
          phase: "awaiting_deposits",
          dealPda: "escrow-pda-1",
          depositInstructions: {
            escrowPda: "escrow-pda-1",
            stakeModel: "equal_stake",
            buyer: {
              wallet: "buyer-wallet",
              stake: 4,
              total: 4,
            },
            seller: {
              wallet: "seller-wallet",
              stake: 4,
              total: 4,
            },
          },
        }),
      })
    );
    const responseBody = (res.json as any).mock.calls[0][0];
    expect(JSON.stringify(responseBody.sportEscrow.depositInstructions)).not.toContain("collateral");
  });

  it("stores SPORT ticket chat without forwarding it to the middleman brain", async () => {
    createMessageServiceMock.mockResolvedValue({
      id: "message-1",
      ticketId: "sport-ticket-1",
      senderWallet: "buyer-wallet",
      content: "I agree",
    });
    prismaMock.ticket.findUnique.mockResolvedValue({ rollupMode: "SPORT" });

    const { sendMessage } = await import("../src/controllers/ticket.controller");
    const req: any = {
      params: { id: "sport-ticket-1" },
      wallet: "buyer-wallet",
      body: { content: "I agree" },
    };
    const res = createResponseMock();

    await sendMessage(req, res);

    expect(createMessageServiceMock).toHaveBeenCalledWith("sport-ticket-1", "buyer-wallet", "I agree");
    expect(forwardMessageMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        sportMathOnly: true,
        brain: null,
      })
    );
  });
});
