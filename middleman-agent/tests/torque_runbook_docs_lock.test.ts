import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const RUNBOOK_PATH = resolve(__dirname, "../docs/torque-mcp-runbook.md");

describe("torque MCP runbook", () => {
  it("pins the official docs-locked flow and terminology", () => {
    const runbook = readFileSync(RUNBOOK_PATH, "utf8");

    expect(runbook).toContain("1. `auth`");
    expect(runbook).toContain("8. `list_custom_events`");
    expect(runbook).toContain("https://ingest.torque.so/events");
    expect(runbook).toContain("x-api-key");
    expect(runbook).toContain("customEventId");
    expect(runbook).toContain("SUM(participantRewardLamports)");
    expect(runbook).toContain("VALUE / 1000000000");
    expect(runbook).toContain("sqlQuery");
    expect(runbook).toContain("confirmed false");
    expect(runbook).toContain("air_otc_trade_reward_participant_v2");
    expect(runbook).not.toContain("List project events");
    expect(runbook).not.toContain("query by event name");
  });
});
