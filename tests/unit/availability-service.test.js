import { describe, expect, it, vi } from "vitest";
import { createAvailabilityService } from "../../src/domain/search/availability-service.js";
import { AvailabilityState } from "../../src/infrastructure/cache-repository.js";

describe("availability service", () => {
  it("coalesces the same segment/date regardless of paired return date", async () => {
    const gate = Promise.resolve({
      state: AvailabilityState.AVAILABLE,
      source: "network",
      flights: [{ key: "shared" }]
    });
    const loadFlights = vi.fn(() => gate);
    const service = createAvailabilityService({ loadFlights });
    const scope = service.createScope({ preferredReturnDates: ["2026-09-03"] });
    const [first, second] = await Promise.all([
      scope.resolve({ origin: "AAA", destination: "BBB", date: "2026-09-01", arrivalDate: "2026-09-04" }),
      scope.resolve({ origin: "AAA", destination: "BBB", date: "2026-09-01", arrivalDate: "2026-09-05" })
    ]);
    expect(loadFlights).toHaveBeenCalledOnce();
    expect(first.flights).toEqual(second.flights);
    expect(scope.diagnostics).toMatchObject({
      uniquePlannedProbes: 1,
      uniqueResolvedProbes: 1
    });
  });

  it("keeps transient failures unknown and exposes them for retry", async () => {
    const service = createAvailabilityService({
      loadFlights: vi.fn().mockRejectedValue(new Error("timeout"))
    });
    const scope = service.createScope();
    const outcome = await scope.resolve({ origin: "AAA", destination: "BBB", date: "2026-09-01" });
    expect(outcome.state).toBe(AvailabilityState.UNKNOWN);
    expect(scope.getFailed()).toHaveLength(1);
  });

  it("prunes excluded and date-invalid segments without network", async () => {
    const loadFlights = vi.fn();
    const service = createAvailabilityService({
      loadFlights,
      isRouteExcluded: () => true
    });
    const scope = service.createScope();
    const outcome = await scope.resolve({ origin: "AAA", destination: "BBB", date: "2026-09-01" });
    expect(outcome.state).toBe(AvailabilityState.UNAVAILABLE);
    expect(loadFlights).not.toHaveBeenCalled();
    expect(scope.getFailed()).toEqual([]);
  });

  it("starts only the current lazy frontier and selects the highest queued priority", async () => {
    const releases = new Map();
    const starts = [];
    const loadFlights = vi.fn(({ origin }) => new Promise(resolve => {
      starts.push(origin);
      releases.set(origin, () => resolve({
        state: AvailabilityState.UNAVAILABLE,
        source: "network",
        flights: []
      }));
    }));
    const service = createAvailabilityService({
      loadFlights,
      getEffectiveConcurrency: () => 1
    });
    const scope = service.createScope({ maxConcurrentRequests: 5 });
    const first = scope.schedule(
      { origin: "AAA", destination: "ZZZ", date: "2026-09-01" },
      { priority: 1 }
    );
    await vi.waitFor(() => expect(starts).toEqual(["AAA"]));
    const low = scope.schedule(
      { origin: "BBB", destination: "ZZZ", date: "2026-09-01" },
      { priority: 1 }
    );
    const high = scope.schedule(
      { origin: "CCC", destination: "ZZZ", date: "2026-09-01" },
      { priority: 100 }
    );

    releases.get("AAA")();
    await vi.waitFor(() => expect(starts).toEqual(["AAA", "CCC"]));
    releases.get("CCC")();
    await vi.waitFor(() => expect(starts).toEqual(["AAA", "CCC", "BBB"]));
    releases.get("BBB")();
    await Promise.all([first, low, high]);
    expect(scope.diagnostics).toMatchObject({
      uniquePlannedProbes: 3,
      uniqueResolvedProbes: 3,
      peakActiveProbes: 1
    });
  });

  it("bulk-preflights each canonical cache key at most once per scope", async () => {
    const cache = {
      lookupMany: vi.fn(async keys => new Map(keys.map(key => [key, {
        state: AvailabilityState.UNKNOWN,
        reason: "miss"
      }]))),
      get: vi.fn()
    };
    const service = createAvailabilityService({ cache, loadFlights: vi.fn() });
    const scope = service.createScope();
    const segments = [
      { origin: "AAA", destination: "BBB", date: "2026-09-01" },
      { origin: "AAA", destination: "BBB", date: "2026-09-01" }
    ];

    await scope.preflight(segments);
    await scope.preflight(segments);

    expect(cache.lookupMany).toHaveBeenCalledOnce();
    expect(cache.lookupMany).toHaveBeenCalledWith(["AAA-BBB-2026-09-01"]);
    expect(scope.diagnostics.preflightKeys).toBe(1);
  });

  it("attaches cache provenance to normalized flights", async () => {
    const checkedAt = Date.now() - 120_000;
    const rawFlight = {
      key: "cached-flight",
      departureDate: "1 September 2026",
      arrivalDate: "1 September 2026",
      departure: "10:00 am",
      arrival: "12:00 pm",
      departureOffsetText: "UTC",
      arrivalOffsetText: "UTC"
    };
    const service = createAvailabilityService({
      cache: {
        lookupMany: vi.fn(async keys => new Map(keys.map(key => [key, {
          state: AvailabilityState.AVAILABLE,
          source: "cache",
          checkedAt,
          results: [rawFlight]
        }])) )
      },
      loadFlights: vi.fn()
    });
    const scope = service.createScope();
    const segment = { origin: "AAA", destination: "BBB", date: "2026-09-01" };
    await scope.preflight([segment]);
    const outcome = await scope.resolve(segment);

    expect(outcome.flights[0].availability).toEqual({ source: "cache", checkedAt });
  });

  it("forces only allowlisted keys while reusing a completed search snapshot", async () => {
    const seedKey = "AAA-BBB-2026-09-01";
    const forcedKey = "BBB-CCC-2026-09-01";
    const loadFlights = vi.fn(async ({ origin }) => ({
      state: AvailabilityState.UNAVAILABLE,
      source: "network",
      checkedAt: 2000,
      flights: [],
      reason: "empty-response",
      origin
    }));
    const service = createAvailabilityService({ loadFlights });
    const scope = service.createScope({
      seedOutcomes: new Map([[seedKey, {
        state: AvailabilityState.UNAVAILABLE,
        source: "cache",
        checkedAt: 1000,
        flights: []
      }]]),
      forceNetworkKeys: new Set([forcedKey]),
      networkAllowlist: new Set([forcedKey])
    });

    const seeded = await scope.resolve({ origin: "AAA", destination: "BBB", date: "2026-09-01" });
    const forced = await scope.resolve({ origin: "BBB", destination: "CCC", date: "2026-09-01" });
    const outside = await scope.resolve({ origin: "CCC", destination: "DDD", date: "2026-09-01" });

    expect(seeded).toMatchObject({ source: "cache", checkedAt: 1000 });
    expect(forced).toMatchObject({ source: "network", checkedAt: 2000 });
    expect(outside).toMatchObject({ state: "unknown", reason: "outside-refresh-scope" });
    expect(loadFlights).toHaveBeenCalledOnce();
    expect(loadFlights).toHaveBeenCalledWith(expect.objectContaining({
      origin: "BBB",
      destination: "CCC",
      skipCache: true
    }));
    expect(scope.snapshot().get(forcedKey)).toMatchObject({ checkedAt: 2000 });
  });

  it("rejects both active and queued probes when the search is cancelled", async () => {
    const controller = new AbortController();
    const starts = [];
    const service = createAvailabilityService({
      getEffectiveConcurrency: () => 1,
      loadFlights: vi.fn(({ origin, signal }) => new Promise((_resolve, reject) => {
        starts.push(origin);
        signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {
          once: true
        });
      }))
    });
    const scope = service.createScope({ signal: controller.signal, maxConcurrentRequests: 2 });
    const active = scope.schedule({ origin: "AAA", destination: "ZZZ", date: "2026-09-01" });
    const queued = scope.schedule({ origin: "BBB", destination: "ZZZ", date: "2026-09-01" });
    await vi.waitFor(() => expect(starts).toEqual(["AAA"]));

    controller.abort();

    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(starts).toEqual(["AAA"]);
  });
});
