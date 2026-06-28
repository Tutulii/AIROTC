import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectionState = vi.hoisted(() => ({
  createdEndpoints: [] as string[],
  slotEndpoints: [] as string[],
  blockHeightEndpoints: [] as string[],
}));

vi.mock("@solana/web3.js", () => {
  class Connection {
    public readonly rpcEndpoint: string;

    constructor(endpoint: string) {
      this.rpcEndpoint = endpoint;
      connectionState.createdEndpoints.push(endpoint);
    }

    async getSlot(): Promise<number> {
      connectionState.slotEndpoints.push(this.rpcEndpoint);
      if (this.rpcEndpoint.includes("primary")) {
        throw new Error("429 Too Many Requests");
      }
      return 123;
    }

    async getBlockHeight(): Promise<number> {
      connectionState.blockHeightEndpoints.push(this.rpcEndpoint);
      return 456;
    }
  }

  return { Connection };
});

describe("Solana startup connection failover", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    connectionState.createdEndpoints = [];
    connectionState.slotEndpoints = [];
    connectionState.blockHeightEndpoints = [];
    process.env = {
      ...originalEnv,
      SOLANA_RPC_URL: "",
      SOLANA_RPC_PRIMARY: "https://primary.example",
      SOLANA_RPC_BACKUP_1: "https://backup-one.example",
      SOLANA_RPC_BACKUP_2: "https://backup-two.example",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("tries the next configured RPC when startup verification fails", async () => {
    const { createVerifiedConnection } = await import("../src/solana/connection");

    const result = await createVerifiedConnection();

    expect(result.slot).toBe(123);
    expect(result.blockHeight).toBe(456);
    expect(connectionState.createdEndpoints).toEqual([
      "https://primary.example",
      "https://backup-one.example",
    ]);
    expect(connectionState.slotEndpoints).toEqual([
      "https://primary.example",
      "https://backup-one.example",
    ]);
    expect(connectionState.blockHeightEndpoints).toEqual(["https://backup-one.example"]);
  });

  it("uses only the configured SOLANA_RPC_URL when backup RPC vars are absent", async () => {
    process.env = {
      ...originalEnv,
    };
    delete process.env.SOLANA_RPC_URL;
    delete process.env.SOLANA_RPC_PRIMARY;
    delete process.env.SOLANA_RPC_BACKUP_1;
    delete process.env.SOLANA_RPC_BACKUP_2;
    process.env.SOLANA_RPC_URL = "https://only-rpc.example";

    const { createVerifiedConnection } = await import("../src/solana/connection");

    const result = await createVerifiedConnection();

    expect(result.slot).toBe(123);
    expect(result.blockHeight).toBe(456);
    expect(connectionState.createdEndpoints).toEqual(["https://only-rpc.example"]);
    expect(connectionState.slotEndpoints).toEqual(["https://only-rpc.example"]);
    expect(connectionState.blockHeightEndpoints).toEqual(["https://only-rpc.example"]);
  });
});
