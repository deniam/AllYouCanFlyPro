import { describe, expect, it } from "vitest";
import {
  formatOffsetForDisplay,
  normalizeFlightOffset,
  unifyRawFlight
} from "../../src/domain/flight-normalizer.js";

describe("flight normalizer", () => {
  it("supports half-hour station offsets", () => {
    expect(normalizeFlightOffset("UTC+5:30")).toBe("+05:30");
    expect(formatOffsetForDisplay("+05:30")).toBe("UTC+5:30");
  });

  it("normalizes an overnight flight", () => {
    const flight = unifyRawFlight({
      key: "key",
      departure: "11:30 pm",
      arrival: "1:15 am",
      departureDateIso: "2026-08-28",
      arrivalDateIso: "2026-08-28",
      departureDate: "28 August 2026",
      arrivalDate: "28 August 2026",
      departureOffsetText: "UTC+2",
      arrivalOffsetText: "UTC+2",
      departureStationText: "Alpha",
      arrivalStationText: "Bravo"
    });
    expect(flight.displayDeparture).toBe("23:30");
    expect(flight.calculatedDuration.totalMinutes).toBe(105);
    expect(flight.calculatedDuration.arrivalDate.getUTCDate()).toBe(29);
  });
});
