import net from "net";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { loadConfig } from "../config";
import { getConnection } from "../solana/connection";
import { PER_TEE_RPC_URL } from "./magicblockPerContract";
import { logger } from "../utils/logger";

export type DependencyClass =
  | "magicblock_tee"
  | "magicblock_auth"
  | "encrypt"
  | "ika"
  | "solana_rpc"
  | "umbra"
  | "internal_pipeline"
  | "unknown";

export type DependencyProbeStatus = "ok" | "degraded" | "down";

export interface DependencyProbeResult {
  name: string;
  status: DependencyProbeStatus;
  critical: boolean;
  latencyMs: number | null;
  endpoint?: string;
  classification: DependencyClass;
  detail?: string;
}

export interface DependencyHealthSnapshot {
  checkedAt: string;
  overallStatus: "ok" | "degraded" | "down";
  probes: Record<string, DependencyProbeResult>;
}

interface DependencyHealthDeps {
  loadConfig: typeof loadConfig;
  getConnection: typeof getConnection;
  now: () => number;
  fetchImpl: typeof fetch;
  probeTcp: (host: string, port: number, timeoutMs: number) => Promise<void>;
  probeMagicBlockAuth: (rpcUrl: string, privateKeyBase58: string) => Promise<void>;
}

const CACHE_TTL_MS = 15_000;

const defaultDeps: DependencyHealthDeps = {
  loadConfig,
  getConnection,
  now: () => Date.now(),
  fetchImpl: fetch,
  probeTcp: (host, port, timeoutMs) =>
    new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`TCP timeout to ${host}:${port}`));
      }, timeoutMs);

      socket.once("connect", () => {
        clearTimeout(timeout);
        socket.end();
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      });
    }),
  probeMagicBlockAuth: async (rpcUrl, privateKeyBase58) => {
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    await getAuthToken(
      rpcUrl,
      keypair.publicKey,
      async (message: Uint8Array) => nacl.sign.detached(message, keypair.secretKey)
    );
  },
};

function parseEndpointHostPort(raw: string): { host: string; port: number; endpoint: string } {
  const normalized =
    raw.startsWith("http://") ||
    raw.startsWith("https://") ||
    raw.startsWith("grpc://") ||
    raw.startsWith("grpcs://")
      ? raw
      : `https://${raw}`;
  const url = new URL(normalized);
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === "http:" ? 80 : 443)),
    endpoint: normalized,
  };
}

export function classifyDependencyError(error: unknown): DependencyClass {
  const message = String((error as any)?.message || error || "").toLowerCase();

  if (
    message.includes("scorechain client") ||
    message.includes("failed to authenticate") ||
    message.includes("native root ca") ||
    message.includes("auth failed after retries")
  ) {
    return "magicblock_auth";
  }
  if (
    message.includes("tee") ||
    message.includes("permission status request failed") ||
    message.includes("quote") ||
    message.includes("attestation") ||
    message.includes("delegate_permission") ||
    message.includes("per session owner did not return")
  ) {
    return "magicblock_tee";
  }
  if (message.includes("encrypt")) {
    return "encrypt";
  }
  if (
    message.includes("dwallet") ||
    message.includes("ika") ||
    message.includes("presign") ||
    message.includes("approve_message")
  ) {
    return "ika";
  }
  if (
    message.includes("rpc") ||
    message.includes("blockhash") ||
    message.includes("fetch failed") ||
    message.includes("slot") ||
    message.includes("transaction was not confirmed")
  ) {
    return "solana_rpc";
  }
  if (message.includes("umbra")) {
    return "umbra";
  }
  if (
    message.includes("release approval") ||
    message.includes("confidential") ||
    message.includes("pipeline") ||
    message.includes("approval gate")
  ) {
    return "internal_pipeline";
  }
  return "unknown";
}

function resolveOverallStatus(
  probes: Record<string, DependencyProbeResult>
): DependencyHealthSnapshot["overallStatus"] {
  const values = Object.values(probes);
  if (values.some((probe) => probe.critical && probe.status === "down")) {
    return "down";
  }
  if (values.some((probe) => probe.status !== "ok")) {
    return "degraded";
  }
  return "ok";
}

async function probeHttpReachability(
  deps: DependencyHealthDeps,
  url: string,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await deps.fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 500) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function retryDependencyProbe<T>(
  attempts: number,
  fn: () => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
}

export function createDependencyHealthService(deps: DependencyHealthDeps = defaultDeps) {
  let cachedSnapshot: DependencyHealthSnapshot | null = null;
  let cachedAt = 0;

  async function probeSolanaRpc(): Promise<DependencyProbeResult> {
    const startedAt = deps.now();
    try {
      await deps.getConnection().getSlot("confirmed");
      return {
        name: "solana_rpc",
        status: "ok",
        critical: true,
        latencyMs: deps.now() - startedAt,
        classification: "solana_rpc",
      };
    } catch (error) {
      return {
        name: "solana_rpc",
        status: "down",
        critical: true,
        latencyMs: deps.now() - startedAt,
        classification: classifyDependencyError(error),
        detail: String((error as any)?.message || error),
      };
    }
  }

  async function probeMagicBlockTee(): Promise<DependencyProbeResult> {
    const startedAt = deps.now();
    try {
      await retryDependencyProbe(3, () =>
        probeHttpReachability(deps, PER_TEE_RPC_URL, 4_000)
      );
      return {
        name: "magicblock_tee",
        status: "ok",
        critical: true,
        latencyMs: deps.now() - startedAt,
        endpoint: PER_TEE_RPC_URL,
        classification: "magicblock_tee",
      };
    } catch (error) {
      return {
        name: "magicblock_tee",
        status: "down",
        critical: true,
        latencyMs: deps.now() - startedAt,
        endpoint: PER_TEE_RPC_URL,
        classification: "magicblock_tee",
        detail: String((error as any)?.message || error),
      };
    }
  }

  async function probeMagicBlockAuth(privateKeyBase58: string): Promise<DependencyProbeResult> {
    const startedAt = deps.now();
    try {
      await retryDependencyProbe(3, () =>
        deps.probeMagicBlockAuth(PER_TEE_RPC_URL, privateKeyBase58)
      );
      return {
        name: "magicblock_auth",
        status: "ok",
        critical: true,
        latencyMs: deps.now() - startedAt,
        endpoint: PER_TEE_RPC_URL,
        classification: "magicblock_auth",
      };
    } catch (error) {
      return {
        name: "magicblock_auth",
        status: "down",
        critical: true,
        latencyMs: deps.now() - startedAt,
        endpoint: PER_TEE_RPC_URL,
        classification: "magicblock_auth",
        detail: String((error as any)?.message || error),
      };
    }
  }

  async function probeTcpBackedDependency(
    name: "encrypt" | "ika",
    rawEndpoint: string
  ): Promise<DependencyProbeResult> {
    const startedAt = deps.now();
    const { host, port, endpoint } = parseEndpointHostPort(rawEndpoint);
    try {
      await deps.probeTcp(host, port, 4_000);
      return {
        name,
        status: "ok",
        critical: true,
        latencyMs: deps.now() - startedAt,
        endpoint,
        classification: name,
      };
    } catch (error) {
      return {
        name,
        status: "down",
        critical: true,
        latencyMs: deps.now() - startedAt,
        endpoint,
        classification: name,
        detail: String((error as any)?.message || error),
      };
    }
  }

  async function getSnapshot(options?: { forceRefresh?: boolean }): Promise<DependencyHealthSnapshot> {
    const now = deps.now();
    if (!options?.forceRefresh && cachedSnapshot && now - cachedAt < CACHE_TTL_MS) {
      return cachedSnapshot;
    }

    const config = deps.loadConfig();
    const [solanaRpc, magicblockTee, magicblockAuth, encrypt, ika] = await Promise.all([
      probeSolanaRpc(),
      probeMagicBlockTee(),
      probeMagicBlockAuth(config.privateKey),
      probeTcpBackedDependency("encrypt", config.encryptGrpcUrl),
      probeTcpBackedDependency("ika", config.ikaGrpcUrl),
    ]);

    const probes = {
      solana_rpc: solanaRpc,
      magicblock_tee: magicblockTee,
      magicblock_auth: magicblockAuth,
      encrypt,
      ika,
    };

    cachedSnapshot = {
      checkedAt: new Date(now).toISOString(),
      overallStatus: resolveOverallStatus(probes),
      probes,
    };
    cachedAt = now;
    return cachedSnapshot;
  }

  async function assertHealthyForOperation(
    operation: string,
    required: Array<keyof Awaited<ReturnType<typeof getSnapshot>>["probes"]>
  ): Promise<DependencyHealthSnapshot> {
    const snapshot = await getSnapshot({ forceRefresh: true });
    const blockers = required
      .map((name) => snapshot.probes[name])
      .filter((probe) => probe && probe.status === "down");

    if (blockers.length > 0) {
      logger.error("dependency_health_gate_blocked", {
        operation,
        blockers: blockers.map((probe) => ({
          name: probe.name,
          endpoint: probe.endpoint,
          detail: probe.detail,
          classification: probe.classification,
        })),
      });
      throw new Error(
        `dependency_health_blocked:${operation}:${blockers
          .map((probe) => probe.classification)
          .join(",")}`
      );
    }

    const degraded = required
      .map((name) => snapshot.probes[name])
      .filter((probe) => probe && probe.status === "degraded");
    if (degraded.length > 0) {
      logger.warn("dependency_health_gate_degraded", {
        operation,
        degraded: degraded.map((probe) => probe.name),
      });
    }

    return snapshot;
  }

  return {
    getSnapshot,
    assertHealthyForOperation,
  };
}

export const dependencyHealthService = createDependencyHealthService();
