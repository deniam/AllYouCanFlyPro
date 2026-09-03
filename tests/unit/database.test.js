import { describe, expect, it } from "vitest";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import Dexie from "../../src/libs/dexie.mjs";
import { createDatabase } from "../../src/infrastructure/database.js";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

describe("IndexedDB schema migration", () => {
  it("removes only the legacy routes table when upgrading v2 to v3", async () => {
    const name = `FlightSearchCacheMigration-${Date.now()}-${Math.random()}`;
    const legacy = new Dexie(name);
    legacy.version(2).stores({
      cache: "key, timestamp",
      routes: "++id, departureStation"
    });
    await legacy.open();
    await legacy.routes.add({ departureStation: "AAA", arrivalStations: [{ id: "BBB" }] });
    const cached = { key: "AAA-BBB-2026-09-01", timestamp: Date.now(), results: [] };
    await legacy.cache.put(cached);
    legacy.close();

    const upgraded = createDatabase(name);
    await upgraded.open();
    expect(upgraded.tables.map(table => table.name)).toEqual(["cache"]);
    await expect(upgraded.cache.get(cached.key)).resolves.toEqual(cached);
    upgraded.close();
    await Dexie.delete(name);
  });
});
