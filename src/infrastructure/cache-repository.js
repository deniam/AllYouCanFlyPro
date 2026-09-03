export const AvailabilityState = Object.freeze({
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
  UNKNOWN: "unknown"
});

const NEGATIVE_CACHE_LIFETIME_MS = 30 * 60 * 1000;

export function createFlightCache(db, lifetimeProvider, {
  negativeLifetimeMs = NEGATIVE_CACHE_LIFETIME_MS,
  lookupBatchSize = 500,
  yieldBetweenBatches = true,
  onMetric = () => {}
} = {}) {
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const reportMetric = metric => {
    try {
      onMetric(metric);
    } catch {
      // Debug instrumentation must never affect cache behavior.
    }
  };
  function lifetimeFor(results) {
    return Array.isArray(results) && results.length === 0
      ? negativeLifetimeMs
      : lifetimeProvider();
  }

  function isFresh(entry, now = Date.now()) {
    return entry
      && Array.isArray(entry.results)
      && now - entry.timestamp < lifetimeFor(entry.results);
  }

  function yieldToEventLoop() {
    return new Promise(resolve => setTimeout(resolve, 0));
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
        if (!isFresh(entry)) return null;
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
      const startedAt = clock();
      let batchCount = 0;
      try {
        const now = Date.now();
        const values = new Map();
        const batchSize = Math.max(1, Math.floor(Number(lookupBatchSize) || 500));
        for (let start = 0; start < uniqueKeys.length; start += batchSize) {
          const batchKeys = uniqueKeys.slice(start, start + batchSize);
          batchCount += 1;
          const entries = await db.cache.bulkGet(batchKeys);
          batchKeys.forEach((key, index) => {
            const entry = entries[index];
            if (!entry || !Array.isArray(entry.results)) {
              values.set(key, { state: AvailabilityState.UNKNOWN, reason: "miss" });
              return;
            }
            if (!isFresh(entry, now)) {
              values.set(key, { state: AvailabilityState.UNKNOWN, reason: "expired" });
              return;
            }
            values.set(key, entry.results.length
              ? { state: AvailabilityState.AVAILABLE, results: entry.results, source: "cache" }
              : { state: AvailabilityState.UNAVAILABLE, results: [], source: "cache", reason: "empty-response" });
          });
          if (yieldBetweenBatches && start + batchSize < uniqueKeys.length) {
            await yieldToEventLoop();
          }
        }
        reportMetric({
          stage: "cache.lookupMany",
          keyCount: uniqueKeys.length,
          batchCount,
          durationMs: clock() - startedAt
        });
        return values;
      } catch (error) {
        reportMetric({
          stage: "cache.lookupMany",
          keyCount: uniqueKeys.length,
          batchCount,
          durationMs: clock() - startedAt,
          error: true
        });
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
      const startedAt = clock();
      try {
        const threshold = Date.now() - lifetimeProvider();
        await db.cache.where("timestamp").below(threshold).delete();
        reportMetric({ stage: "cache.cleanup", durationMs: clock() - startedAt });
      } catch (error) {
        reportMetric({ stage: "cache.cleanup", durationMs: clock() - startedAt, error: true });
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
