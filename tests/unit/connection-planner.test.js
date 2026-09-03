import { describe, expect, it, vi } from "vitest";
import {
  createConnectionPlanner,
  flightInstanceKey
} from "../../src/domain/search/connection-planner.js";
import { createAvailabilityService } from "../../src/domain/search/availability-service.js";
import { AvailabilityState } from "../../src/infrastructure/cache-repository.js";

function flight(origin, destination, date, departureUtc, arrivalUtc, key = null) {
  return {
    key: key ?? `${origin}-${destination}-${departureUtc}`,
    departureStation: origin,
    arrivalStation: destination,
    departureStationText: origin,
    arrivalStationText: destination,
    departureDateIso: date,
    departureDateUtc: new Date(departureUtc),
    arrivalDateUtc: new Date(arrivalUtc),
    departureDate: date,
    arrivalDate: date,
    calculatedDuration: {
      departureDate: new Date(departureUtc),
      arrivalDate: new Date(arrivalUtc)
    }
  };
}

function catalog(routes) {
  const destinations = new Map();
  for (const [origin, destination] of routes) {
    const values = destinations.get(origin) ?? [];
    values.push(destination);
    destinations.set(origin, values);
  }
  return {
    airportCodes: [...new Set(routes.flat())],
    getDestinations: origin => destinations.get(origin) ?? [],
    isDateAvailable: () => true
  };
}

function scope(responses, knownEntries = new Map()) {
  const requested = [];
  return {
    requested,
    diagnostics: { prunedBranches: 0 },
    async preflight() {},
    getKnown: key => knownEntries.get(key) ?? null,
    async resolve(segment) {
      requested.push(`${segment.origin}-${segment.destination}-${segment.date}`);
      return responses.get(`${segment.origin}-${segment.destination}-${segment.date}`)
        ?? { state: AvailabilityState.UNAVAILABLE, flights: [] };
    }
  };
}

function planner(routes, responses, knownEntries = new Map()) {
  const availabilityScope = scope(responses, knownEntries);
  const results = [];
  const plannerInstance = createConnectionPlanner({
    routeCatalog: catalog(routes),
    availabilityScope,
    appendRouteToDisplay: result => results.push(result)
  });
  return { search: plannerInstance.search, availabilityScope, results };
}

describe("connection planner", () => {
  it("uses UTC schedule times to distinguish flights without an API key", () => {
    const early = flight(
      "AAA", "BBB", "2026-09-01",
      "2026-09-01T08:00:00Z", "2026-09-01T10:00:00Z"
    );
    const late = flight(
      "AAA", "BBB", "2026-09-01",
      "2026-09-01T18:00:00Z", "2026-09-01T20:00:00Z"
    );
    delete early.key;
    delete late.key;
    expect(flightInstanceKey(early)).not.toBe(flightInstanceKey(late));
  });

  it("finds a next-day overnight connection even when max connection is under 24 hours", async () => {
    const responses = new Map([
      ["AAA-BBB-2026-09-01", { state: AvailabilityState.AVAILABLE, flights: [flight("AAA", "BBB", "2026-09-01", "2026-09-01T20:00:00Z", "2026-09-01T23:30:00Z")] }],
      ["BBB-CCC-2026-09-02", { state: AvailabilityState.AVAILABLE, flights: [flight("BBB", "CCC", "2026-09-02", "2026-09-02T01:00:00Z", "2026-09-02T04:00:00Z")] }]
    ]);
    const { search, availabilityScope } = planner([["AAA", "BBB"], ["BBB", "CCC"]], responses);
    const results = await search({
      origins: ["AAA"], destinations: ["CCC"], selectedDate: "2026-09-01", maxTransfers: 1,
      allowOvernight: true, minConnection: 60, maxConnection: 120,
      bookingWindow: { from: "2026-09-01", to: "2026-09-04" }
    });
    expect(results).toHaveLength(1);
    expect(availabilityScope.requested).toContain("BBB-CCC-2026-09-02");
  });

  it("does not query a prefix when a cached suffix is confirmed empty", async () => {
    const known = new Map([
      ["BBB-CCC-2026-09-01", { state: AvailabilityState.UNAVAILABLE, flights: [] }]
    ]);
    const { search, availabilityScope } = planner(
      [["AAA", "BBB"], ["BBB", "CCC"]],
      new Map(),
      known
    );
    const results = await search({
      origins: ["AAA"], destinations: ["CCC"], selectedDate: "2026-09-01", maxTransfers: 1,
      allowOvernight: false, bookingWindow: { from: "2026-09-01", to: "2026-09-04" }
    });
    expect(results).toHaveLength(0);
    expect(availabilityScope.requested).toEqual([]);
  });

  it("derives the third-leg date from the second flight arrival", async () => {
    const responses = new Map([
      ["AAA-BBB-2026-09-01", { state: AvailabilityState.AVAILABLE, flights: [flight("AAA", "BBB", "2026-09-01", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z")] }],
      ["BBB-CCC-2026-09-01", { state: AvailabilityState.AVAILABLE, flights: [flight("BBB", "CCC", "2026-09-01", "2026-09-01T14:00:00Z", "2026-09-01T23:30:00Z")] }],
      ["CCC-DDD-2026-09-02", { state: AvailabilityState.AVAILABLE, flights: [flight("CCC", "DDD", "2026-09-02", "2026-09-02T02:00:00Z", "2026-09-02T04:00:00Z")] }]
    ]);
    const { search, availabilityScope } = planner(
      [["AAA", "BBB"], ["BBB", "CCC"], ["CCC", "DDD"]], responses
    );
    const results = await search({
      origins: ["AAA"], destinations: ["DDD"], selectedDate: "2026-09-01", maxTransfers: 2,
      allowOvernight: true, minConnection: 60, maxConnection: 180,
      bookingWindow: { from: "2026-09-01", to: "2026-09-04" }
    });
    expect(results).toHaveLength(1);
    expect(availabilityScope.requested).toContain("CCC-DDD-2026-09-02");
  });

  it("shares one availability response while branching by individual flight times", async () => {
    const responses = new Map([
      ["AAA-BBB-2026-09-01", {
        state: AvailabilityState.AVAILABLE,
        source: "network",
        flights: [
          flight("AAA", "BBB", "2026-09-01", "2026-09-01T07:00:00Z", "2026-09-01T10:00:00Z", "first-early"),
          flight("AAA", "BBB", "2026-09-01", "2026-09-01T15:00:00Z", "2026-09-01T18:00:00Z", "first-late")
        ]
      }],
      ["BBB-CCC-2026-09-01", {
        state: AvailabilityState.AVAILABLE,
        source: "network",
        flights: [
          flight("BBB", "CCC", "2026-09-01", "2026-09-01T13:00:00Z", "2026-09-01T15:00:00Z", "second-early"),
          flight("BBB", "CCC", "2026-09-01", "2026-09-01T20:00:00Z", "2026-09-01T22:00:00Z", "second-late")
        ]
      }]
    ]);
    const loadFlights = vi.fn(segment => responses.get(
      `${segment.origin}-${segment.destination}-${segment.date}`
    ));
    const service = createAvailabilityService({ loadFlights });
    const availabilityScope = service.createScope({ maxConcurrentRequests: 4 });
    const search = createConnectionPlanner({
      routeCatalog: catalog([["AAA", "BBB"], ["BBB", "CCC"]]),
      availabilityScope
    }).search;

    const results = await search({
      origins: ["AAA"], destinations: ["CCC"], selectedDate: "2026-09-01",
      maxTransfers: 1, allowOvernight: false, minConnection: 90, maxConnection: 180,
      bookingWindow: { from: "2026-09-01", to: "2026-09-04" }
    });

    expect(results).toHaveLength(2);
    expect(results.map(result => result.key)).toEqual([
      "first-early | second-early",
      "first-late | second-late"
    ]);
    expect(loadFlights).toHaveBeenCalledTimes(2);
    expect(loadFlights.mock.calls.filter(([segment]) => segment.origin === "BBB")).toHaveLength(1);
  });

  it("does not schedule a downstream segment until its prefix becomes available", async () => {
    let releasePrefix;
    const prefixGate = new Promise(resolve => { releasePrefix = resolve; });
    const loadFlights = vi.fn(segment => {
      if (segment.origin === "AAA") return prefixGate;
      return Promise.resolve({
        state: AvailabilityState.UNAVAILABLE,
        source: "network",
        flights: []
      });
    });
    const service = createAvailabilityService({ loadFlights });
    const availabilityScope = service.createScope({ maxConcurrentRequests: 4 });
    const searchPromise = createConnectionPlanner({
      routeCatalog: catalog([["AAA", "BBB"], ["BBB", "CCC"]]),
      availabilityScope
    }).search({
      origins: ["AAA"], destinations: ["CCC"], selectedDate: "2026-09-01",
      maxTransfers: 1, allowOvernight: false,
      bookingWindow: { from: "2026-09-01", to: "2026-09-04" }
    });

    await vi.waitFor(() => expect(loadFlights).toHaveBeenCalledOnce());
    expect(loadFlights.mock.calls[0][0]).toMatchObject({ origin: "AAA", destination: "BBB" });
    releasePrefix({
      state: AvailabilityState.AVAILABLE,
      source: "network",
      flights: [flight(
        "AAA", "BBB", "2026-09-01",
        "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z"
      )]
    });
    await searchPromise;
    expect(loadFlights).toHaveBeenCalledTimes(2);
    expect(loadFlights.mock.calls[1][0]).toMatchObject({ origin: "BBB", destination: "CCC" });
  });

  it("prioritizes a newly unlocked completion probe before queued unrelated prefixes", async () => {
    const starts = [];
    const loadFlights = vi.fn(segment => {
      starts.push(`${segment.origin}-${segment.destination}`);
      if (segment.origin === "AAA") {
        return Promise.resolve({
          state: AvailabilityState.AVAILABLE,
          source: "network",
          flights: [flight(
            "AAA", "BBB", "2026-09-01",
            "2026-09-01T08:00:00Z", "2026-09-01T10:00:00Z"
          )]
        });
      }
      return Promise.resolve({
        state: AvailabilityState.UNAVAILABLE,
        source: "network",
        flights: []
      });
    });
    const service = createAvailabilityService({
      loadFlights,
      getEffectiveConcurrency: () => 1
    });
    const availabilityScope = service.createScope({ maxConcurrentRequests: 4 });
    await createConnectionPlanner({
      routeCatalog: catalog([
        ["AAA", "BBB"], ["BBB", "CCC"],
        ["DDD", "EEE"], ["EEE", "CCC"]
      ]),
      availabilityScope
    }).search({
      origins: ["AAA", "DDD"], destinations: ["CCC"], selectedDate: "2026-09-01",
      maxTransfers: 1, allowOvernight: false, minConnection: 30, maxConnection: 300,
      bookingWindow: { from: "2026-09-01", to: "2026-09-04" }
    });

    expect(starts).toEqual(["AAA-BBB", "BBB-CCC", "DDD-EEE"]);
  });

  it("preflights only edges inside the layered origin-to-destination graph", async () => {
    const preflighted = [];
    const availabilityScope = {
      diagnostics: { prunedBranches: 0 },
      async preflight(segments) { preflighted.push(...segments); },
      getKnown: () => null,
      async resolve() {
        return { state: AvailabilityState.UNAVAILABLE, flights: [] };
      }
    };
    const search = createConnectionPlanner({
      routeCatalog: catalog([
        ["AAA", "BBB"], ["BBB", "CCC"],
        ["AAA", "XXX"], ["XXX", "YYY"], ["DDD", "EEE"]
      ]),
      availabilityScope
    }).search;

    await search({
      origins: ["AAA"], destinations: ["CCC"], selectedDate: "2026-09-01",
      maxTransfers: 1, allowOvernight: false,
      bookingWindow: { from: "2026-09-01", to: "2026-09-04" }
    });

    expect(preflighted.map(segment => `${segment.origin}-${segment.destination}`)).toEqual([
      "AAA-BBB",
      "BBB-CCC"
    ]);
  });

  it("scales shared-path execution by unique segment/date nodes", async () => {
    const width = 32;
    const firstLayer = Array.from({ length: width }, (_, index) => `A${index}`);
    const secondLayer = Array.from({ length: width }, (_, index) => `B${index}`);
    const routes = [
      ...firstLayer.map(node => ["START", node]),
      ...firstLayer.flatMap(origin => secondLayer.map(destination => [origin, destination])),
      ...secondLayer.map(node => [node, "END"])
    ];
    const loadFlights = vi.fn(segment => {
      const isFirst = segment.origin === "START";
      const isLast = segment.destination === "END";
      const departure = isFirst ? "08:00:00Z" : isLast ? "12:00:00Z" : "10:00:00Z";
      const arrival = isFirst ? "09:00:00Z" : isLast ? "13:00:00Z" : "11:00:00Z";
      return Promise.resolve({
        state: AvailabilityState.AVAILABLE,
        source: "network",
        flights: [flight(
          segment.origin,
          segment.destination,
          segment.date,
          `${segment.date}T${departure}`,
          `${segment.date}T${arrival}`,
          `${segment.origin}-${segment.destination}`
        )]
      });
    });
    const service = createAvailabilityService({ loadFlights });
    const availabilityScope = service.createScope({ maxConcurrentRequests: 32 });
    const search = createConnectionPlanner({
      routeCatalog: catalog(routes),
      availabilityScope
    }).search;

    const results = await search({
      origins: ["START"], destinations: ["END"], selectedDate: "2026-09-01",
      maxTransfers: 2, allowOvernight: false, minConnection: 30, maxConnection: 180,
      bookingWindow: { from: "2026-09-01", to: "2026-09-04" },
      appendResults: false
    });

    const uniqueSegmentNodes = width + width * width + width;
    expect(results).toHaveLength(width * width);
    expect(loadFlights).toHaveBeenCalledTimes(uniqueSegmentNodes);
    expect(availabilityScope.diagnostics).toMatchObject({
      uniquePlannedProbes: uniqueSegmentNodes,
      uniqueResolvedProbes: uniqueSegmentNodes
    });
  }, 10000);
});
