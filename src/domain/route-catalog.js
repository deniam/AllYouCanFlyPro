/** @typedef {import('./types.js').Route} Route */

function stationCode(station) {
  return typeof station === "object" ? station?.id : station;
}

/**
 * Builds all static route and airport indexes once. The returned facade does not
 * mutate the packaged route dataset.
 * @param {Route[]} routes
 */
export function createRouteCatalog(routes) {
  const byOrigin = new Map();
  const byOriginAndDestination = new Map();
  const originsByDestination = new Map();
  const airportsByCode = new Map();

  for (const route of routes) {
    const origin = stationCode(route.departureStation);
    if (!origin) continue;

    if (typeof route.departureStation === "object") {
      airportsByCode.set(origin, Object.freeze({ ...route.departureStation }));
    }

    const originRoutes = byOrigin.get(origin) ?? [];
    originRoutes.push(route);
    byOrigin.set(origin, originRoutes);

    const destinationMap = byOriginAndDestination.get(origin) ?? new Map();
    byOriginAndDestination.set(origin, destinationMap);

    for (const arrival of route.arrivalStations ?? []) {
      const destination = stationCode(arrival);
      if (!destination) continue;
      destinationMap.set(destination, route);

      const origins = originsByDestination.get(destination) ?? new Set();
      origins.add(origin);
      originsByDestination.set(destination, origins);

      if (typeof arrival === "object" && !airportsByCode.has(destination)) {
        airportsByCode.set(destination, Object.freeze({ ...arrival }));
      }
    }
  }

  for (const [key, value] of byOrigin) byOrigin.set(key, Object.freeze([...value]));

  function getArrival(origin, destination) {
    const route = byOriginAndDestination.get(origin)?.get(destination);
    if (!route) return null;
    return route.arrivalStations.find(item => stationCode(item) === destination) ?? null;
  }

  return Object.freeze({
    routes: Object.freeze(routes),
    airportCodes: Object.freeze([...airportsByCode.keys()]),
    getAirport(code) {
      return airportsByCode.get(String(code).toUpperCase()) ?? null;
    },
    getRoutesFrom(origin) {
      return byOrigin.get(String(origin).toUpperCase()) ?? Object.freeze([]);
    },
    getRoute(origin, destination) {
      return byOriginAndDestination
        .get(String(origin).toUpperCase())
        ?.get(String(destination).toUpperCase()) ?? null;
    },
    getDestinations(origin) {
      return Object.freeze([
        ...(byOriginAndDestination.get(String(origin).toUpperCase())?.keys() ?? [])
      ]);
    },
    getOrigins(destination) {
      return Object.freeze([
        ...(originsByDestination.get(String(destination).toUpperCase()) ?? [])
      ]);
    },
    getFlightDates(origin, destination) {
      const arrival = getArrival(
        String(origin).toUpperCase(),
        String(destination).toUpperCase()
      );
      if (!arrival || typeof arrival !== "object" || !Array.isArray(arrival.flightDates)) {
        return Object.freeze([]);
      }
      return Object.freeze([...arrival.flightDates]);
    },
    isDateAvailable(origin, destination, date) {
      const arrival = getArrival(
        String(origin).toUpperCase(),
        String(destination).toUpperCase()
      );
      if (!arrival) return false;
      if (typeof arrival !== "object") return true;
      if (arrival.operationStartDate && date < arrival.operationStartDate.slice(0, 10)) return false;
      if (!Array.isArray(arrival.flightDates)) return true;
      return arrival.flightDates.includes(date);
    }
  });
}

export { stationCode };
