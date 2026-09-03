import { describe, expect, it, vi } from "vitest";
import { createConnectionsSearch } from "../../src/domain/search/connections.js";
import { createRouteCatalog } from "../../src/domain/route-catalog.js";

function flight(key, from, to, departure, arrival) {
  return {
    key,
    departureStation: from,
    arrivalStation: to,
    departureStationText: from,
    arrivalStationText: to,
    departureDateIso: departure.slice(0, 10),
    calculatedDuration: {
      departureDate: new Date(departure),
      arrivalDate: new Date(arrival)
    }
  };
}

function setup() {
  const date = "2026-09-01";
  const routes = [
    { departureStation: "AAA", arrivalStations: [{ id: "BBB", flightDates: [date] }] },
    { departureStation: "BBB", arrivalStations: [{ id: "CCC", flightDates: [date] }] }
  ];
  const flights = new Map([
    ["AAA-BBB", flight("first", "AAA", "BBB", `${date}T08:00:00Z`, `${date}T10:00:00Z`)],
    ["BBB-CCC", flight("second", "BBB", "CCC", `${date}T12:00:00Z`, `${date}T14:00:00Z`)]
  ]);
  const availabilityScope = {
    diagnostics: { prunedBranches: 0 },
    preflight: vi.fn(async () => {}),
    getKnown: () => null,
    schedule: vi.fn(async ({ origin, destination }) => ({
      state: "available",
      flights: [flights.get(`${origin}-${destination}`)].filter(Boolean)
    }))
  };
  const catalog = createRouteCatalog(routes);
  const appendRouteToDisplay = vi.fn();
  const search = createConnectionsSearch({
    routeCatalog: catalog,
    availabilityScope,
    airportLookup: {},
    appendRouteToDisplay,
    isCancelled: () => false,
    updateProgress: vi.fn(),
    debugLogger: vi.fn()
  });
  return { date, availabilityScope, appendRouteToDisplay, search };
}

describe("connection search adapter", () => {
  it("delegates to the planner and preserves the positional API", async () => {
    const { date, availabilityScope, appendRouteToDisplay, search } = setup();

    const results = await search(
      ["AAA"],
      ["CCC"],
      date,
      1,
      true,
      true,
      { minConnection: 90, maxConnection: 300 }
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ key: "first | second", stops: "1 transfer" });
    expect(availabilityScope.preflight).toHaveBeenCalled();
    expect(appendRouteToDisplay).toHaveBeenCalledWith(results[0]);
  });

  it("fails clearly when a search is started without an availability scope", async () => {
    const { date } = setup();
    const search = createConnectionsSearch({
      routeCatalog: createRouteCatalog([])
    });

    await expect(search(["AAA"], ["BBB"], date, 1)).rejects.toThrow(
      "Connection search requires an availability scope"
    );
  });
});
