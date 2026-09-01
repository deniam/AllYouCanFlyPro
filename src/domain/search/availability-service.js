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
  logger = () => {},
  getEffectiveConcurrency = () => Number.POSITIVE_INFINITY,
  subscribeConcurrency = () => () => {}
}) {
  async function peekMany(keys) {
    if (!keys.length || typeof cache?.lookupMany !== "function") return new Map();
    return cache.lookupMany(keys);
  }

  function createScope({
    signal,
    preferredReturnDates = [],
    maxConcurrentRequests = Number.POSITIVE_INFINITY
  } = {}) {
    const inFlight = new Map();
    const known = new Map();
    const failed = new Map();
    const cacheMisses = new Set();
    const preflightedKeys = new Set();
    const plannedKeys = new Set();
    const resolvedKeys = new Set();
    const probeNodes = new Map();
    const probeQueue = [];
    let activeProbes = 0;
    let cleared = false;
    let probePumpScheduled = false;
    const diagnostics = {
      cacheHits: 0,
      networkRequests: 0,
      prunedBranches: 0,
      uniquePlannedProbes: 0,
      uniqueResolvedProbes: 0,
      peakPendingProbes: 0,
      peakActiveProbes: 0,
      peakNetworkConcurrency: 0,
      preflightKeys: 0,
      concurrencyChanges: []
    };

    const configuredProbeLimit = Number.isFinite(Number(maxConcurrentRequests))
      ? Math.max(1, Math.floor(Number(maxConcurrentRequests)))
      : Number.POSITIVE_INFINITY;

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

    function markPlanned(key) {
      if (plannedKeys.has(key)) return;
      plannedKeys.add(key);
      diagnostics.uniquePlannedProbes = plannedKeys.size;
    }

    function markResolved(key) {
      if (resolvedKeys.has(key)) return;
      resolvedKeys.add(key);
      diagnostics.uniqueResolvedProbes = resolvedKeys.size;
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

    async function resolveImmediate(segment) {
      throwIfCancelled();
      const key = keyFor(segment.origin, segment.destination, segment.date);
      const staticResult = fromStatic(segment);
      if (staticResult) {
        diagnostics.prunedBranches += 1;
        return remember(key, staticResult);
      }
      if (known.has(key)) return known.get(key);
      if (inFlight.has(key)) return inFlight.get(key);

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

    function concurrencyLimit() {
      const effective = Number(getEffectiveConcurrency());
      const normalized = Number.isFinite(effective)
        ? Math.max(1, Math.floor(effective))
        : configuredProbeLimit;
      return Math.max(1, Math.min(configuredProbeLimit, normalized));
    }

    function sortQueue() {
      probeQueue.sort((left, right) =>
        right.priority - left.priority
        || right.consumers - left.consumers
        || left.key.localeCompare(right.key)
      );
    }

    function finishProbe(node, method, value) {
      if (node.settled) return;
      node.settled = true;
      probeNodes.delete(node.key);
      markResolved(node.key);
      node[method](value);
    }

    function pumpProbeQueue() {
      probePumpScheduled = false;
      if (cleared || signal?.aborted) return;
      sortQueue();
      while (activeProbes < concurrencyLimit() && probeQueue.length) {
        const node = probeQueue.shift();
        if (!node || node.settled) continue;
        activeProbes += 1;
        diagnostics.peakActiveProbes = Math.max(
          diagnostics.peakActiveProbes,
          activeProbes
        );
        Promise.resolve(resolveImmediate(node.segment))
          .then(
            outcome => finishProbe(node, "resolve", outcome),
            error => finishProbe(node, "reject", error)
          )
          .finally(() => {
            activeProbes -= 1;
            // Give probe consumers one microtask turn to apply the outcome,
            // prune branches and enqueue newly unlocked higher-value work.
            queueMicrotask(requestProbePump);
          });
      }
      diagnostics.peakPendingProbes = Math.max(
        diagnostics.peakPendingProbes,
        probeQueue.filter(node => !node.settled).length
      );
    }

    function requestProbePump() {
      if (probePumpScheduled || cleared) return;
      probePumpScheduled = true;
      queueMicrotask(pumpProbeQueue);
    }

    function schedule(segment, { priority = 0 } = {}) {
      throwIfCancelled();
      const key = keyFor(segment.origin, segment.destination, segment.date);
      markPlanned(key);
      const staticResult = fromStatic(segment);
      if (staticResult) {
        diagnostics.prunedBranches += 1;
        const outcome = remember(key, staticResult);
        markResolved(key);
        return Promise.resolve(outcome);
      }
      if (known.has(key)) {
        markResolved(key);
        return Promise.resolve(known.get(key));
      }

      const existing = probeNodes.get(key);
      if (existing) {
        existing.consumers += 1;
        existing.priority = Math.max(existing.priority, Number(priority) || 0);
        sortQueue();
        return existing.promise;
      }

      let resolvePromise;
      let rejectPromise;
      const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      const node = {
        key,
        segment: { ...segment },
        priority: Number(priority) || 0,
        consumers: 1,
        settled: false,
        promise,
        resolve: resolvePromise,
        reject: rejectPromise
      };
      probeNodes.set(key, node);
      probeQueue.push(node);
      diagnostics.peakPendingProbes = Math.max(diagnostics.peakPendingProbes, probeQueue.length);
      requestProbePump();
      return promise;
    }

    function rejectQueuedProbes(error) {
      for (const node of probeQueue) finishProbe(node, "reject", error);
      probeQueue.length = 0;
    }

    const onAbort = () => {
      rejectQueuedProbes(signal?.reason ?? new DOMException("Search cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    async function preflight(segments) {
      const unique = [...new Map(segments.map(segment => [
        keyFor(segment.origin, segment.destination, segment.date), segment
      ])).values()].filter(segment => {
        const key = keyFor(segment.origin, segment.destination, segment.date);
        return !preflightedKeys.has(key) && !known.has(key);
      });
      const keys = unique.map(segment => keyFor(segment.origin, segment.destination, segment.date));
      keys.forEach(key => preflightedKeys.add(key));
      diagnostics.preflightKeys = preflightedKeys.size;
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

    const unsubscribeConcurrency = subscribeConcurrency(state => {
      const changes = state?.concurrencyChanges;
      if (Array.isArray(changes)) diagnostics.concurrencyChanges = [...changes];
      requestProbePump();
    });

    function clear() {
      cleared = true;
      unsubscribeConcurrency?.();
      signal?.removeEventListener("abort", onAbort);
      const error = signal?.reason ?? new DOMException("Search scope cleared", "AbortError");
      rejectQueuedProbes(error);
      inFlight.clear();
      known.clear();
      failed.clear();
      cacheMisses.clear();
      probeNodes.clear();
    }

    return Object.freeze({
      resolve: schedule,
      schedule,
      preflight,
      getKnown: key => known.get(key) ?? null,
      getFailed: () => [...failed.entries()].map(([key, outcome]) => ({ key, ...outcome })),
      diagnostics,
      clear
    });
  }

  return Object.freeze({ createScope, peekMany });
}

export { keyFor as availabilityKey };
