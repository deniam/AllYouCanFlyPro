import { describe, expect, it } from "vitest";
import { combineOneStopFlights } from "../../src/domain/search/connections.js";

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
});
