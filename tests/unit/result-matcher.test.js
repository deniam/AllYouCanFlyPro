import { describe, expect, it } from "vitest";
import { deduplicateFlights } from "../../src/domain/search/result-matcher.js";

describe("result matching", () => {
  it("deduplicates stable flight keys", () => {
    expect(deduplicateFlights([{ key: "a" }, { key: "a" }, { key: "b" }]).map(item => item.key))
      .toEqual(["a", "b"]);
  });
});
