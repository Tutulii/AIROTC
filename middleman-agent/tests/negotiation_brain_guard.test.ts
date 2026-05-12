import { describe, expect, it } from "vitest";

import { shouldSkipNegotiationBrainAnalysis } from "../src/services/negotiationBrainGuard";

describe("negotiation brain guard", () => {
  it("skips negotiation analysis once the pipeline is in a post-negotiation confirmed stage", () => {
    expect(
      shouldSkipNegotiationBrainAnalysis({
        ticketId: "ticket-1",
        stage: "awaiting_buyer_release_confirmation",
        status: "confirmed",
        createdAt: new Date().toISOString(),
      })
    ).toBe(true);

    expect(
      shouldSkipNegotiationBrainAnalysis({
        ticketId: "ticket-1",
        stage: "settled",
        status: "confirmed",
        createdAt: new Date().toISOString(),
      })
    ).toBe(true);
  });

  it("keeps negotiation analysis enabled before post-negotiation stages", () => {
    expect(
      shouldSkipNegotiationBrainAnalysis({
        ticketId: "ticket-2",
        stage: "verified",
        status: "confirmed",
        createdAt: new Date().toISOString(),
      })
    ).toBe(false);

    expect(
      shouldSkipNegotiationBrainAnalysis({
        ticketId: "ticket-2",
        stage: "awaiting_buyer_release_confirmation",
        status: "pending",
        createdAt: new Date().toISOString(),
      })
    ).toBe(false);

    expect(shouldSkipNegotiationBrainAnalysis(null)).toBe(false);
  });
});

