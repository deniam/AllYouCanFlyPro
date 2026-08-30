export function addDaysUTC(date, days) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function parseLocalDate(dateText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText));
  if (!match) return new Date(Number.NaN);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function normalizeOffset(offset) {
  if (!offset) return "UTC";
  const text = String(offset).trim().replace(/^UTC/i, "");
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(text);
  if (!match) return "UTC";
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  if (hours === 0 && minutes === 0) return "UTC";
  return `UTC${match[1]}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

export function offsetToIso(offset) {
  const normalized = normalizeOffset(offset);
  if (normalized === "UTC") return "Z";
  const match = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/.exec(normalized);
  if (!match) return "Z";
  return `${match[1]}${String(Number(match[2])).padStart(2, "0")}:${match[3] ?? "00"}`;
}

export function parseFlightDateTime(dateTime, offset = "UTC") {
  if (!dateTime) return null;
  if (dateTime instanceof Date) return new Date(dateTime.getTime());
  const text = String(dateTime).trim();
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(text)) return new Date(text.replace(" ", "T"));
  return new Date(`${text.replace(" ", "T")}${offsetToIso(offset)}`);
}

export function minutesBetween(earlier, later) {
  return Math.round((later.getTime() - earlier.getTime()) / 60000);
}
