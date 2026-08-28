import { describe, expect, it } from "vitest";
import {
  buildGraph,
  candidateHasValidFlightDates,
  findCandidateRoutes
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
