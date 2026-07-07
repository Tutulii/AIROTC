import { describe, expect, it } from "vitest";
import { resolveSportStake } from "../src/api/restServer";

describe("SPORT stake resolver", () => {
  it("uses offer price as the SPORT equal-stake amount for position-layer offers", () => {
    expect(resolveSportStake(0.001, 1)).toBe(0.001);
  });

  it("falls back to amount for legacy SPORT callers without a price", () => {
    expect(resolveSportStake(0, 0.25)).toBe(0.25);
  });
});
