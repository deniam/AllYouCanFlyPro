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
