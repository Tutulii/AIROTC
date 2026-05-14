import { afterEach, describe, expect, it } from "vitest";
import {
  TEST_BRIDGE_SECRET,
  signBridgePayload,
  verifyBridgeRequest,
} from "../src/security/bridgeAuth";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_BRIDGE_SECRET = process.env.BRIDGE_SECRET;

function restoreEnv(): void {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }

  if (ORIGINAL_BRIDGE_SECRET === undefined) {
    delete process.env.BRIDGE_SECRET;
  } else {
    process.env.BRIDGE_SECRET = ORIGINAL_BRIDGE_SECRET;
  }
}

describe("middleman bridge authentication secret hardening", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("fails closed outside tests when BRIDGE_SECRET is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.BRIDGE_SECRET;

    const result = verifyBridgeRequest(
      "POST",
      "/v1/deals/create-matched",
      "{}",
      undefined,
      Date.now().toString(),
    );

    expect(result).toEqual({
      valid: false,
      status: 503,
      reason: "Bridge authentication is not configured",
    });
  });

  it("rejects known placeholder bridge secrets in production", () => {
    process.env.NODE_ENV = "production";
    process.env.BRIDGE_SECRET = "meridian-bridge-secret-change-in-production";

    const timestamp = Date.now().toString();
    const signature = signBridgePayload(
      process.env.BRIDGE_SECRET,
      timestamp,
      "POST",
      "/v1/deals/create-matched",
      "{}",
    );

    const result = verifyBridgeRequest(
      "POST",
      "/v1/deals/create-matched",
      "{}",
      signature,
      timestamp,
    );

    expect(result).toEqual({
      valid: false,
      status: 503,
      reason: "Bridge secret uses a known placeholder value",
    });
  });

  it("accepts valid signed bridge requests with a production-length secret", () => {
    process.env.NODE_ENV = "production";
    process.env.BRIDGE_SECRET = "0123456789abcdef0123456789abcdef";

    const body = JSON.stringify({ ticketId: "ticket-1" });
    const timestamp = Date.now().toString();
    const signature = signBridgePayload(
      process.env.BRIDGE_SECRET,
      timestamp,
      "POST",
      "/v1/deals/create-matched",
      body,
    );

    expect(verifyBridgeRequest(
      "POST",
      "/v1/deals/create-matched",
      body,
      signature,
      timestamp,
    )).toEqual({ valid: true });
  });

  it("keeps the explicit test fallback for isolated unit tests", () => {
    process.env.NODE_ENV = "test";
    delete process.env.BRIDGE_SECRET;

    const timestamp = Date.now().toString();
    const signature = signBridgePayload(
      TEST_BRIDGE_SECRET,
      timestamp,
      "POST",
      "/v1/deals/create-matched",
      "{}",
    );

    expect(verifyBridgeRequest(
      "POST",
      "/v1/deals/create-matched",
      "{}",
      signature,
      timestamp,
    )).toEqual({ valid: true });
  });
});
