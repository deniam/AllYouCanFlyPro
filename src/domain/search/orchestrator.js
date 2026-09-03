import { deduplicateFlights, defaultFlightKey } from "./result-matcher.js";
import { minutesBetween } from "../dates.js";
import { mapConcurrentOrdered } from "./concurrency.js";

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Search cancelled", "AbortError");
}

function code(value) {
  return typeof value === "object" ? value?.id : value;
}

async function runLeg(request, dependencies, signal, append, skipProgress = false) {
  throwIfAborted(signal);
  const params = { ...request, append, skipProgress, signal };
  return request.maxTransfers > 0
    ? dependencies.searchConnections(params)
    : dependencies.searchDirect(params);
}

/**
 * Runs a complete one-way or round-trip search with no DOM access.
 * Platform requests, caching and rendering are supplied as dependencies.
 */
export async function runSearch(request, dependencies, signal, onProgress = () => {}) {
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  const {
    origins,
    destinations,
    departureDates,
    returnDates = [],
    tripType = "oneway",
    maxTransfers = 0,
    originalOrigins = origins,
    minRoundTripGapMinutes = 360,
    maxConcurrentRequests = 1
  } = request;
  const onRoundTripResult = dependencies.onRoundTripResult ?? (() => {});
  const withDiagnostics = results => {
    const diagnostics = dependencies.getDiagnostics?.() ?? {
      complete: true,
      failedProbes: [],
      cacheHits: 0,
      networkRequests: 0,
      prunedBranches: 0
    };
    Object.defineProperty(results, "diagnostics", {
      value: {
        ...diagnostics,
        complete: !(diagnostics.failedProbes?.length)
      },
      enumerable: false
    });
    return results;
  };

  const outbound = [];
  for (const date of departureDates) {
    throwIfAborted(signal);
    const flights = await runLeg(
      {
        origins,
        destinations,
        date,
        maxTransfers,
        preferredReturnDates: tripType === "return" ? returnDates : []
      },
      dependencies,
      signal,
      true
    );
    outbound.push(...(flights ?? []));
  }
  // Aggregated routes carry a key made from every segment. Using only the
  // endpoints and departure time here incorrectly merged distinct layovers
  // that happened to start on the same flight.
  const uniqueOutbound = deduplicateFlights(outbound);
  if (tripType === "oneway") {
    dependencies.debugLogger?.("[perf:search]", {
      durationMs: (globalThis.performance?.now?.() ?? Date.now()) - startedAt,
      stage: "search.complete",
      resultCount: uniqueOutbound.length
    });
    return withDiagnostics(uniqueOutbound);
  }

  uniqueOutbound.forEach(flight => {
    flight.returnFlights = [];
  });

  const originAnywhere = originalOrigins.length === 1 && originalOrigins[0] === "ANY";
  const queries = new Map();
  const outboundsByReturnKey = new Map();
  const outboundIndexes = new Map(uniqueOutbound.map((flight, index) => [flight, index]));
  const addOutboundToReturnGroup = (key, flight) => {
    const group = outboundsByReturnKey.get(key) ?? [];
    if (!group.includes(flight)) group.push(flight);
    outboundsByReturnKey.set(key, group);
  };
  for (const flight of uniqueOutbound) {
    const outboundOrigin = code(flight.departureStation);
    const outboundDestination = code(flight.arrivalStation);
    for (const date of returnDates) {
      if (originAnywhere) {
        const returnKey = `${destinations.join(",")}|${outboundOrigin}`;
        const key = `${returnKey}|${date}`;
        queries.set(key, {
          origins: destinations,
          destinations: [outboundOrigin],
          date,
          returnKey
        });
        addOutboundToReturnGroup(returnKey, flight);
      } else {
        for (const origin of originalOrigins) {
          const returnKey = `${outboundDestination}|${origin}`;
          const key = `${returnKey}|${date}`;
          queries.set(key, {
            origins: [outboundDestination],
            destinations: [origin],
            date,
            returnKey
          });
          addOutboundToReturnGroup(returnKey, flight);
        }
      }
    }
  }

  let processed = 0;
  onProgress({ current: 0, total: queries.size, message: "Checking inbound flights" });
  const inboundGroups = await mapConcurrentOrdered(
    queries.values(),
    maxConcurrentRequests,
    async query => {
      throwIfAborted(signal);
      const flights = await runLeg(
        { ...query, maxTransfers },
        dependencies,
        signal,
        false,
        true
      ) ?? [];
      throwIfAborted(signal);

      // Process each completed inbound response immediately. The ordered map
      // still preserves the final result order, while this side effect lets
      // the UI show valid round trips as soon as they are discovered.
      const relevantOutbounds = outboundsByReturnKey.get(query.returnKey) ?? [];
      for (const outbound of relevantOutbounds) {
        const matchingFlights = flights.filter(candidate => {
          const inboundOrigin = code(candidate.departureStation);
          const inboundDestination = code(candidate.arrivalStation);
          const outboundOrigin = code(outbound.departureStation);
          const outboundDestination = code(outbound.arrivalStation);
          const stationsMatch = originAnywhere
            ? destinations.includes(inboundOrigin) && inboundDestination === outboundOrigin
            : inboundOrigin === outboundDestination && originalOrigins.includes(inboundDestination);
          const outboundArrival = outbound.calculatedDuration?.arrivalDate;
          const inboundDeparture = candidate.calculatedDuration?.departureDate;
          return stationsMatch
            && outboundArrival instanceof Date
            && inboundDeparture instanceof Date
            && minutesBetween(outboundArrival, inboundDeparture) >= minRoundTripGapMinutes;
        });
        const existingKeys = new Set(outbound.returnFlights.map(defaultFlightKey));
        const newFlights = deduplicateFlights(matchingFlights)
          .filter(candidate => !existingKeys.has(defaultFlightKey(candidate)));
        if (!newFlights.length) continue;

        const wasVisible = outbound.returnFlights.length > 0;
        outbound.returnFlights.push(...newFlights);
        onRoundTripResult(outbound, outboundIndexes.get(outbound), { isUpdate: wasVisible });
      }

      processed += 1;
      onProgress({
        current: processed,
        total: queries.size,
        message: `Checking inbound flights ${query.origins.join(",")} → ${query.destinations.join(",")} on ${query.date}`
      });
      return flights;
    }
  );
  const inbound = inboundGroups.flat();
  const uniqueInbound = deduplicateFlights(inbound);

  // Reconcile in inbound response order while only visiting outbounds in the
  // matching return-pair group. This preserves the previous final ordering
  // without the global outbound × inbound scan.
  const returnKeys = new Map(uniqueOutbound.map(flight => [flight, new Set()]));
  uniqueOutbound.forEach(flight => { flight.returnFlights = []; });
  for (const candidate of uniqueInbound) {
    const inboundOrigin = code(candidate.departureStation);
    const inboundDestination = code(candidate.arrivalStation);
    const returnKey = originAnywhere
      ? `${destinations.join(",")}|${inboundDestination}`
      : `${inboundOrigin}|${inboundDestination}`;
    const relevantOutbounds = outboundsByReturnKey.get(returnKey) ?? [];
    const departure = candidate.calculatedDuration?.departureDate;
    for (const outbound of relevantOutbounds) {
      const outboundArrival = outbound.calculatedDuration?.arrivalDate;
      if (!(outboundArrival instanceof Date) || !(departure instanceof Date)) continue;
      if (minutesBetween(outboundArrival, departure) < minRoundTripGapMinutes) continue;
      const existingKeys = returnKeys.get(outbound);
      const candidateKey = defaultFlightKey(candidate);
      if (existingKeys.has(candidateKey)) continue;
      existingKeys.add(candidateKey);
      outbound.returnFlights.push(candidate);
    }
  }
  const results = uniqueOutbound.filter(flight => flight.returnFlights.length > 0);
  dependencies.debugLogger?.("[perf:search]", {
    durationMs: (globalThis.performance?.now?.() ?? Date.now()) - startedAt,
    stage: "search.return-match",
    outboundCount: uniqueOutbound.length,
    inboundCount: uniqueInbound.length,
    resultCount: results.length
  });
  return withDiagnostics(results);
}
