import { addDaysUTC } from "../dates.js";

const DEFAULT_BOOKING_HORIZON_DAYS = 3;

function utcDateText(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Selects an API arrival date that can warm the reverse segment cache.
 * Explicit return dates may be same-day; automatic warm-up prefers a later day.
 */
export function createPairedDateSelector({
  routeCatalog,
  lookupMany,
  getCached,
  now = () => new Date(),
  bookingHorizonDays = DEFAULT_BOOKING_HORIZON_DAYS
}) {
  const reservations = new Set();
  const reservationKey = (origin, destination, date) => `${origin}-${destination}-${date}`;

  async function firstUncached(origin, destination, dates) {
    const candidates = [];
    for (const date of dates) {
      const key = reservationKey(origin, destination, date);
      if (reservations.has(key)) continue;
      reservations.add(key);
      candidates.push({ date, key });
    }
    if (!candidates.length) return null;

    const cachedByKey = typeof lookupMany === "function"
      ? await lookupMany(candidates.map(candidate => candidate.key))
      : new Map();
    let selectedDate = null;
    for (const candidate of candidates) {
      const cached = typeof lookupMany === "function"
        ? cachedByKey.get(candidate.key)
        : await getCached?.(origin, destination, candidate.date);
      const isCached = typeof lookupMany === "function"
        ? cached?.state === "available" || cached?.state === "unavailable"
        : Array.isArray(cached);
      if (!isCached) {
        selectedDate = candidate.date;
        break;
      }
    }
    candidates.forEach(candidate => {
      if (candidate.date !== selectedDate) reservations.delete(candidate.key);
    });
    return selectedDate;
  }

  async function selectPairedArrivalDate({
    origin,
    destination,
    departureDate,
    preferredReturnDates = []
  }) {
    const reverseDates = routeCatalog.getFlightDates(destination, origin);
    if (!reverseDates.length) return "";

    const today = new Date(now());
    const todayUtc = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate()
    ));
    const horizon = utcDateText(addDaysUTC(todayUtc, bookingHorizonDays));
    const available = new Set(reverseDates.filter(date => date <= horizon));
    const preferred = [...new Set(preferredReturnDates)]
      .filter(date => date >= departureDate && available.has(date))
      .sort();

    const uncachedPreferred = await firstUncached(destination, origin, preferred);
    if (uncachedPreferred) {
      reservations.add(reservationKey(destination, origin, uncachedPreferred));
      return uncachedPreferred;
    }

    const laterDates = reverseDates
      .filter(date => date > departureDate && date <= horizon)
      .sort();
    const uncachedLater = await firstUncached(destination, origin, laterDates);
    if (uncachedLater) {
      reservations.add(reservationKey(destination, origin, uncachedLater));
      return uncachedLater;
    }

    if (departureDate >= horizon && available.has(departureDate)) {
      const uncachedSameDay = await firstUncached(destination, origin, [departureDate]);
      if (uncachedSameDay) {
        reservations.add(reservationKey(destination, origin, uncachedSameDay));
        return uncachedSameDay;
      }
    }

    const fallback = preferred.find(date => !reservations.has(
      reservationKey(destination, origin, date)
    )) ?? laterDates.find(date => !reservations.has(
      reservationKey(destination, origin, date)
    )) ?? preferred[0] ?? laterDates[0]
      ?? (departureDate >= horizon && available.has(departureDate) ? departureDate : "");
    if (fallback) reservations.add(reservationKey(destination, origin, fallback));
    return fallback;
  }

  selectPairedArrivalDate.release = ({ origin, destination, arrivalDate }) => {
    if (arrivalDate) reservations.delete(reservationKey(destination, origin, arrivalDate));
  };
  selectPairedArrivalDate.reset = () => reservations.clear();
  return selectPairedArrivalDate;
}
