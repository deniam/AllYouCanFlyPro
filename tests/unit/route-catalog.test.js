import { describe, expect, it } from "vitest";
import { createRouteCatalog } from "../../src/domain/route-catalog.js";
import { routesFixture } from "../fixtures/routes.js";

describe("route catalog", () => {
  const catalog = createRouteCatalog(routesFixture);

  it("indexes both directions needed by suggestions", () => {
    expect(catalog.getDestinations("AAA")).toEqual(["BBB", "DDD"]);
    expect(catalog.getOrigins("CCC")).toEqual(["BBB"]);
    expect(catalog.getRoute("AAA", "BBB")).toBe(routesFixture[0]);
  });

  it("honours explicit flight dates", () => {
    expect(catalog.isDateAvailable("AAA", "BBB", "2026-08-28")).toBe(true);
    expect(catalog.isDateAvailable("AAA", "BBB", "2026-08-30")).toBe(false);
    expect(catalog.getFlightDates("AAA", "BBB")).toEqual(["2026-08-28", "2026-08-29"]);
  });

  it("treats a missing flightDates property as unrestricted", () => {
    expect(catalog.isDateAvailable("CCC", "AAA", "2030-01-01")).toBe(true);
  });

  it("honours operationStartDate and an explicitly empty schedule", () => {
    const dated = createRouteCatalog([{
      departureStation: "AAA",
      arrivalStations: [
        { id: "BBB", operationStartDate: "2026-09-10", flightDates: ["2026-09-10"] },
        { id: "CCC", flightDates: [] }
      ]
    }]);
    expect(dated.isDateAvailable("AAA", "BBB", "2026-09-09")).toBe(false);
    expect(dated.isDateAvailable("AAA", "BBB", "2026-09-10")).toBe(true);
    expect(dated.isDateAvailable("AAA", "CCC", "2026-09-10")).toBe(false);
  });

  it("removes excluded routes from active catalog views", () => {
    const excluded = createRouteCatalog(routesFixture, { excludedRoutes: ["aaa-bbb"] });

    expect(excluded.getRoute("AAA", "BBB")).toBeNull();
    expect(excluded.getDestinations("AAA")).toEqual(["DDD"]);
    expect(excluded.getOrigins("BBB")).toEqual([]);
    expect(excluded.getActiveRoutes()[0].arrivalStations.map(station => station.id)).toEqual(["DDD"]);
    expect(excluded.isDateAvailable("AAA", "BBB", "2026-08-28")).toBe(false);
  });

  it("can exclude a route after the catalog is created", () => {
    const dynamic = createRouteCatalog(routesFixture);

    expect(dynamic.excludeRoute("AAA", "BBB")).toBe(true);
    expect(dynamic.excludeRoute("AAA", "BBB")).toBe(false);
    expect(dynamic.getDestinations("AAA")).toEqual(["DDD"]);
  });
});
