import { describe, expect, it, vi } from "vitest";
import { createDirectSearch } from "../../src/domain/search/direct.js";

describe("direct search", () => {
  it("filters route dates and uses the flight cache", async () => {
    const fetchFlights = vi.fn(async () => [{ key: "fresh" }]);
    const append = vi.fn();
    const search = createDirectSearch({
      fetchRoutes: async () => [{
        departureStation: "AAA",
        arrivalStations: [
          { id: "BBB", flightDates: ["2026-09-01"] },
          { id: "CCC", flightDates: ["2026-09-02"] }
        ]
      }],
      getPreviousResults: () => [],
      isCancelled: () => false,
      getCached: async (_origin, destination) => destination === "BBB" ? [{ key: "cached" }] : null,
      setCached: vi.fn(),
      fetchFlights,
      normalizeFlight: flight => ({ ...flight, normalized: true }),
      appendResult: append,
      updateProgress: vi.fn()
    });

    const results = await search(["AAA"], ["ANY"], "2026-09-01");
    expect(results).toEqual([{ key: "cached", normalized: true }]);
    expect(fetchFlights).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledOnce();
  });
});
