import { minutesBetween } from "../dates.js";

export function deduplicateFlights(flights, keyOf = defaultFlightKey) {
  const seen = new Set();
  return flights.filter(flight => {
    const key = keyOf(flight);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function defaultFlightKey(flight) {
  if (flight?.key) return flight.key;
  const route = Array.isArray(flight?.route) ? flight.route.join("-") : flight?.flightCode ?? "flight";
  const departure = flight?.calculatedDuration?.departureDate;
  return `${route}|${departure instanceof Date ? departure.getTime() : departure ?? ""}`;
}

export function matchReturnFlights(outbound, inboundFlights, {
  origins,
  destinations,
  minGapMinutes = 360
}) {
  const outboundOrigin = outbound.route?.[0]
    ?? outbound.departureStation?.id
    ?? outbound.departureStation;
  const outboundDestination = outbound.route?.at(-1)
    ?? outbound.arrivalStation?.id
    ?? outbound.arrivalStation;
  const outboundArrival = outbound.calculatedDuration?.arrivalDate;
  if (!(outboundArrival instanceof Date)) return [];

  return deduplicateFlights(inboundFlights.filter(inbound => {
    const inboundOrigin = inbound.route?.[0]
      ?? inbound.departureStation?.id
      ?? inbound.departureStation;
    const inboundDestination = inbound.route?.at(-1)
      ?? inbound.arrivalStation?.id
      ?? inbound.arrivalStation;
    const inboundDeparture = inbound.calculatedDuration?.departureDate;
    return destinations.includes(outboundDestination)
      && origins.includes(outboundOrigin)
      && inboundOrigin === outboundDestination
      && inboundDestination === outboundOrigin
      && inboundDeparture instanceof Date
      && minutesBetween(outboundArrival, inboundDeparture) >= minGapMinutes;
  }));
}
