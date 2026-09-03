import { describe, expect, it } from "vitest";
import {
  collectResultRefreshKeys,
  oldestCheckedAt,
  shouldSkipStageProgress
} from "../../src/domain/search/refresh.js";

function flight(origin, destination, date) {
  return {
    departureStationCode: origin,
    arrivalStationCode: destination,
    departureDateIso: date
  };
}

describe("route refresh helpers", () => {
  it("collects one canonical key for a direct result", () => {
    expect([...collectResultRefreshKeys(flight("AAA", "BBB", "2026-09-01"))])
      .toEqual(["AAA-BBB-2026-09-01"]);
  });

  it("collects and deduplicates every connection and round-trip segment", () => {
    const outboundFirst = flight("AAA", "BBB", "2026-09-01");
    const outboundSecond = flight("BBB", "CCC", "2026-09-02");
    const inbound = flight("CCC", "AAA", "2026-09-05");
    const result = {
      segments: [outboundFirst, outboundSecond],
      returnFlights: [inbound, { segments: [inbound] }]
    };

    expect([...collectResultRefreshKeys(result, { includeReturns: true })]).toEqual([
      "AAA-BBB-2026-09-01",
      "BBB-CCC-2026-09-02",
      "CCC-AAA-2026-09-05"
    ]);
  });

  it("uses the oldest valid check time for a grouped refresh", () => {
    const keys = new Set(["one", "two", "missing"]);
    const outcomes = new Map([
      ["one", { checkedAt: 5000 }],
      ["two", { checkedAt: 3000 }]
    ]);
    expect(oldestCheckedAt(keys, outcomes)).toBe(3000);
  });

  it("always suppresses global stage progress for a non-streaming route refresh", () => {
    expect(shouldSkipStageProgress(false, false)).toBe(true);
    expect(shouldSkipStageProgress(false, true)).toBe(true);
    expect(shouldSkipStageProgress(true, false)).toBe(false);
    expect(shouldSkipStageProgress(true, true)).toBe(true);
  });
});
