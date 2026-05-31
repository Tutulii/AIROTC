import { describe, expect, it } from "vitest";

import { redactUrlSecret } from "../src/utils/redact";

describe("redactUrlSecret", () => {
  it("redacts query-string RPC secrets", () => {
    expect(redactUrlSecret("https://devnet.helius-rpc.com/?api-key=helius-secret")).toBe(
      "https://devnet.helius-rpc.com/?api-key=***"
    );
  });

  it("redacts Alchemy path-style RPC secrets", () => {
    expect(redactUrlSecret("https://solana-devnet.g.alchemy.com/v2/alchemy-secret-key")).toBe(
      "https://solana-devnet.g.alchemy.com/v2/***"
    );
    expect(redactUrlSecret("wss://solana-devnet.g.alchemy.com/v2/alchemy-secret-key")).toBe(
      "wss://solana-devnet.g.alchemy.com/v2/***"
    );
  });

  it("redacts provider passwords and long QuickNode path tokens", () => {
    expect(redactUrlSecret("https://user:pass@example.com/rpc")).toBe(
      "https://user:***@example.com/rpc"
    );
    expect(redactUrlSecret("https://white-long-secret-token.solana-devnet.quiknode.pro/0123456789abcdef0123456789abcdef")).toBe(
      "https://white-long-secret-token.solana-devnet.quiknode.pro/***"
    );
  });
});
