import { stationCode } from "../route-catalog.js";
import { addDaysUTC } from "../dates.js";

export function buildGraph(routes) {
  const graph = new Map();
  for (const route of routes) {
    const origin = stationCode(route.departureStation);
    if (!origin) continue;
    const destinations = graph.get(origin) ?? [];
    for (const arrival of route.arrivalStations ?? []) {
      const destination = stationCode(arrival);
      if (destination && !destinations.includes(destination)) destinations.push(destination);
    }
    graph.set(origin, destinations);
  }
  return graph;
}

export function findCandidateRoutes(graph, origins, destinations, maxTransfers) {
  const destinationSet = new Set(destinations);
  const results = [];
  const seen = new Set();

  function visit(current, path) {
    if (path.length > maxTransfers + 2) return;
    if (path.length > 1 && destinationSet.has(current)) {
      const key = path.join("-");
      if (!seen.has(key)) {
        seen.add(key);
        results.push([...path]);
      }
    }
    if (path.length === maxTransfers + 2) return;
    for (const next of graph.get(current) ?? []) {
      if (!path.includes(next)) visit(next, [...path, next]);
    }
  }

  for (const origin of origins) visit(origin, [origin]);
  return results;
}

export function candidateHasValidFlightDates(
  candidate,
  routes,
  selectedDate,
  bookingHorizon,
  allowedOffsets,
  logger = () => {}
) {
  const baseDate = new Date(`${selectedDate}T00:00:00Z`);
  const allowedDates = allowedOffsets
    .map(offset => addDaysUTC(baseDate, offset))
    .filter(date => date <= bookingHorizon)
    .map(date => date.toISOString().slice(0, 10));

  for (let index = 0; index < candidate.length - 1; index += 1) {
    const origin = candidate[index];
    const destination = candidate[index + 1];
    const route = routes.find(item => stationCode(item.departureStation) === origin);
    const arrival = route?.arrivalStations?.find(item => stationCode(item) === destination);
    const segmentDates = allowedDates.filter(date =>
      !arrival?.operationStartDate || date >= arrival.operationStartDate.slice(0, 10)
    );
    if (!arrival?.flightDates?.some(date => segmentDates.includes(date))) {
      logger(`Segment ${origin} → ${destination} has no flight in ${allowedDates.join(", ")}`);
      return false;
    }
  }
  return true;
}
