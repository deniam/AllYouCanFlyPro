import { createConnectionPlanner } from "./connection-planner.js";

/**
 * Compatibility adapter for the historical positional search API. The
 * planner is now the only connection-search implementation; availability,
 * caching and route eligibility are owned by its injected dependencies.
 */
export function createConnectionsSearch({
  routeCatalog,
  airportLookup = {},
  availabilityScope,
  isCancelled = () => false,
  updateProgress = () => {},
  debugLogger = () => {},
  isRouteExcluded = () => false,
  appendRouteToDisplay = () => {}
}) {
  const planners = new WeakMap();
  const getPlanner = scope => {
    if (!scope || (typeof scope !== "object" && typeof scope !== "function")) {
      throw new Error("Connection search requires an availability scope");
    }
    if (!planners.has(scope)) {
      planners.set(scope, createConnectionPlanner({
        routeCatalog,
        airportLookup,
        availabilityScope: scope,
        isCancelled,
        updateProgress,
        debugLogger,
        isRouteExcluded,
        appendRouteToDisplay
      }));
    }
    return planners.get(scope);
  };

  return async function searchConnectingRoutes(
    origins,
    destinations,
    selectedDate,
    maxTransfers,
    shouldAppend = true,
    skipProgress = false,
    queryOptions = {}
  ) {
    const scope = queryOptions.availabilityScope ?? availabilityScope;
    return getPlanner(scope).search({
      origins,
      destinations,
      selectedDate,
      maxTransfers,
      allowOvernight: queryOptions.allowOvernight ?? false,
      minConnection: Number(queryOptions.minConnection ?? 90),
      maxConnection: Number(queryOptions.maxConnection ?? 5000),
      connectionRadiusKm: Number(queryOptions.connectionRadiusKm ?? 0),
      allowChangeAirport: queryOptions.allowChangeAirport ?? false,
      bookingWindow: queryOptions.bookingWindow,
      appendResults: shouldAppend,
      skipProgress
    });
  };
}
