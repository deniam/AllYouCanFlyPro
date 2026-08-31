import { describe, expect, it } from "vitest";
import { createConnectionPlanner } from "../../src/domain/search/connection-planner.js";
import { AvailabilityState } from "../../src/infrastructure/cache-repository.js";

function flight(origin, destination, date, departureUtc, arrivalUtc) {
  return {
    key: `${origin}-${destination}-${date}`,
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
  const destinations = new Map(routes.map(([origin, destination]) => [origin, [destination]]));
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
});
