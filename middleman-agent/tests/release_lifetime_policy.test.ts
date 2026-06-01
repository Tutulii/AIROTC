import { describe, expect, it } from "vitest";
import { shouldEnforceReleaseLifetime } from "../src/services/releaseLifetimePolicy";

describe("release lifetime policy", () => {
  it("does not enforce the wall-clock release TTL after payment is locked", () => {
    expect(shouldEnforceReleaseLifetime({ payment_locked: true })).toBe(false);
    expect(shouldEnforceReleaseLifetime({ paymentLocked: true })).toBe(false);
  });

  it("keeps the lifetime guard for deals that are not payment locked", () => {
    expect(shouldEnforceReleaseLifetime({ payment_locked: false })).toBe(true);
    expect(shouldEnforceReleaseLifetime(null)).toBe(true);
  });
});
