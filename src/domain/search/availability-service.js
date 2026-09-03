import { AvailabilityState, segmentCacheKey } from "../../infrastructure/cache-repository.js";
import { ErrorCode } from "../../infrastructure/errors.js";
import { unifyRawFlight } from "../flight-normalizer.js";

function keyFor(origin, destination, date) {
  return segmentCacheKey(origin, destination, date);
}

function normalizeOutcome(outcome, source = "network") {
  if (outcome?.state === AvailabilityState.AVAILABLE) {
    const availability = Object.freeze({
      source: outcome.source ?? source,
      checkedAt: Number.isFinite(outcome.checkedAt) ? outcome.checkedAt : null
    });
    const flights = (outcome.flights ?? outcome.results ?? [])
      .map(rawFlight => ({ ...unifyRawFlight(rawFlight), availability }))
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

function clock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function createPriorityQueue(compare) {
  const heap = [];

  function swap(left, right) {
    [heap[left], heap[right]] = [heap[right], heap[left]];
    heap[left].heapIndex = left;
    heap[right].heapIndex = right;
  }

  function bubbleUp(start) {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[index], heap[parent]) <= 0) break;
      swap(index, parent);
      index = parent;
    }
  }

  function bubbleDown(start) {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (left < heap.length && compare(heap[left], heap[largest]) > 0) largest = left;
      if (right < heap.length && compare(heap[right], heap[largest]) > 0) largest = right;
      if (largest === index) return;
      swap(index, largest);
      index = largest;
    }
  }

  return {
    get size() {
      return heap.length;
    },
    push(node) {
      node.heapIndex = heap.length;
      heap.push(node);
      bubbleUp(node.heapIndex);
    },
    update(node) {
      if (node.heapIndex < 0) return;
      bubbleUp(node.heapIndex);
      bubbleDown(node.heapIndex);
    },
    pop() {
      if (!heap.length) return null;
      const result = heap[0];
      const last = heap.pop();
      result.heapIndex = -1;
      if (heap.length && last !== result) {
        heap[0] = last;
        last.heapIndex = 0;
        bubbleDown(0);
      }
      return result;
    },
    drain() {
      const result = heap.slice();
      heap.length = 0;
      result.forEach(node => { node.heapIndex = -1; });
      return result;
    }
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
    maxConcurrentRequests = Number.POSITIVE_INFINITY,
    seedOutcomes = new Map(),
    forceNetworkKeys = new Set(),
    networkAllowlist = null
  } = {}) {
    const inFlight = new Map();
    const known = new Map();
    const failed = new Map();
    const cacheMisses = new Set();
    const preflightedKeys = new Set();
    const plannedKeys = new Set();
    const resolvedKeys = new Set();
    const probeNodes = new Map();
    const probeQueue = createPriorityQueue((left, right) =>
      left.priority - right.priority
      || left.consumers - right.consumers
      || right.key.localeCompare(left.key)
    );
    let activeProbes = 0;
    let cleared = false;
    let probePumpScheduled = false;
    const forcedKeys = new Set(forceNetworkKeys);
    const allowedNetworkKeys = networkAllowlist === null
      ? null
      : new Set(networkAllowlist);
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

    for (const [key, outcome] of seedOutcomes ?? []) {
      if (!forcedKeys.has(key)) known.set(key, normalizeOutcome(outcome, outcome?.source));
    }

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

      if (allowedNetworkKeys && !allowedNetworkKeys.has(key)) {
        return remember(key, {
          state: AvailabilityState.UNKNOWN,
          flights: [],
          source: "snapshot",
          reason: "outside-refresh-scope"
        });
      }

      const promise = (async () => {
        throwIfCancelled();
        try {
          const outcome = await loadFlights({
            ...segment,
            preferredReturnDates,
            skipCache: cacheMisses.has(key) || forcedKeys.has(key),
            signal
          });
          const normalizationStartedAt = clock();
          const normalized = normalizeOutcome(outcome);
          logger("[perf:availability.normalize]", {
            key,
            durationMs: clock() - normalizationStartedAt,
            flightCount: normalized.flights.length
          });
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
      while (activeProbes < concurrencyLimit() && probeQueue.size) {
        const node = probeQueue.pop();
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
        probeQueue.size
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
        probeQueue.update(existing);
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
      diagnostics.peakPendingProbes = Math.max(diagnostics.peakPendingProbes, probeQueue.size);
      requestProbePump();
      return promise;
    }

    function rejectQueuedProbes(error) {
      for (const node of probeQueue.drain()) finishProbe(node, "reject", error);
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
      const cacheKeys = keys.filter(key => !forcedKeys.has(key));
      forcedKeys.forEach(key => {
        if (keys.includes(key)) cacheMisses.add(key);
      });
      const cached = await peekMany(cacheKeys);
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
      snapshot: () => new Map(known),
      diagnostics,
      clear
    });
  }

  return Object.freeze({ createScope, peekMany });
}

export { keyFor as availabilityKey };
