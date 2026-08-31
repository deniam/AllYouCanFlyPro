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
  if (tripType === "oneway") return withDiagnostics(uniqueOutbound);

  uniqueOutbound.forEach(flight => {
    flight.returnFlights = [];
  });

  const originAnywhere = originalOrigins.length === 1 && originalOrigins[0] === "ANY";
  const queries = new Map();
  for (const flight of uniqueOutbound) {
    const outboundOrigin = code(flight.departureStation);
    const outboundDestination = code(flight.arrivalStation);
    for (const date of returnDates) {
      if (originAnywhere) {
        const key = `${destinations.join(",")}|${outboundOrigin}|${date}`;
        queries.set(key, { origins: destinations, destinations: [outboundOrigin], date });
      } else {
        for (const origin of originalOrigins) {
          const key = `${outboundDestination}|${origin}|${date}`;
          queries.set(key, { origins: [outboundDestination], destinations: [origin], date });
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
      for (const [index, outbound] of uniqueOutbound.entries()) {
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
        onRoundTripResult(outbound, index, { isUpdate: wasVisible });
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

  for (const flight of uniqueOutbound) {
    const outboundOrigin = code(flight.departureStation);
    const outboundDestination = code(flight.arrivalStation);
    const outboundArrival = flight.calculatedDuration?.arrivalDate;
    flight.returnFlights = uniqueInbound.filter(candidate => {
      const departure = candidate.calculatedDuration?.departureDate;
      if (!(outboundArrival instanceof Date) || !(departure instanceof Date)) return false;
      const inboundOrigin = code(candidate.departureStation);
      const inboundDestination = code(candidate.arrivalStation);
      const stationsMatch = originAnywhere
        ? destinations.includes(inboundOrigin) && inboundDestination === outboundOrigin
        : inboundOrigin === outboundDestination && originalOrigins.includes(inboundDestination);
      return stationsMatch && minutesBetween(outboundArrival, departure) >= minRoundTripGapMinutes;
    });
  }
  return withDiagnostics(uniqueOutbound.filter(flight => flight.returnFlights.length > 0));
}
