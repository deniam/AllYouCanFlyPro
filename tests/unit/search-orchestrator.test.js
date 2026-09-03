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

  it("keeps distinct layovers that share endpoints and departure time", async () => {
    const viaFirst = flight(
      "first | via-one", "AAA", "DDD", "2026-09-01T08:00:00Z", "2026-09-01T14:00:00Z"
    );
    const viaSecond = flight(
      "first | via-two", "AAA", "DDD", "2026-09-01T08:00:00Z", "2026-09-01T15:00:00Z"
    );
    const searchConnections = vi.fn(async () => [viaFirst, viaSecond, viaFirst]);

    const results = await runSearch({
      origins: ["AAA"], destinations: ["DDD"],
      departureDates: ["2026-09-01"], maxTransfers: 1
    }, { searchDirect: vi.fn(), searchConnections });

    expect(results.map(result => result.key)).toEqual(["first | via-one", "first | via-two"]);
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

  it("loads independent inbound dates concurrently", async () => {
    let active = 0;
    let maximum = 0;
    const returnDates = ["2026-09-02", "2026-09-03", "2026-09-04"];
    const searchDirect = vi.fn(async ({ origins, date }) => {
      if (origins[0] === "AAA") {
        return [flight("out", "AAA", "BBB", "2026-09-01T08:00:00Z", "2026-09-01T10:00:00Z")];
      }
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, date === returnDates[0] ? 10 : 1));
      active -= 1;
      return [flight(date, "BBB", "AAA", `${date}T08:00:00Z`, `${date}T10:00:00Z`)];
    });

    const results = await runSearch({
      origins: ["AAA"], destinations: ["BBB"], originalOrigins: ["AAA"],
      departureDates: ["2026-09-01"], returnDates, tripType: "return",
      maxConcurrentRequests: 3
    }, { searchDirect, searchConnections: vi.fn() });

    expect(maximum).toBe(3);
    expect(results[0].returnFlights.map(item => item.key)).toEqual(returnDates);
  });

  it("emits valid round trips as inbound responses complete", async () => {
    const returnDates = ["2026-09-02", "2026-09-03"];
    const events = [];
    let searchResolved = false;
    let firstEvent;
    const firstEventReady = new Promise(resolve => {
      firstEvent = resolve;
    });
    const searchDirect = vi.fn(async ({ origins, date }) => {
      if (origins[0] === "AAA") {
        return [flight("out", "AAA", "BBB", "2026-09-01T08:00:00Z", "2026-09-01T10:00:00Z")];
      }
      if (date === returnDates[0]) await new Promise(resolve => setTimeout(resolve, 20));
      return [flight(date, "BBB", "AAA", `${date}T08:00:00Z`, `${date}T10:00:00Z`)];
    });

    const search = runSearch({
      origins: ["AAA"], destinations: ["BBB"], originalOrigins: ["AAA"],
      departureDates: ["2026-09-01"], returnDates, tripType: "return",
      maxConcurrentRequests: 2
    }, {
      searchDirect,
      searchConnections: vi.fn(),
      onRoundTripResult: (result, index, metadata) => {
        events.push({ result, index, metadata });
        firstEvent();
      }
    }).then(result => {
      searchResolved = true;
      return result;
    });

    await firstEventReady;
    expect(searchResolved).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].index).toBe(0);
    expect(events[0].metadata.isUpdate).toBe(false);
    expect(events[0].result.returnFlights.map(item => item.key)).toEqual([returnDates[1]]);

    const results = await search;
    expect(events).toHaveLength(2);
    expect(events[1].metadata.isUpdate).toBe(true);
    expect(results[0].returnFlights.map(item => item.key)).toEqual(returnDates);
  });

  it("does not emit late round-trip results after cancellation", async () => {
    const controller = new AbortController();
    let callbackCount = 0;
    const searchDirect = vi.fn(async ({ origins, date }) => origins[0] === "AAA"
      ? [flight("out", "AAA", "BBB", "2026-09-01T08:00:00Z", "2026-09-01T10:00:00Z")]
      : [flight(date, "BBB", "AAA", `${date}T08:00:00Z`, `${date}T10:00:00Z`)]);

    await expect(runSearch({
      origins: ["AAA"], destinations: ["BBB"], originalOrigins: ["AAA"],
      departureDates: ["2026-09-01"],
      returnDates: ["2026-09-02", "2026-09-03"],
      tripType: "return"
    }, {
      searchDirect,
      searchConnections: vi.fn(),
      onRoundTripResult: () => {
        callbackCount += 1;
        controller.abort();
      }
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    expect(callbackCount).toBe(1);
  });
});
