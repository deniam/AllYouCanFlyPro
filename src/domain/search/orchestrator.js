import { deduplicateFlights, defaultFlightKey } from "./result-matcher.js";
import { minutesBetween } from "../dates.js";

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
    minRoundTripGapMinutes = 360
  } = request;

  const outbound = [];
  for (const date of departureDates) {
    throwIfAborted(signal);
    const flights = await runLeg(
      { origins, destinations, date, maxTransfers },
      dependencies,
      signal,
      false
    );
    outbound.push(...(flights ?? []));
  }
  const uniqueOutbound = deduplicateFlights(outbound, flight => {
    const route = Array.isArray(flight.route) ? flight.route.join("-") : defaultFlightKey(flight);
    const departure = flight.calculatedDuration?.departureDate;
    return `${route}|${departure instanceof Date ? departure.getTime() : departure}`;
  });
  if (tripType === "oneway") return uniqueOutbound;

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

  const inbound = [];
  let processed = 0;
  onProgress({ current: 0, total: queries.size, message: "Checking inbound flights" });
  for (const query of queries.values()) {
    throwIfAborted(signal);
    inbound.push(...(await runLeg(
      { ...query, maxTransfers },
      dependencies,
      signal,
      false,
      true
    ) ?? []));
    processed += 1;
    onProgress({
      current: processed,
      total: queries.size,
      message: `Checking inbound flights ${query.origins.join(",")} → ${query.destinations.join(",")} on ${query.date}`
    });
  }
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
  return uniqueOutbound.filter(flight => flight.returnFlights.length > 0);
}
