import { describe, expect, it, vi } from "vitest";
import { createFlightCache } from "../../src/infrastructure/cache-repository.js";

function database(entry) {
  return {
    cache: {
      get: vi.fn(async () => entry),
      put: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      where: vi.fn(() => ({ below: () => ({ delete: vi.fn(async () => {}) }) }))
    }
  };
}

describe("flight cache", () => {
  it("returns a valid entry and preserves Date values supplied by IndexedDB", async () => {
    const date = new Date("2026-09-01T10:00:00Z");
    const db = database({ timestamp: Date.now(), results: [{ departureDateUtc: date }] });
    const cache = createFlightCache(db, () => 60_000);
    const result = await cache.get("AAA-BBB-2026-09-01");
    expect(result[0].departureDateUtc).toBe(date);
  });

  it.each([
    null,
    { timestamp: Date.now(), results: "corrupt" },
    { timestamp: Date.now() - 120_000, results: [] }
  ])("treats missing, corrupt and expired entries as misses", async entry => {
    const cache = createFlightCache(database(entry), () => 60_000);
    await expect(cache.get("key")).resolves.toBeNull();
  });

  it("exposes tri-state lookup and gives empty responses a shorter TTL", async () => {
    const databaseWithEmpty = database({ timestamp: Date.now() - 60_000, results: [] });
    const cache = createFlightCache(databaseWithEmpty, () => 4 * 60 * 60 * 1000);
    await expect(cache.lookup("key")).resolves.toMatchObject({ state: "unavailable", results: [] });
  });
});
