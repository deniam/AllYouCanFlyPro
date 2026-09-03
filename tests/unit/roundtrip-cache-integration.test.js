import { describe, expect, it, vi } from "vitest";
import { createRouteCatalog } from "../../src/domain/route-catalog.js";
import { createDirectSearch } from "../../src/domain/search/direct.js";
import { runSearch } from "../../src/domain/search/orchestrator.js";
import { createPairedDateSelector } from "../../src/domain/search/paired-date-selector.js";
import { createMultipassClient } from "../../src/infrastructure/multipass-client.js";
import { segmentCacheKey } from "../../src/infrastructure/cache-repository.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
}

function normalized(raw) {
  return {
    ...raw,
    route: [raw.departureStation, raw.arrivalStation],
    calculatedDuration: {
      departureDate: new Date(raw.departureDateTime),
      arrivalDate: new Date(raw.arrivalDateTime)
    }
  };
}

describe("paired round-trip cache integration", () => {
  it("serves a direct round-trip with one availability request", async () => {
    const departureDate = "2026-08-30";
    const returnDate = "2026-08-31";
    const routes = [{
      departureStation: "AAA",
      arrivalStations: [{ id: "BBB", flightDates: [departureDate] }]
    }, {
      departureStation: "BBB",
      arrivalStations: [{ id: "AAA", flightDates: [returnDate] }]
    }];
    const catalog = createRouteCatalog(routes);
    const values = new Map();
    const cache = {
      get: vi.fn(async key => values.get(key) ?? null),
      put: vi.fn(async (key, flights) => values.set(key, flights))
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      flightsOutbound: [{
        key: "out", departureStation: "AAA", arrivalStation: "BBB",
        departureDateTime: `${departureDate}T08:00:00Z`,
        arrivalDateTime: `${departureDate}T10:00:00Z`
      }],
      flightsInbound: [{
        key: "in", departureStation: "BBB", arrivalStation: "AAA",
        departureDateTime: `${returnDate}T08:00:00Z`,
        arrivalDateTime: `${returnDate}T10:00:00Z`
      }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const gateway = {
      queryTabs: vi.fn().mockResolvedValue([{ id: 7, status: "complete" }]),
      sendMessage: vi.fn(async (_tabId, message) => {
        if (message.action === "ping") return { success: true };
        if (message.action === "getDynamicUrl") return { dynamicUrl: "https://example.test/availability" };
        if (message.action === "getHeaders") return { headers: {} };
        return { success: true };
      })
    };
    const client = createMultipassClient({
      gateway,
      cache,
      scheduler: {
        schedule: vi.fn(async task => task()),
        recordSuccess: vi.fn(),
        recordRateLimit: vi.fn()
      },
      sessionStorage: memoryStorage(),
      fetchImpl
    });
    const selectArrival = createPairedDateSelector({
      routeCatalog: catalog,
      getCached: (origin, destination, date) => cache.get(segmentCacheKey(origin, destination, date)),
      now: () => new Date("2026-08-29T12:00:00Z")
    });
    const fetchFlights = async (origin, destination, date, options = {}) => client.getFlights({
      origin,
      destination,
      date,
      arrivalDate: await selectArrival({
        origin,
        destination,
        departureDate: date,
        preferredReturnDates: options.preferredReturnDates ?? []
      })
    });
    const availabilityScope = {
      preflight: vi.fn(async () => {}),
      resolve: vi.fn(async segment => {
        const flights = (await fetchFlights(
          segment.origin,
          segment.destination,
          segment.date,
          { preferredReturnDates: segment.preferredReturnDates }
        )).map(normalized);
        return flights.length
          ? { state: "available", flights }
          : { state: "unavailable", flights: [] };
      })
    };
    const searchDirect = createDirectSearch({
      routeCatalog: catalog,
      isCancelled: () => false,
      appendResult: vi.fn(),
      updateProgress: vi.fn(),
      getAvailabilityScope: () => availabilityScope
    });

    const results = await runSearch({
      origins: ["AAA"], destinations: ["BBB"], originalOrigins: ["AAA"],
      departureDates: [departureDate], returnDates: [returnDate], tripType: "return"
    }, {
      searchDirect: ({ origins, destinations, date, append, skipProgress, preferredReturnDates }) =>
        searchDirect(origins, destinations, date, append, false, skipProgress, { preferredReturnDates }),
      searchConnections: vi.fn()
    });

    expect(results).toHaveLength(1);
    expect(results[0].returnFlights.map(flight => flight.key)).toEqual(["in"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(values.get(`BBB-AAA-${returnDate}`)).toEqual([expect.objectContaining({ key: "in" })]);
  });
});
