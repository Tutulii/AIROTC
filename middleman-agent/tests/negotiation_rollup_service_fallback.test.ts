import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  NegotiationRollupService,
  type NegotiationSession,
} from "../src/services/negotiationRollupService";
import { PrivateNegotiationService } from "../src/services/privateNegotiationService";

const SESSION_PDA = new PublicKey(new Uint8Array(32).fill(5));
const VALIDATOR_IDENTITY = new PublicKey(new Uint8Array(32).fill(8));

function buildSession(overrides: Partial<NegotiationSession> = {}): NegotiationSession {
  return {
    ticketId: "ticket-fallback",
    sessionPda: SESSION_PDA,
    delegatedAt: Date.now(),
    validator: "tee.magicblock.test",
    validatorIdentity: VALIDATOR_IDENTITY,
    isPrivate: true,
    permissionMode: "session_only_fallback",
    erConnection: {} as any,
    ...overrides,
  };
}

describe("NegotiationRollupService PER fallback finalization", () => {
  let service: NegotiationRollupService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new NegotiationRollupService(
      new Connection("http://127.0.0.1:8899", "confirmed"),
      Keypair.generate(),
      "PER"
    );
  });

  afterEach(() => {
    service.shutdown();
    vi.restoreAllMocks();
  });

  it("commits, waits for owner return, and closes permission for session-only fallback flows", async () => {
    const waitSpy = vi
      .spyOn(PrivateNegotiationService.prototype, "waitForOwnerReturn")
      .mockResolvedValue(undefined);
    const closeSpy = vi
      .spyOn(PrivateNegotiationService.prototype, "closePermissionOnly")
      .mockResolvedValue("close-sig");
    const commitSpy = vi
      .spyOn(service as any, "commitAndUndelegate")
      .mockResolvedValue({
        commitSignature: "commit-sig",
        l1TransactionSignature: "l1-sig",
      });
    const queueSpy = vi.spyOn(service as any, "queuePermissionCloseRetry");

    const result = await (service as any).finalizePrivateSession(buildSession());

    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(waitSpy).toHaveBeenCalledWith(SESSION_PDA);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(typeof closeSpy.mock.calls[0]?.[0]).toBe("bigint");
    expect(closeSpy.mock.calls[0]?.[1]).toEqual(SESSION_PDA);
    expect(queueSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      commitSig: "commit-sig",
      l1TransactionSignature: "l1-sig",
      teeSealedState: "Committed securely via session-only PER fallback",
    });
  });

  it("queues a permission close retry when fallback finalization cannot close the permission on L1", async () => {
    vi.spyOn(PrivateNegotiationService.prototype, "waitForOwnerReturn").mockResolvedValue(undefined);
    vi.spyOn(PrivateNegotiationService.prototype, "closePermissionOnly").mockRejectedValue(
      new Error("close permission failed")
    );
    vi.spyOn(service as any, "commitAndUndelegate").mockResolvedValue({
      commitSignature: "commit-sig",
      l1TransactionSignature: "l1-sig",
    });
    const queueSpy = vi.spyOn(service as any, "queuePermissionCloseRetry");

    const result = await (service as any).finalizePrivateSession(buildSession());

    expect(queueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: "ticket-fallback", sessionPda: SESSION_PDA }),
      "commit-sig",
      "close permission failed"
    );
    expect(result).toEqual({
      commitSig: "commit-sig",
      l1TransactionSignature: "l1-sig",
      teeSealedState:
        "Committed securely via session-only PER fallback (permission close queued on L1)",
    });
  });
});
