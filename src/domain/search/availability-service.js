import { AvailabilityState, segmentCacheKey } from "../../infrastructure/cache-repository.js";
import { ErrorCode } from "../../infrastructure/errors.js";
import { unifyRawFlight } from "../flight-normalizer.js";

function keyFor(origin, destination, date) {
  return segmentCacheKey(origin, destination, date);
}

function normalizeOutcome(outcome, source = "network") {
  if (outcome?.state === AvailabilityState.AVAILABLE) {
    const flights = (outcome.flights ?? outcome.results ?? [])
      .map(unifyRawFlight)
      .filter(flight => flight?.departureDateUtc instanceof Date
        && !Number.isNaN(flight.departureDateUtc.getTime())
        && flight?.arrivalDateUtc instanceof Date
        && !Number.isNaN(flight.arrivalDateUtc.getTime()));
    return {
      ...outcome,
      state: AvailabilityState.AVAILABLE,
      flights
    };
  }
  if (outcome?.state === AvailabilityState.UNAVAILABLE) {
    return { ...outcome, state: AvailabilityState.UNAVAILABLE, flights: [] };
  }
  return {
    ...outcome,
    state: AvailabilityState.UNKNOWN,
    source,
    flights: [],
    reason: outcome?.reason ?? "request-error"
  };
}

/**
 * Search-scoped availability registry. It owns logical single-flight and
 * diagnostics while the supplied loader owns the transport/cache write.
 */
export function createAvailabilityService({
  cache,
  loadFlights,
  isDateAvailable = () => true,
  isRouteExcluded = () => false,
  logger = () => {}
}) {
  async function peekMany(keys) {
    if (typeof cache?.lookupMany !== "function") return new Map();
    return cache.lookupMany(keys);
  }

  function createScope({ signal, preferredReturnDates = [] } = {}) {
    const inFlight = new Map();
    const known = new Map();
    const failed = new Map();
    const cacheMisses = new Set();
    const diagnostics = {
      cacheHits: 0,
      networkRequests: 0,
      prunedBranches: 0
    };

    function throwIfCancelled() {
      if (signal?.aborted) {
        const error = signal.reason ?? new DOMException("Search cancelled", "AbortError");
        throw error;
      }
    }

    function remember(key, outcome) {
      known.set(key, outcome);
      if (outcome.state === AvailabilityState.UNKNOWN) failed.set(key, outcome);
      else failed.delete(key);
      return outcome;
    }

    function fromStatic(segment) {
      if (!segment.destination || isRouteExcluded(segment.origin, segment.destination)) {
        return { state: AvailabilityState.UNAVAILABLE, flights: [], source: "catalog", reason: "excluded-route" };
      }
      if (!isDateAvailable(segment.origin, segment.destination, segment.date)) {
        return { state: AvailabilityState.UNAVAILABLE, flights: [], source: "catalog", reason: "date-unavailable" };
      }
      return null;
    }

    async function resolve(segment) {
      throwIfCancelled();
      const key = keyFor(segment.origin, segment.destination, segment.date);
      if (known.has(key)) return known.get(key);
      if (inFlight.has(key)) return inFlight.get(key);

      const staticResult = fromStatic(segment);
      if (staticResult) {
        diagnostics.prunedBranches += 1;
        return remember(key, staticResult);
      }

      const promise = (async () => {
        throwIfCancelled();
        try {
          const outcome = await loadFlights({
            ...segment,
            preferredReturnDates,
            skipCache: cacheMisses.has(key),
            signal
          });
          const normalized = normalizeOutcome(outcome);
          if (normalized.source === "cache") diagnostics.cacheHits += 1;
          else diagnostics.networkRequests += 1;
          return remember(key, normalized);
        } catch (error) {
          if (error?.code === ErrorCode.AUTH_REQUIRED || error?.code === ErrorCode.CANCELLED
            || error?.name === "AbortError") throw error;
          logger("Availability probe failed", segment, error);
          return remember(key, {
            state: AvailabilityState.UNKNOWN,
            flights: [],
            source: "network",
            reason: error?.code === ErrorCode.RATE_LIMITED ? "rate-limit" : "request-error",
            error
          });
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, promise);
      return promise;
    }

    async function preflight(segments) {
      const unique = [...new Map(segments.map(segment => [
        keyFor(segment.origin, segment.destination, segment.date), segment
      ])).values()];
      const keys = unique.map(segment => keyFor(segment.origin, segment.destination, segment.date));
      const cached = await peekMany(keys);
      for (const segment of unique) {
        const key = keyFor(segment.origin, segment.destination, segment.date);
          const value = cached.get(key);
        if (!value || value.state === AvailabilityState.UNKNOWN) {
          if (value?.reason === "miss" || value?.reason === "expired") cacheMisses.add(key);
          continue;
        }
        remember(key, normalizeOutcome(value, "cache"));
        diagnostics.cacheHits += 1;
      }
      return known;
    }

    return Object.freeze({
      resolve,
      preflight,
      getKnown: key => known.get(key) ?? null,
      getFailed: () => [...failed.entries()].map(([key, outcome]) => ({ key, ...outcome })),
      diagnostics,
      clear: () => { inFlight.clear(); known.clear(); failed.clear(); cacheMisses.clear(); }
    });
  }

  return Object.freeze({ createScope, peekMany });
}

export { keyFor as availabilityKey };
