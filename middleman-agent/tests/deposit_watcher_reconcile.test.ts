import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const publishMock = vi.fn();
const confirmedDeposits = new Set<string>();
const transactionCreateMock = vi.fn().mockResolvedValue({});

const ticketId = "5f3ce9f6-c351-4b1c-8758-88a1a1975ab5";
const dealPda = new PublicKey("5JMyHXRoY81o2L4h616jQFah3hwntJ4T9RN3hySdUvoN");
const buyer = new PublicKey("HmguKMS1Zdyncqb7UkKo9aw2YR1H9wvuYwkmtaT7u9Xv");
const seller = new PublicKey("EdUWKpttdUtWWiUpWzDasouXPvZzpuMpjytteHEzuk9Y");

vi.mock("../src/services/eventBus", () => ({
  eventBus: {
    publish: publishMock,
  },
}));

vi.mock("../src/utils/logger", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn(() => logger),
  };
  return { logger };
});

vi.mock("../src/state/dealTracker", () => ({
  dealTracker: {},
}));

vi.mock("../src/services/duneSIMService", () => ({
  duneSIM: {
    isAvailable: false,
  },
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    depositConfirmation: {
      createMany: vi.fn().mockResolvedValue({ count: 3 }),
      updateMany: vi.fn(async ({ where }: any) => {
        const key = `${where.ticketId}:${where.type}`;
        if (confirmedDeposits.has(key)) {
          return { count: 0 };
        }
        confirmedDeposits.add(key);
        return { count: 1 };
      }),
    },
    deal: {
      findUnique: vi.fn().mockResolvedValue({ id: "deal-db-id" }),
    },
    transaction: {
      create: transactionCreateMock,
    },
  },
}));

vi.mock("../src/services/onChainExecutionService", () => ({
  dealContexts: {
    [ticketId]: {
      buyer,
      seller,
    },
  },
  getAnchorProgram: () => ({
    program: {
      account: {
        deal: {
          fetch: vi.fn().mockResolvedValue({
            buyerCollateralLocked: false,
            sellerCollateralLocked: false,
            paymentLocked: false,
          }),
        },
      },
    },
  }),
}));

vi.mock("../core/dealPhaseManager", () => ({
  dealPhaseManager: {
    getDealWithFallback: vi.fn().mockResolvedValue(null),
    recordDeposit: vi.fn().mockResolvedValue({ success: true }),
    persistDealPublic: vi.fn(),
  },
}));

function tx(sender: PublicKey, deltaLamports: number) {
  return {
    transaction: {
      message: {
        staticAccountKeys: [sender, dealPda, PublicKey.default],
      },
    },
    meta: {
      preBalances: [0, 0, 0],
      postBalances: [0, deltaLamports, 0],
      logMessages: [],
    },
  };
}

describe("deposit watcher historical reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmedDeposits.clear();
    process.env.AIROTC_ENABLE_DEPOSIT_WS_WATCHER = "false";
  });

  afterEach(async () => {
    const { stopWatching } = await import("../src/listeners/depositWatcher");
    stopWatching(ticketId);
  });

  it("reconciles direct SOL PDA deposits even when payment arrived before both collaterals", async () => {
    const paymentSig = "3cE9XJMZkYosVnjuKtvXnZiZHeAqtBb9JmYB9yox5mXgeTGEMYxizEUfMvFzHhyEqdNpNxCDGnRseJeewFiRTZ4p";
    const sellerSig = "5HXHAAgi8312fP98QFXanxyfS8JEDbAqUPL7byK63aweT5jBJx6W2h4wYDbzyXWb7ekN8gRPEaAps4G6HGM3Dq5g";
    const buyerSig = "4YfM1HmqnpaXuzshYMSCC1qHNZiwCtzKAkWXLQPnXMNLhkhFEkeZiH4PQgB762DpD7sCj4Fyu93EhgAcv873iFsr";

    const connection = {
      getBalance: vi.fn().mockResolvedValue(703_633_120),
      getSignaturesForAddress: vi.fn().mockResolvedValue([
        { signature: buyerSig, err: null },
        { signature: sellerSig, err: null },
        { signature: paymentSig, err: null },
      ]),
      getTransaction: vi.fn(async (signature: string) => {
        if (signature === paymentSig) return tx(buyer, 0.1 * LAMPORTS_PER_SOL);
        if (signature === sellerSig) return tx(seller, 0.3 * LAMPORTS_PER_SOL);
        if (signature === buyerSig) return tx(buyer, 0.3 * LAMPORTS_PER_SOL);
        return null;
      }),
      removeAccountChangeListener: vi.fn(),
    };

    const { watchForDeposits, reconcileDepositWatcherFromHistory } = await import("../src/listeners/depositWatcher");
    await watchForDeposits(
      connection as any,
      ticketId,
      dealPda,
      0.3 * LAMPORTS_PER_SOL,
      0.3 * LAMPORTS_PER_SOL,
      0.1 * LAMPORTS_PER_SOL,
    );

    const result = await reconcileDepositWatcherFromHistory(connection as any, ticketId, "test");

    expect(result.buyerDeposited).toBe(true);
    expect(result.sellerDeposited).toBe(true);
    expect(result.paymentDeposited).toBe(true);
    const depositTypes = publishMock.mock.calls.map(call => call[1].deposit_type);
    expect(depositTypes.slice(0, 2).sort()).toEqual([
      "buyer_collateral",
      "seller_collateral",
    ]);
    expect(depositTypes[2]).toBe("buyer_payment");
  });
});
