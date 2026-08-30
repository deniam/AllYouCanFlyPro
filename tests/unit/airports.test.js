import { describe, expect, it } from "vitest";
import {
  expandAirportCodes,
  haversineDistance,
  resolveAirport
} from "../../src/domain/airports.js";

const context = {
  airports: [
    { code: "AAA", name: "Alpha Airport (AAA)", country: "Exampleland" },
    { code: "BBB", name: "Bravo Airport (BBB)", country: "Exampleland" },
    { code: "CCC", name: "Charlie Airport (CCC)", country: "Elsewhere" }
  ],
  countries: { Exampleland: ["AAA", "BBB"], Elsewhere: ["CCC"] },
  groups: { HOM: ["AAA", "BBB"] },
  groupName: key => key === "HOM" ? "Home (Any)" : key
};

describe("airport resolution", () => {
  it.each([
    ["Anywhere", ["ANY"]],
    ["AAA", ["AAA"]],
    ["Alpha Airport (AAA)", ["AAA"]],
    ["Exampleland", ["AAA", "BBB"]],
    ["HOM", ["AAA", "BBB"]],
    ["Home (Any)", ["AAA", "BBB"]],
    ["missing", []]
  ])("resolves %s", (input, expected) => {
    expect(resolveAirport(input, context)).toEqual(expected);
  });

  it("expands and deduplicates groups", () => {
    expect(expandAirportCodes(["HOM", "AAA"], context.groups)).toEqual(["AAA", "BBB"]);
  });

  it("calculates geographic distance", () => {
    expect(haversineDistance(0, 0, 0, 1)).toBeCloseTo(111.19, 1);
  });
});
