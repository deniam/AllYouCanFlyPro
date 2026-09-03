import Dexie from "../libs/dexie.mjs";

let database;

export function createDatabase(name = "FlightSearchCache") {
  const instance = new Dexie(name);
  instance.version(1).stores({
    cache: "key, timestamp"
  });
  // Historical schema kept for Dexie upgrade ordering. Packaged route data is
  // no longer copied into IndexedDB.
  instance.version(2).stores({
    cache: "key, timestamp",
    routes: "++id, departureStation"
  });
  // The routes object store was used by versions before the route catalog was
  // kept in memory. Remove it during the next schema upgrade; cached flight
  // responses in `cache` remain untouched.
  instance.version(3).stores({
    cache: "key, timestamp",
    routes: null
  });
  return instance;
}

export function getDatabase() {
  if (database) return database;
  database = createDatabase();
  return database;
}
