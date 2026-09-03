import { describe, expect, it, vi } from "vitest";
import { createRouteCatalog } from "../../src/domain/route-catalog.js";
import { createDirectSearch } from "../../src/domain/search/direct.js";

function createSearch(routes, availabilityScope, options = {}) {
  return createDirectSearch({
    routeCatalog: createRouteCatalog(routes),
    isCancelled: () => false,
    appendResult: options.appendResult ?? vi.fn(),
    updateProgress: options.updateProgress ?? vi.fn(),
    getConcurrency: options.getConcurrency,
    getAvailabilityScope: () => availabilityScope,
    logger: vi.fn()
  });
}

describe("direct search", () => {
  it("filters route dates and reads availability from the search scope", async () => {
    const append = vi.fn();
    const availabilityScope = {
      preflight: vi.fn(async () => {}),
      resolve: vi.fn(async ({ destination }) => destination === "BBB"
        ? { state: "available", flights: [{ key: "cached", normalized: true }] }
        : { state: "unavailable", flights: [] })
    };
    const search = createSearch([{
      departureStation: "AAA",
      arrivalStations: [
        { id: "BBB", flightDates: ["2026-09-01"] },
        { id: "CCC", flightDates: ["2026-09-02"] }
      ]
    }], availabilityScope, { appendResult: append });

    const results = await search(["AAA"], ["ANY"], "2026-09-01");
    expect(results).toEqual([{ key: "cached", normalized: true }]);
    expect(availabilityScope.preflight).toHaveBeenCalledWith([
      { origin: "AAA", destination: "BBB", date: "2026-09-01" }
    ]);
    expect(append).toHaveBeenCalledOnce();
  });

  it("passes paired return dates to every availability probe", async () => {
    const availabilityScope = {
      preflight: vi.fn(async () => {}),
      resolve: vi.fn(async () => ({ state: "unavailable", flights: [] }))
    };
    const search = createSearch([{
      departureStation: "AAA",
      arrivalStations: [{ id: "BBB", flightDates: ["2026-09-01"] }]
    }], availabilityScope);
    const queryOptions = { preferredReturnDates: ["2026-09-02"] };

    await search(["AAA"], ["BBB"], "2026-09-01", true, false, false, queryOptions);
    expect(availabilityScope.resolve).toHaveBeenCalledWith({
      origin: "AAA",
      destination: "BBB",
      date: "2026-09-01",
      preferredReturnDates: queryOptions.preferredReturnDates
    });
  });

  it("loads independent route pairs concurrently and preserves result order", async () => {
    let active = 0;
    let maximum = 0;
    const origins = ["A1", "A2", "A3", "A4"];
    const availabilityScope = {
      preflight: vi.fn(async () => {}),
      resolve: vi.fn(async ({ origin }) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, origin === "A1" ? 10 : 1));
        active -= 1;
        return { state: "available", flights: [{ key: origin }] };
      })
    };
    const search = createSearch(origins.map(origin => ({
      departureStation: origin,
      arrivalStations: [{ id: "BBB", flightDates: ["2026-09-01"] }]
    })), availabilityScope, { getConcurrency: () => 3 });

    const results = await search(origins, ["BBB"], "2026-09-01");
    expect(maximum).toBe(3);
    expect(results.map(result => result.key)).toEqual(origins);
  });
});
