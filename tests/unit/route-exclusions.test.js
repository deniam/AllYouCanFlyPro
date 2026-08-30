import { describe, expect, it } from "vitest";
import {
  createRouteExclusionsRepository,
  routeExclusionKey,
  routeExclusionsStorageKey
} from "../../src/infrastructure/route-exclusions.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

describe("route exclusions", () => {
  it("normalizes route keys", () => {
    expect(routeExclusionKey(" cdt ", "ltn")).toBe("CDT-LTN");
  });

  it("persists and reloads excluded routes", () => {
    const storage = memoryStorage();
    const repository = createRouteExclusionsRepository(storage);

    expect(repository.add("cdt", "ltn")).toBe(true);
    expect(repository.add("CDT", "LTN")).toBe(false);
    expect(repository.has("CDT", "LTN")).toBe(true);
    expect(JSON.parse(storage.getItem(routeExclusionsStorageKey))).toEqual(["CDT-LTN"]);
    expect(createRouteExclusionsRepository(storage).load()).toEqual(["CDT-LTN"]);
  });

  it("ignores malformed stored values", () => {
    const repository = createRouteExclusionsRepository(memoryStorage({
      [routeExclusionsStorageKey]: JSON.stringify(["CDT-LTN", "not-a-route", 15])
    }));

    expect(repository.load()).toEqual(["CDT-LTN"]);
  });
});
