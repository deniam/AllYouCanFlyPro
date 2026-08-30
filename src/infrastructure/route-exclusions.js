const STORAGE_KEY = "excludedRoutes";
const ROUTE_KEY_PATTERN = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/;

export function routeExclusionKey(origin, destination) {
  const normalizedOrigin = String(origin ?? "").trim().toUpperCase();
  const normalizedDestination = String(destination ?? "").trim().toUpperCase();
  if (!normalizedOrigin || !normalizedDestination) return null;
  return `${normalizedOrigin}-${normalizedDestination}`;
}

function readKeys(storage) {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || "[]");
    return new Set(
      Array.isArray(value)
        ? value.filter(key => typeof key === "string" && ROUTE_KEY_PATTERN.test(key.toUpperCase()))
          .map(key => key.toUpperCase())
        : []
    );
  } catch {
    return new Set();
  }
}

export function createRouteExclusionsRepository(storage = localStorage) {
  const excluded = readKeys(storage);

  function persist() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify([...excluded].sort()));
    } catch {
      // The in-memory exclusion remains active for the current session even
      // when browser storage is unavailable or full.
    }
  }

  return Object.freeze({
    load() {
      return [...excluded];
    },
    has(origin, destination) {
      const key = routeExclusionKey(origin, destination);
      return key ? excluded.has(key) : false;
    },
    add(origin, destination) {
      const key = routeExclusionKey(origin, destination);
      if (!key || excluded.has(key)) return false;
      excluded.add(key);
      persist();
      return true;
    }
  });
}

export const routeExclusionsStorageKey = STORAGE_KEY;
