export function parse12HourTime(timeText) {
  const match = String(timeText ?? "").trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (match[3].toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (match[3].toLowerCase() === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

export function convertTo24Hour(timeText) {
  const parsed = parse12HourTime(timeText);
  return parsed
    ? `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`
    : timeText;
}

export function normalizeFlightOffset(offset) {
  const text = String(offset ?? "UTC").trim().toUpperCase();
  if (!text || text === "UTC") return "+00:00";
  const match = text.match(/^(?:UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return text;
  return `${match[1]}${String(Number(match[2])).padStart(2, "0")}:${match[3] ?? "00"}`;
}

function offsetMinutes(offset) {
  const match = normalizeFlightOffset(offset).match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function combineDateAndTime(dateText, time) {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, time.hour, time.minute));
}

export function parseServerDate(value) {
  if (!value) return null;
  if (value instanceof Date) return new Date(value.getTime());
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00Z`);
  const match = String(value).trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (match) {
    const months = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    const month = months.indexOf(match[2]);
    if (month >= 0) return new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  }
  return new Date(value);
}

export function formatFlightDateSingle(value) {
  const date = value instanceof Date ? value : parseServerDate(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

export function formatFlightDateCombined(departure, arrival) {
  const departureDate = departure instanceof Date ? departure : parseServerDate(departure);
  const arrivalDate = arrival instanceof Date ? arrival : parseServerDate(arrival);
  if (!departureDate || !arrivalDate) return "";
  return departureDate.toDateString() === arrivalDate.toDateString()
    ? formatFlightDateSingle(departureDate)
    : `${formatFlightDateSingle(departureDate)} - ${formatFlightDateSingle(arrivalDate)}`;
}

export function formatOffsetForDisplay(offset) {
  const normalized = normalizeFlightOffset(offset);
  const match = normalized.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match || (match[2] === "00" && match[3] === "00")) return "UTC";
  const minutes = match[3] === "00" ? "" : `:${match[3]}`;
  return `UTC${match[1]}${Number(match[2])}${minutes}`;
}

export function unifyRawFlight(rawFlight) {
  const parsedDepartureDate = parseServerDate(rawFlight.departureDate);
  const parsedArrivalDate = parseServerDate(rawFlight.arrivalDate);
  const departureDateText = rawFlight.departureDateIso
    ?? parsedDepartureDate?.toISOString().slice(0, 10);
  const arrivalDateText = rawFlight.arrivalDateIso
    ?? parsedArrivalDate?.toISOString().slice(0, 10);
  const departureTime = parse12HourTime(rawFlight.departure);
  const arrivalTime = parse12HourTime(rawFlight.arrival);
  if (!departureDateText || !arrivalDateText || !departureTime || !arrivalTime) return rawFlight;

  const localDeparture = combineDateAndTime(departureDateText, departureTime);
  let localArrival = combineDateAndTime(arrivalDateText, arrivalTime);
  const departureOffset = normalizeFlightOffset(rawFlight.departureOffsetText);
  const arrivalOffset = normalizeFlightOffset(rawFlight.arrivalOffsetText);
  const utcDeparture = new Date(localDeparture.getTime() - offsetMinutes(departureOffset) * 60000);
  let utcArrival = new Date(localArrival.getTime() - offsetMinutes(arrivalOffset) * 60000);
  if (utcArrival <= utcDeparture) {
    localArrival = new Date(localArrival.getTime() + 86400000);
    utcArrival = new Date(utcArrival.getTime() + 86400000);
  }
  const totalMinutes = Math.round((utcArrival - utcDeparture) / 60000);

  return {
    ...rawFlight,
    departureDateUtc: utcDeparture,
    arrivalDateUtc: utcArrival,
    departureOffset,
    arrivalOffset,
    displayDeparture: convertTo24Hour(rawFlight.departure),
    displayArrival: convertTo24Hour(rawFlight.arrival),
    calculatedDuration: {
      hours: Math.floor(totalMinutes / 60),
      minutes: totalMinutes % 60,
      totalMinutes,
      departureDate: localDeparture,
      arrivalDate: localArrival
    },
    formattedFlightDate: formatFlightDateCombined(rawFlight.departureDate, rawFlight.arrivalDate),
    route: [rawFlight.departureStationText, rawFlight.arrivalStationText]
  };
}
