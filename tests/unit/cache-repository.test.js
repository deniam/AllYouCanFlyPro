import { describe, expect, it, vi } from "vitest";
import { createFlightCache } from "../../src/infrastructure/cache-repository.js";

function database(entry) {
  return {
    cache: {
      get: vi.fn(async () => entry),
      bulkGet: vi.fn(async keys => keys.map(() => entry)),
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
    { timestamp: Date.now() - 31 * 60_000, results: [] }
  ])("treats missing, corrupt and expired entries as misses", async entry => {
    const cache = createFlightCache(database(entry), () => 60_000);
    await expect(cache.get("key")).resolves.toBeNull();
  });

  it("uses the same 30-minute negative TTL for get and lookup", async () => {
    const databaseWithEmpty = database({ timestamp: Date.now() - 60_000, results: [] });
    const cache = createFlightCache(databaseWithEmpty, () => 4 * 60 * 60 * 1000);
    await expect(cache.get("key")).resolves.toEqual([]);
    await expect(cache.lookup("key")).resolves.toMatchObject({ state: "unavailable", results: [] });
  });

  it("batches lookupMany without changing its Map result", async () => {
    const db = database({ timestamp: Date.now(), results: [{ id: 1 }] });
    const cache = createFlightCache(db, () => 60_000, {
      lookupBatchSize: 500,
      yieldBetweenBatches: false
    });
    const keys = Array.from({ length: 3_000 }, (_, index) => `key-${index}`);
    const result = await cache.lookupMany([...keys, keys[0]]);

    expect(db.cache.bulkGet).toHaveBeenCalledTimes(6);
    expect(db.cache.bulkGet.mock.calls.map(([batch]) => batch.length)).toEqual([
      500, 500, 500, 500, 500, 500
    ]);
    expect(result.size).toBe(3_000);
    expect(result.get("key-2999")).toMatchObject({ state: "available" });
  });
});
