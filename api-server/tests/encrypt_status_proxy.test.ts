import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    body: undefined,
  };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res;
  });
  return res;
}

async function loadStatusHandler() {
  const routerModule = await import("../src/routes/encrypt.routes");
  const router = routerModule.default as any;
  const layer = router.stack.find((entry: any) => entry.route?.path === "/status");
  if (!layer) {
    throw new Error("status route not found");
  }
  return layer.route.stack[0].handle as (req: any, res: any) => Promise<void>;
}

describe("encrypt status proxy", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock as any);
    process.env.MIDDLEMAN_URL = "http://middleman.test";
    process.env.AGENT_API_SECRET = "test-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MIDDLEMAN_URL;
    delete process.env.AGENT_API_SECRET;
  });

  it("proxies middleman confidential status over HTTP instead of importing middleman sources", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        confidential_escrow: "active",
        agent_dwallet: "dwallet-1",
      }),
    });

    const handler = await loadStatusHandler();
    const res = createMockResponse();

    await handler({} as any, res);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://middleman.test/v1/confidential/status",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer test-secret",
        },
      })
    );
    expect(res.status).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      confidential_escrow: "active",
      agent_dwallet: "dwallet-1",
      source: "middleman_proxy",
    });
  });

  it("returns a 503 fallback payload when the middleman status endpoint is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const handler = await loadStatusHandler();
    const res = createMockResponse();

    await handler({} as any, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toEqual(
      expect.objectContaining({
        confidential_escrow: "unknown",
        source: "middleman_proxy",
        error: "middleman_unreachable",
        details: "fetch failed",
      })
    );
  });
});
