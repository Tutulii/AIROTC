import { describe, expect, it } from "vitest";
import { resolveNormalEscrowTimeoutPolicy } from "../src/services/normalEscrowTimeoutPolicy";

const NOW_MS = Date.UTC(2026, 5, 6, 12, 0, 0);

describe("normal escrow timeout policy", () => {
  it("uses the 7-day production default without proof override env", () => {
    const policy = resolveNormalEscrowTimeoutPolicy({}, NOW_MS);

    expect(policy.source).toBe("default_7_day_timeout");
    expect(policy.devnetOnly).toBe(false);
    expect(policy.durationSeconds).toBe(7 * 24 * 60 * 60);
    expect(policy.timeoutUnixSeconds).toBe(Math.floor(NOW_MS / 1000) + policy.durationSeconds);
  });

  it("allows short timeout only with explicit devnet proof acknowledgement", () => {
    const policy = resolveNormalEscrowTimeoutPolicy(
      {
        AIROTC_NORMAL_ESCROW_TIMEOUT_SECONDS: "15",
        AIROTC_ALLOW_SHORT_ESCROW_TIMEOUT_FOR_DEVNET_PROOF: "true",
        SOLANA_RPC_URL: "https://api.devnet.solana.com",
      },
      NOW_MS
    );

    expect(policy.source).toBe("devnet_proof_override");
    expect(policy.devnetOnly).toBe(true);
    expect(policy.durationSeconds).toBe(15);
    expect(policy.timeoutUnixSeconds).toBe(Math.floor(NOW_MS / 1000) + 15);
  });

  it("rejects short timeout without explicit proof acknowledgement", () => {
    expect(() =>
      resolveNormalEscrowTimeoutPolicy(
        {
          AIROTC_NORMAL_ESCROW_TIMEOUT_SECONDS: "15",
          SOLANA_RPC_URL: "https://api.devnet.solana.com",
        },
        NOW_MS
      )
    ).toThrow(/requires_AIROTC_ALLOW_SHORT_ESCROW_TIMEOUT_FOR_DEVNET_PROOF/);
  });

  it("rejects short timeout outside devnet", () => {
    expect(() =>
      resolveNormalEscrowTimeoutPolicy(
        {
          AIROTC_NORMAL_ESCROW_TIMEOUT_SECONDS: "15",
          AIROTC_ALLOW_SHORT_ESCROW_TIMEOUT_FOR_DEVNET_PROOF: "true",
          SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
        },
        NOW_MS
      )
    ).toThrow(/requires_AIROTC_ALLOW_SHORT_ESCROW_TIMEOUT_FOR_DEVNET_PROOF/);
  });

  it("rejects unsafe proof override durations", () => {
    expect(() =>
      resolveNormalEscrowTimeoutPolicy(
        {
          AIROTC_NORMAL_ESCROW_TIMEOUT_SECONDS: "5",
          AIROTC_ALLOW_SHORT_ESCROW_TIMEOUT_FOR_DEVNET_PROOF: "true",
          SOLANA_RPC_URL: "https://api.devnet.solana.com",
        },
        NOW_MS
      )
    ).toThrow(/at_least_10_seconds/);

    expect(() =>
      resolveNormalEscrowTimeoutPolicy(
        {
          AIROTC_NORMAL_ESCROW_TIMEOUT_SECONDS: "604801",
          AIROTC_ALLOW_SHORT_ESCROW_TIMEOUT_FOR_DEVNET_PROOF: "true",
          SOLANA_RPC_URL: "https://api.devnet.solana.com",
        },
        NOW_MS
      )
    ).toThrow(/must_not_exceed_default_7_day_timeout/);
  });
});
