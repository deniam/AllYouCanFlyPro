import Dexie from "../libs/dexie.mjs";

let database;

export function getDatabase() {
  if (database) return database;
  database = new Dexie("FlightSearchCache");
  database.version(1).stores({
    cache: "key, timestamp"
  });
  // Keep the legacy routes table in the schema so upgrading never deletes it.
  // Packaged route data is no longer copied into this table on startup.
  database.version(2).stores({
    cache: "key, timestamp",
    routes: "++id, departureStation"
  });
  return database;
}
