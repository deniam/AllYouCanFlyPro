import { describe, expect, it, vi } from "vitest";
import { createMultipassClient } from "../../src/infrastructure/multipass-client.js";
import { ErrorCode } from "../../src/infrastructure/errors.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
}

function createHarness(overrides = {}) {
  const cache = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined)
  };
  const gateway = {
    queryTabs: vi.fn().mockResolvedValue([{ id: 7, status: "complete" }]),
    createTab: vi.fn().mockResolvedValue({ id: 8, status: "loading" }),
    reloadTab: vi.fn().mockResolvedValue(undefined),
    waitForTabComplete: vi.fn().mockResolvedValue(undefined),
    injectContentScript: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(async (_tabId, message) => {
      if (message.action === "ping") return { success: true };
      if (message.action === "getDynamicUrl") return { dynamicUrl: "https://example.test/availability/id" };
      if (message.action === "getHeaders") return { headers: { "x-test": "yes" } };
      return { success: true };
    })
  };
  const throttler = { wait: vi.fn().mockResolvedValue(undefined) };
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    flightsOutbound: [{ key: "flight-1" }]
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const client = createMultipassClient({
    gateway,
    cache,
    throttler,
    sessionStorage: memoryStorage(),
    fetchImpl,
    ...overrides
  });
  return { client, cache, gateway, throttler, fetchImpl };
}

describe("MultipassClient", () => {
  it("discovers a session, requests flights, and caches the response", async () => {
    const { client, cache, fetchImpl } = createHarness();
    const flights = await client.getFlights({ origin: "AAA", destination: "BBB", date: "2026-08-28" });
    expect(flights).toEqual([{ key: "flight-1" }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledWith("AAA-BBB-2026-08-28", flights);
  });

  it("does not access the tab or network on a cache hit", async () => {
    const { client, cache, gateway, fetchImpl } = createHarness();
    cache.get.mockResolvedValue([{ key: "cached" }]);
    await expect(client.getFlights({ origin: "AAA", destination: "BBB", date: "2026-08-28" }))
      .resolves.toEqual([{ key: "cached" }]);
    expect(gateway.queryTabs).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes unexpected HTTP failures", async () => {
    const { client, fetchImpl } = createHarness({ maxAttempts: 1 });
    fetchImpl.mockResolvedValue(new Response("failed", { status: 503 }));
    await expect(client.getFlights({ origin: "AAA", destination: "BBB", date: "2026-08-28" }))
      .rejects.toMatchObject({ code: ErrorCode.HTTP_ERROR, status: 503 });
  });

  it("honours cancellation before a request", async () => {
    const { client } = createHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(client.getFlights(
      { origin: "AAA", destination: "BBB", date: "2026-08-28" },
      controller.signal
    )).rejects.toMatchObject({ code: ErrorCode.CANCELLED });
  });

  it("treats the observed 400 response as empty availability", async () => {
    const { client, fetchImpl } = createHarness({ maxAttempts: 1 });
    fetchImpl.mockResolvedValue(new Response("", { status: 400 }));
    await expect(client.getFlights({ origin: "AAA", destination: "BBB", date: "2026-08-28" }))
      .resolves.toEqual([]);
  });

  it.each([426, 429, 501])("normalizes HTTP %s as rate limiting", async status => {
    const { client, fetchImpl } = createHarness({ maxAttempts: 1 });
    fetchImpl.mockResolvedValue(new Response("", { status }));
    await expect(client.getFlights({ origin: "AAA", destination: "BBB", date: "2026-08-28" }))
      .rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED, status });
  });

  it("normalizes network failures", async () => {
    const { client, fetchImpl } = createHarness({ maxAttempts: 1 });
    fetchImpl.mockRejectedValue(new TypeError("offline"));
    await expect(client.getFlights({ origin: "AAA", destination: "BBB", date: "2026-08-28" }))
      .rejects.toMatchObject({ code: ErrorCode.HTTP_ERROR, message: "offline" });
  });

  it("recognizes an HTML login response and refreshes the session", async () => {
    const { client, fetchImpl, gateway } = createHarness({ maxAttempts: 1 });
    fetchImpl.mockResolvedValue(new Response("<!doctype html><title>Login</title>", {
      status: 200,
      headers: { "content-type": "text/html" }
    }));
    await expect(client.getFlights({ origin: "AAA", destination: "BBB", date: "2026-08-28" }))
      .rejects.toMatchObject({ code: ErrorCode.AUTH_REQUIRED });
    expect(gateway.reloadTab).toHaveBeenCalledOnce();
  });
});
