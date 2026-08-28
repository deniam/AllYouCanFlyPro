import { describe, expect, it } from "vitest";
import {
  addDaysUTC,
  minutesBetween,
  normalizeOffset,
  offsetToIso,
  parseFlightDateTime,
  parseLocalDate
} from "../../src/domain/dates.js";

describe("date helpers", () => {
  it("adds UTC calendar days across month boundaries", () => {
    expect(addDaysUTC(new Date("2026-08-31T00:00:00Z"), 1).toISOString())
      .toBe("2026-09-01T00:00:00.000Z");
  });

  it("normalizes offsets", () => {
    expect(normalizeOffset("+02:30")).toBe("UTC+2:30");
    expect(offsetToIso("UTC-3")).toBe("-03:00");
  });

  it("parses an API datetime with its station offset", () => {
    expect(parseFlightDateTime("2026-08-28 10:00:00", "UTC+2").toISOString())
      .toBe("2026-08-28T08:00:00.000Z");
  });

  it("uses local components for calendar dates", () => {
    const date = parseLocalDate("2026-08-28");
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 7, 28]);
  });

  it("calculates connection minutes", () => {
    expect(minutesBetween(new Date("2026-08-28T10:00Z"), new Date("2026-08-28T11:45Z")))
      .toBe(105);
  });
});
