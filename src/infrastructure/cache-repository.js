export function createFlightCache(db, lifetimeProvider) {
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
