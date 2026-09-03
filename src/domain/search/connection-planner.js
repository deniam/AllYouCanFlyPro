import { addDaysUTC, minutesBetween } from "../dates.js";
import { formatFlightDateCombined } from "../flight-normalizer.js";
import { haversineDistance } from "../airports.js";
import { AvailabilityState } from "../../infrastructure/cache-repository.js";
import { availabilityKey } from "./availability-service.js";

const MIN_LOCAL_OFFSET_MINUTES = -12 * 60;
const MAX_LOCAL_OFFSET_MINUTES = 14 * 60;
const COMPLETION_PRIORITY = 1_000_000;

function code(value) {
  return typeof value === "object" ? value?.id : value;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function utcText(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : String(value ?? "");
}

function departureUtc(flight) {
  return flight?.departureDateUtc ?? flight?.calculatedDuration?.departureDate;
}

function arrivalUtc(flight) {
  return flight?.arrivalDateUtc ?? flight?.calculatedDuration?.arrivalDate;
}

export function flightInstanceKey(flight) {
  if (flight?.key) return String(flight.key);
  return [
    code(flight?.departureStation),
    code(flight?.arrivalStation),
    utcText(departureUtc(flight)),
    utcText(arrivalUtc(flight))
  ].join("|");
}

function requestedLocalDate(flight) {
  return flight?.departureDateIso
    ?? flight?.calculatedDuration?.departureDate?.toISOString?.().slice(0, 10);
}

function dateRange(from, to) {
  const dates = [];
  for (let cursor = new Date(`${from}T00:00:00Z`);
    isoDate(cursor) <= to;
    cursor = addDaysUTC(cursor, 1)) {
    dates.push(isoDate(cursor));
  }
  return dates;
}

function possibleLocalDates(earliestUtc, latestUtc, bookingFrom, bookingTo) {
  const start = new Date(earliestUtc.getTime() + MIN_LOCAL_OFFSET_MINUTES * 60000);
  const end = new Date(latestUtc.getTime() + MAX_LOCAL_OFFSET_MINUTES * 60000);
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
    gaps.push(minutesBetween(arrivalUtc(chain[index]), departureUtc(chain[index + 1])));
  }
  const totalMinutes = minutesBetween(firstDeparture, lastArrival);
  const route = {
    key: chain.map(flightInstanceKey).join(" | "),
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
  for (let index = 0; index < chain.length - 1; index += 1) {
    const from = code(chain[index].arrivalStation);
    const to = code(chain[index + 1].departureStation);
    if (from === to) continue;
    const left = airportLookup?.[from];
    const right = airportLookup?.[to];
    const airportChange = {
      from,
      to,
      distanceKm: left && right && [left.latitude, left.longitude, right.latitude, right.longitude].every(Number.isFinite)
        ? Math.round(haversineDistance(left.latitude, left.longitude, right.latitude, right.longitude))
        : null
    };
    if (chain.length === 2) route.airportChange = airportChange;
    else route[index === 0 ? "airportChangeOne" : "airportChangeTwo"] = airportChange;
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
  const adjacency = new Map();
  const allCodes = new Set(routeCatalog.airportCodes ?? []);
  for (const origin of routeCatalog.airportCodes ?? []) {
    const destinations = [...(routeCatalog.getDestinations(origin) ?? [])];
    adjacency.set(origin, destinations);
    destinations.forEach(destination => allCodes.add(destination));
  }
  const nearbyIndexes = new Map();

  function nearbyAirports(codeValue, radiusKm) {
    if (!(Number(radiusKm) > 0)) return [codeValue];
    const radiusKey = String(Number(radiusKm));
    let index = nearbyIndexes.get(radiusKey);
    if (!index) {
      index = new Map();
      for (const airportCode of allCodes) {
        const base = airportLookup?.[airportCode];
        const neighbors = [airportCode];
        if (base && [base.latitude, base.longitude].every(Number.isFinite)) {
          for (const otherCode of allCodes) {
            if (otherCode === airportCode) continue;
            const airport = airportLookup?.[otherCode];
            if (!airport || ![airport.latitude, airport.longitude].every(Number.isFinite)) continue;
            if (haversineDistance(
              base.latitude,
              base.longitude,
              airport.latitude,
              airport.longitude
            ) <= Number(radiusKm)) neighbors.push(otherCode);
          }
        }
        index.set(airportCode, Object.freeze(neighbors));
      }
      nearbyIndexes.set(radiusKey, index);
    }
    return index.get(codeValue) ?? [codeValue];
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
    skipProgress = false
  }) {
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const maxFlights = Math.max(1, Number(maxTransfers) + 1);
    const bookingFrom = bookingWindow.from ?? isoDate(new Date());
    const horizon = bookingWindow.to
      ?? isoDate(addDaysUTC(new Date(`${bookingFrom}T00:00:00Z`), 3));
    const overnightDates = dateRange(selectedDate, horizon);
    const targets = new Set(destinations.includes("ANY") ? allCodes : destinations);
    const originCodes = origins.includes("ANY") ? [...allCodes] : origins;
    const changeAirport = allowChangeAirport && Number(connectionRadiusKm) > 0;
    const results = [];
    const resultKeys = new Set();
    const partialChainKeys = new Set();
    const plannedKeys = new Set();
    const resolvedKeys = new Set();
    const enqueueKeys = new Set();
    const scheduleProbe = availabilityScope.schedule?.bind(availabilityScope)
      ?? availabilityScope.resolve.bind(availabilityScope);

    function datesForLayer(layer, origin, destination) {
      const dates = layer === 0 || !allowOvernight ? [selectedDate] : overnightDates;
      return dates.filter(date => routeCatalog.isDateAvailable(origin, destination, date));
    }

    function buildRelevantLayers(useKnownAvailability) {
      const layers = Array.from({ length: maxFlights }, () => new Map());
      const memo = new Map();

      function edgeIsLive(layer, origin, destination) {
        if (isRouteExcluded(origin, destination)) return false;
        const dates = datesForLayer(layer, origin, destination);
        if (!dates.length) return false;
        if (!useKnownAvailability) return true;
        return dates.some(date =>
          availabilityScope.getKnown(availabilityKey(origin, destination, date))?.state
            !== AvailabilityState.UNAVAILABLE
        );
      }

      function canReach(origin, flightsLeft, layer) {
        const memoKey = `${origin}|${flightsLeft}|${layer}`;
        if (memo.has(memoKey)) return memo.get(memoKey);
        if (flightsLeft <= 0) return false;
        for (const destination of adjacency.get(origin) ?? []) {
          if (!edgeIsLive(layer, origin, destination)) continue;
          if (targets.has(destination)) {
            memo.set(memoKey, true);
            return true;
          }
          if (flightsLeft <= 1) continue;
          const nextOrigins = changeAirport
            ? nearbyAirports(destination, connectionRadiusKm)
            : [destination];
          if (nextOrigins.some(next => canReach(next, flightsLeft - 1, layer + 1))) {
            memo.set(memoKey, true);
            return true;
          }
        }
        memo.set(memoKey, false);
        return false;
      }

      const collected = new Set();
      function collect(origin, flightsLeft, layer) {
        const stateKey = `${origin}|${flightsLeft}|${layer}`;
        if (collected.has(stateKey) || flightsLeft <= 0) return;
        collected.add(stateKey);
        for (const destination of adjacency.get(origin) ?? []) {
          if (!edgeIsLive(layer, origin, destination)) continue;
          const nextOrigins = flightsLeft > 1
            ? (changeAirport ? nearbyAirports(destination, connectionRadiusKm) : [destination])
              .filter(next => canReach(next, flightsLeft - 1, layer + 1))
            : [];
          if (!targets.has(destination) && !nextOrigins.length) continue;
          const layerOrigins = layers[layer];
          const layerDestinations = layerOrigins.get(origin) ?? new Set();
          layerDestinations.add(destination);
          layerOrigins.set(origin, layerDestinations);
          for (const next of nextOrigins) collect(next, flightsLeft - 1, layer + 1);
        }
      }

      const viableOrigins = originCodes.filter(origin => canReach(origin, maxFlights, 0));
      viableOrigins.forEach(origin => collect(origin, maxFlights, 0));
      return { layers, viableOrigins };
    }

    const structural = buildRelevantLayers(false);
    const preflightSegmentsByKey = new Map();
    for (let layer = 0; layer < structural.layers.length; layer += 1) {
      for (const [origin, layerDestinations] of structural.layers[layer]) {
        for (const destination of layerDestinations) {
          for (const date of datesForLayer(layer, origin, destination)) {
            const segment = { origin, destination, date };
            preflightSegmentsByKey.set(availabilityKey(origin, destination, date), segment);
          }
        }
      }
    }
    const preflightSegments = [...preflightSegmentsByKey.values()];
    await availabilityScope.preflight(preflightSegments);
    if (isCancelled()) return results;
    const relevant = buildRelevantLayers(true);

    let pendingEvents = 0;
    const completedEvents = [];
    let completedEventsHead = 0;
    let eventWaiter = null;

    function publishEvent(event) {
      completedEvents.push(event);
      eventWaiter?.();
      eventWaiter = null;
    }

    async function nextEvent() {
      if (completedEventsHead >= completedEvents.length) {
        await new Promise(resolve => { eventWaiter = resolve; });
      }
      const event = completedEvents[completedEventsHead++];
      if (completedEventsHead > 1024 && completedEventsHead * 2 > completedEvents.length) {
        completedEvents.splice(0, completedEventsHead);
        completedEventsHead = 0;
      }
      return event;
    }

    function priorityFor({ destination, remainingFlights, dateAlternatives = 1 }) {
      const completion = targets.has(destination) ? COMPLETION_PRIORITY : 0;
      const branchValue = 10_000 / Math.max(1, dateAlternatives);
      const proximity = (maxFlights - remainingFlights) * 100;
      return completion + branchValue + proximity;
    }

    function enqueueProbe(probe, context, priority) {
      if (isCancelled()) return;
      const probeKey = availabilityKey(probe.origin, probe.destination, probe.date);
      const contextKey = `${context.chainKey ?? "root"}|${probeKey}`;
      if (enqueueKeys.has(contextKey)) return;
      enqueueKeys.add(contextKey);
      plannedKeys.add(probeKey);
      pendingEvents += 1;
      Promise.resolve(scheduleProbe(probe, { priority }))
        .then(
          outcome => publishEvent({ probe, context, outcome, probeKey }),
          error => publishEvent({ probe, context, error, probeKey })
        );
    }

    function finishAlternative(context, compatibleFlights, outcome) {
      const group = context.alternativeGroup;
      if (!group) return;
      group.remaining -= 1;
      if (compatibleFlights > 0) group.sawCompatibleFlight = true;
      if (outcome?.state === AvailabilityState.UNKNOWN) group.sawUnknown = true;
      if (group.remaining === 0 && !group.sawCompatibleFlight && !group.sawUnknown) {
        availabilityScope.diagnostics.prunedBranches += 1;
      }
    }

    function emitResult(chain) {
      const result = aggregateRoute(chain, airportLookup);
      if (!result || resultKeys.has(result.key)) return;
      resultKeys.add(result.key);
      results.push(result);
      if (appendResults) appendRouteToDisplay(result);
    }

    function scheduleNextState(chain, flightsRemaining) {
      if (isCancelled() || flightsRemaining <= 0) return;
      const previous = chain[chain.length - 1];
      const previousArrival = arrivalUtc(previous);
      if (!(previousArrival instanceof Date) || Number.isNaN(previousArrival.getTime())) return;
      const layer = chain.length;
      const departureOrigins = changeAirport
        ? nearbyAirports(code(previous.arrivalStation), connectionRadiusKm)
        : [code(previous.arrivalStation)];
      let dates = [selectedDate];
      if (allowOvernight) {
        dates = possibleLocalDates(
          new Date(previousArrival.getTime() + Number(minConnection) * 60000),
          new Date(previousArrival.getTime() + Number(maxConnection) * 60000),
          bookingFrom,
          horizon
        );
      }
      const chainKey = chain.map(flightInstanceKey).join("|");
      for (const nextOrigin of departureOrigins) {
        const destinationsForLayer = relevant.layers[layer]?.get(nextOrigin) ?? new Set();
        for (const destination of destinationsForLayer) {
          const candidateDates = dates.filter(date =>
            routeCatalog.isDateAvailable(nextOrigin, destination, date)
          );
          if (!candidateDates.length) continue;
          const alternativeGroup = {
            remaining: candidateDates.length,
            sawCompatibleFlight: false,
            sawUnknown: false
          };
          for (const date of candidateDates) {
            const probe = { origin: nextOrigin, destination, date };
            const context = {
              chain,
              chainKey,
              previous,
              remainingFlights: flightsRemaining - 1,
              alternativeGroup
            };
            enqueueProbe(probe, context, priorityFor({
              destination,
              remainingFlights: flightsRemaining - 1,
              dateAlternatives: candidateDates.length
            }));
          }
        }
      }
    }

    function processAvailableFlights(probe, context, outcome) {
      let compatibleFlights = 0;
      for (const flight of outcome.flights ?? []) {
        if (requestedLocalDate(flight) !== probe.date) continue;
        if (context.previous) {
          const gap = minutesBetween(arrivalUtc(context.previous), departureUtc(flight));
          if (gap < Number(minConnection) || gap > Number(maxConnection)) continue;
        }
        compatibleFlights += 1;
        const chain = [...(context.chain ?? []), flight];
        const chainKey = chain.map(flightInstanceKey).join("|");
        if (partialChainKeys.has(chainKey)) continue;
        partialChainKeys.add(chainKey);
        if (targets.has(code(flight.arrivalStation))) emitResult(chain);
        if (context.remainingFlights > 0) scheduleNextState(chain, context.remainingFlights);
      }
      return compatibleFlights;
    }

    for (const origin of relevant.viableOrigins) {
      for (const destination of relevant.layers[0]?.get(origin) ?? []) {
        const probe = { origin, destination, date: selectedDate };
        const alternativeGroup = {
          remaining: 1,
          sawCompatibleFlight: false,
          sawUnknown: false
        };
        enqueueProbe(probe, {
          chain: [],
          chainKey: "root",
          previous: null,
          remainingFlights: maxFlights - 1,
          alternativeGroup
        }, priorityFor({ destination, remainingFlights: maxFlights - 1 }));
      }
    }

    while (pendingEvents > 0 && !isCancelled()) {
      const event = await nextEvent();
      pendingEvents -= 1;
      if (event.error) throw event.error;
      if (!resolvedKeys.has(event.probeKey)) {
        resolvedKeys.add(event.probeKey);
        if (!skipProgress) {
          updateProgress(
            resolvedKeys.size,
            Math.max(resolvedKeys.size, plannedKeys.size),
            `Checking ${event.probe.origin} → ${event.probe.destination} on ${event.probe.date}`
          );
        }
      }
      const compatibleFlights = event.outcome.state === AvailabilityState.AVAILABLE
        ? processAvailableFlights(event.probe, event.context, event.outcome)
        : 0;
      finishAlternative(event.context, compatibleFlights, event.outcome);
    }

    debugLogger(
      `Lazy connecting search completed: ${results.length} results, ` +
      `${resolvedKeys.size}/${plannedKeys.size} unique availability probes, ` +
      `${preflightSegments.length} relevant cache keys`
    );
    debugLogger("[perf:planner]", {
      durationMs: (globalThis.performance?.now?.() ?? Date.now()) - startedAt,
      resultCount: results.length,
      preflightKeyCount: preflightSegments.length,
      plannedProbeCount: plannedKeys.size
    });
    return results;
  }

  return Object.freeze({ search });
}
