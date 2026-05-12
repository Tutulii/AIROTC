import { describe, expect, it, vi } from "vitest";
import {
  classifyDependencyError,
  createDependencyHealthService,
} from "../src/services/dependencyHealthService";

describe("dependencyHealthService", () => {
  it("classifies known upstream failures into stable dependency buckets", () => {
    expect(classifyDependencyError(new Error("Permission status request failed: 500"))).toBe(
      "magicblock_tee"
    );
    expect(classifyDependencyError(new Error("Failed to authenticate: no native root CA certificates found"))).toBe(
      "magicblock_auth"
    );
    expect(classifyDependencyError(new Error("Encrypt gRPC unavailable"))).toBe("encrypt");
    expect(classifyDependencyError(new Error("ika presign failed"))).toBe("ika");
    expect(classifyDependencyError(new Error("RPC fetch failed"))).toBe("solana_rpc");
  });

  it("blocks critical operations when a required dependency is down", async () => {
    const service = createDependencyHealthService({
      loadConfig: () =>
        ({
          privateKey: "base58-private-key",
          encryptGrpcUrl: "https://encrypt.example:443",
          ikaGrpcUrl: "https://ika.example:443",
        } as any),
      getConnection: () =>
        ({
          getSlot: vi.fn().mockResolvedValue(123),
        }) as any,
      now: (() => {
        let current = 1_000;
        return () => ++current;
      })(),
      fetchImpl: vi.fn().mockRejectedValue(new Error("fetch failed")),
      probeTcp: vi.fn().mockResolvedValue(undefined),
      probeMagicBlockAuth: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      service.assertHealthyForOperation("per_live", ["solana_rpc", "magicblock_tee"])
    ).rejects.toThrow("dependency_health_blocked:per_live:magicblock_tee");
  });

  it("returns a structured snapshot when core dependencies are reachable", async () => {
    const service = createDependencyHealthService({
      loadConfig: () =>
        ({
          privateKey: "base58-private-key",
          encryptGrpcUrl: "https://encrypt.example:443",
          ikaGrpcUrl: "https://ika.example:443",
        } as any),
      getConnection: () =>
        ({
          getSlot: vi.fn().mockResolvedValue(321),
        }) as any,
      now: (() => {
        let current = 10_000;
        return () => ++current;
      })(),
      fetchImpl: vi.fn().mockResolvedValue({ status: 404 } as any),
      probeTcp: vi.fn().mockResolvedValue(undefined),
      probeMagicBlockAuth: vi.fn().mockResolvedValue(undefined),
    });

    const snapshot = await service.getSnapshot({ forceRefresh: true });

    expect(snapshot.overallStatus).toBe("ok");
    expect(snapshot.probes.solana_rpc.status).toBe("ok");
    expect(snapshot.probes.magicblock_tee.status).toBe("ok");
    expect(snapshot.probes.magicblock_auth.status).toBe("ok");
    expect(snapshot.probes.encrypt.status).toBe("ok");
    expect(snapshot.probes.ika.status).toBe("ok");
  });

  it("blocks auth-dependent PER operations when MagicBlock auth is down", async () => {
    const service = createDependencyHealthService({
      loadConfig: () =>
        ({
          privateKey: "base58-private-key",
          encryptGrpcUrl: "https://encrypt.example:443",
          ikaGrpcUrl: "https://ika.example:443",
        } as any),
      getConnection: () =>
        ({
          getSlot: vi.fn().mockResolvedValue(777),
        }) as any,
      now: (() => {
        let current = 20_000;
        return () => ++current;
      })(),
      fetchImpl: vi.fn().mockResolvedValue({ status: 404 } as any),
      probeTcp: vi.fn().mockResolvedValue(undefined),
      probeMagicBlockAuth: vi.fn().mockRejectedValue(new Error("Failed to authenticate: TLS root CA missing")),
    });

    await expect(
      service.assertHealthyForOperation("per_auth", ["solana_rpc", "magicblock_tee", "magicblock_auth"])
    ).rejects.toThrow("dependency_health_blocked:per_auth:magicblock_auth");
  });
});
