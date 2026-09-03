import { segmentCacheKey } from "../../infrastructure/cache-repository.js";

function stationCode(value) {
  if (value && typeof value === "object") return value.id ?? value.code ?? "";
  return value ?? "";
}

function localDepartureDate(flight) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(flight?.departureDateIso ?? "")) {
    return flight.departureDateIso;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(flight?.departureDate ?? "")) {
    return flight.departureDate;
  }
  const local = flight?.calculatedDuration?.departureDate;
  return local instanceof Date && !Number.isNaN(local.getTime())
    ? local.toISOString().slice(0, 10)
    : null;
}

export function collectResultRefreshKeys(result, { includeReturns = false } = {}) {
  const keys = new Set();
  const visit = flight => {
    const segments = Array.isArray(flight?.segments) && flight.segments.length
      ? flight.segments
      : [flight];
    for (const segment of segments) {
      const origin = stationCode(segment.departureStationCode ?? segment.departureStation);
      const destination = stationCode(segment.arrivalStationCode ?? segment.arrivalStation);
      const date = localDepartureDate(segment);
      if (origin && destination && date) keys.add(segmentCacheKey(origin, destination, date));
    }
  };
  visit(result);
  if (includeReturns) (result?.returnFlights ?? []).forEach(visit);
  return keys;
}

export function oldestCheckedAt(keys, outcomesByKey) {
  const timestamps = [...keys]
    .map(key => outcomesByKey.get(key)?.checkedAt)
    .filter(Number.isFinite);
  return timestamps.length ? Math.min(...timestamps) : null;
}

export function shouldSkipStageProgress(streamResults, requestedSkipProgress = false) {
  return !streamResults || requestedSkipProgress;
}
