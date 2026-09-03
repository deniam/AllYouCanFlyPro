import { ErrorCode } from "../../infrastructure/errors.js";
import { mapConcurrentOrdered } from "./concurrency.js";

/**
 * Creates the direct-flight search stage. Static route eligibility is read
 * from the already-indexed catalog; availability and cache access belong to
 * the search-scoped availability service.
 */
export function createDirectSearch({
  routeCatalog,
  isCancelled,
  appendResult,
  updateProgress,
  getConcurrency = () => 1,
  logger = () => {},
  getAvailabilityScope = () => null
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
    const sourceOrigins = reverse ? destinations : origins;
    const sourceDestinations = reverse ? origins : destinations;
    const requestedOrigins = sourceOrigins.includes("ANY")
      ? routeCatalog.airportCodes
      : sourceOrigins;
    const requestedDestinations = sourceDestinations.includes("ANY")
      ? null
      : new Set(sourceDestinations);
    const pairs = [];

    for (const origin of requestedOrigins) {
      const availableDestinations = routeCatalog.getDestinations(origin)
        .filter(destination =>
          (!requestedDestinations || requestedDestinations.has(destination))
          && routeCatalog.isDateAvailable(origin, destination, selectedDate));
      for (const destination of availableDestinations) {
        pairs.push({ origin, destination });
      }
    }

    let processed = 0;
    if (!skipProgress) updateProgress(0, pairs.length, "Checking direct flights");

    const availabilityScope = queryOptions.availabilityScope ?? getAvailabilityScope();
    if (!availabilityScope?.resolve) {
      throw new Error("Direct search requires an availability scope");
    }
    if (availabilityScope.preflight) {
      await availabilityScope.preflight(pairs.map(pair => ({
        ...pair,
        date: selectedDate
      })));
    }

    const pairResults = await mapConcurrentOrdered(pairs, getConcurrency(), async pair => {
      if (isCancelled()) return [];
      if (routeCatalog.isRouteExcluded(pair.origin, pair.destination)) return [];

      let flights = [];
      try {
        const outcome = await availabilityScope.resolve({
          origin: pair.origin,
          destination: pair.destination,
          date: selectedDate,
          preferredReturnDates: queryOptions.preferredReturnDates ?? []
        });
        if (outcome?.state === "unknown") {
          logger(`Direct availability unresolved for ${pair.origin} → ${pair.destination}`);
        } else if (Array.isArray(outcome?.flights)) {
          flights = outcome.flights;
        }
      } catch (error) {
        if ([ErrorCode.AUTH_REQUIRED, ErrorCode.CANCELLED].includes(error?.code)) throw error;
        logger(`Skipping ${pair.origin} → ${pair.destination} after request error: ${error?.message ?? error}`);
      }

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
