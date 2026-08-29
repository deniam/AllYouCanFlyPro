import { describe, expect, it, vi } from "vitest";
import { createRouteCatalog } from "../../src/domain/route-catalog.js";
import { createPairedDateSelector } from "../../src/domain/search/paired-date-selector.js";

function selector({ reverseDates = [], cachedKeys = [] } = {}) {
  const catalog = createRouteCatalog([{
    departureStation: "BBB",
    arrivalStations: [{ id: "AAA", flightDates: reverseDates }]
  }]);
  const cached = new Set(cachedKeys);
  const getCached = vi.fn(async (origin, destination, date) =>
    cached.has(`${origin}-${destination}-${date}`) ? [] : null
  );
  return {
    getCached,
    select: createPairedDateSelector({
      routeCatalog: catalog,
      getCached,
      now: () => new Date("2026-08-29T12:00:00Z")
    })
  };
}

describe("paired arrival date selector", () => {
  it("prefers an explicit valid same-day return", async () => {
    const { select } = selector({ reverseDates: ["2026-08-30", "2026-08-31"] });
    await expect(select({
      origin: "AAA", destination: "BBB", departureDate: "2026-08-30",
      preferredReturnDates: ["2026-08-30"]
    })).resolves.toBe("2026-08-30");
  });

  it("skips cached preferred dates and warms the next selected date", async () => {
    const { select } = selector({
      reverseDates: ["2026-08-30", "2026-08-31", "2026-09-01"],
      cachedKeys: ["BBB-AAA-2026-08-30"]
    });
    await expect(select({
      origin: "AAA", destination: "BBB", departureDate: "2026-08-30",
      preferredReturnDates: ["2026-08-30", "2026-08-31"]
    })).resolves.toBe("2026-08-31");
  });

  it("uses the nearest later reverse date for one-way warm-up", async () => {
    const { select } = selector({ reverseDates: ["2026-08-30", "2026-09-01"] });
    await expect(select({
      origin: "AAA", destination: "BBB", departureDate: "2026-08-30"
    })).resolves.toBe("2026-09-01");
  });

  it("allows same-day warm-up only at the booking horizon boundary", async () => {
    const { select } = selector({ reverseDates: ["2026-09-01"] });
    await expect(select({
      origin: "AAA", destination: "BBB", departureDate: "2026-09-01"
    })).resolves.toBe("2026-09-01");
  });

  it("returns an empty arrival when no reverse date is valid", async () => {
    const { select } = selector({ reverseDates: ["2026-09-02"] });
    await expect(select({
      origin: "AAA", destination: "BBB", departureDate: "2026-08-30",
      preferredReturnDates: ["2026-08-31"]
    })).resolves.toBe("");
  });
});
