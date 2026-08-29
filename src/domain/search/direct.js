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

    const results = [];
    let processed = 0;
    if (!skipProgress) updateProgress(0, pairs.length, "Checking direct flights");

    for (const pair of pairs) {
      if (isCancelled()) break;
      processed += 1;
      if (!skipProgress) {
        updateProgress(processed, pairs.length, `Checking ${pair.origin} → ${pair.destination} on ${selectedDate}`);
      }
      if (reverse && !allowedReversePairs.has(`${pair.origin}-${pair.destination}`)) continue;

      let flights = await getCached(pair.origin, pair.destination, selectedDate);
      if (!flights) {
        flights = await fetchFlights(pair.origin, pair.destination, selectedDate, queryOptions);
        if (!Array.isArray(flights)) flights = [];
        await setCached(pair.origin, pair.destination, selectedDate, flights);
      }
      flights = flights.map(normalizeFlight);
      if (shouldAppend) flights.forEach(appendResult);
      results.push(...flights);
    }
    logger(`Direct flight search complete. Found ${results.length} flights.`);
    return results;
  };
}
