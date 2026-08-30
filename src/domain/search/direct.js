import { ErrorCode } from "../../infrastructure/errors.js";
import { mapConcurrentOrdered } from "./concurrency.js";

/**
 * Creates the direct-flight search stage without coupling it to the DOM or the
 * WebExtensions platform.
 */
export function createDirectSearch({
  fetchRoutes,
  getPreviousResults,
  isCancelled,
  getCached,
  setCached,
  fetchFlights,
  normalizeFlight,
  appendResult,
  updateProgress,
  getConcurrency = () => 1,
  isRouteExcluded = () => false,
  logger = () => {}
}) {
  return async function searchDirectRoutes(
    origins,
    destinations,
    selectedDate,
    shouldAppend = true,
    reverse = false,
    skipProgress = false,
    queryOptions = {}
  ) {
    let allowedReversePairs = null;
    if (reverse && getPreviousResults().length) {
      allowedReversePairs = new Set(
        getPreviousResults().map(flight => `${flight.arrivalStation}-${flight.departureStation}`)
      );
    }

    if (reverse) [origins, destinations] = [destinations, origins];

    const routes = (await fetchRoutes())
      .map(route => ({
        ...route,
        arrivalStations: (route.arrivalStations || []).filter(arrival => {
          if (arrival.operationStartDate && new Date(selectedDate) < new Date(arrival.operationStartDate)) return false;
          return reverse || !arrival.flightDates || arrival.flightDates.includes(selectedDate);
        })
      }))
      .filter(route => route.arrivalStations.length > 0);

    const pairs = [];
    for (const origin of origins) {
      const route = routes.find(candidate => {
        const departure = typeof candidate.departureStation === "object"
          ? candidate.departureStation.id
          : candidate.departureStation;
        return departure === origin;
      });
      if (!route) continue;
      const arrivals = destinations.length === 1 && destinations[0] === "ANY"
        ? route.arrivalStations
        : route.arrivalStations.filter(arrival => destinations.includes(
          typeof arrival === "object" ? arrival.id : arrival
        ));
      for (const arrival of arrivals) {
        pairs.push({ origin, destination: typeof arrival === "object" ? arrival.id : arrival });
      }
    }

    let processed = 0;
    if (!skipProgress) updateProgress(0, pairs.length, "Checking direct flights");

    const pairResults = await mapConcurrentOrdered(pairs, getConcurrency(), async pair => {
      if (isCancelled()) return [];
      if (isRouteExcluded(pair.origin, pair.destination)) return [];
      if (reverse && !allowedReversePairs.has(`${pair.origin}-${pair.destination}`)) return [];

      let flights;
      try {
        flights = await getCached(pair.origin, pair.destination, selectedDate);
        if (!flights) {
          flights = await fetchFlights(pair.origin, pair.destination, selectedDate, queryOptions);
          if (!Array.isArray(flights)) flights = [];
          await setCached(pair.origin, pair.destination, selectedDate, flights);
        }
      } catch (error) {
        if ([ErrorCode.AUTH_REQUIRED, ErrorCode.CANCELLED].includes(error?.code)) throw error;
        logger(`Skipping ${pair.origin} → ${pair.destination} after request error: ${error?.message ?? error}`);
        flights = [];
      }
      flights = flights.map(normalizeFlight);
      if (shouldAppend) flights.forEach(appendResult);
      processed += 1;
      if (!skipProgress) {
        updateProgress(processed, pairs.length, `Checked ${pair.origin} → ${pair.destination} on ${selectedDate}`);
      }
      return flights;
    });
    const results = pairResults.flat();
    logger(`Direct flight search complete. Found ${results.length} flights.`);
    return results;
  };
}
