/**
 * @param {string} value
 */
export function normalizeAirportCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Resolves an autocomplete value to concrete airport codes without DOM access.
 * @param {string} input
 * @param {{airports: Array<{code:string,name:string,country?:string}>, countries: Record<string,string[]>, groups: Record<string,string[]>, groupName?: (key:string)=>string}} context
 */
export function resolveAirport(input, context) {
  const value = String(input ?? "").trim();
  if (!value) return [];
  if (/^(any|anywhere)$/i.test(value)) return ["ANY"];

  const upper = normalizeAirportCode(value);
  if (context.groups[upper]) return [...context.groups[upper]];

  const group = Object.keys(context.groups).find(key => {
    const name = context.groupName?.(key) ?? key;
    return name.toLowerCase() === value.toLowerCase();
  });
  if (group) return [...context.groups[group]];

  const country = Object.keys(context.countries).find(
    name => name.toLowerCase() === value.toLowerCase()
  );
  if (country) return [...context.countries[country]];

  const codeMatch = value.match(/\(([A-Z0-9]{3,6})\)\s*$/i);
  const candidateCode = normalizeAirportCode(codeMatch?.[1] ?? value);
  const airport = context.airports.find(item =>
    item.code === candidateCode || item.name.toLowerCase() === value.toLowerCase()
  );
  return airport ? [airport.code] : [];
}

export function expandAirportCodes(codes, groups) {
  return [...new Set(codes.flatMap(code => groups[normalizeAirportCode(code)] ?? [normalizeAirportCode(code)]))];
}

export function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = value => value * Math.PI / 180;
  const radius = 6371;
  const latitudeDelta = toRad(lat2 - lat1);
  const longitudeDelta = toRad(lon2 - lon1);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(longitudeDelta / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
