import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("PER strict opaque mode config", () => {
  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("defaults strict opaque PER mode to true", async () => {
    delete process.env.PER_STRICT_OPAQUE_MODE;
    process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";
    process.env.PROGRAM_ID = "prog";
    process.env.PRIVATE_KEY = "secret";
    process.env.OPENAI_API_KEY = "test-key";

    const { loadConfig } = await import("../src/config");
    expect(loadConfig().perStrictOpaqueMode).toBe(true);
  });

  it("allows strict opaque PER mode to be explicitly disabled", async () => {
    process.env.PER_STRICT_OPAQUE_MODE = "false";
    process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";
    process.env.PROGRAM_ID = "prog";
    process.env.PRIVATE_KEY = "secret";
    process.env.OPENAI_API_KEY = "test-key";

    const { loadConfig } = await import("../src/config");
    expect(loadConfig().perStrictOpaqueMode).toBe(false);
  });
});
