const CACHE_KEY = "routesDatasetCache";
const DEFAULT_MANIFEST_URL = "https://deniam.github.io/AllYouCanFlyPro/routes-manifest.json";
const DEFAULT_ROUTES_URL = "https://deniam.github.io/AllYouCanFlyPro/routes.json";
const DEFAULT_MAXIMUM_BYTES = 4_000_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IATA_PATTERN = /^[A-Z0-9]{3}$/;

function datasetStats(routes) {
  let connectionCount = 0;
  let flightDateCount = 0;
  for (const route of routes) {
    connectionCount += route.arrivalStations?.length ?? 0;
    for (const arrival of route.arrivalStations ?? []) {
      flightDateCount += arrival.flightDates?.length ?? 0;
    }
  }
  return { routeCount: routes.length, connectionCount, flightDateCount };
}

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) return false;
  if (typeof manifest.datasetVersion !== "string" || !manifest.datasetVersion) return false;
  if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) return false;
  if (!DATE_PATTERN.test(manifest.scanRange?.from ?? "")) return false;
  if (!DATE_PATTERN.test(manifest.scanRange?.to ?? "")) return false;
  return ["routeCount", "connectionCount", "flightDateCount", "serializedBytes"]
    .every(key => Number.isInteger(manifest[key]) && manifest[key] >= 0);
}

export function validateRoutesDataset(routes, manifest, maximumBytes = DEFAULT_MAXIMUM_BYTES) {
  const errors = [];
  const pairs = new Set();
  const departures = new Set();
  if (!Array.isArray(routes) || routes.length === 0) errors.push("Routes must be a non-empty array");

  for (const route of routes ?? []) {
    const departureStation = route?.departureStation;
    const departure = departureStation?.id;
    if (!IATA_PATTERN.test(departure ?? "")) errors.push("Invalid departure station");
    if (typeof departureStation?.name !== "string" || !departureStation.name) errors.push(`Missing departure name for ${departure}`);
    if (typeof departureStation?.country !== "string" || !departureStation.country) errors.push(`Missing departure country for ${departure}`);
    if (!Number.isFinite(departureStation?.longitude) || !Number.isFinite(departureStation?.latitude)) {
      errors.push(`Invalid departure coordinates for ${departure}`);
    }
    if (departures.has(departure)) errors.push(`Duplicate departure station: ${departure}`);
    departures.add(departure);
    if (!Array.isArray(route?.arrivalStations)) errors.push(`Missing arrivals for ${departure}`);

    for (const arrival of route?.arrivalStations ?? []) {
      const pair = `${departure}-${arrival?.id}`;
      if (!IATA_PATTERN.test(arrival?.id ?? "")) errors.push(`Invalid arrival station for ${departure}`);
      if (typeof arrival?.name !== "string" || !arrival.name) errors.push(`Missing arrival name for ${pair}`);
      if (typeof arrival?.country !== "string" || !arrival.country) errors.push(`Missing arrival country for ${pair}`);
      if (pairs.has(pair)) errors.push(`Duplicate route: ${pair}`);
      pairs.add(pair);
      if (arrival.operationStartDate && !DATE_PATTERN.test(arrival.operationStartDate)) {
        errors.push(`Invalid operationStartDate for ${pair}`);
      }
      if (!Array.isArray(arrival.flightDates)) {
        errors.push(`Missing flightDates for ${pair}`);
      } else {
        const uniqueDates = new Set(arrival.flightDates);
        if (uniqueDates.size !== arrival.flightDates.length) errors.push(`Duplicate flightDates for ${pair}`);
        if (arrival.flightDates.some(date => !DATE_PATTERN.test(date))) errors.push(`Invalid flightDates for ${pair}`);
        if (arrival.flightDates.some((date, index) => index > 0 && date < arrival.flightDates[index - 1])) {
          errors.push(`Unsorted flightDates for ${pair}`);
        }
      }
    }
  }

  const canonicalJson = JSON.stringify(routes);
  const serializedBytes = new TextEncoder().encode(canonicalJson).byteLength;
  if (serializedBytes > maximumBytes) errors.push("Routes dataset exceeds the local cache size limit");
  const stats = datasetStats(routes ?? []);
  if (manifest) {
    if (!validateManifest(manifest)) errors.push("Invalid routes manifest");
    for (const key of ["routeCount", "connectionCount", "flightDateCount", "serializedBytes"]) {
      if (manifest[key] !== (key === "serializedBytes" ? serializedBytes : stats[key])) {
        errors.push(`Manifest ${key} does not match the dataset`);
      }
    }
  }
  return { valid: errors.length === 0, errors, canonicalJson, serializedBytes, ...stats };
}

async function sha256(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is unavailable");
  const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function validateCandidate(candidate, maximumBytes, cryptoImpl) {
  if (!candidate?.manifest || !candidate?.routes) return null;
  const validation = validateRoutesDataset(candidate.routes, candidate.manifest, maximumBytes);
  if (!validation.valid) return null;
  const checksum = await sha256(validation.canonicalJson, cryptoImpl);
  if (checksum !== candidate.manifest.sha256.toLowerCase()) return null;
  return { ...candidate, validation };
}

/**
 * Loads one immutable route array before application indexes are created.
 * Remote data is cached only after schema and checksum verification.
 */
export async function loadRoutesDataset({
  storageGet,
  storageSet,
  storageGetBytesInUse = async () => null,
  fallbackLoader,
  fetchImpl = fetch,
  cryptoImpl = globalThis.crypto,
  manifestUrl = DEFAULT_MANIFEST_URL,
  routesUrl = DEFAULT_ROUTES_URL,
  manifestTimeoutMs = 3000,
  routesTimeoutMs = 10_000,
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
  logger = () => {}
}) {
  const cachePromise = Promise.resolve()
    .then(() => storageGet(CACHE_KEY))
    .then(result => result?.[CACHE_KEY] ?? null)
    .catch(error => {
      logger("Unable to read cached routes dataset", error);
      return null;
    });
  const manifestPromise = fetchWithTimeout(fetchImpl, manifestUrl, manifestTimeoutMs)
    .then(async response => {
      if (!response.ok) throw new Error(`Routes manifest returned HTTP ${response.status}`);
      const manifest = await response.json();
      if (!validateManifest(manifest)) throw new Error("Routes manifest is invalid");
      return manifest;
    })
    .catch(error => {
      logger("Unable to load remote routes manifest", error);
      return null;
    });

  const [cachedRaw, remoteManifest] = await Promise.all([cachePromise, manifestPromise]);
  const cached = await validateCandidate(cachedRaw, maximumBytes, cryptoImpl).catch(error => {
    logger("Cached routes dataset is invalid", error);
    return null;
  });

  if (cached && remoteManifest?.datasetVersion === cached.manifest.datasetVersion) {
    return { routes: cached.routes, manifest: cached.manifest, source: "cache" };
  }

  if (remoteManifest) {
    try {
      const response = await fetchWithTimeout(fetchImpl, routesUrl, routesTimeoutMs);
      if (!response.ok) throw new Error(`Routes dataset returned HTTP ${response.status}`);
      const routes = JSON.parse(await response.text());
      const remote = await validateCandidate(
        { manifest: remoteManifest, routes },
        maximumBytes,
        cryptoImpl
      );
      if (!remote) throw new Error("Routes dataset failed schema or checksum validation");
      try {
        await storageSet({ [CACHE_KEY]: { manifest: remote.manifest, routes: remote.routes } });
        const bytesInUse = await storageGetBytesInUse(CACHE_KEY);
        logger("Stored routes dataset", { bytesInUse, datasetVersion: remote.manifest.datasetVersion });
      } catch (error) {
        logger("Unable to persist routes dataset; using it for this session", error);
      }
      return { routes: remote.routes, manifest: remote.manifest, source: "remote" };
    } catch (error) {
      logger("Unable to load remote routes dataset", error);
    }
  }

  if (cached) return { routes: cached.routes, manifest: cached.manifest, source: "cache-stale" };
  const routes = await fallbackLoader();
  const fallbackValidation = validateRoutesDataset(routes, null, maximumBytes);
  if (!fallbackValidation.valid) {
    throw new Error(`Packaged routes fallback is invalid: ${fallbackValidation.errors.join(", ")}`);
  }
  return { routes, manifest: null, source: "packaged" };
}

export const routesDatasetCacheKey = CACHE_KEY;
