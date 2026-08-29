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
  getCached,
  now = () => new Date(),
  bookingHorizonDays = DEFAULT_BOOKING_HORIZON_DAYS
}) {
  async function firstUncached(origin, destination, dates) {
    for (const date of dates) {
      const cached = await getCached(origin, destination, date);
      if (!Array.isArray(cached)) return date;
    }
    return null;
  }

  return async function selectPairedArrivalDate({
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
    if (uncachedPreferred) return uncachedPreferred;

    const laterDates = reverseDates
      .filter(date => date > departureDate && date <= horizon)
      .sort();
    const uncachedLater = await firstUncached(destination, origin, laterDates);
    if (uncachedLater) return uncachedLater;

    if (departureDate >= horizon && available.has(departureDate)) {
      const uncachedSameDay = await firstUncached(destination, origin, [departureDate]);
      if (uncachedSameDay) return uncachedSameDay;
    }

    return preferred[0]
      ?? laterDates[0]
      ?? (departureDate >= horizon && available.has(departureDate) ? departureDate : "");
  };
}
