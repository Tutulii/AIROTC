import { describe, expect, it } from "vitest";
import { resolveSportEscrowAssetType, resolveSportStake } from "../src/api/restServer";

describe("SPORT stake resolver", () => {
  it("uses offer price as the SPORT equal-stake amount for position-layer offers", () => {
    expect(resolveSportStake(0.001, 1)).toBe(0.001);
  });

  it("falls back to amount for legacy SPORT callers without a price", () => {
    expect(resolveSportStake(0, 0.25)).toBe(0.25);
  });

  it("keeps TxLINE market labels out of SPORT on-chain mint resolution", () => {
    expect(resolveSportEscrowAssetType("SPORT", "TXLINE:18202701:1X2_PARTICIPANT_RESULT:part1", null)).toBe("SOL");
  });

  it("preserves non-SPORT asset resolution behavior", () => {
    expect(resolveSportEscrowAssetType("NONE", "BONK", null)).toBe("BONK");
  });
});
