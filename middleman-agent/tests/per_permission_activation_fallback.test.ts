import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  PrivateNegotiationService,
  waitForPermissionActivationWithFallback,
} from "../src/services/privateNegotiationService";
import { rpcManager } from "../src/utils/rpcManager";

const sendAndConfirmTransactionMock = vi.hoisted(() => vi.fn());

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    sendAndConfirmTransaction: sendAndConfirmTransactionMock,
  };
});

const SESSION_PDA = new PublicKey(new Uint8Array(32).fill(9));
const ORIGINAL_FETCH = global.fetch;

describe("waitForPermissionActivationWithFallback", () => {
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("returns active when the permission endpoint reports authorized users", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ authorizedUsers: ["buyer"] }),
    } as any);

    await expect(
      waitForPermissionActivationWithFallback({
        rpcUrl: "https://devnet-tee.magicblock.app",
        sessionPda: SESSION_PDA,
        timeoutMs: 5,
      })
    ).resolves.toMatchObject({
      active: true,
      degraded: false,
      source: "permission_status",
    });
  });

  it("falls back to L1-confirmed proceed mode when the permission endpoint only returns upstream 500s", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as any);

    await expect(
      waitForPermissionActivationWithFallback({
        rpcUrl: "https://devnet-tee.magicblock.app",
        sessionPda: SESSION_PDA,
        timeoutMs: 5,
        allowL1ConfirmedFallback: true,
      })
    ).resolves.toMatchObject({
      active: true,
      degraded: true,
      source: "l1_confirmed_fallback",
    });
  });

  it("fails closed when the endpoint responds successfully but never marks the permission active", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ authorizedUsers: [] }),
    } as any);

    await expect(
      waitForPermissionActivationWithFallback({
        rpcUrl: "https://devnet-tee.magicblock.app",
        sessionPda: SESSION_PDA,
        timeoutMs: 5,
      })
    ).resolves.toMatchObject({
      active: false,
      degraded: false,
      source: "timeout",
    });
  });

  it("closes permissions without adding the non-signer permission fee payer to the tx signatures", async () => {
    sendAndConfirmTransactionMock.mockResolvedValue("close-sig");

    const service = new PrivateNegotiationService(
      new Connection("http://127.0.0.1:8899", "confirmed"),
      Keypair.generate()
    );

    await expect(service.closePermissionOnly(1n, SESSION_PDA)).resolves.toBe("close-sig");

    expect(sendAndConfirmTransactionMock).toHaveBeenCalledTimes(1);
    const [, , signers] = sendAndConfirmTransactionMock.mock.calls[0]!;
    expect(signers).toHaveLength(1);
  });

  it("fails fast on the known permission borrow conflict so PER can fall back immediately", async () => {
    const service = new PrivateNegotiationService(
      new Connection("http://127.0.0.1:8899", "confirmed"),
      Keypair.generate()
    ) as any;

    const rpcMock = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Transaction simulation failed: Error processing Instruction 0: instruction tries to borrow reference for an account which is already borrowed."
        )
      );

    service.getNegotiationProgram = vi.fn(() => ({
      methods: {
        delegatePrivatePermission: vi.fn(() => ({
          accounts: vi.fn(() => ({
            rpc: rpcMock,
          })),
        })),
      },
    }));

    vi.spyOn(rpcManager, "getConnection").mockReturnValue({} as any);

    await expect(service.delegateToTee(1n, SESSION_PDA)).rejects.toThrow(/already borrowed/i);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});
