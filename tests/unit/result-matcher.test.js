import { describe, expect, it } from "vitest";
import { deduplicateFlights, matchReturnFlights } from "../../src/domain/search/result-matcher.js";

const flight = (key, from, to, departure, arrival) => ({
  key,
  departureStation: from,
  arrivalStation: to,
  route: [from, to],
  calculatedDuration: { departureDate: new Date(departure), arrivalDate: new Date(arrival) }
});

describe("result matching", () => {
  it("deduplicates stable flight keys", () => {
    expect(deduplicateFlights([{ key: "a" }, { key: "a" }, { key: "b" }]).map(item => item.key))
      .toEqual(["a", "b"]);
  });

  it("matches only reverse flights after the minimum gap", () => {
    const outbound = flight("out", "AAA", "BBB", "2026-09-01T08:00:00Z", "2026-09-01T10:00:00Z");
    const valid = flight("valid", "BBB", "AAA", "2026-09-01T17:00:00Z", "2026-09-01T19:00:00Z");
    const early = flight("early", "BBB", "AAA", "2026-09-01T12:00:00Z", "2026-09-01T14:00:00Z");
    expect(matchReturnFlights(outbound, [valid, early], {
      origins: ["AAA"], destinations: ["BBB"], minGapMinutes: 360
    }).map(item => item.key)).toEqual(["valid"]);
  });
});
