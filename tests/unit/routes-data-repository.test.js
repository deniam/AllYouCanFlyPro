import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  loadRoutesDataset,
  routesDatasetCacheKey,
  validateRoutesDataset
} from "../../src/infrastructure/routes-data-repository.js";

const routes = [{
  departureStation: {
    id: "AAA",
    name: "Alpha",
    country: "Test",
    longitude: 1,
    latitude: 2
  },
  arrivalStations: [{
    id: "BBB",
    name: "Beta",
    country: "Test",
    operationStartDate: "2026-08-29",
    flightDates: ["2026-09-01", "2026-09-02"]
  }]
}];

function manifestFor(value = routes, datasetVersion = "2026-08-29T22:30:00Z") {
  const json = JSON.stringify(value);
  const validation = validateRoutesDataset(value, null);
  return {
    schemaVersion: 1,
    datasetVersion,
    generatedAt: datasetVersion,
    apiVersion: "29.14.0",
    scanRange: { from: "2026-08-29", to: "2026-10-31" },
    routeCount: validation.routeCount,
    connectionCount: validation.connectionCount,
    flightDateCount: validation.flightDateCount,
    serializedBytes: validation.serializedBytes,
    sha256: createHash("sha256").update(json).digest("hex")
  };
}

function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function repositoryOptions(overrides = {}) {
  return {
    storageGet: vi.fn(async () => ({})),
    storageSet: vi.fn(async () => true),
    storageGetBytesInUse: vi.fn(async () => 1234),
    fallbackLoader: vi.fn(async () => routes),
    manifestUrl: "https://data.test/routes-manifest.json",
    routesUrl: "https://data.test/routes.json",
    logger: vi.fn(),
    ...overrides
  };
}

describe("routes data repository", () => {
  it("downloads, validates, and stores a new remote dataset", async () => {
    const manifest = manifestFor();
    const fetchImpl = vi.fn(async url =>
      String(url).includes("manifest") ? responseJson(manifest) : responseJson(routes)
    );
    const options = repositoryOptions({ fetchImpl });

    const result = await loadRoutesDataset(options);

    expect(result.source).toBe("remote");
    expect(result.routes).toEqual(routes);
    expect(options.storageSet).toHaveBeenCalledWith({
      [routesDatasetCacheKey]: { manifest, routes }
    });
    expect(options.fallbackLoader).not.toHaveBeenCalled();
  });

  it("uses a valid cache without downloading the full dataset", async () => {
    const manifest = manifestFor();
    const fetchImpl = vi.fn(async () => responseJson(manifest));
    const options = repositoryOptions({
      fetchImpl,
      storageGet: vi.fn(async () => ({
        [routesDatasetCacheKey]: { manifest, routes }
      }))
    });

    const result = await loadRoutesDataset(options);

    expect(result.source).toBe("cache");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(options.storageSet).not.toHaveBeenCalled();
  });

  it("uses the last valid cache when the remote manifest is unavailable", async () => {
    const manifest = manifestFor();
    const options = repositoryOptions({
      fetchImpl: vi.fn(async () => responseJson({}, 503)),
      storageGet: vi.fn(async () => ({
        [routesDatasetCacheKey]: { manifest, routes }
      }))
    });

    const result = await loadRoutesDataset(options);

    expect(result.source).toBe("cache-stale");
    expect(options.fallbackLoader).not.toHaveBeenCalled();
  });

  it("falls back to the packaged dataset when remote data has the wrong checksum", async () => {
    const manifest = { ...manifestFor(), sha256: "0".repeat(64) };
    const fetchImpl = vi.fn(async url =>
      String(url).includes("manifest") ? responseJson(manifest) : responseJson(routes)
    );
    const options = repositoryOptions({ fetchImpl });

    const result = await loadRoutesDataset(options);

    expect(result.source).toBe("packaged");
    expect(options.storageSet).not.toHaveBeenCalled();
  });

  it("uses verified remote data even if the storage write is rejected", async () => {
    const manifest = manifestFor();
    const options = repositoryOptions({
      fetchImpl: vi.fn(async url =>
        String(url).includes("manifest") ? responseJson(manifest) : responseJson(routes)
      ),
      storageSet: vi.fn(async () => { throw new Error("QUOTA_BYTES"); })
    });

    const result = await loadRoutesDataset(options);

    expect(result.source).toBe("remote");
    expect(result.routes).toEqual(routes);
  });

  it("rejects datasets above the configured cache cap", async () => {
    const manifest = manifestFor();
    const options = repositoryOptions({
      maximumBytes: 10,
      fetchImpl: vi.fn(async url =>
        String(url).includes("manifest") ? responseJson(manifest) : responseJson(routes)
      )
    });

    await expect(loadRoutesDataset(options)).rejects.toThrow("Packaged routes fallback is invalid");
  });
});
