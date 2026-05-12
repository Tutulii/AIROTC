import { afterEach, describe, expect, it } from "vitest";
import {
  resolveUmbraIndexerEndpoint,
  resolveUmbraRelayerEndpoint,
  UMBRA_ENDPOINTS,
  validateUmbraEndpointNetwork,
} from "../src/services/umbraService";

describe("Umbra endpoint network policy", () => {
  const previousIndexer = process.env.UMBRA_INDEXER_API_ENDPOINT;
  const previousRelayer = process.env.UMBRA_RELAYER_API_ENDPOINT;

  afterEach(() => {
    if (previousIndexer === undefined) {
      delete process.env.UMBRA_INDEXER_API_ENDPOINT;
    } else {
      process.env.UMBRA_INDEXER_API_ENDPOINT = previousIndexer;
    }

    if (previousRelayer === undefined) {
      delete process.env.UMBRA_RELAYER_API_ENDPOINT;
    } else {
      process.env.UMBRA_RELAYER_API_ENDPOINT = previousRelayer;
    }
  });

  it("uses official devnet indexer and relayer defaults on devnet", () => {
    delete process.env.UMBRA_INDEXER_API_ENDPOINT;
    delete process.env.UMBRA_RELAYER_API_ENDPOINT;

    expect(resolveUmbraIndexerEndpoint("devnet")).toBe(UMBRA_ENDPOINTS.devnet.indexer);
    expect(resolveUmbraRelayerEndpoint("devnet")).toBe(UMBRA_ENDPOINTS.devnet.relayer);
  });

  it("uses official mainnet indexer and relayer defaults on mainnet", () => {
    delete process.env.UMBRA_INDEXER_API_ENDPOINT;
    delete process.env.UMBRA_RELAYER_API_ENDPOINT;

    expect(resolveUmbraIndexerEndpoint("mainnet")).toBe(UMBRA_ENDPOINTS.mainnet.indexer);
    expect(resolveUmbraRelayerEndpoint("mainnet")).toBe(UMBRA_ENDPOINTS.mainnet.relayer);
  });

  it("fails fast when devnet is configured with official mainnet endpoints", () => {
    process.env.UMBRA_INDEXER_API_ENDPOINT = UMBRA_ENDPOINTS.mainnet.indexer;
    process.env.UMBRA_RELAYER_API_ENDPOINT = UMBRA_ENDPOINTS.mainnet.relayer;

    expect(() => resolveUmbraIndexerEndpoint("devnet")).toThrow(
      "Umbra indexer endpoint/network mismatch"
    );
    expect(() => resolveUmbraRelayerEndpoint("devnet")).toThrow(
      "Umbra relayer endpoint/network mismatch"
    );
  });

  it("fails fast when mainnet is configured with official devnet endpoints", () => {
    expect(() =>
      validateUmbraEndpointNetwork(UMBRA_ENDPOINTS.devnet.indexer, "mainnet", "indexer")
    ).toThrow("Umbra indexer endpoint/network mismatch");
    expect(() =>
      validateUmbraEndpointNetwork(UMBRA_ENDPOINTS.devnet.relayer, "mainnet", "relayer")
    ).toThrow("Umbra relayer endpoint/network mismatch");
  });

  it("allows custom endpoints for private indexers or local relayers", () => {
    expect(
      validateUmbraEndpointNetwork("http://127.0.0.1:8787/", "devnet", "indexer")
    ).toBe("http://127.0.0.1:8787");
    expect(
      validateUmbraEndpointNetwork("http://127.0.0.1:8788/", "devnet", "relayer")
    ).toBe("http://127.0.0.1:8788");
  });
});
