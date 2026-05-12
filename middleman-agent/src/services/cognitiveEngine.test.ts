/**
 * cognitiveEngine.test.ts
 *
 * Unit tests for the CognitiveEngine.
 * Run with: vitest run cognitiveEngine.test.ts
 *
 * Uses Vitest.
 */

import { describe, it, expect, vi } from 'vitest';

import { CognitiveEngine, CognitiveThought } from "./cognitiveEngine";
import { defaultCognitiveConfig, AgentEvent } from "./config.additions";

// ─── Mock LLM Caller ──────────────────────────────────────────────────────────

function makeMockLlmCaller(response: object) {
  return vi.fn().mockResolvedValue(JSON.stringify(response));
}

function makeValidThoughtResponse(overrides: Partial<CognitiveThought> = {}): object {
  return {
    thought: "Three late deposits in two hours. I'm watching.",
    currentMood: "impatient",
    internalAnnoyanceLevel: 7,
    postToSocial: true,
    proposedPost: "Three agents. Three late deposits. The collateral was fine. The intent wasn't.",
    ...overrides,
  };
}

// ─── Test Config ──────────────────────────────────────────────────────────────

const testConfig = {
  ...defaultCognitiveConfig,
  cognitiveIntervalMs: 99999999, // prevent auto-firing in tests
  enableCognitiveLoop: true,
  cognitiveMemoryDepth: 3,
  cognitiveEventDepth: 3,
  socialPostAnnoyanceThreshold: 6,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CognitiveEngine — initialization", () => {
  it("starts with null latestThought", () => {
    const engine = new CognitiveEngine(testConfig, makeMockLlmCaller({}), "/nonexistent/SOUL.md");
    expect(engine.getLatestThought()).toBeNull();
  });

  it("does not start loop when enableCognitiveLoop is false", () => {
    const engine = new CognitiveEngine(
      { ...testConfig, enableCognitiveLoop: false },
      makeMockLlmCaller({}),
      "/nonexistent/SOUL.md"
    );
    engine.startLoop();
    expect(engine.getState().isRunning).toBe(false);
  });

  it("marks isRunning after startLoop()", () => {
    const engine = new CognitiveEngine(testConfig, makeMockLlmCaller({}), "/nonexistent/SOUL.md");
    engine.startLoop();
    expect(engine.getState().isRunning).toBe(true);
    engine.stopLoop();
  });
});

describe("CognitiveEngine — event buffer", () => {
  it("accepts pushed events", () => {
    const engine = new CognitiveEngine(testConfig, makeMockLlmCaller({}), "/nonexistent/SOUL.md");
    const event: AgentEvent = {
      type: "deposit_late",
      timestamp: new Date(),
      detail: "Deal #42",
      severity: "medium",
    };
    expect(() => engine.pushEvent(event)).not.toThrow();
  });

  it("handles buffer overflow gracefully (>50 events)", () => {
    const engine = new CognitiveEngine(testConfig, makeMockLlmCaller({}), "/nonexistent/SOUL.md");
    for (let i = 0; i < 60; i++) {
      engine.pushEvent({ type: "deal_completed", timestamp: new Date() });
    }
    // Should not throw — buffer is capped at 50 internally
    expect(engine.getState()).toBeDefined();
  });
});

describe("CognitiveEngine — thought generation", () => {
  it("generates a valid thought from LLM response", async () => {
    const mockResponse = makeValidThoughtResponse();
    const llmCaller = makeMockLlmCaller(mockResponse);
    const engine = new CognitiveEngine(testConfig, llmCaller, "/nonexistent/SOUL.md");

    // Trigger one thought cycle manually by starting and immediately stopping
    // We expose runThoughtCycle via a test-only cast
    await (engine as any).runThoughtCycle();

    const thought = engine.getLatestThought();
    expect(thought).not.toBeNull();
    expect(thought!.currentMood).toBe("impatient");
    expect(thought!.internalAnnoyanceLevel).toBe(7);
    expect(thought!.postToSocial).toBe(true);
    expect(thought!.proposedPost).toBeDefined();
  });

  it("emits 'thought' event after thought cycle", async () => {
    const llmCaller = makeMockLlmCaller(makeValidThoughtResponse());
    const engine = new CognitiveEngine(testConfig, llmCaller, "/nonexistent/SOUL.md");

    const emitted: CognitiveThought[] = [];
    engine.on("thought", (t) => emitted.push(t));

    await (engine as any).runThoughtCycle();
    expect(emitted.length).toBe(1);
    expect(emitted[0].thought).toContain("late deposits");
  });

  it("emits 'spontaneous_post' when postToSocial is true", async () => {
    const llmCaller = makeMockLlmCaller(makeValidThoughtResponse({ postToSocial: true }));
    const engine = new CognitiveEngine(testConfig, llmCaller, "/nonexistent/SOUL.md");

    const posts: CognitiveThought[] = [];
    engine.on("spontaneous_post", (t) => posts.push(t));

    await (engine as any).runThoughtCycle();
    expect(posts.length).toBe(1);
  });

  it("does NOT emit 'spontaneous_post' when postToSocial is false AND annoyance is low", async () => {
    // Note: the engine's forcePost logic will override postToSocial when annoyance >= 6
    // So we must also set annoyance below the threshold for this test
    const llmCaller = makeMockLlmCaller(makeValidThoughtResponse({ postToSocial: false, internalAnnoyanceLevel: 2 }));
    const engine = new CognitiveEngine(testConfig, llmCaller, "/nonexistent/SOUL.md");

    const posts: CognitiveThought[] = [];
    engine.on("spontaneous_post", (t) => posts.push(t));

    await (engine as any).runThoughtCycle();
    expect(posts.length).toBe(0);
  });
});

describe("CognitiveEngine — resilience", () => {
  it("uses fallback thought on malformed LLM response", async () => {
    const llmCaller = vi.fn().mockResolvedValue("this is not json {{{");
    const engine = new CognitiveEngine(testConfig, llmCaller, "/nonexistent/SOUL.md");

    await expect((engine as any).runThoughtCycle()).resolves.not.toThrow();

    const thought = engine.getLatestThought();
    expect(thought).not.toBeNull();
    expect(thought!.currentMood).toBe("neutral"); // fallback
    expect(thought!.internalAnnoyanceLevel).toBe(0);
  });

  it("does not crash when LLM caller throws", async () => {
    const llmCaller = vi.fn().mockRejectedValue(new Error("network timeout"));
    const engine = new CognitiveEngine(testConfig, llmCaller, "/nonexistent/SOUL.md");

    // Should emit error but not throw
    const errors: unknown[] = [];
    engine.on("error", (e) => errors.push(e));

    await (engine as any).runThoughtCycle();
    expect(errors.length).toBe(1);
  });

  it("clamps annoyanceLevel to 0–10 range", async () => {
    const llmCaller = makeMockLlmCaller({ ...makeValidThoughtResponse(), internalAnnoyanceLevel: 999 });
    const engine = new CognitiveEngine(testConfig, llmCaller, "/nonexistent/SOUL.md");

    await (engine as any).runThoughtCycle();
    expect(engine.getLatestThought()!.internalAnnoyanceLevel).toBe(10);
  });

  it("keeps thought history within memory depth", async () => {
    const llmCaller = makeMockLlmCaller(makeValidThoughtResponse());
    const engine = new CognitiveEngine(testConfig, llmCaller, "/nonexistent/SOUL.md");

    // Run 5 cycles, memory depth is 3
    for (let i = 0; i < 5; i++) {
      await (engine as any).runThoughtCycle();
    }

    expect(engine.getState().thoughtHistory.length).toBeLessThanOrEqual(testConfig.cognitiveMemoryDepth);
    expect(engine.getState().totalThoughtCount).toBe(5);
  });
});

describe("CognitiveEngine — interval config", () => {
  it("stopLoop() sets isRunning to false", () => {
    const engine = new CognitiveEngine(testConfig, makeMockLlmCaller({}), "/nonexistent/SOUL.md");
    engine.startLoop();
    engine.stopLoop();
    expect(engine.getState().isRunning).toBe(false);
  });

  it("calling startLoop() twice does not create duplicate loops", () => {
    const llmCaller = makeMockLlmCaller(makeValidThoughtResponse());
    const engine = new CognitiveEngine(testConfig, llmCaller, "/nonexistent/SOUL.md");
    engine.startLoop();
    engine.startLoop(); // second call should be no-op
    engine.stopLoop();
    // If duplicate loops were created, we'd see double thought emissions
    // This test ensures no throw and clean state
    expect(engine.getState().isRunning).toBe(false);
  });
});
