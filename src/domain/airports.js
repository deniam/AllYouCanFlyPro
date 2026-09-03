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
  const groups = context.groups ?? {};
  const airports = context.airports ?? [];
  const countries = context.countries ?? {};
  const expand = codes => [...new Set(codes.flatMap(code => groups[normalizeAirportCode(code)] ?? [code]))];
  if (groups[upper]) return expand(groups[upper]);

  const group = Object.keys(groups).find(key => {
    const name = context.groupName?.(key) ?? key;
    return name.toLowerCase() === value.toLowerCase();
  });
  if (group) return expand(groups[group]);

  const anyGroup = value.match(/^(.+)\(any\)$/i);
  if (anyGroup) {
    const derivedKey = normalizeAirportCode(anyGroup[1].trim().slice(0, 3));
    if (groups[derivedKey]) return expand(groups[derivedKey]);
  }

  const country = Object.keys(countries).find(
    name => name.toLowerCase() === value.toLowerCase()
  );
  if (country) return [...countries[country]];

  const codeMatch = value.match(/\(([A-Z0-9]{3,6})\)\s*$/i);
  const candidateCode = normalizeAirportCode(codeMatch?.[1] ?? value);
  const airport = airports.find(item =>
    item.code === candidateCode || item.name.toLowerCase() === value.toLowerCase()
  );
  if (airport) return expand([airport.code]);

  const matches = airports.filter(item => item.name.toLowerCase().includes(value.toLowerCase()));
  if (matches.length) return expand(matches.map(item => item.code));
  return context.fallbackUnknown ? [upper] : [];
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
