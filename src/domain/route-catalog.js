/** @typedef {import('./types.js').Route} Route */

function stationCode(station) {
  return typeof station === "object" ? station?.id : station;
}

function routeKey(origin, destination) {
  return `${String(origin ?? "").toUpperCase()}-${String(destination ?? "").toUpperCase()}`;
}

/**
 * Builds all static route and airport indexes once. The returned facade does not
 * mutate the packaged route dataset.
 * @param {Route[]} routes
 */
export function createRouteCatalog(routes, { excludedRoutes = [] } = {}) {
  const excluded = new Set(excludedRoutes.map(key => String(key).toUpperCase()));
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

  function isRouteExcluded(origin, destination) {
    return excluded.has(routeKey(origin, destination));
  }

  function activeRoute(route) {
    const origin = stationCode(route.departureStation);
    const arrivalStations = (route.arrivalStations ?? [])
      .filter(arrival => !isRouteExcluded(origin, stationCode(arrival)));
    if (!arrivalStations.length) return null;
    if (arrivalStations.length === (route.arrivalStations ?? []).length) return route;
    return { ...route, arrivalStations };
  }

  function activeRoutesFrom(origin) {
    return Object.freeze(
      (byOrigin.get(String(origin).toUpperCase()) ?? [])
        .map(activeRoute)
        .filter(Boolean)
    );
  }

  function getArrival(origin, destination) {
    if (isRouteExcluded(origin, destination)) return null;
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
      return activeRoutesFrom(origin);
    },
    getRoute(origin, destination) {
      if (isRouteExcluded(origin, destination)) return null;
      return byOriginAndDestination
        .get(String(origin).toUpperCase())
        ?.get(String(destination).toUpperCase()) ?? null;
    },
    getDestinations(origin) {
      return Object.freeze([
        ...(byOriginAndDestination.get(String(origin).toUpperCase())?.keys() ?? [])
      ].filter(destination => !isRouteExcluded(origin, destination)));
    },
    getActiveRoutes() {
      return Object.freeze(routes.map(activeRoute).filter(Boolean));
    },
    isRouteExcluded(origin, destination) {
      return isRouteExcluded(origin, destination);
    },
    excludeRoute(origin, destination) {
      const key = routeKey(origin, destination);
      if (excluded.has(key)) return false;
      excluded.add(key);
      return true;
    },
    getOrigins(destination) {
      return Object.freeze([
        ...(originsByDestination.get(String(destination).toUpperCase()) ?? [])
      ].filter(origin => !isRouteExcluded(origin, destination)));
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
