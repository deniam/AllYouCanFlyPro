import { describe, expect, it, vi } from "vitest";
import {
  createMultipassClient,
  parseRetryAfter
} from "../../src/infrastructure/multipass-client.js";
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
    updateTab: vi.fn().mockResolvedValue(undefined),
    createWindow: vi.fn().mockResolvedValue({
      id: 3,
      tabs: [{ id: 8, windowId: 3, status: "loading" }]
    }),
    focusWindow: vi.fn().mockResolvedValue(undefined),
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
  const scheduler = {
    schedule: vi.fn(async task => task()),
    recordSuccess: vi.fn(),
    recordRateLimit: vi.fn()
  };
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    flightsOutbound: [{ key: "flight-1" }]
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const client = createMultipassClient({
    gateway,
    cache,
    scheduler,
    sessionStorage: memoryStorage(),
    fetchImpl,
    ...overrides
  });
  return { client, cache, gateway, scheduler, fetchImpl };
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

  it("coalesces identical in-flight availability requests", async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { client, fetchImpl } = createHarness();
    fetchImpl.mockImplementation(async () => {
      await gate;
      return new Response(JSON.stringify({ flightsOutbound: [{ key: "shared" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const segment = { origin: "AAA", destination: "BBB", date: "2026-08-28" };
    const first = client.getFlights(segment);
    const second = client.getFlights(segment);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ key: "shared" }],
      [{ key: "shared" }]
    ]);
  });

  it("keeps different RT arrival dates as separate in-flight requests", async () => {
    const { client, fetchImpl } = createHarness();
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({
      flightsOutbound: [{ key: "flight-1" }],
      flightsInbound: []
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await Promise.all([
      client.getFlights({
        origin: "AAA", destination: "BBB", date: "2026-08-28", arrivalDate: "2026-08-29"
      }),
      client.getFlights({
        origin: "AAA", destination: "BBB", date: "2026-08-28", arrivalDate: "2026-08-30"
      })
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent cold-session discovery", async () => {
    const { client, gateway } = createHarness();
    await Promise.all([client.ensureSession(), client.ensureSession(), client.ensureSession()]);
    const dynamicUrlRequests = gateway.sendMessage.mock.calls.filter(
      ([, message]) => message.action === "getDynamicUrl"
    );
    expect(dynamicUrlRequests).toHaveLength(1);
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
    const { client, cache, fetchImpl, scheduler } = createHarness({ maxAttempts: 1 });
    fetchImpl.mockResolvedValue(new Response("", { status: 400 }));
    await expect(client.getFlights({
      origin: "AAA", destination: "BBB", date: "2026-08-28", arrivalDate: "2026-08-29"
    }))
      .resolves.toEqual([]);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledWith("AAA-BBB-2026-08-28", []);
    expect(scheduler.recordSuccess).toHaveBeenCalledOnce();
  });

  it("treats HTTP 302 as a permanently missing route", async () => {
    const onRouteNotFound = vi.fn();
    const { client, cache, fetchImpl, scheduler } = createHarness({ onRouteNotFound });
    fetchImpl.mockResolvedValue(new Response("", { status: 302 }));

    await expect(client.getFlights({
      origin: "CDT", destination: "LTN", date: "2026-08-31"
    })).resolves.toEqual([]);
    expect(onRouteNotFound).toHaveBeenCalledWith({ origin: "CDT", destination: "LTN" });
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("manual");
    expect(cache.put).toHaveBeenCalledWith("CDT-LTN-2026-08-31", []);
    expect(scheduler.recordSuccess).toHaveBeenCalledOnce();
  });

  it("requests and caches both sides of a paired RT response", async () => {
    const { client, cache, fetchImpl } = createHarness();
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({
      flightsOutbound: [{ key: "out" }],
      flightsInbound: [{ key: "in" }]
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(client.getFlights({
      origin: "AAA", destination: "BBB", date: "2026-08-28", arrivalDate: "2026-08-29"
    })).resolves.toEqual([{ key: "out" }]);
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(request).toMatchObject({
      flightType: "RT", origin: "AAA", destination: "BBB",
      departure: "2026-08-28", arrival: "2026-08-29"
    });
    expect(cache.put).toHaveBeenCalledWith("AAA-BBB-2026-08-28", [{ key: "out" }]);
    expect(cache.put).toHaveBeenCalledWith("BBB-AAA-2026-08-29", [{ key: "in" }]);
  });

  it("negative-caches a valid empty inbound response", async () => {
    const { client, cache, fetchImpl } = createHarness();
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({
      flightsOutbound: [{ key: "out" }],
      flightsInbound: []
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await client.getFlights({
      origin: "AAA", destination: "BBB", date: "2026-08-28", arrivalDate: "2026-08-29"
    });
    expect(cache.put).toHaveBeenCalledWith("BBB-AAA-2026-08-29", []);
  });

  it("does not cache a malformed or missing inbound response", async () => {
    const logger = vi.fn();
    const { client, cache } = createHarness({ logger });

    await client.getFlights({
      origin: "AAA", destination: "BBB", date: "2026-08-28", arrivalDate: "2026-08-29"
    });
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("reverse availability was not cached"),
      expect.any(Object)
    );
  });

  it("treats a JSON response without flightsOutbound as empty availability", async () => {
    const { client, cache, fetchImpl } = createHarness({ maxAttempts: 1 });
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ message: "no flights" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    await expect(client.getFlights({ origin: "AAA", destination: "BBB", date: "2026-08-28" }))
      .resolves.toEqual([]);
    expect(cache.put).toHaveBeenCalledWith("AAA-BBB-2026-08-28", []);
  });

  it("opens Multipass in an active tab when no Multipass tab exists", async () => {
    const { client, gateway } = createHarness();
    gateway.queryTabs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 8, windowId: 3, status: "complete" }]);

    await expect(client.ensureSession()).resolves.toMatchObject({
      dynamicUrl: "https://example.test/availability/id"
    });
    expect(gateway.createTab).toHaveBeenCalledWith({
      url: "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets",
      active: true
    });
  });

  it("opens an active authentication tab when session discovery times out", async () => {
    const { client, gateway } = createHarness();
    gateway.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.action === "ping") return { success: true };
      if (message.action === "getDynamicUrl") {
        return { error: "Dynamic URL was not found before timeout" };
      }
      return { success: true };
    });

    await expect(client.ensureSession()).rejects.toMatchObject({ code: ErrorCode.AUTH_REQUIRED });
    expect(gateway.createTab).toHaveBeenCalledWith({
      url: "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets",
      active: true
    });
  });

  it.each([426, 429, 501])("normalizes HTTP %s as rate limiting", async status => {
    const { client, fetchImpl, scheduler } = createHarness({ maxAttempts: 1 });
    fetchImpl.mockResolvedValue(new Response("", {
      status,
      headers: status === 429 ? { "retry-after": "7" } : undefined
    }));
    await expect(client.getFlights({ origin: "AAA", destination: "BBB", date: "2026-08-28" }))
      .rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED, status });
    expect(scheduler.recordRateLimit).toHaveBeenCalledWith(
      status === 429 ? 7000 : expect.any(Number),
      status,
      status === 429 ? "7" : null
    );
  });

  it("normalizes network failures", async () => {
    const { client, fetchImpl } = createHarness({ maxAttempts: 1 });
    fetchImpl.mockRejectedValue(new TypeError("offline"));
    await expect(client.getFlights({ origin: "AAA", destination: "BBB", date: "2026-08-28" }))
      .rejects.toMatchObject({ code: ErrorCode.HTTP_ERROR, message: "offline" });
  });

  it("stops a hanging availability request after the configured timeout", async () => {
    const hangingFetch = vi.fn((_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }));
    const { client } = createHarness({
      fetchImpl: hangingFetch,
      maxAttempts: 2,
      requestTimeoutMs: 10
    });

    await expect(client.getFlights({ origin: "AAA", destination: "BBB", date: "2026-08-28" }))
      .rejects.toMatchObject({
        code: ErrorCode.HTTP_ERROR,
        message: "Availability request timed out after 0.01 seconds",
        retryable: false
      });
    expect(hangingFetch).toHaveBeenCalledOnce();
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

describe("Retry-After parser", () => {
  it("supports seconds and HTTP dates", () => {
    expect(parseRetryAfter("7", 0)).toBe(7000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", Date.UTC(2026, 0, 1)))
      .toBe(10000);
    expect(parseRetryAfter("invalid", 0)).toBeNull();
  });
});
