import { addDaysUTC, minutesBetween } from "../dates.js";
import { formatFlightDateCombined } from "../flight-normalizer.js";
import { haversineDistance } from "../airports.js";
import { AvailabilityState } from "../../infrastructure/cache-repository.js";
import { mapConcurrentOrdered } from "./concurrency.js";

const MIN_LOCAL_OFFSET_MINUTES = -12 * 60;
const MAX_LOCAL_OFFSET_MINUTES = 14 * 60;

function code(value) {
  return typeof value === "object" ? value?.id : value;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function flightKey(flight) {
  return flight?.key ?? `${flight?.departureStation}|${flight?.arrivalStation}|${flight?.departureDateIso}|${flight?.departure}`;
}

function departureUtc(flight) {
  return flight?.departureDateUtc ?? flight?.calculatedDuration?.departureDate;
}

function arrivalUtc(flight) {
  return flight?.arrivalDateUtc ?? flight?.calculatedDuration?.arrivalDate;
}

function requestedLocalDate(flight) {
  return flight?.departureDateIso
    ?? flight?.calculatedDuration?.departureDate?.toISOString?.().slice(0, 10);
}

function nearbyAirports(codeValue, airportLookup, radiusKm) {
  const base = airportLookup?.[codeValue];
  if (!base || !(Number(radiusKm) > 0)) return [codeValue];
  const result = [codeValue];
  for (const [otherCode, airport] of Object.entries(airportLookup)) {
    if (otherCode === codeValue || !airport) continue;
    if (![base.latitude, base.longitude, airport.latitude, airport.longitude].every(Number.isFinite)) continue;
    if (haversineDistance(base.latitude, base.longitude, airport.latitude, airport.longitude) <= radiusKm) {
      result.push(otherCode);
    }
  }
  return result;
}

function possibleLocalDates(earliestUtc, latestUtc, bookingFrom, bookingTo) {
  const start = new Date(earliestUtc.getTime() + MIN_LOCAL_OFFSET_MINUTES * 60000);
  const end = new Date(latestUtc.getTime() + MAX_LOCAL_OFFSET_MINUTES * 60000);
  // The arithmetic above intentionally expands the date envelope. Correct
  // UTC filtering is performed after the availability response is received.
  const first = new Date(Math.min(start.getTime(), end.getTime()));
  const last = new Date(Math.max(start.getTime(), end.getTime()));
  const dates = [];
  for (let cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()));
    cursor <= last;
    cursor = addDaysUTC(cursor, 1)) {
    const date = isoDate(cursor);
    if (date >= bookingFrom && date <= bookingTo) dates.push(date);
  }
  return dates;
}

function aggregateRoute(chain, airportLookup) {
  if (!chain.length) return null;
  const first = chain[0];
  const last = chain[chain.length - 1];
  const firstDeparture = departureUtc(first);
  const lastArrival = arrivalUtc(last);
  if (!(firstDeparture instanceof Date) || !(lastArrival instanceof Date)) return null;
  const gaps = [];
  for (let index = 0; index < chain.length - 1; index += 1) {
    const gap = minutesBetween(arrivalUtc(chain[index]), departureUtc(chain[index + 1]));
    gaps.push(gap);
  }
  const totalMinutes = minutesBetween(firstDeparture, lastArrival);
  const route = {
    key: chain.map(flightKey).join(" | "),
    fareSellKey: first.fareSellKey,
    departure: first.departure,
    arrival: last.arrival,
    departureStation: first.departureStation,
    departureStationText: first.departureStationText,
    arrivalStation: last.arrivalStation,
    arrivalStationText: last.arrivalStationText,
    departureDate: first.departureDate,
    arrivalDate: last.arrivalDate,
    stops: `${chain.length - 1} transfer${chain.length - 1 === 1 ? "" : "s"}`,
    totalConnectionTime: gaps.reduce((sum, value) => sum + value, 0),
    segments: chain,
    calculatedDuration: {
      hours: Math.floor(totalMinutes / 60),
      minutes: totalMinutes % 60,
      totalMinutes,
      departureDate: first.calculatedDuration?.departureDate ?? first.departureDate,
      arrivalDate: last.calculatedDuration?.arrivalDate ?? last.arrivalDate
    },
    formattedFlightDate: formatFlightDateCombined(first.departureDate, last.arrivalDate),
    currency: first.currency,
    displayPrice: first.displayPrice,
    priceTag: first.priceTag,
    route: [first.departureStationText, last.arrivalStationText]
  };
  if (chain.length === 2) {
    const from = code(first.arrivalStation);
    const to = code(last.departureStation);
    const left = airportLookup?.[from];
    const right = airportLookup?.[to];
    route.airportChange = {
      from,
      to,
      distanceKm: left && right && [left.latitude, left.longitude, right.latitude, right.longitude].every(Number.isFinite)
        ? Math.round(haversineDistance(left.latitude, left.longitude, right.latitude, right.longitude))
        : null
    };
  } else if (chain.length === 3) {
    for (const [index, field] of [[0, "airportChangeOne"], [1, "airportChangeTwo"]]) {
      const from = code(chain[index].arrivalStation);
      const to = code(chain[index + 1].departureStation);
      if (from === to) continue;
      const left = airportLookup?.[from];
      const right = airportLookup?.[to];
      route[field] = {
        from,
        to,
        distanceKm: left && right && [left.latitude, left.longitude, right.latitude, right.longitude].every(Number.isFinite)
          ? Math.round(haversineDistance(left.latitude, left.longitude, right.latitude, right.longitude))
          : null
      };
    }
  }
  return route;
}

export function createConnectionPlanner({
  routeCatalog,
  airportLookup = {},
  availabilityScope,
  isCancelled = () => false,
  updateProgress = () => {},
  debugLogger = () => {},
  isRouteExcluded = () => false,
  appendRouteToDisplay = () => {}
}) {
  function allEdges() {
    const edges = [];
    for (const origin of routeCatalog.airportCodes ?? []) {
      for (const destination of routeCatalog.getDestinations(origin) ?? []) {
        if (origin !== destination && !isRouteExcluded(origin, destination)) edges.push({ origin, destination });
      }
    }
    return edges;
  }

function hasStaticPath(origin, targets, flightsLeft, date, allowChangeAirport, radiusKm, known, memo = new Map()) {
    const memoKey = `${origin}|${flightsLeft}|${date ?? "*"}|${allowChangeAirport ? radiusKm : 0}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    if (targets.has(origin)) return true;
    if (flightsLeft <= 0) return false;
    for (const destination of routeCatalog.getDestinations(origin) ?? []) {
      if (isRouteExcluded(origin, destination) || (date && !routeCatalog.isDateAvailable(origin, destination, date))) continue;
      const key = `${origin}-${destination}-${date}`;
      const state = known.get(key)?.state;
      if (state === AvailabilityState.UNAVAILABLE) continue;
      const nextAirports = allowChangeAirport ? nearbyAirports(destination, airportLookup, radiusKm) : [destination];
      if (nextAirports.some(next => hasStaticPath(next, targets, flightsLeft - 1, date, allowChangeAirport, radiusKm, known, memo))) {
        memo.set(memoKey, true);
        return true;
      }
    }
    memo.set(memoKey, false);
    return false;
}

  async function search({
    origins,
    destinations,
    selectedDate,
    maxTransfers,
    allowOvernight = false,
    minConnection = 90,
    maxConnection = 5000,
    connectionRadiusKm = 0,
    allowChangeAirport = false,
    bookingWindow = {},
    appendResults = true,
    maxConcurrentRequests = 1
  }) {
    const maxFlights = Math.max(1, Number(maxTransfers) + 1);
    const today = bookingWindow.from ?? isoDate(new Date());
    const horizon = bookingWindow.to ?? isoDate(addDaysUTC(new Date(`${today}T00:00:00Z`), 3));
    const edges = allEdges();
    const allCodes = [...new Set(edges.flatMap(edge => [edge.origin, edge.destination]))];
    const targets = new Set(destinations.includes("ANY") ? allCodes : destinations);
    const originCodes = origins.includes("ANY") ? allCodes : origins;
    const preflightDates = [];
    for (const edge of edges) {
      if (!allowOvernight) preflightDates.push({ ...edge, date: selectedDate });
      else {
        for (let cursor = new Date(`${selectedDate}T00:00:00Z`); isoDate(cursor) <= horizon; cursor = addDaysUTC(cursor, 1)) {
          preflightDates.push({ ...edge, date: isoDate(cursor) });
        }
      }
    }
    await availabilityScope.preflight(preflightDates);
    const known = new Map();
    for (const item of preflightDates) {
      const value = availabilityScope.getKnown(`${item.origin}-${item.destination}-${item.date}`);
      if (value) known.set(`${item.origin}-${item.destination}-${item.date}`, value);
    }

    const reachabilityMemo = new Map();
    const viableOrigins = originCodes.filter(origin =>
      hasStaticPath(origin, targets, maxFlights, allowOvernight ? null : selectedDate, allowChangeAirport, connectionRadiusKm, known, reachabilityMemo)
    );
    const results = [];
    const resultKeys = new Set();
    let resolved = 0;
    let planned = 0;
    const probeConcurrency = Math.max(1, Math.min(4, Number(maxConcurrentRequests) || 1));

    async function resolveFlights(origin, destination, date) {
      const outcome = await availabilityScope.resolve({ origin, destination, date });
      resolved += 1;
      updateProgress(resolved, Math.max(resolved, planned), `Checking ${origin} → ${destination} on ${date}`);
      return outcome;
    }

    async function resolveMany(segments) {
      planned += segments.length;
      return mapConcurrentOrdered(
        segments,
        probeConcurrency,
        segment => resolveFlights(segment.origin, segment.destination, segment.date)
      );
    }

    async function expandState(state, flightLegsRemaining) {
      if (isCancelled()) return;
      const previous = state.chain[state.chain.length - 1];
      const departureOrigins = allowChangeAirport
        ? nearbyAirports(code(previous.arrivalStation), airportLookup, connectionRadiusKm)
        : [code(previous.arrivalStation)];
      let dates = [selectedDate];
      if (allowOvernight) {
        const arrival = arrivalUtc(previous);
        const earliest = new Date(arrival.getTime() + minConnection * 60000);
        const latest = new Date(arrival.getTime() + maxConnection * 60000);
        dates = possibleLocalDates(earliest, latest, today, horizon);
      }
      const probes = [];
      const alternatives = new Map();
      for (const nextOrigin of departureOrigins) {
        for (const destination of routeCatalog.getDestinations(nextOrigin) ?? []) {
          if (isRouteExcluded(nextOrigin, destination) || !targets.size) continue;
          if (!allowOvernight && !routeCatalog.isDateAvailable(nextOrigin, destination, selectedDate)) continue;
          const candidateDates = dates.filter(date => routeCatalog.isDateAvailable(nextOrigin, destination, date));
          if (!candidateDates.length) continue;
          alternatives.set(`${nextOrigin}|${destination}`, candidateDates.length);
          for (const date of candidateDates) probes.push({ origin: nextOrigin, destination, date });
        }
      }
      probes.sort((left, right) => {
        const score = alternatives.get(`${left.origin}|${left.destination}`)
          - alternatives.get(`${right.origin}|${right.destination}`);
        return score || `${left.origin}-${left.destination}-${left.date}`.localeCompare(`${right.origin}-${right.destination}-${right.date}`);
      });
      const outcomes = await resolveMany(probes);
      const nextStates = [];
      const grouped = new Map();
      probes.forEach((probe, index) => {
        const groupKey = `${probe.origin}|${probe.destination}`;
        const group = grouped.get(groupKey) ?? { probe, outcomes: [] };
        group.outcomes.push({ probe, outcome: outcomes[index] });
        grouped.set(groupKey, group);
      });
      for (const { outcomes: groupedOutcomes } of grouped.values()) {
        let sawUnknown = false;
        let sawAvailable = false;
        for (const { probe, outcome } of groupedOutcomes) {
          if (outcome.state === AvailabilityState.UNKNOWN) {
            sawUnknown = true;
            continue;
          }
          if (outcome.state !== AvailabilityState.AVAILABLE) continue;
          sawAvailable = true;
          const flights = outcome.flights.filter(flight => requestedLocalDate(flight) === probe.date);
            for (const flight of flights) {
              const gap = minutesBetween(arrivalUtc(previous), departureUtc(flight));
              if (gap < minConnection || gap > maxConnection) continue;
              const chain = [...state.chain, flight];
              if (targets.has(code(flight.arrivalStation))) {
                const result = aggregateRoute(chain, airportLookup);
                if (result && !resultKeys.has(result.key)) {
                  resultKeys.add(result.key);
                  results.push(result);
                  if (appendResults) appendRouteToDisplay(result);
                }
              }
              if (flightLegsRemaining > 1) nextStates.push({ chain, legs: flightLegsRemaining - 1 });
            }
        }
        if (!sawAvailable && !sawUnknown) availabilityScope.diagnostics.prunedBranches += 1;
      }
      await mapConcurrentOrdered(nextStates, probeConcurrency, state => expandState(state, state.legs));
    }

    const firstProbes = [];
    for (const origin of viableOrigins) {
      for (const destination of routeCatalog.getDestinations(origin) ?? []) {
        if (isRouteExcluded(origin, destination) || !routeCatalog.isDateAvailable(origin, destination, selectedDate)) continue;
        firstProbes.push({ origin, destination, date: selectedDate });
      }
    }
    const destinationFanout = new Map();
    for (const probe of firstProbes) {
      destinationFanout.set(probe.destination, (destinationFanout.get(probe.destination) ?? 0) + 1);
    }
    firstProbes.sort((left, right) => {
      const score = (destinationFanout.get(right.destination) ?? 0)
        - (destinationFanout.get(left.destination) ?? 0);
      return score || `${left.origin}-${left.destination}`.localeCompare(`${right.origin}-${right.destination}`);
    });
    const firstOutcomes = await resolveMany(firstProbes);
    for (let probeIndex = 0; probeIndex < firstProbes.length; probeIndex += 1) {
        if (isCancelled()) break;
        const outcome = firstOutcomes[probeIndex];
        if (outcome.state !== AvailabilityState.AVAILABLE) continue;
        const flights = outcome.flights.filter(flight => requestedLocalDate(flight) === selectedDate);
        for (const flight of flights) {
          const airport = code(flight.arrivalStation);
          if (targets.has(airport)) {
            const result = aggregateRoute([flight], airportLookup);
            if (result && !resultKeys.has(result.key)) {
              resultKeys.add(result.key);
              results.push(result);
              if (appendResults) appendRouteToDisplay(result);
            }
          }
          if (maxFlights > 1) await expandState({ chain: [flight] }, maxFlights - 1);
        }
      }
    debugLogger(`Optimized connecting search completed: ${results.length} results, ${resolved} availability probes`);
    return results;
  }

  return Object.freeze({ search });
}
