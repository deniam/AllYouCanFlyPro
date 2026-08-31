import { stationCode } from "../route-catalog.js";
import { addDaysUTC } from "../dates.js";
import { haversineDistance } from "../airports.js";

function arrivalAvailableOnDates(arrival, availableDates) {
  if (!availableDates) return true;
  const operationStartDate = typeof arrival === "object"
    ? arrival.operationStartDate?.slice(0, 10)
    : null;
  const eligibleDates = availableDates.filter(date =>
    !operationStartDate || date >= operationStartDate
  );
  if (!eligibleDates.length) return false;
  const flightDates = typeof arrival === "object" ? arrival.flightDates : null;
  return !Array.isArray(flightDates)
    || flightDates.some(date => eligibleDates.includes(date));
}

export function buildGraph(routes, availableDates = null) {
  const graph = new Map();
  for (const route of routes) {
    const origin = stationCode(route.departureStation);
    if (!origin) continue;
    const destinations = graph.get(origin) ?? [];
    for (const arrival of route.arrivalStations ?? []) {
      if (!arrivalAvailableOnDates(arrival, availableDates)) continue;
      const destination = stationCode(arrival);
      if (destination && !destinations.includes(destination)) destinations.push(destination);
    }
    if (destinations.length) graph.set(origin, destinations);
  }
  return graph;
}

export function buildGroundTransferGraph(graph, airportLookup, radiusKm) {
  const radius = Number(radiusKm);
  if (!(radius > 0)) return new Map();
  const codes = [...new Set([
    ...graph.keys(),
    ...[...graph.values()].flat()
  ])].filter(code => airportLookup[code]);
  const groundGraph = new Map();

  for (let leftIndex = 0; leftIndex < codes.length; leftIndex += 1) {
    const leftCode = codes[leftIndex];
    const left = airportLookup[leftCode];
    if (![left.latitude, left.longitude].every(Number.isFinite)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < codes.length; rightIndex += 1) {
      const rightCode = codes[rightIndex];
      const right = airportLookup[rightCode];
      if (![right.latitude, right.longitude].every(Number.isFinite)) continue;
      if (haversineDistance(
        left.latitude, left.longitude, right.latitude, right.longitude
      ) > radius) continue;
      const leftNeighbours = groundGraph.get(leftCode) ?? [];
      const rightNeighbours = groundGraph.get(rightCode) ?? [];
      leftNeighbours.push(rightCode);
      rightNeighbours.push(leftCode);
      groundGraph.set(leftCode, leftNeighbours);
      groundGraph.set(rightCode, rightNeighbours);
    }
  }
  return groundGraph;
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

/**
 * Returns graph vertices that can reach any destination within the requested
 * number of flight segments. Traversing the reversed graph avoids expanding
 * an ANY origin into unrelated airports.
 */
export function findReachableOrigins(graph, destinations, maxTransfers, {
  groundGraph = new Map(),
  originGraph = graph
} = {}) {
  const reverseGraph = new Map();
  for (const [origin, arrivals] of graph) {
    for (const destination of arrivals) {
      const predecessors = reverseGraph.get(destination) ?? [];
      if (!predecessors.includes(origin)) predecessors.push(origin);
      reverseGraph.set(destination, predecessors);
    }
  }

  const originEdges = new Set();
  for (const [origin, arrivals] of originGraph) {
    arrivals.forEach(destination => originEdges.add(`${origin}|${destination}`));
  }

  const reachable = new Set();
  let frontier = destinations.map(airport => ({
    airport,
    flightSegments: 0,
    groundAllowed: false
  }));
  const visited = new Set(frontier.map(state =>
    `${state.airport}|${state.flightSegments}|${state.groundAllowed}`
  ));
  const maximumSegments = Math.max(1, Math.floor(Number(maxTransfers) || 0) + 1);

  for (let frontierIndex = 0; frontierIndex < frontier.length; frontierIndex += 1) {
    const state = frontier[frontierIndex];
    if (state.flightSegments < maximumSegments) {
      for (const origin of reverseGraph.get(state.airport) ?? []) {
        if (originEdges.has(`${origin}|${state.airport}`)) reachable.add(origin);
        const nextState = {
          airport: origin,
          flightSegments: state.flightSegments + 1,
          groundAllowed: true
        };
        const key = `${nextState.airport}|${nextState.flightSegments}|true`;
        if (!visited.has(key)) {
          visited.add(key);
          frontier.push(nextState);
        }
      }
    }

    // A ground edge is optional after a flight edge, consumes no flight
    // segment, and cannot be followed by another ground edge.
    if (state.groundAllowed) {
      for (const neighbour of groundGraph.get(state.airport) ?? []) {
        const nextState = {
          airport: neighbour,
          flightSegments: state.flightSegments,
          groundAllowed: false
        };
        const key = `${nextState.airport}|${nextState.flightSegments}|false`;
        if (!visited.has(key)) {
          visited.add(key);
          frontier.push(nextState);
        }
      }
    }
  }

  // Preserve route-catalog order so candidate and result ordering remains stable.
  return [...graph.keys()].filter(origin => reachable.has(origin));
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
