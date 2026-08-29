import { describe, expect, it, vi } from "vitest";
import { runSearch } from "../../src/domain/search/orchestrator.js";

const flight = (key, from, to, departure, arrival) => ({
  key,
  route: [from, to],
  departureStation: from,
  arrivalStation: to,
  calculatedDuration: { departureDate: new Date(departure), arrivalDate: new Date(arrival) }
});

describe("search orchestrator", () => {
  it("runs each one-way departure date", async () => {
    const searchDirect = vi.fn(async ({ date }) => [flight(date, "AAA", "BBB", `${date}T08:00:00Z`, `${date}T10:00:00Z`)]);
    const results = await runSearch({
      origins: ["AAA"], destinations: ["BBB"],
      departureDates: ["2026-09-01", "2026-09-02"]
    }, { searchDirect, searchConnections: vi.fn() });
    expect(results).toHaveLength(2);
    expect(searchDirect).toHaveBeenCalledTimes(2);
  });

  it("matches a round-trip after the minimum gap", async () => {
    const searchDirect = vi.fn(async ({ origins }) => origins[0] === "AAA"
      ? [flight("out", "AAA", "BBB", "2026-09-01T08:00:00Z", "2026-09-01T10:00:00Z")]
      : [flight("in", "BBB", "AAA", "2026-09-02T08:00:00Z", "2026-09-02T10:00:00Z")]);
    const results = await runSearch({
      origins: ["AAA"], destinations: ["BBB"], originalOrigins: ["AAA"],
      departureDates: ["2026-09-01"], returnDates: ["2026-09-02"], tripType: "return"
    }, { searchDirect, searchConnections: vi.fn() });
    expect(results).toHaveLength(1);
    expect(results[0].returnFlights.map(item => item.key)).toEqual(["in"]);
    expect(searchDirect.mock.calls[0][0].preferredReturnDates).toEqual(["2026-09-02"]);
    expect(searchDirect.mock.calls[1][0].preferredReturnDates).toBeUndefined();
  });

  it("keeps every selected return date in the inbound search", async () => {
    const searchDirect = vi.fn(async ({ origins, date }) => origins[0] === "AAA"
      ? [flight("out", "AAA", "BBB", "2026-09-01T08:00:00Z", "2026-09-01T10:00:00Z")]
      : [flight(date, "BBB", "AAA", `${date}T08:00:00Z`, `${date}T10:00:00Z`)]);
    const results = await runSearch({
      origins: ["AAA"], destinations: ["BBB"], originalOrigins: ["AAA"],
      departureDates: ["2026-09-01"],
      returnDates: ["2026-09-02", "2026-09-03"],
      tripType: "return"
    }, { searchDirect, searchConnections: vi.fn() });

    expect(results[0].returnFlights.map(item => item.key)).toEqual(["2026-09-02", "2026-09-03"]);
    expect(searchDirect).toHaveBeenCalledTimes(3);
  });

  it("searches inbound after a connecting outbound route is found", async () => {
    const searchConnections = vi.fn(async ({ origins }) => origins[0] === "AAA"
      ? [flight("connected-out", "AAA", "CCC", "2026-09-01T08:00:00Z", "2026-09-01T14:00:00Z")]
      : [flight("direct-in", "CCC", "AAA", "2026-09-02T08:00:00Z", "2026-09-02T10:00:00Z")]);
    const results = await runSearch({
      origins: ["AAA"], destinations: ["CCC"], originalOrigins: ["AAA"],
      departureDates: ["2026-09-01"], returnDates: ["2026-09-02"],
      tripType: "return", maxTransfers: 1
    }, { searchDirect: vi.fn(), searchConnections });

    expect(results).toHaveLength(1);
    expect(results[0].returnFlights.map(item => item.key)).toEqual(["direct-in"]);
    expect(searchConnections).toHaveBeenCalledTimes(2);
  });
});
