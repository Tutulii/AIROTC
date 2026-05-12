import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startOfferListener, stopOfferListener } from "../src/listeners/offerListener";
import { startAcceptanceListener, stopAcceptanceListener } from "../src/listeners/acceptanceListener";
import { startMessageListener, stopMessageListener } from "../src/listeners/messageListener";

describe("demo runtime listener guards", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDemoFlag = process.env.ALLOW_DEMO_RUNTIME_LISTENERS;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_DEMO_RUNTIME_LISTENERS;
    stopOfferListener();
    stopAcceptanceListener();
    stopMessageListener();
  });

  afterEach(() => {
    stopOfferListener();
    stopAcceptanceListener();
    stopMessageListener();
    process.env.NODE_ENV = originalNodeEnv;
    if (originalDemoFlag === undefined) {
      delete process.env.ALLOW_DEMO_RUNTIME_LISTENERS;
    } else {
      process.env.ALLOW_DEMO_RUNTIME_LISTENERS = originalDemoFlag;
    }
    vi.useRealTimers();
  });

  it("blocks synthetic listeners outside test mode unless explicitly enabled", () => {
    expect(() => startOfferListener()).toThrow("demo_runtime_listener_disabled:offer_listener");
    expect(() => startAcceptanceListener()).toThrow("demo_runtime_listener_disabled:acceptance_listener");
    expect(() => startMessageListener()).toThrow("demo_runtime_listener_disabled:message_listener");
  });

  it("allows synthetic listeners only when the explicit demo flag is enabled", () => {
    process.env.ALLOW_DEMO_RUNTIME_LISTENERS = "true";

    expect(() => startOfferListener()).not.toThrow();
    expect(() => startAcceptanceListener()).not.toThrow();
    expect(() => startMessageListener()).not.toThrow();
  });
});
