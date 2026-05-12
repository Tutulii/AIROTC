import { describe, expect, it } from "vitest";
import { calculateTorqueParticipantReward } from "../src/services/torqueRewardPolicy";

const config = {
  erPlatformFeeBps: 100,
  perPlatformFeeBps: 110,
  erRewardShareOfFeeBps: 1000,
  perRewardShareOfFeeBps: 1200,
};

describe("torqueRewardPolicy", () => {
  it("computes ER participant rewards from platform fee share", () => {
    const quote = calculateTorqueParticipantReward({
      rollupMode: "ER",
      tradeNotionalLamports: 10_000_000_000n,
      config,
    });

    expect(quote.tradeNotionalLamports).toBe(10_000_000_000n);
    expect(quote.platformFeeBps).toBe(100);
    expect(quote.platformFeeLamports).toBe(100_000_000n);
    expect(quote.participantRewardLamports).toBe(5_000_000n);
  });

  it("computes PER participant rewards from the higher private fee share", () => {
    const quote = calculateTorqueParticipantReward({
      rollupMode: "PER",
      tradeNotionalLamports: 10_000_000_000n,
      config,
    });

    expect(quote.tradeNotionalLamports).toBe(10_000_000_000n);
    expect(quote.platformFeeBps).toBe(110);
    expect(quote.platformFeeLamports).toBe(110_000_000n);
    expect(quote.participantRewardLamports).toBe(6_600_000n);
  });

  it("rejects zero or negative trade notionals", () => {
    expect(() =>
      calculateTorqueParticipantReward({
        rollupMode: "ER",
        tradeNotionalLamports: 0n,
        config,
      })
    ).toThrow("torque_reward_trade_notional_must_be_positive");
  });
});
