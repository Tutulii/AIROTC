import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { MeridianClient as RuntimeMeridianClient } from "../src/sdk/meridianClient";
import { MeridianClient as AgentMeridianClient } from "../agents/sdk/MeridianClient";

const ORIGINAL_ENV = { ...process.env };

describe("strict PER legacy path guards", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("blocks runtime fetchLiveTerms for private sessions in strict PER mode", async () => {
    process.env.PER_STRICT_OPAQUE_MODE = "true";

    const client = new RuntimeMeridianClient({
      privateMode: true,
      connection: new Connection("https://api.devnet.solana.com", "confirmed"),
      payer: Keypair.generate(),
    });

    await expect(client.fetchLiveTerms("ticket-per")).rejects.toThrow(
      "per_strict_opaque_mode_violation:fetch_live_terms_disabled:ticket-per"
    );
    await expect(client.fetchCommittedTerms("ticket-per")).rejects.toThrow(
      "per_strict_opaque_mode_violation:fetch_committed_terms_disabled:ticket-per"
    );
  });

  it("still allows public-session fetchLiveTerms even when strict PER mode is enabled", async () => {
    process.env.PER_STRICT_OPAQUE_MODE = "true";

    const client = new RuntimeMeridianClient({
      privateMode: false,
      connection: new Connection("https://api.devnet.solana.com", "confirmed"),
      payer: Keypair.generate(),
    });

    const expected = {
      sessionPda: Keypair.generate().publicKey,
      agreedPriceLamports: 5n,
      agreedAsset: "SOL",
      buyerCollateralLamports: 2n,
      sellerCollateralLamports: 2n,
      status: "consensusReached",
    };

    const spy = vi
      .spyOn((client as any).rollupService, "fetchLiveTerms")
      .mockResolvedValue(expected);

    await expect(client.fetchLiveTerms("ticket-er")).resolves.toEqual(expected);
    expect(spy).toHaveBeenCalledWith("ticket-er");
  });

  it("blocks plaintext commit/reveal endpoints in the agent SDK under strict PER mode", async () => {
    const client = new AgentMeridianClient({
      apiUrl: "http://localhost:3000",
      wsUrl: "ws://localhost:3001",
      keypair: Keypair.generate(),
      privateMode: true,
      strictOpaquePerMode: true,
    });

    await expect(
      client.commitTerms("deal-1", {
        price: 5,
        collateral_buyer: 2,
        collateral_seller: 2,
        asset_type: "SOL",
      })
    ).rejects.toThrow("Strict opaque PER mode does not allow plaintext commit/reveal endpoints.");

    await expect(
      client.revealTerms(
        "deal-1",
        {
          price: 5,
          collateral_buyer: 2,
          collateral_seller: 2,
          asset_type: "SOL",
        },
        "nonce"
      )
    ).rejects.toThrow("Strict opaque PER mode does not allow plaintext commit/reveal endpoints.");

    await expect(client.getPrivacyStatus("deal-1")).rejects.toThrow(
      "Strict opaque PER mode does not expose legacy privacy-status endpoints."
    );
  });

  it("blocks storing plaintext PER session terms in strict mode", () => {
    process.env.PER_STRICT_OPAQUE_MODE = "true";

    const client = new RuntimeMeridianClient({
      privateMode: true,
      connection: new Connection("https://api.devnet.solana.com", "confirmed"),
      payer: Keypair.generate(),
    });

    expect(() =>
      client.setSessionTerms("ticket-per", {
        priceLamports: 5n,
        quantity: 1n,
        assetMint: Keypair.generate().publicKey,
        buyerCollateral: 2n,
        sellerCollateral: 2n,
      })
    ).toThrow("per_strict_opaque_mode_violation:set_session_terms_disabled:ticket-per");
  });
});
