import { describe, expect, it } from "vitest";
import {
  buildGraph,
  buildGroundTransferGraph,
  candidateHasValidFlightDates,
  findCandidateRoutes,
  findReachableOrigins
} from "../../src/domain/search/candidate-builder.js";
import { routesFixture } from "../fixtures/routes.js";

describe("candidate builder", () => {
  const graph = buildGraph(routesFixture);

  it("finds only direct routes with zero transfers", () => {
    expect(findCandidateRoutes(graph, ["AAA"], ["DDD"], 0)).toEqual([["AAA", "DDD"]]);
  });

  it("finds one-stop routes while preventing cycles", () => {
    expect(findCandidateRoutes(graph, ["AAA"], ["CCC"], 1)).toEqual([
      ["AAA", "BBB", "CCC"]
    ]);
  });

  it("keeps deterministic origin order", () => {
    expect(findCandidateRoutes(graph, ["BBB", "AAA"], ["CCC"], 1)[0])
      .toEqual(["BBB", "CCC"]);
  });

  it("resolves ANY origins through one- and two-transfer reverse paths", () => {
    const routeGraph = new Map([
      ["DIRECT", ["DEST"]],
      ["ONE", ["DIRECT"]],
      ["TWO", ["ONE"]],
      ["TOO_FAR", ["TWO"]],
      ["UNRELATED", ["OTHER"]]
    ]);

    expect(findReachableOrigins(routeGraph, ["DEST"], 1))
      .toEqual(["DIRECT", "ONE"]);
    expect(findReachableOrigins(routeGraph, ["DEST"], 2))
      .toEqual(["DIRECT", "ONE", "TWO"]);
  });

  it("treats a nearby-airport change as a zero-segment edge between flights", () => {
    const flightGraph = new Map([
      ["TLV", ["FCO"]],
      ["CIA", ["LTN"]]
    ]);
    const groundGraph = buildGroundTransferGraph(flightGraph, {
      FCO: { latitude: 41.8, longitude: 12.25 },
      CIA: { latitude: 41.8, longitude: 12.6 }
    }, 100);

    expect(findReachableOrigins(flightGraph, ["LTN"], 1, { groundGraph }))
      .toEqual(["TLV", "CIA"]);
  });

  it("filters graph edges by flightDates and operationStartDate", () => {
    const routes = [
      {
        departureStation: "AAA",
        arrivalStations: [{ id: "DEST", flightDates: ["2026-09-01"] }]
      },
      {
        departureStation: "BBB",
        arrivalStations: [{ id: "DEST", flightDates: ["2026-09-02"] }]
      },
      {
        departureStation: "CCC",
        arrivalStations: [{
          id: "DEST",
          operationStartDate: "2026-09-02",
          flightDates: ["2026-09-01", "2026-09-02"]
        }]
      }
    ];

    expect([...buildGraph(routes, ["2026-09-01"]).keys()]).toEqual(["AAA"]);
    expect([...buildGraph(routes, ["2026-09-02"]).keys()]).toEqual(["BBB", "CCC"]);
  });

  it("filters candidate dates against operationStartDate", () => {
    const routes = [{
      departureStation: "AAA",
      arrivalStations: [{ id: "BBB", operationStartDate: "2026-09-02", flightDates: ["2026-09-01", "2026-09-02"] }]
    }];
    expect(candidateHasValidFlightDates(
      ["AAA", "BBB"], routes, "2026-09-01", new Date("2026-09-01T00:00:00Z"), [0]
    )).toBe(false);
  });
});
