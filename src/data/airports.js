import Dexie from '../libs/dexie.mjs';

// Initialize Dexie database (ensure the version and store definitions match your app)
const db = new Dexie("FlightSearchCache");
db.version(1).stores({
  cache: 'key, timestamp'
});
db.version(2).stores({
  cache: 'key, timestamp',
  routes: '++id, departureStation'
});

// Mapping for multi-airport cities:
// Keys are the city code used in autocomplete, values are arrays of actual airport codes.
export const MULTI_AIRPORT_CITIES = {
  "LON": ["LTN", "LGW"],
  "PAR": ["ORY", "BVA"],
  "MIL": ["MXP", "BGY"],
  "ROM": ["FCO", "CIA"],
  "VEN": ["VCE", "TSF"],
  "CAM": ["NAP", "QSR"],
  "OOS": ["OSL", "TRF"],
  "STO": ["ARN", "NYO"],
  "EAP": ["BSL", "MLH"],
  "BUH": ["OTP", "BBU"],
  "CAN": ["FUE", "LPA", "TFS"],
  "VAL": ["VLC", "CDT"],
  "BAR": ["BCN", "GRO"],
  "SAR": ["AHO", "OLB"],
  "BLS": ["VAR", "BOJ"],
  "CRE": ["HER", "CHQ"],
  "GRI": ["CFU", "HER", "CHQ", "JMK", "JSI", "JTR", "RHO", "SKG", "ZTH"]
};

// Country flag mapping.
const flagMapping = {
  "Albania": "🇦🇱",
  "Armenia": "🇦🇲",
  "Austria": "🇦🇹",
  "Azerbaijan": "🇦🇿",
  "Belgium": "🇧🇪",
  "Bosnia and Herzegovina": "🇧🇦",
  "Bulgaria": "🇧🇬",
  "Croatia": "🇭🇷",
  "Cyprus": "🇨🇾",
  "Czech Republic": "🇨🇿",
  "Denmark": "🇩🇰",
  "Egypt": "🇪🇬",
  "Estonia": "🇪🇪",
  "Finland": "🇫🇮",
  "France": "🇫🇷",
  "Georgia": "🇬🇪",
  "Germany": "🇩🇪",
  "Greece": "🇬🇷",
  "Hungary": "🇭🇺",
  "Iceland": "🇮🇸",
  "Israel": "🇮🇱",
  "Italy": "🇮🇹",
  "Jordan": "🇯🇴",
  "Kazakhstan": "🇰🇿",
  "Kosovo": "🇽🇰",
  "Kyrgyzstan": "🇰🇬",
  "Latvia": "🇱🇻",
  "Lebanon": "🇱🇧",
  "Lithuania": "🇱🇹",
  "Maldives": "🇲🇻",
  "Malta": "🇲🇹",
  "Moldova": "🇲🇩",
  "Montenegro": "🇲🇪",
  "Morocco": "🇲🇦",
  "Netherlands": "🇳🇱",
  "North Macedonia": "🇲🇰",
  "Norway": "🇳🇴",
  "Oman": "🇴🇲",
  "Poland": "🇵🇱",
  "Portugal": "🇵🇹",
  "Romania": "🇷🇴",
  "Saudi Arabia": "🇸🇦",
  "Serbia": "🇷🇸",
  "Slovakia": "🇸🇰",
  "Slovenia": "🇸🇮",
  "Spain": "🇪🇸",
  "Sweden": "🇸🇪",
  "Switzerland": "🇨🇭",
  "Türkiye": "🇹🇷",
  "United Arab Emirates": "🇦🇪",
  "United Kingdom": "🇬🇧",
  "Uzbekistan": "🇺🇿"
};

// Helper to return the flag for a given country.
function getCountryFlag(country) {
  return flagMapping[country] || "";
}

// Helper to look up a display name for multi-airport cities.
export function cityNameLookup(cityCode) {
  const mapping = {
    "LON": "London (Any)",
    "PAR": "Paris (Any)",
    "MIL": "Milan (Any)",
    "ROM": "Rome (Any)",
    "VEN": "Venice (Any)",
    "CAM": "Naples (Any)",
    "OOS": "Oslo (Any)",
    "STO": "Stockholm (Any)",
    "EAP": "Basel (Any)",
    "BUH": "Bucharest (Any)",
    "CAN": "Canary Islands (Any)",
    "VAL": "Valencia (Any)",
    "BAR": "Barcelona (Any)",
    "SAR": "Sardinia (Any)",
    "BLS": "Black Sea (Any)",
    "CRE": "Crete (Any)",
    "GRI": "Greek Islands (Any)"
  };
  return mapping[cityCode] || cityCode;
}

/**
 * Loads route data from the IndexedDB and builds the airports and country mappings.
 * It reads departure station data from all routes and then augments the collection
 * with additional multi-airport city entries defined in MULTI_AIRPORT_CITIES.
 *
 * @returns {Promise<{AIRPORTS: Array, COUNTRY_AIRPORTS: Object}>}
 */
export async function loadAirportsData() {
  // Retrieve all routes from IndexedDB.
  const routes = await db.routes.toArray();
  const airportsMap = new Map();

  // Process both departure and arrival stations.
  routes.forEach(route => {
    // Process departureStation.
    const dep = route.departureStation;
    if (dep && dep.id) {
      airportsMap.set(dep.id, {
        code: dep.id,
        name: `${dep.name} (${dep.id})`,
        country: dep.country,
        longitude: dep.longitude,
        latitude: dep.latitude,
        flag: getCountryFlag(dep.country)
      });
    }
    // Process each arrivalStation.
    if (route.arrivalStations && Array.isArray(route.arrivalStations)) {
      route.arrivalStations.forEach(arr => {
        if (arr && arr.id && !airportsMap.has(arr.id)) {
          airportsMap.set(arr.id, {
            code: arr.id,
            name: `${arr.name} (${arr.id})`,
            country: arr.country,
            flag: getCountryFlag(arr.country)
          });
        }
      });
    }
  });

  // Add multi-airport city entries.
  Object.keys(MULTI_AIRPORT_CITIES).forEach(cityCode => {
    const airportCodes = MULTI_AIRPORT_CITIES[cityCode];
    let country = "";
    for (let code of airportCodes) {
      if (airportsMap.has(code)) {
        country = airportsMap.get(code).country;
        break;
      }
    }
    airportsMap.set(cityCode, {
      code: cityCode,
      name: cityNameLookup(cityCode),
      country: country,
      flag: getCountryFlag(country)
    });
  });

  // Convert map to a sorted array.
  const AIRPORTS = Array.from(airportsMap.values()).sort((a, b) =>
    a.code.localeCompare(b.code)
  );

  // Build a mapping of countries to their airport codes.
  const COUNTRY_AIRPORTS = AIRPORTS.reduce((acc, airport) => {
    if (!acc[airport.country]) {
      acc[airport.country] = [];
    }
    acc[airport.country].push(airport.code);
    return acc;
  }, {});

  return { AIRPORTS, COUNTRY_AIRPORTS };
}