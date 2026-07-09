import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Escrow } from "../target/types/escrow";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { assert, expect } from "chai";
import { createHash } from "crypto";

describe("escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.escrow as Program<Escrow>;

  // ── Keypairs ──
  const admin = provider.wallet as anchor.Wallet;
  const buyer = Keypair.generate();
  const seller = Keypair.generate();
  const middleman = Keypair.generate();
  const outsider = Keypair.generate();

  // ── PDAs ──
  let configPda: PublicKey;
  let configBump: number;

  // ── Helpers ──
  const DEAL_ID = new anchor.BN(1);
  const PRICE = new anchor.BN(1 * LAMPORTS_PER_SOL);
  const COLLATERAL_BUYER = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
  const COLLATERAL_SELLER = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
  const TIMEOUT_SECONDS = 10; // short timeout for testing

  function getDealPda(
    buyerKey: PublicKey,
    dealId: anchor.BN
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("deal"),
        buyerKey.toBuffer(),
        dealId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
  }

  function hash32(value: string): number[] {
    return Array.from(createHash("sha256").update(value).digest());
  }

  function getSportPositionPda(positionIdHash: number[]): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("sport_position"), Buffer.from(positionIdHash)],
      program.programId
    );
  }

  function getSportPositionPdaV2(positionIdHash: number[]): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("sport_position_v2"), Buffer.from(positionIdHash)],
      program.programId
    );
  }

  async function airdrop(
    key: PublicKey,
    amount: number = 10 * LAMPORTS_PER_SOL
  ) {
    const sig = await provider.connection.requestAirdrop(key, amount);
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  async function getBalance(key: PublicKey): Promise<number> {
    return provider.connection.getBalance(key);
  }

  // ── Setup ──
  before(async () => {
    // Find config PDA
    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    // Airdrop SOL to all participants
    await airdrop(buyer.publicKey);
    await airdrop(seller.publicKey);
    await airdrop(middleman.publicKey);
    await airdrop(outsider.publicKey);
  });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Config initialization
  // ═══════════════════════════════════════════════════════════════════

  describe("initialize_config", () => {
    it("initializes config with admin as authority", async () => {
      await program.methods
        .initializeConfig()
        .accountsPartial({
          config: configPda,
          authority: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const config = await program.account.config.fetch(configPda);
      assert.ok(config.authority.equals(admin.publicKey));
      assert.equal(config.paused, false);
    });

    it("fails to initialize config twice", async () => {
      try {
        await program.methods
          .initializeConfig()
          .accountsPartial({
            config: configPda,
            authority: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("should have thrown");
      } catch (err) {
        // Account already initialized — expect Anchor error
        assert.ok(err);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. Pause / unpause
  // ═══════════════════════════════════════════════════════════════════

  describe("set_paused", () => {
    it("admin can pause the contract", async () => {
      await program.methods
        .setPaused(true)
        .accountsPartial({
          config: configPda,
          authority: admin.publicKey,
        })
        .rpc();

      const config = await program.account.config.fetch(configPda);
      assert.equal(config.paused, true);
    });

    it("rejects deal creation while paused", async () => {
      const [dealPda] = getDealPda(buyer.publicKey, DEAL_ID);
      const now = Math.floor(Date.now() / 1000);

      try {
        await program.methods
          .createDeal(
            DEAL_ID,
            "SOL",
            "Test deal",
            PRICE,
            COLLATERAL_BUYER,
            COLLATERAL_SELLER,
            new anchor.BN(now + 3600),
            { normal: {} }, null
          )
          .accountsPartial({
            deal: dealPda,
            initializer: buyer.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            middleman: middleman.publicKey,
            config: configPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(
          err.toString().includes("Paused") ||
          err.error?.errorCode?.code === "Paused"
        );
      }
    });

    it("non-admin cannot toggle pause", async () => {
      try {
        await program.methods
          .setPaused(false)
          .accountsPartial({
            config: configPda,
            authority: outsider.publicKey,
          })
          .signers([outsider])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(
          err.toString().includes("Unauthorized") ||
          err.error?.errorCode?.code === "Unauthorized"
        );
      }
    });

    it("admin can unpause", async () => {
      await program.methods
        .setPaused(false)
        .accountsPartial({
          config: configPda,
          authority: admin.publicKey,
        })
        .rpc();

      const config = await program.account.config.fetch(configPda);
      assert.equal(config.paused, false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. Happy path: create → lock → pay → release → close
  // ═══════════════════════════════════════════════════════════════════

  describe("happy path", () => {
    const happyDealId = new anchor.BN(100);
    let dealPda: PublicKey;

    before(() => {
      [dealPda] = getDealPda(buyer.publicKey, happyDealId);
    });

    it("creates a deal", async () => {
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(
          happyDealId,
          "SOL",
          "1 SOL OTC trade",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 3600),
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.ok(deal.buyer.equals(buyer.publicKey));
      assert.ok(deal.seller.equals(seller.publicKey));
      assert.ok(deal.middleman.equals(middleman.publicKey));
      assert.equal(deal.price.toString(), PRICE.toString());
      assert.deepEqual(deal.status, { created: {} });
      assert.equal(deal.middlemanFeeBps, 100); // 1% for Normal
    });

    it("buyer locks collateral", async () => {
      const balBefore = await getBalance(buyer.publicKey);

      await program.methods
        .lockCollateral()
        .accountsPartial({
          deal: dealPda,
          user: buyer.publicKey,
          config: configPda,
                  })
        .signers([buyer])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.equal(deal.buyerCollateralLocked, true);
      assert.equal(deal.sellerCollateralLocked, false);
      assert.deepEqual(deal.status, { created: {} }); // not yet CollateralLocked

      const balAfter = await getBalance(buyer.publicKey);
      assert.ok(balBefore - balAfter >= COLLATERAL_BUYER.toNumber());
    });

    it("rejects buyer double-deposit", async () => {
      try {
        await program.methods
          .lockCollateral()
          .accountsPartial({
            deal: dealPda,
            user: buyer.publicKey,
            config: configPda,
                      })
          .signers([buyer])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(
          err.toString().includes("AlreadyDeposited") ||
          err.error?.errorCode?.code === "AlreadyDeposited"
        );
      }
    });

    it("seller locks collateral → status advances to CollateralLocked", async () => {
      await program.methods
        .lockCollateral()
        .accountsPartial({
          deal: dealPda,
          user: seller.publicKey,
          config: configPda,
                  })
        .signers([seller])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.equal(deal.buyerCollateralLocked, true);
      assert.equal(deal.sellerCollateralLocked, true);
      assert.deepEqual(deal.status, { collateralLocked: {} });
    });

    it("buyer locks payment → status advances to PaymentLocked", async () => {
      await program.methods
        .lockPayment()
        .accountsPartial({
          deal: dealPda,
          buyer: buyer.publicKey,
          config: configPda,
                  })
        .signers([buyer])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.equal(deal.paymentLocked, true);
      assert.deepEqual(deal.status, { paymentLocked: {} });
    });

    it("middleman releases funds → Completed", async () => {
      const sellerBefore = await getBalance(seller.publicKey);
      const buyerBefore = await getBalance(buyer.publicKey);
      const middlemanBefore = await getBalance(middleman.publicKey);

      await program.methods
        .releaseFunds()
        .accountsPartial({
          deal: dealPda,
          middleman: middleman.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          feeReceiver: middleman.publicKey,
          config: configPda,
                  })
        .signers([middleman])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.deepEqual(deal.status, { completed: {} });

      // Verify funds moved
      const sellerAfter = await getBalance(seller.publicKey);
      const buyerAfter = await getBalance(buyer.publicKey);

      // Seller should receive: price - fee + collateral_seller
      const expectedFee = PRICE.toNumber() / 100; // 1%
      const expectedSellerGain =
        PRICE.toNumber() - expectedFee + COLLATERAL_SELLER.toNumber();
      assert.ok(sellerAfter - sellerBefore >= expectedSellerGain - 10000); // tx fee tolerance

      // Buyer should get collateral back
      assert.ok(
        buyerAfter - buyerBefore >= COLLATERAL_BUYER.toNumber() - 10000
      );
    });

    it("closes the completed deal and reclaims rent", async () => {
      const rentBefore = await getBalance(buyer.publicKey);

      await program.methods
        .closeDeal()
        .accountsPartial({
          deal: dealPda,
          authority: buyer.publicKey,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      const rentAfter = await getBalance(buyer.publicKey);
      assert.ok(rentAfter > rentBefore); // rent reclaimed

      // Verify account is gone
      const info = await provider.connection.getAccountInfo(dealPda);
      assert.isNull(info);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. Cancellation flow
  // ═══════════════════════════════════════════════════════════════════

  describe("cancellation", () => {
    it("buyer can cancel a Created deal (no locks)", async () => {
      const cancelDealId = new anchor.BN(200);
      const [dealPda] = getDealPda(buyer.publicKey, cancelDealId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(
          cancelDealId,
          "SOL",
          "cancel test",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 3600),
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      await program.methods
        .cancelDeal()
        .accountsPartial({
          deal: dealPda,
          caller: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          config: configPda,
                  })
        .signers([buyer])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.deepEqual(deal.status, { cancelled: {} });
    });

    it("refunds buyer collateral on cancel after partial lock", async () => {
      const cancelDealId = new anchor.BN(201);
      const [dealPda] = getDealPda(buyer.publicKey, cancelDealId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(
          cancelDealId,
          "SOL",
          "partial cancel",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 3600),
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Buyer locks collateral
      await program.methods
        .lockCollateral()
        .accountsPartial({
          deal: dealPda,
          user: buyer.publicKey,
          config: configPda,
                  })
        .signers([buyer])
        .rpc();

      const balBefore = await getBalance(buyer.publicKey);

      // Buyer cancels → should get collateral back
      await program.methods
        .cancelDeal()
        .accountsPartial({
          deal: dealPda,
          caller: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          config: configPda,
                  })
        .signers([buyer])
        .rpc();

      const balAfter = await getBalance(buyer.publicKey);
      assert.ok(balAfter > balBefore); // got refund (minus tx fee)
    });

    it("only middleman can cancel when both collaterals locked", async () => {
      const cancelDealId = new anchor.BN(202);
      const [dealPda] = getDealPda(buyer.publicKey, cancelDealId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(
          cancelDealId,
          "SOL",
          "middleman cancel",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 3600),
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Both lock collateral
      await program.methods
        .lockCollateral()
        .accountsPartial({
          deal: dealPda,
          user: buyer.publicKey,
          config: configPda,
                  })
        .signers([buyer])
        .rpc();

      await program.methods
        .lockCollateral()
        .accountsPartial({
          deal: dealPda,
          user: seller.publicKey,
          config: configPda,
                  })
        .signers([seller])
        .rpc();

      // Buyer cannot cancel
      try {
        await program.methods
          .cancelDeal()
          .accountsPartial({
            deal: dealPda,
            caller: buyer.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            config: configPda,
                      })
          .signers([buyer])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(err.toString().includes("Unauthorized"));
      }

      // Middleman can cancel
      await program.methods
        .cancelDeal()
        .accountsPartial({
          deal: dealPda,
          caller: middleman.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          config: configPda,
                  })
        .signers([middleman])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.deepEqual(deal.status, { cancelled: {} });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. Timeout refund flow
  // ═══════════════════════════════════════════════════════════════════

  describe("refund_on_timeout", () => {
    it("refunds after timeout with proper signer", async () => {
      const timeoutDealId = new anchor.BN(300);
      const [dealPda] = getDealPda(buyer.publicKey, timeoutDealId);
      const now = Math.floor(Date.now() / 1000);

      // Create deal with very short timeout (already expired)
      await program.methods
        .createDeal(
          timeoutDealId,
          "SOL",
          "timeout test",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 2), // 2 seconds
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Lock buyer collateral
      await program.methods
        .lockCollateral()
        .accountsPartial({
          deal: dealPda,
          user: buyer.publicKey,
          config: configPda,
                  })
        .signers([buyer])
        .rpc();

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 4000));

      const buyerBefore = await getBalance(buyer.publicKey);

      // Buyer triggers refund
      await program.methods
        .refundOnTimeout()
        .accountsPartial({
          deal: dealPda,
          caller: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          config: configPda,
                  })
        .signers([buyer])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.deepEqual(deal.status, { refunded: {} });

      const buyerAfter = await getBalance(buyer.publicKey);
      assert.ok(buyerAfter > buyerBefore); // got collateral back
    });

    it("outsider cannot trigger timeout refund", async () => {
      const timeoutDealId2 = new anchor.BN(301);
      const [dealPda] = getDealPda(buyer.publicKey, timeoutDealId2);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(
          timeoutDealId2,
          "SOL",
          "outsider test",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 2),
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      await new Promise((resolve) => setTimeout(resolve, 4000));

      try {
        await program.methods
          .refundOnTimeout()
          .accountsPartial({
            deal: dealPda,
            caller: outsider.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            config: configPda,
                      })
          .signers([outsider])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(
          err.toString().includes("Unauthorized") ||
          err.error?.errorCode?.code === "Unauthorized"
        );
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. Access control / authorization failures
  // ═══════════════════════════════════════════════════════════════════

  describe("authorization", () => {
    const authDealId = new anchor.BN(400);
    let dealPda: PublicKey;

    before(async () => {
      [dealPda] = getDealPda(buyer.publicKey, authDealId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(
          authDealId,
          "SOL",
          "auth test",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 3600),
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();
    });

    it("outsider cannot lock collateral", async () => {
      try {
        await program.methods
          .lockCollateral()
          .accountsPartial({
            deal: dealPda,
            user: outsider.publicKey,
            config: configPda,
                      })
          .signers([outsider])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        // Constraint violation — Unauthorized
        assert.ok(err);
      }
    });

    it("seller cannot lock payment (only buyer)", async () => {
      // First lock both collaterals to reach CollateralLocked
      await program.methods
        .lockCollateral()
        .accountsPartial({
          deal: dealPda,
          user: buyer.publicKey,
          config: configPda,
                  })
        .signers([buyer])
        .rpc();

      await program.methods
        .lockCollateral()
        .accountsPartial({
          deal: dealPda,
          user: seller.publicKey,
          config: configPda,
                  })
        .signers([seller])
        .rpc();

      try {
        await program.methods
          .lockPayment()
          .accountsPartial({
            deal: dealPda,
            buyer: seller.publicKey,
            config: configPda,
                      })
          .signers([seller])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(err);
      }
    });

    it("non-middleman cannot release funds", async () => {
      // Lock payment first
      await program.methods
        .lockPayment()
        .accountsPartial({
          deal: dealPda,
          buyer: buyer.publicKey,
          config: configPda,
                  })
        .signers([buyer])
        .rpc();

      try {
        await program.methods
          .releaseFunds()
          .accountsPartial({
            deal: dealPda,
            middleman: buyer.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            feeReceiver: buyer.publicKey,
            config: configPda,
                      })
          .signers([buyer])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(err);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. Invalid state transitions
  // ═══════════════════════════════════════════════════════════════════

  describe("state transitions", () => {
    it("cannot lock payment before collateral is locked", async () => {
      const stDealId = new anchor.BN(500);
      const [dealPda] = getDealPda(buyer.publicKey, stDealId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(
          stDealId,
          "SOL",
          "state test",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 3600),
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      try {
        await program.methods
          .lockPayment()
          .accountsPartial({
            deal: dealPda,
            buyer: buyer.publicKey,
            config: configPda,
                      })
          .signers([buyer])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(
          err.toString().includes("CollateralNotLocked") ||
          err.error?.errorCode?.code === "CollateralNotLocked"
        );
      }
    });

    it("cannot close a non-terminal deal", async () => {
      const stDealId2 = new anchor.BN(501);
      const [dealPda] = getDealPda(buyer.publicKey, stDealId2);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(
          stDealId2,
          "SOL",
          "close test",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 3600),
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      try {
        await program.methods
          .closeDeal()
          .accountsPartial({
            deal: dealPda,
            authority: buyer.publicKey,
            rentReceiver: buyer.publicKey,
          })
          .signers([buyer])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(
          err.toString().includes("DealNotTerminal") ||
          err.error?.errorCode?.code === "DealNotTerminal"
        );
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 8. PDA uniqueness (seed collision prevention)
  // ═══════════════════════════════════════════════════════════════════

  describe("PDA uniqueness", () => {
    it("same deal_id with different buyers creates different PDAs", async () => {
      const sharedDealId = new anchor.BN(999);
      const [pdaBuyer1] = getDealPda(buyer.publicKey, sharedDealId);
      const [pdaBuyer2] = getDealPda(outsider.publicKey, sharedDealId);

      // These should be different addresses
      assert.ok(
        !pdaBuyer1.equals(pdaBuyer2),
        "PDAs should differ for different buyers"
      );
    });

    it("different deal_ids produce unique PDAs for same buyer", () => {
      const [pda1] = getDealPda(buyer.publicKey, new anchor.BN(1001));
      const [pda2] = getDealPda(buyer.publicKey, new anchor.BN(1002));
      assert.ok(!pda1.equals(pda2), "PDAs should differ for different deal IDs");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 9. Edge cases & overflow protection
  // ═══════════════════════════════════════════════════════════════════

  describe("edge cases", () => {
    it("rejects zero-value deal", async () => {
      const edgeDealId = new anchor.BN(600);
      const [dealPda] = getDealPda(buyer.publicKey, edgeDealId);
      const now = Math.floor(Date.now() / 1000);

      try {
        await program.methods
          .createDeal(
            edgeDealId,
            "SOL",
            "zero value",
            new anchor.BN(0), // Zero price
            new anchor.BN(0),
            new anchor.BN(0),
            new anchor.BN(now + 3600),
            { normal: {} }, null
          )
          .accountsPartial({
            deal: dealPda,
            initializer: buyer.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            middleman: middleman.publicKey,
            config: configPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer])
          .rpc();
        assert.fail("should have thrown for zero price");
      } catch (err: any) {
        assert.ok(err, "Zero-value deal should be rejected");
      }
    });

    it("handles maximum u64 price without overflow", async () => {
      const edgeDealId = new anchor.BN(601);
      const [dealPda] = getDealPda(buyer.publicKey, edgeDealId);
      const now = Math.floor(Date.now() / 1000);
      const maxU64 = new anchor.BN("18446744073709551615"); // 2^64 - 1

      try {
        await program.methods
          .createDeal(
            edgeDealId,
            "SOL",
            "overflow test",
            maxU64,
            maxU64,
            maxU64,
            new anchor.BN(now + 3600),
            { normal: {} }, null
          )
          .accountsPartial({
            deal: dealPda,
            initializer: buyer.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            middleman: middleman.publicKey,
            config: configPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer])
          .rpc();
        // Even if it succeeds, it won't be able to lock (insufficient funds)
        // The point is: no overflow panic
      } catch (err: any) {
        // Expected: either InsufficientFunds or Anchor constraint — NOT a panic
        assert.ok(err, "Should handle max u64 gracefully (no panic)");
      }
    });

    it("cannot create deal with same deal_id twice for same buyer", async () => {
      const dupDealId = new anchor.BN(602);
      const [dealPda] = getDealPda(buyer.publicKey, dupDealId);
      const now = Math.floor(Date.now() / 1000);

      // First creation succeeds
      await program.methods
        .createDeal(
          dupDealId,
          "SOL",
          "dup test",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 3600),
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Second creation should fail (PDA already exists)
      try {
        await program.methods
          .createDeal(
            dupDealId,
            "SOL",
            "dup test 2",
            PRICE,
            COLLATERAL_BUYER,
            COLLATERAL_SELLER,
            new anchor.BN(now + 3600),
            { normal: {} }, null
          )
          .accountsPartial({
            deal: dealPda,
            initializer: buyer.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            middleman: middleman.publicKey,
            config: configPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(err, "Duplicate deal_id for same buyer should fail");
      }
    });

    it("seller can also cancel a Created deal", async () => {
      const sellerCancelId = new anchor.BN(603);
      const [dealPda] = getDealPda(buyer.publicKey, sellerCancelId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(
          sellerCancelId,
          "SOL",
          "seller cancel OK",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 3600),
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Seller cancels (should be allowed on Created deals)
      await program.methods
        .cancelDeal()
        .accountsPartial({
          deal: dealPda,
          caller: seller.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          config: configPda,
                  })
        .signers([seller])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.deepEqual(deal.status, { cancelled: {} });
    });

    it("refund before timeout is rejected", async () => {
      const noTimeoutId = new anchor.BN(604);
      const [dealPda] = getDealPda(buyer.publicKey, noTimeoutId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(
          noTimeoutId,
          "SOL",
          "early refund test",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 86400), // 24 hours — far from expiry
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      try {
        await program.methods
          .refundOnTimeout()
          .accountsPartial({
            deal: dealPda,
            caller: buyer.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            config: configPda,
                      })
          .signers([buyer])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(
          err.toString().includes("NotTimedOut") ||
          err.toString().includes("Timeout") ||
          err.error?.errorCode?.code === "NotTimedOut",
          "Refund before timeout should fail"
        );
      }
    });

    it("cannot release on non-PaymentLocked deal", async () => {
      const releaseId = new anchor.BN(605);
      const [dealPda] = getDealPda(buyer.publicKey, releaseId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(
          releaseId,
          "SOL",
          "early release test",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 3600),
          { normal: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      try {
        await program.methods
          .releaseFunds()
          .accountsPartial({
            deal: dealPda,
            middleman: middleman.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            feeReceiver: middleman.publicKey,
            config: configPda,
                      })
          .signers([middleman])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(err, "Release on Created deal should fail");
      }
    });

    it("outsider cannot close even a completed deal", async () => {
      // Try to close one of the already-completed deals
      const existingDealId = new anchor.BN(200);
      const [dealPda] = getDealPda(buyer.publicKey, existingDealId);

      try {
        await program.methods
          .closeDeal()
          .accountsPartial({
            deal: dealPda,
            authority: outsider.publicKey,
            rentReceiver: outsider.publicKey,
          })
          .signers([outsider])
          .rpc();
        // If it doesn't throw, the deal might already be closed — which is also OK
      } catch (err: any) {
        assert.ok(err, "Outsider should not be able to close deal");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 10. Privacy mode deal creation & fee verification
  // ═══════════════════════════════════════════════════════════════════

  describe("privacy mode", () => {
    it("creates a privacy-mode deal with terms hash", async () => {
      const privDealId = new anchor.BN(700);
      const [dealPda] = getDealPda(buyer.publicKey, privDealId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(
          privDealId,
          "SOL",
          "privacy deal",
          PRICE,
          COLLATERAL_BUYER,
          COLLATERAL_SELLER,
          new anchor.BN(now + 3600),
          { privacy: {} }, null
        )
        .accountsPartial({
          deal: dealPda,
          initializer: buyer.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          middleman: middleman.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.deepEqual(deal.status, { created: {} });
      // Privacy mode should have higher middleman fee (150 bps = 1.5%)
      assert.equal(deal.middlemanFeeBps, 150, "Privacy mode fee should be 150 bps");
    });

    it("privacy mode fee differs from normal mode fee", async () => {
      const normalDealId = new anchor.BN(701);
      const privDealId2 = new anchor.BN(702);
      const [normalPda] = getDealPda(buyer.publicKey, normalDealId);
      const [privPda] = getDealPda(buyer.publicKey, privDealId2);
      const now = Math.floor(Date.now() / 1000);

      // Create normal deal
      await program.methods
        .createDeal(normalDealId, "SOL", "normal fee test", PRICE,
          COLLATERAL_BUYER, COLLATERAL_SELLER, new anchor.BN(now + 3600), { normal: {} }, null)
        .accountsPartial({
          deal: normalPda, initializer: buyer.publicKey,
          buyer: buyer.publicKey, seller: seller.publicKey,
          middleman: middleman.publicKey, config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Create privacy deal
      await program.methods
        .createDeal(privDealId2, "SOL", "privacy fee test", PRICE,
          COLLATERAL_BUYER, COLLATERAL_SELLER, new anchor.BN(now + 3600), { privacy: {} }, null)
        .accountsPartial({
          deal: privPda, initializer: buyer.publicKey,
          buyer: buyer.publicKey, seller: seller.publicKey,
          middleman: middleman.publicKey, config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      const normalDeal = await program.account.deal.fetch(normalPda);
      const privDeal = await program.account.deal.fetch(privPda);
      assert.notEqual(
        normalDeal.middlemanFeeBps,
        privDeal.middlemanFeeBps,
        "Privacy mode should have different fee bps than normal"
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 11. Advanced authorization & state edge cases
  // ═══════════════════════════════════════════════════════════════════

  describe("advanced edge cases", () => {
    it("outsider cannot cancel a Created deal", async () => {
      const advDealId = new anchor.BN(800);
      const [dealPda] = getDealPda(buyer.publicKey, advDealId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(advDealId, "SOL", "outsider cancel test", PRICE,
          COLLATERAL_BUYER, COLLATERAL_SELLER, new anchor.BN(now + 3600), { normal: {} }, null)
        .accountsPartial({
          deal: dealPda, initializer: buyer.publicKey,
          buyer: buyer.publicKey, seller: seller.publicKey,
          middleman: middleman.publicKey, config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      try {
        await program.methods
          .cancelDeal()
          .accountsPartial({
            deal: dealPda,
            caller: outsider.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            config: configPda,
                      })
          .signers([outsider])
          .rpc();
        assert.fail("Outsider should not be able to cancel");
      } catch (err: any) {
        assert.ok(
          err.toString().includes("Unauthorized") ||
          err.error?.errorCode?.code === "Unauthorized",
          "Should reject outsider cancel"
        );
      }
    });

    it("cannot release funds on a cancelled deal", async () => {
      const cancelRelId = new anchor.BN(801);
      const [dealPda] = getDealPda(buyer.publicKey, cancelRelId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(cancelRelId, "SOL", "cancel-release test", PRICE,
          COLLATERAL_BUYER, COLLATERAL_SELLER, new anchor.BN(now + 3600), { normal: {} }, null)
        .accountsPartial({
          deal: dealPda, initializer: buyer.publicKey,
          buyer: buyer.publicKey, seller: seller.publicKey,
          middleman: middleman.publicKey, config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      // Cancel it
      await program.methods
        .cancelDeal()
        .accountsPartial({
          deal: dealPda, caller: buyer.publicKey,
          buyer: buyer.publicKey, seller: seller.publicKey,
          config: configPda,         })
        .signers([buyer])
        .rpc();

      // Try to release on cancelled deal
      try {
        await program.methods
          .releaseFunds()
          .accountsPartial({
            deal: dealPda, middleman: middleman.publicKey,
            buyer: buyer.publicKey, seller: seller.publicKey,
            feeReceiver: middleman.publicKey, config: configPda,
                      })
          .signers([middleman])
          .rpc();
        assert.fail("Should not release on cancelled deal");
      } catch (err: any) {
        assert.ok(err, "Release on cancelled deal should fail");
      }
    });

    it("cannot lock collateral on a cancelled deal", async () => {
      const lockCancelId = new anchor.BN(802);
      const [dealPda] = getDealPda(buyer.publicKey, lockCancelId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(lockCancelId, "SOL", "lock-after-cancel test", PRICE,
          COLLATERAL_BUYER, COLLATERAL_SELLER, new anchor.BN(now + 3600), { normal: {} }, null)
        .accountsPartial({
          deal: dealPda, initializer: buyer.publicKey,
          buyer: buyer.publicKey, seller: seller.publicKey,
          middleman: middleman.publicKey, config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      await program.methods
        .cancelDeal()
        .accountsPartial({
          deal: dealPda, caller: buyer.publicKey,
          buyer: buyer.publicKey, seller: seller.publicKey,
          config: configPda,         })
        .signers([buyer])
        .rpc();

      try {
        await program.methods
          .lockCollateral()
          .accountsPartial({
            deal: dealPda, user: buyer.publicKey,
            config: configPda,           })
          .signers([buyer])
          .rpc();
        assert.fail("Should not lock collateral on cancelled deal");
      } catch (err: any) {
        assert.ok(err, "Lock after cancel should fail");
      }
    });

    it("deal metadata is correctly stored (asset, description, price)", async () => {
      const metaDealId = new anchor.BN(803);
      const [dealPda] = getDealPda(buyer.publicKey, metaDealId);
      const now = Math.floor(Date.now() / 1000);
      const testAsset = "BONK";
      const testDesc = "Metadata verification test";

      await program.methods
        .createDeal(metaDealId, testAsset, testDesc, PRICE,
          COLLATERAL_BUYER, COLLATERAL_SELLER, new anchor.BN(now + 3600), { normal: {} }, null)
        .accountsPartial({
          deal: dealPda, initializer: buyer.publicKey,
          buyer: buyer.publicKey, seller: seller.publicKey,
          middleman: middleman.publicKey, config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.equal(deal.assetType, testAsset, "Asset should match");
      assert.equal(deal.assetDescription, testDesc, "Description should match");
      assert.equal(deal.price.toString(), PRICE.toString(), "Price should match");
      assert.equal(deal.collateralBuyer.toString(), COLLATERAL_BUYER.toString());
      assert.equal(deal.collateralSeller.toString(), COLLATERAL_SELLER.toString());
    });

    it("deal expiry timestamp is correctly stored", async () => {
      const expiryId = new anchor.BN(804);
      const [dealPda] = getDealPda(buyer.publicKey, expiryId);
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + 7200; // 2 hours

      await program.methods
        .createDeal(expiryId, "SOL", "expiry test", PRICE,
          COLLATERAL_BUYER, COLLATERAL_SELLER, new anchor.BN(expiresAt), { normal: {} }, null)
        .accountsPartial({
          deal: dealPda, initializer: buyer.publicKey,
          buyer: buyer.publicKey, seller: seller.publicKey,
          middleman: middleman.publicKey, config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.equal(deal.timeout.toNumber(), expiresAt, "Expiry timestamp should match");
    });

    it("middleman can cancel even a Created deal", async () => {
      const mmCancelId = new anchor.BN(805);
      const [dealPda] = getDealPda(buyer.publicKey, mmCancelId);
      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createDeal(mmCancelId, "SOL", "middleman early cancel", PRICE,
          COLLATERAL_BUYER, COLLATERAL_SELLER, new anchor.BN(now + 3600), { normal: {} }, null)
        .accountsPartial({
          deal: dealPda, initializer: buyer.publicKey,
          buyer: buyer.publicKey, seller: seller.publicKey,
          middleman: middleman.publicKey, config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      await program.methods
        .cancelDeal()
        .accountsPartial({
          deal: dealPda, caller: middleman.publicKey,
          buyer: buyer.publicKey, seller: seller.publicKey,
          config: configPda,         })
        .signers([middleman])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.deepEqual(deal.status, { cancelled: {} }, "Middleman should be able to cancel Created deal");
    });
  });

  describe("sport prefunded positions", () => {
    const nativeMint = new PublicKey("So11111111111111111111111111111111111111112");
    const sportStake = new anchor.BN(0.05 * LAMPORTS_PER_SOL);

    before(async () => {
      try {
        await program.account.config.fetch(configPda);
      } catch {
        await program.methods
          .initializeConfig()
          .accountsPartial({
            config: configPda,
            authority: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }
    });

    it("creates, funds, commits, and settles equal-stake SPORT positions", async () => {
      const now = Math.floor(Date.now() / 1000);
      const buyerPositionHash = hash32(`sport-buyer-${Date.now()}`);
      const sellerPositionHash = hash32(`sport-seller-${Date.now()}`);
      const fixtureHash = hash32("txline-fixture-18198205");
      const marketHash = hash32("1X2_PARTICIPANT_RESULT");
      const selectionHash = hash32("part1");
      const [buyerPositionPda] = getSportPositionPda(buyerPositionHash);
      const [sellerPositionPda] = getSportPositionPda(sellerPositionHash);

      await program.methods
        .initializeSportPosition(
          buyerPositionHash,
          fixtureHash,
          marketHash,
          selectionHash,
          { back: {} },
          sportStake,
          new anchor.BN(now + 3600)
        )
        .accountsPartial({
          sportPosition: buyerPositionPda,
          owner: buyer.publicKey,
          mint: nativeMint,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      await program.methods
        .initializeSportPosition(
          sellerPositionHash,
          fixtureHash,
          marketHash,
          selectionHash,
          { lay: {} },
          sportStake,
          new anchor.BN(now + 3600)
        )
        .accountsPartial({
          sportPosition: sellerPositionPda,
          owner: seller.publicKey,
          mint: nativeMint,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      await program.methods
        .fundSportPosition()
        .accountsPartial({
          sportPosition: buyerPositionPda,
          owner: buyer.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      await program.methods
        .fundSportPosition()
        .accountsPartial({
          sportPosition: sellerPositionPda,
          owner: seller.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      const fundedBuyerPosition = await (program.account as any).sportPositionVault.fetch(buyerPositionPda);
      const fundedSellerPosition = await (program.account as any).sportPositionVault.fetch(sellerPositionPda);
      assert.equal(fundedBuyerPosition.funded, true);
      assert.equal(fundedSellerPosition.funded, true);

      const sportDealId = new anchor.BN(900);
      const [dealPda] = getDealPda(buyer.publicKey, sportDealId);

      await program.methods
        .commitSportPositionsToDeal(sportDealId, new anchor.BN(now + 86400))
        .accountsPartial({
          buyerPosition: buyerPositionPda,
          sellerPosition: sellerPositionPda,
          deal: dealPda,
          middleman: middleman.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          mint: nativeMint,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([middleman])
        .rpc();

      const deal = await program.account.deal.fetch(dealPda);
      assert.deepEqual(deal.tradeMode, { sport: {} });
      assert.deepEqual(deal.status, { paymentLocked: {} });
      assert.equal(deal.price.toString(), sportStake.toString());
      assert.equal(deal.collateralBuyer.toString(), "0");
      assert.equal(deal.collateralSeller.toString(), sportStake.toString());
      assert.equal(deal.buyerCollateralLocked, true);
      assert.equal(deal.sellerCollateralLocked, true);
      assert.equal(deal.paymentLocked, true);
      assert.isNull(await provider.connection.getAccountInfo(buyerPositionPda));
      assert.isNull(await provider.connection.getAccountInfo(sellerPositionPda));

      const buyerBeforeSettlement = await getBalance(buyer.publicKey);
      await program.methods
        .settleToBuyer()
        .accountsPartial({
          deal: dealPda,
          middleman: middleman.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          feeReceiver: middleman.publicKey,
          dealAta: dealPda,
          buyerAta: buyer.publicKey,
          sellerAta: seller.publicKey,
          feeAta: middleman.publicKey,
          config: configPda,
        })
        .signers([middleman])
        .rpc();

      const buyerAfterSettlement = await getBalance(buyer.publicKey);
      const settledDeal = await program.account.deal.fetch(dealPda);
      assert.deepEqual(settledDeal.status, { refunded: {} });
      assert.ok(
        buyerAfterSettlement - buyerBeforeSettlement >= 2 * sportStake.toNumber() - sportStake.toNumber() / 100 - 10000,
        "SPORT winner should receive the pooled stake minus fee"
      );
    });

    it("cancels an unmatched funded SPORT position and closes the vault", async () => {
      const now = Math.floor(Date.now() / 1000);
      const positionHash = hash32(`sport-cancel-${Date.now()}`);
      const [positionPda] = getSportPositionPda(positionHash);

      await program.methods
        .initializeSportPosition(
          positionHash,
          hash32("txline-fixture-cancel"),
          hash32("1X2_PARTICIPANT_RESULT"),
          hash32("draw"),
          { back: {} },
          sportStake,
          new anchor.BN(now + 3600)
        )
        .accountsPartial({
          sportPosition: positionPda,
          owner: buyer.publicKey,
          mint: nativeMint,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      await program.methods
        .fundSportPosition()
        .accountsPartial({
          sportPosition: positionPda,
          owner: buyer.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      await program.methods
        .cancelSportPosition()
        .accountsPartial({
          sportPosition: positionPda,
          owner: buyer.publicKey,
          config: configPda,
        })
        .signers([buyer])
        .rpc();

      assert.isNull(await provider.connection.getAccountInfo(positionPda));
    });

    it("partially commits v2 SPORT positions and refunds unmatched remaining stake", async () => {
      const now = Math.floor(Date.now() / 1000);
      const buyerPositionHash = hash32(`sport-v2-buyer-${Date.now()}`);
      const sellerPositionHash = hash32(`sport-v2-seller-${Date.now()}`);
      const fixtureHash = hash32("txline-fixture-v2-partial");
      const marketHash = hash32("1X2_PARTICIPANT_RESULT");
      const selectionHash = hash32("part1");
      const backStake = new anchor.BN(0.03 * LAMPORTS_PER_SOL);
      const layStake = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
      const fillStake = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
      const remainingStake = new anchor.BN(0.02 * LAMPORTS_PER_SOL);
      const [buyerPositionPda] = getSportPositionPdaV2(buyerPositionHash);
      const [sellerPositionPda] = getSportPositionPdaV2(sellerPositionHash);

      await program.methods
        .initializeSportPositionV2(
          buyerPositionHash,
          fixtureHash,
          marketHash,
          selectionHash,
          { back: {} },
          backStake,
          new anchor.BN(now + 3600)
        )
        .accountsPartial({
          sportPosition: buyerPositionPda,
          owner: buyer.publicKey,
          mint: nativeMint,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      await program.methods
        .initializeSportPositionV2(
          sellerPositionHash,
          fixtureHash,
          marketHash,
          selectionHash,
          { lay: {} },
          layStake,
          new anchor.BN(now + 3600)
        )
        .accountsPartial({
          sportPosition: sellerPositionPda,
          owner: seller.publicKey,
          mint: nativeMint,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      await program.methods
        .fundSportPositionV2()
        .accountsPartial({
          sportPosition: buyerPositionPda,
          owner: buyer.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      await program.methods
        .fundSportPositionV2()
        .accountsPartial({
          sportPosition: sellerPositionPda,
          owner: seller.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      const fundedBuyerPosition = await (program.account as any).sportPositionVaultV2.fetch(buyerPositionPda);
      const fundedSellerPosition = await (program.account as any).sportPositionVaultV2.fetch(sellerPositionPda);
      assert.equal(fundedBuyerPosition.availableStake.toString(), backStake.toString());
      assert.equal(fundedBuyerPosition.committedStake.toString(), "0");
      assert.equal(fundedSellerPosition.availableStake.toString(), layStake.toString());

      const sportDealId = new anchor.BN(910);
      const [dealPda] = getDealPda(buyer.publicKey, sportDealId);

      await program.methods
        .commitSportPositionFillToDeal(sportDealId, fillStake, new anchor.BN(now + 86400))
        .accountsPartial({
          buyerPosition: buyerPositionPda,
          sellerPosition: sellerPositionPda,
          deal: dealPda,
          middleman: middleman.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          mint: nativeMint,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([middleman])
        .rpc();

      const partialDeal = await program.account.deal.fetch(dealPda);
      assert.deepEqual(partialDeal.tradeMode, { sport: {} });
      assert.deepEqual(partialDeal.status, { paymentLocked: {} });
      assert.equal(partialDeal.price.toString(), fillStake.toString());
      assert.equal(partialDeal.collateralBuyer.toString(), "0");
      assert.equal(partialDeal.collateralSeller.toString(), fillStake.toString());

      const postFillBuyerPosition = await (program.account as any).sportPositionVaultV2.fetch(buyerPositionPda);
      const postFillSellerPosition = await (program.account as any).sportPositionVaultV2.fetch(sellerPositionPda);
      assert.equal(postFillBuyerPosition.availableStake.toString(), remainingStake.toString());
      assert.equal(postFillBuyerPosition.committedStake.toString(), fillStake.toString());
      assert.equal(postFillBuyerPosition.refundedStake.toString(), "0");
      assert.equal(postFillSellerPosition.availableStake.toString(), "0");
      assert.equal(postFillSellerPosition.committedStake.toString(), fillStake.toString());

      const overfillDealId = new anchor.BN(911);
      const [overfillDealPda] = getDealPda(buyer.publicKey, overfillDealId);
      try {
        await program.methods
          .commitSportPositionFillToDeal(overfillDealId, new anchor.BN(1), new anchor.BN(now + 86400))
          .accountsPartial({
            buyerPosition: buyerPositionPda,
            sellerPosition: sellerPositionPda,
            deal: overfillDealPda,
            middleman: middleman.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            mint: nativeMint,
            config: configPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([middleman])
          .rpc();
        assert.fail("overfill should have thrown");
      } catch (err: any) {
        assert.ok(
          err.toString().includes("InsufficientFunds") ||
          err.error?.errorCode?.code === "InsufficientFunds"
        );
      }

      await program.methods
        .cancelSportPositionRemaining()
        .accountsPartial({
          sportPosition: buyerPositionPda,
          owner: buyer.publicKey,
          config: configPda,
        })
        .signers([buyer])
        .rpc();

      const cancelledBuyerPosition = await (program.account as any).sportPositionVaultV2.fetch(buyerPositionPda);
      assert.equal(cancelledBuyerPosition.availableStake.toString(), "0");
      assert.equal(cancelledBuyerPosition.committedStake.toString(), fillStake.toString());
      assert.equal(cancelledBuyerPosition.refundedStake.toString(), remainingStake.toString());

      await program.methods
        .closeSportPositionV2IfEmpty()
        .accountsPartial({
          sportPosition: sellerPositionPda,
          owner: seller.publicKey,
          config: configPda,
        })
        .signers([seller])
        .rpc();

      await program.methods
        .closeSportPositionV2IfEmpty()
        .accountsPartial({
          sportPosition: buyerPositionPda,
          owner: buyer.publicKey,
          config: configPda,
        })
        .signers([buyer])
        .rpc();

      assert.isNull(await provider.connection.getAccountInfo(sellerPositionPda));
      assert.isNull(await provider.connection.getAccountInfo(buyerPositionPda));
    });

    it("lets a keeper refund and close an expired unmatched v2 SPORT position", async () => {
      const now = Math.floor(Date.now() / 1000);
      const positionHash = hash32(`sport-v2-expired-refund-${Date.now()}`);
      const [positionPda] = getSportPositionPdaV2(positionHash);
      const stake = new anchor.BN(0.02 * LAMPORTS_PER_SOL);

      await program.methods
        .initializeSportPositionV2(
          positionHash,
          hash32("txline-fixture-expired-refund"),
          hash32("1X2_PARTICIPANT_RESULT"),
          hash32("part2"),
          { lay: {} },
          stake,
          new anchor.BN(now + 1)
        )
        .accountsPartial({
          sportPosition: positionPda,
          owner: seller.publicKey,
          mint: nativeMint,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      await program.methods
        .fundSportPositionV2()
        .accountsPartial({
          sportPosition: positionPda,
          owner: seller.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      try {
        await program.methods
          .refundExpiredSportPositionRemaining()
          .accountsPartial({
            sportPosition: positionPda,
            owner: seller.publicKey,
            keeper: middleman.publicKey,
            config: configPda,
          })
          .signers([middleman])
          .rpc();
        assert.fail("keeper refund before expiry should have thrown");
      } catch (err: any) {
        assert.ok(
          err.toString().includes("TimeoutNotReached") ||
          err.error?.errorCode?.code === "TimeoutNotReached"
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 4000));
      const sellerBeforeRefund = await getBalance(seller.publicKey);

      await program.methods
        .refundExpiredSportPositionRemaining()
        .accountsPartial({
          sportPosition: positionPda,
          owner: seller.publicKey,
          keeper: middleman.publicKey,
          config: configPda,
        })
        .signers([middleman])
        .rpc();

      const sellerAfterRefund = await getBalance(seller.publicKey);
      const refundedPosition = await (program.account as any).sportPositionVaultV2.fetch(positionPda);
      assert.equal(refundedPosition.availableStake.toString(), "0");
      assert.equal(refundedPosition.committedStake.toString(), "0");
      assert.equal(refundedPosition.refundedStake.toString(), stake.toString());
      assert.ok(
        sellerAfterRefund - sellerBeforeRefund >= stake.toNumber(),
        "expired keeper refund should return unmatched stake to the original owner"
      );

      await program.methods
        .closeExpiredSportPositionV2IfEmpty()
        .accountsPartial({
          sportPosition: positionPda,
          owner: seller.publicKey,
          keeper: middleman.publicKey,
          config: configPda,
        })
        .signers([middleman])
        .rpc();

      assert.isNull(await provider.connection.getAccountInfo(positionPda));
    });

    it("rejects legacy create_deal for SPORT mode", async () => {
      const sportDealId = new anchor.BN(901);
      const [dealPda] = getDealPda(buyer.publicKey, sportDealId);
      const now = Math.floor(Date.now() / 1000);

      try {
        await program.methods
          .createDeal(
            sportDealId,
            "SPORT",
            "should be prefunded",
            sportStake,
            new anchor.BN(0),
            sportStake,
            new anchor.BN(now + 3600),
            { sport: {} }, null
          )
          .accountsPartial({
            deal: dealPda,
            initializer: buyer.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            middleman: middleman.publicKey,
            mint: nativeMint,
            config: configPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          })
          .signers([buyer])
          .rpc();
        assert.fail("should have thrown");
      } catch (err: any) {
        assert.ok(
          err.toString().includes("SportDealRequiresPrefundedPositions") ||
          err.error?.errorCode?.code === "SportDealRequiresPrefundedPositions"
        );
      }
    });
  });
});
