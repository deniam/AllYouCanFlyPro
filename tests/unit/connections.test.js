import { describe, expect, it, vi } from "vitest";
import { combineOneStopFlights, createConnectionsSearch } from "../../src/domain/search/connections.js";
import { createRouteCatalog } from "../../src/domain/route-catalog.js";
import { addDaysUTC } from "../../src/domain/dates.js";

const segment = (key, from, to, departure, arrival) => ({
  key,
  departureStation: from,
  departureStationText: from,
  arrivalStation: to,
  arrivalStationText: to,
  departureDateUtc: new Date(departure),
  arrivalDateUtc: new Date(arrival),
  calculatedDuration: {
    departureDate: new Date(departure),
    arrivalDate: new Date(arrival)
  }
});

const rawSegment = (key, from, to, date, departure, arrival) => ({
  key,
  departureStation: from,
  departureStationText: from,
  arrivalStation: to,
  arrivalStationText: to,
  departureDate: date,
  arrivalDate: date,
  departureDateIso: date,
  arrivalDateIso: date,
  departure,
  arrival,
  departureOffsetText: "UTC",
  arrivalOffsetText: "UTC"
});

describe("connection aggregation", () => {
  it("keeps only flights inside the connection window", () => {
    const first = segment("one", "AAA", "BBB", "2026-09-01T08:00:00Z", "2026-09-01T10:00:00Z");
    const valid = segment("two", "BBB", "CCC", "2026-09-01T12:00:00Z", "2026-09-01T14:00:00Z");
    const tooSoon = segment("three", "BBB", "CCC", "2026-09-01T10:30:00Z", "2026-09-01T12:00:00Z");
    const results = combineOneStopFlights([first], [valid, tooSoon], {
      minConnection: 90,
      maxConnection: 300
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ key: "one | two", totalConnectionTime: 120 });
  });

  it("ignores a segment without normalized timing instead of aborting the search", () => {
    const valid = segment("valid", "BBB", "CCC", "2026-09-01T12:00:00Z", "2026-09-01T14:00:00Z");
    const results = combineOneStopFlights([{ key: "invalid" }], [valid], {
      minConnection: 90,
      maxConnection: 300
    });
    expect(results).toEqual([]);
  });

  it("normalizes raw RT cache hits in an airport-change search", async () => {
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const selectedDate = addDaysUTC(todayUtc, 1).toISOString().slice(0, 10);
    const routes = [
      { departureStation: "AAA", arrivalStations: [{ id: "BBB", flightDates: [selectedDate] }] },
      { departureStation: "CCC", arrivalStations: [{ id: "DDD", flightDates: [selectedDate] }] }
    ];
    const catalog = createRouteCatalog(routes);
    const cached = new Map([
      [`AAA-BBB-${selectedDate}`, [rawSegment(
        "first", "AAA", "BBB", selectedDate, "8:00 am", "10:00 am"
      )]],
      [`CCC-DDD-${selectedDate}`, [rawSegment(
        "second", "CCC", "DDD", selectedDate, "12:00 pm", "2:00 pm"
      )]]
    ]);
    const setCachedResults = vi.fn(async () => {});
    const search = createConnectionsSearch({
      isCancelled: () => false,
      debugLogger: vi.fn(),
      isDateAvailableForSegment: (origin, destination, date) =>
        catalog.isDateAvailable(origin, destination, date),
      getCachedResults: vi.fn(async key => cached.get(key) ?? null),
      setCachedResults,
      getUnifiedCacheKey: (origin, destination, date) => `${origin}-${destination}-${date}`,
      checkRouteSegment: vi.fn(async () => []),
      updateProgress: vi.fn(),
      fetchDestinations: async () => routes,
      routeCatalog: catalog,
      airportLookup: {
        BBB: { latitude: 0, longitude: 0 },
        CCC: { latitude: 0, longitude: 1 }
      },
      appendRouteToDisplay: vi.fn(),
      getSettings: () => ({
        minConnectionTime: 90,
        maxConnectionTime: 1440,
        connectionRadius: 300,
        allowChangeAirport: true
      }),
      getStopoverText: () => "One stop or fewer"
    });

    const results = await search(
      ["AAA"], ["DDD"], selectedDate, 1, false, true, { preferredReturnDates: [] }
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      key: "first | second",
      airportChange: { from: "BBB", to: "CCC" }
    });
    expect(setCachedResults).toHaveBeenCalledTimes(2);
  });

  it.each([
    { maxTransfers: 1, path: ["AAA", "BBB", "DDD"], stopover: "One stop or fewer" },
    { maxTransfers: 2, path: ["AAA", "BBB", "CCC", "DDD"], stopover: "Two stops or fewer (overnight)" }
  ])("passes paired-query options through every segment with $maxTransfers transfers", async ({
    maxTransfers, path, stopover
  }) => {
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const selectedDate = addDaysUTC(todayUtc, 1).toISOString().slice(0, 10);
    const routes = path.slice(0, -1).map((origin, index) => ({
      departureStation: origin,
      arrivalStations: [{ id: path[index + 1], flightDates: [selectedDate] }]
    }));
    const catalog = createRouteCatalog(routes);
    const starts = [8, 12, 16];
    const flights = new Map(path.slice(0, -1).map((origin, index) => {
      const destination = path[index + 1];
      const departure = new Date(`${selectedDate}T${String(starts[index]).padStart(2, "0")}:00:00Z`);
      const arrival = new Date(departure.getTime() + 2 * 60 * 60 * 1000);
      return [`${origin}-${destination}`, segment(
        `${origin}-${destination}`, origin, destination,
        departure.toISOString(), arrival.toISOString()
      )];
    }));
    const checkRouteSegment = vi.fn(async (origin, destination) => [
      flights.get(`${origin}-${destination}`)
    ]);
    const search = createConnectionsSearch({
      isCancelled: () => false,
      debugLogger: vi.fn(),
      isDateAvailableForSegment: (origin, destination, date) =>
        catalog.isDateAvailable(origin, destination, date),
      getCachedResults: vi.fn(async () => null),
      setCachedResults: vi.fn(async () => {}),
      getUnifiedCacheKey: (origin, destination, date) => `${origin}-${destination}-${date}`,
      checkRouteSegment,
      updateProgress: vi.fn(),
      fetchDestinations: async () => routes,
      routeCatalog: catalog,
      airportLookup: {},
      appendRouteToDisplay: vi.fn(),
      getSettings: () => ({
        minConnectionTime: 60,
        maxConnectionTime: 300,
        connectionRadius: 0,
        allowChangeAirport: false
      }),
      getStopoverText: () => stopover
    });
    const queryOptions = { preferredReturnDates: [selectedDate] };

    const results = await search(
      [path[0]], [path.at(-1)], selectedDate, maxTransfers, false, true, queryOptions
    );
    expect(results).toHaveLength(1);
    expect(checkRouteSegment).toHaveBeenCalledTimes(path.length - 1);
    for (const call of checkRouteSegment.mock.calls) expect(call[3]).toBe(queryOptions);
  });
});
