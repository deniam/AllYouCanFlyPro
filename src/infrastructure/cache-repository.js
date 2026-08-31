export const AvailabilityState = Object.freeze({
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
  UNKNOWN: "unknown"
});

const NEGATIVE_CACHE_LIFETIME_MS = 30 * 60 * 1000;

export function createFlightCache(db, lifetimeProvider, {
  negativeLifetimeMs = NEGATIVE_CACHE_LIFETIME_MS
} = {}) {
  function lifetimeFor(results) {
    return Array.isArray(results) && results.length === 0
      ? negativeLifetimeMs
      : lifetimeProvider();
  }

  async function readEntry(key, now = Date.now()) {
    try {
      const entry = await db.cache.get(key);
      if (!entry || !Array.isArray(entry.results)) {
        return { state: AvailabilityState.UNKNOWN, reason: "miss" };
      }
      if (now - entry.timestamp >= lifetimeFor(entry.results)) {
        return { state: AvailabilityState.UNKNOWN, reason: "expired" };
      }
      return entry.results.length
        ? { state: AvailabilityState.AVAILABLE, results: entry.results, source: "cache" }
        : { state: AvailabilityState.UNAVAILABLE, results: [], source: "cache", reason: "empty-response" };
    } catch (error) {
      console.error("Error retrieving cached flight results:", error);
      return { state: AvailabilityState.UNKNOWN, reason: "cache-error", error };
    }
  }

  return Object.freeze({
    async get(key) {
      try {
        const entry = await db.cache.get(key);
        if (!entry || !Array.isArray(entry.results)) return null;
        if (Date.now() - entry.timestamp >= lifetimeProvider()) return null;
        return entry.results;
      } catch (error) {
        console.error("Error retrieving cached flight results:", error);
        return null;
      }
    },
    async lookup(key) {
      return readEntry(key);
    },
    async lookupMany(keys) {
      const uniqueKeys = [...new Set(keys)];
      if (!uniqueKeys.length) return new Map();
      try {
        const entries = await db.cache.bulkGet(uniqueKeys);
        const now = Date.now();
        return new Map(uniqueKeys.map((key, index) => {
          const entry = entries[index];
          if (!entry || !Array.isArray(entry.results)) {
            return [key, { state: AvailabilityState.UNKNOWN, reason: "miss" }];
          }
          if (now - entry.timestamp >= lifetimeFor(entry.results)) {
            return [key, { state: AvailabilityState.UNKNOWN, reason: "expired" }];
          }
          return [key, entry.results.length
            ? { state: AvailabilityState.AVAILABLE, results: entry.results, source: "cache" }
            : { state: AvailabilityState.UNAVAILABLE, results: [], source: "cache", reason: "empty-response" }];
        }));
      } catch (error) {
        console.error("Error retrieving cached flight results:", error);
        return new Map(uniqueKeys.map(key => [key, {
          state: AvailabilityState.UNKNOWN,
          reason: "cache-error",
          error
        }]));
      }
    },
    async put(key, results) {
      try {
        await db.cache.put({ key, results, timestamp: Date.now() });
      } catch (error) {
        console.error("Error caching flight results:", error);
      }
    },
    async cleanup() {
      try {
        const threshold = Date.now() - lifetimeProvider();
        await db.cache.where("timestamp").below(threshold).delete();
      } catch (error) {
        console.error("Error cleaning flight cache:", error);
      }
    },
    async clear() {
      await db.cache.clear();
    }
  });
}

export function segmentCacheKey(origin, destination, date) {
  return `${origin}-${destination}-${date}`;
}
