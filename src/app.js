import { loadAirportsData, MULTI_AIRPORT_CITIES, cityNameLookup, customCityNames } from './data/airports.js';
import { createRouteCatalog } from './domain/route-catalog.js';
import { getDatabase } from './infrastructure/database.js';
import { createFlightCache, segmentCacheKey } from './infrastructure/cache-repository.js';
import { createRequestScheduler } from './infrastructure/request-throttler.js';
import { appState } from './app/state.js';
import { createSettingsRepository } from './infrastructure/settings-repository.js';
import { createExtensionGateway } from './infrastructure/extension-api.js';
import { loadRoutesDataset } from './infrastructure/routes-data-repository.js';
import { createRouteExclusionsRepository } from './infrastructure/route-exclusions.js';
import { ErrorCode } from './infrastructure/errors.js';
import { downloadBlob } from './ui/dom.js';
import { createNotifier } from './ui/notifications.js';
import { downloadTabSeparatedFile, escapeTabularCell } from './ui/csv-export.js';
import { createMultipassClient } from './infrastructure/multipass-client.js';
import { parseLocalDate } from './domain/dates.js';
import { initMultiCalendar, renderCalendarMonth } from './ui/calendar.js';
import { setupAirportAutocomplete } from './ui/autocomplete.js';
import { createResultsRenderer } from './ui/results-renderer.js';
import { createAirportFields } from './ui/airport-fields.js';
import { createCustomGroupsController } from './ui/custom-groups.js';
import { mountChangelog } from './ui/changelog.js';
import { mountDonationReminder } from './ui/reminders.js';
import { createSearchProgress } from './ui/search-progress.js';
import {
  mountSettingsPanel,
  updateMaxConcurrentRequestsWarning,
  validateMaxConcurrentRequestsInput
} from './ui/settings-panel.js';
import { createThemeController } from './ui/theme-controller.js';
import { unifyRawFlight } from './domain/flight-normalizer.js';
import { createDirectSearch } from './domain/search/direct.js';
import { runSearch } from './domain/search/orchestrator.js';
import { createConnectionsSearch } from './domain/search/connections.js';
import { createPairedDateSelector } from './domain/search/paired-date-selector.js';
import { defaultFlightKey } from './domain/search/result-matcher.js';
// ----------------------- Global Settings -----------------------
  const settingsRepository = createSettingsRepository(localStorage);
  const extensionGateway = createExtensionGateway();
  const loadedRoutesDataset = await loadRoutesDataset({
    storageGet: key => extensionGateway.storageGet(key),
    storageSet: value => extensionGateway.storageSet(value),
    storageGetBytesInUse: key => extensionGateway.storageGetBytesInUse(key),
    fallbackLoader: async () => (await import('./data/routes.js')).routesData,
    logger: (...args) => console.warn('[AYCF routes]', ...args)
  });
  const routesData = loadedRoutesDataset.routes;
  const routeExclusions = createRouteExclusionsRepository(localStorage);
  const initialSettings = settingsRepository.load();
  // Throttle and caching parameters (loaded from localStorage if available)
  let debug = initialSettings.debugMode;
  let debugLog = [];
  let originalConsoleWarn = console.warn;
  let scheduleDebugLogDisplayUpdate = () => {};
    if (debug) {
      console.warn = function(...args) {
        debugLogger('WARN:', ...args);
        originalConsoleWarn.apply(console, args);
      };
    }
  const MAX_LOG_ENTRIES = 500;
  let CACHE_LIFETIME = initialSettings.cacheLifetimeHours * 60 * 60 * 1000;
  // 4 hours in ms
  let themeController;
  // Build airport names mapping from AIRPORTS list (strip code in parentheses)
  let AIRPORTS = [];
  let COUNTRY_AIRPORTS = {};
  let airportFlags = {};

  function saveSettings() {
  const minConnection = document.getElementById('min-connection-time').value;
  const maxConnection = document.getElementById('max-connection-time').value;
  const preferredAirport = document.getElementById('preferred-airport').value;
  const allowChange = document.getElementById('allow-change-airport').checked;
  const connectionRadius = document.getElementById('connection-radius').value;
  const maxReq = document.getElementById('max-requests').value;
  const pauseDur = document.getElementById('pause-duration').value;
  const cacheLife = document.getElementById('cache-lifetime').value;
  settingsRepository.update({
    minConnectionTime: minConnection,
    maxConnectionTime: maxConnection,
    preferredAirport,
    allowChangeAirport: allowChange,
    connectionRadius,
    maxRequestsInRow: maxReq,
    pauseDurationSeconds: pauseDur,
    cacheLifetimeHours: cacheLife
  });
  if (debug) {
    console.log('[DEBUG] Settings saved individually:', {
      minConnectionTime: minConnection,
      maxConnectionTime: maxConnection,
      preferredAirport,
      allowChangeAirport: allowChange,
      connectionRadius,
      maxRequestsInRow: maxReq,
      pauseDurationSeconds: pauseDur,
      cacheLifetimeHours: cacheLife
    });
  }
}

    // IndexedDB is used only for API response caching. The selected route
    // dataset (remote cache or packaged fallback) is indexed once in memory.
    const db = getDatabase();
    const flightCache = createFlightCache(db, () => CACHE_LIFETIME);
    const routeCatalog = createRouteCatalog(routesData, {
      excludedRoutes: routeExclusions.load()
    });

  function excludeRoute(origin, destination) {
    if (!routeCatalog.excludeRoute(origin, destination)) return;
    routeExclusions.add(origin, destination);
    debugLogger(`Route excluded after HTTP 302: ${origin} → ${destination}`);
  }

  async function initAirports() {
    try {
      const { AIRPORTS: loadedAirports, COUNTRY_AIRPORTS: loadedCountryAirports } = await loadAirportsData(routesData);
      AIRPORTS = loadedAirports;
      COUNTRY_AIRPORTS = loadedCountryAirports;
      
      // Build the flag mapping and airportLookup mapping once AIRPORTS is populated.
      AIRPORTS.forEach(airport => {
        if (airport.flag) {
          airportFlags[airport.code] = airport.flag;
        }
        airportLookup[airport.code] = airport;
      });
            
    } catch (error) {
      console.error("Error loading airports data:", error);
    }
    // Removed the stray closing brace as it was not part of any valid block or function.
  }
  // Restore saved tab context through the WebExtensions compatibility gateway.
  extensionGateway.storageGet("currentTabContext")
    .then(result => {
      const ctx = result?.currentTabContext;
      if (ctx) {
        appState.currentTabContext = ctx;
        const tabInfoEl = document.getElementById("tab-info");
        if (tabInfoEl) tabInfoEl.textContent = `Current Tab: ${ctx.title} (${ctx.url})`;
        extensionGateway.storageRemove("currentTabContext");
      }
    })
    .catch(error => debugLogger("Unable to restore tab context:", error));

  async function initApp() {
    await initAirports();
  }
  const initializationPromise = initApp();
  // ---------------- Helper: Airport Flag ----------------
  const airportLookup = {};

  function getCountry(airport) {
    if (airport && typeof airport === "object") {
      // Prefer using the airport code if available.
      if (airport.code && airportLookup[airport.code]) {
        return airportLookup[airport.code].country || "";
      }
      // Fallback: use the country property.
      if (airport.country) {
        return airport.country;
      }
    } else if (typeof airport === "string") {
      const found = airportLookup[airport];
      if (found) {
        return found.country || "";
      }
    }
  }

  function getCountryFlag(airport) {
    if (airport && typeof airport === "object") {
      // Prefer using the airport code if available.
      if (airport.code && airportFlags[airport.code]) {
        return airportFlags[airport.code];
      }
      // Fallback: use the country property.
      if (airport.country && airportFlags[airport.country]) {
        return airportFlags[airport.country];
      }
    } else if (typeof airport === "string") {
      const found = airportLookup[airport];
      if (found) {
        if (found.code && airportFlags[found.code]) {
          return airportFlags[found.code];
        }
        if (found.country && airportFlags[found.country]) {
          return airportFlags[found.country];
        }
      }
    }
    return "";
  }
  
  // ----------------------- DOM Elements -----------------------
  const progressContainer = document.getElementById('progress-container');
  const progressText = document.getElementById('progress-text');
  const progressBar = document.getElementById('progress-bar');
  const resultsContainer = document.getElementById("results-container");
  const resultsAndSortContainer = document.getElementById("results-and-sort-container");
  const totalResultsEl = document.getElementById("total-results");
  const sortSelectLabel = document.getElementById("sort-select-label");
  const sortSelect = document.getElementById("sort-select");
  const sortDirectionSelect = document.getElementById("sort-direction-select");
  const returnSortControls = document.getElementById("return-sort-controls");
  const returnSortSelect = document.getElementById("return-sort-select");
  const searchProgress = createSearchProgress({
    container: progressContainer,
    text: progressText,
    bar: progressBar,
    resultsContainer,
    timeoutStatus: document.getElementById("timeout-status")
  });
  const resultsRenderer = createResultsRenderer({
    list: document.querySelector(".route-list"),
    toolbar: resultsAndSortContainer,
    total: totalResultsEl,
    countryFor: getCountry,
    flagFor: getCountryFlag,
    airportName: code => airportLookup[code]?.name ?? code,
    logger: debugLogger
  });
  const airportFields = createAirportFields({ setupAutocomplete });

  const sortOptionsByTripType = Object.freeze({
    oneway: Object.freeze([
      ["default", "Search order"],
      ["airport", "Departure airport"],
      ["arrivalAirport", "Arrival airport"],
      ["departure", "Departure date/time"],
      ["arrival", "Arrival date/time"],
      ["duration", "Total journey duration"],
      ["transfers", "Fewest transfers"],
      ["connections", "Least connection time"]
    ]),
    return: Object.freeze([
      ["default", "Search order"],
      ["airport", "Departure airport"],
      ["arrivalAirport", "Arrival airport"],
      ["departure", "Outbound departure"],
      ["arrival", "Outbound arrival"],
      ["duration", "Outbound journey duration"],
      ["transfers", "Fewest outbound transfers"]
    ])
  });

    const settingSelectors = [
    '#min-connection-time',
    '#max-connection-time',
    '#preferred-airport',
    '#allow-change-airport',
    '#connection-radius',
    '#max-requests',
    '#pause-duration',
    '#cache-lifetime'
  ];

  settingSelectors.forEach(sel => {
    const el = document.querySelector(sel);
    if (!el) return;
    const isTextOrNumber = el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number');
    const eventName = isTextOrNumber ? 'input' : 'change';
    el.addEventListener(eventName, saveSettings);
  });

  let currentSortOption = "default";
  let currentSortDirection = "asc";
  let currentReturnSortOption = "departure";

  function updateSortControls(tripType) {
    const options = sortOptionsByTripType[tripType] ?? sortOptionsByTripType.oneway;
    const allowedOptions = new Set(options.map(([value]) => value));
    if (!allowedOptions.has(currentSortOption)) currentSortOption = "default";

    sortSelect.replaceChildren(...options.map(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }));
    sortSelect.value = currentSortOption;
    sortDirectionSelect.value = currentSortDirection;
    returnSortSelect.value = currentReturnSortOption;
    sortSelectLabel.textContent = tripType === "return" ? "Sort outbound" : "Sort by";
    returnSortControls.classList.toggle("hidden", tripType !== "return");
    returnSortControls.classList.toggle("flex", tripType === "return");
    syncRendererSortState();
  }

  function syncRendererSortState() {
    resultsRenderer.setSortOption(currentSortOption);
    resultsRenderer.setSortDirection(currentSortDirection);
    resultsRenderer.setReturnSortOption(currentReturnSortOption);
  }

  function renderCurrentResults() {
    syncRendererSortState();
    if (appState.tripType === "return") {
      if (appState.defaultResults.length) displayRoundTripResultsAll([...appState.defaultResults]);
      else resultsRenderer.refreshRoundTrips();
    } else {
      displayGlobalResults([...appState.defaultResults]);
    }
  }

  sortSelect.addEventListener("change", () => {
    currentSortOption = sortSelect.value;
    renderCurrentResults();
  });

  sortDirectionSelect.addEventListener("change", () => {
    currentSortDirection = sortDirectionSelect.value === "desc" ? "desc" : "asc";
    renderCurrentResults();
  });

  returnSortSelect.addEventListener("change", () => {
    currentReturnSortOption = returnSortSelect.value;
    renderCurrentResults();
  });

  // ----------------------- Debugging --------------------------------
  function debugLogger() {
      if (!debug) return;
      
      console.log.apply(console, arguments);
      
      const message = Array.from(arguments).map(arg => {
          if (typeof arg === 'object' && arg !== null) {
              try {
                  return JSON.stringify(arg, null, 2);
              } catch {
                  return String(arg);
              }
          }
          return String(arg);
      }).join(' ');

      debugLog.push(`${new Date().toISOString()}: ${message}`);
      
      if (debugLog.length > MAX_LOG_ENTRIES) {
          debugLog.shift();
      }
      scheduleDebugLogDisplayUpdate();
  }

  // ----------------------- UI Helper Functions -----------------------
  function updateProgress(current, total, message) {
    searchProgress.update(current, total, message);
  }

  function hideProgress() {
    searchProgress.hide();
  }
  
  function resetCountdownTimers() {
    searchProgress.resetCountdown();
  }

  function showTimeoutCountdown(waitTimeMs, rateLimited = false) {
    searchProgress.showCountdown(waitTimeMs, rateLimited);
  }

  const requestScheduler = createRequestScheduler(
    () => settingsRepository.load(),
    (waitTimeMs, reason) => showTimeoutCountdown(waitTimeMs, reason === "rate-limit"),
    debugLogger
  );
  const multipassClient = createMultipassClient({
    gateway: extensionGateway,
    cache: flightCache,
    scheduler: requestScheduler,
    logger: debugLogger,
    onRouteNotFound: ({ origin, destination }) => excludeRoute(origin, destination)
  });
  const selectPairedArrivalDate = createPairedDateSelector({
    routeCatalog,
    getCached: (origin, destination, date) =>
      flightCache.get(segmentCacheKey(origin, destination, date))
  });

  function validateMaxConcurrentRequests() {
    const input = document.getElementById("max-concurrent-requests");
    const error = document.getElementById("max-concurrent-requests-error");
    return validateMaxConcurrentRequestsInput(input, error);
  }

  function updateRequestSettings() {
    const previousMaxConcurrentRequests = settingsRepository.load().maxConcurrentRequests;
    const maxRequestsInRow = parseInt(document.getElementById("max-requests").value, 10);
    const pauseDur = parseInt(document.getElementById("pause-duration").value, 10);
    const maxConcurrentRequests = validateMaxConcurrentRequests();
    settingsRepository.update({
      maxRequestsInRow,
      pauseDurationSeconds: pauseDur,
      maxConcurrentRequests
    });
    updateMaxConcurrentRequestsWarning(
      document.getElementById("max-concurrent-requests-warning"),
      maxConcurrentRequests,
      previousMaxConcurrentRequests
    );
    requestScheduler.settingsChanged();
    debugLogger(`Request settings updated: Batch = ${maxRequestsInRow}, Pause = ${pauseDur}s, Max Concurrency = ${maxConcurrentRequests}`);
  }
  function updateCacheLifetimeSetting() {
    const hours = parseFloat(document.getElementById("cache-lifetime").value);
    CACHE_LIFETIME = hours * 60 * 60 * 1000;
    settingsRepository.update({ cacheLifetimeHours: hours });
  }

  function animateElement(element, animationClass, duration = 300) {
    if (element) {
      element.classList.add(animationClass);
      setTimeout(() => {
        element.classList.remove(animationClass);
      }, duration);
    }
  }

  //===========Autocomplete Functions================
// Assumptions:
//   - Global variables AIRPORTS, COUNTRY_AIRPORTS, and ROUTES are available and populated.
//   - getMultiAirportValues(containerId) returns an array of string values from inputs within the container.
//   - resolveAirport(input) resolves a given input string into an array of airport codes.
//   - ROUTES is an array of route objects loaded from Dexie (instead of the old static routesData).

  function setupAutocomplete(inputId, suggestionsId) {
    setupAirportAutocomplete(inputId, suggestionsId, {
      airports: () => AIRPORTS,
      countries: () => COUNTRY_AIRPORTS,
      groups: MULTI_AIRPORT_CITIES,
      catalog: routeCatalog,
      getValues: getMultiAirportValues,
      resolve: resolveAirport,
      onSelect: ({ inputId: selectedInputId, option }) => {
        if (selectedInputId !== "preferred-airport") return;
        settingsRepository.update({ preferredAirport: option.name });
        const firstOrigin = document.querySelector("#origin-multi input");
        if (firstOrigin) firstOrigin.value = option.name;
      }
    });
  }

  // Helper function to get values from all input fields within a container.
  function getMultiAirportValues(containerId) {
    return airportFields.values(containerId);
  }

    // Helper to expand multi-airport city codes
  function expandMultiAirport(codes) {
    if (codes.length === 1 && MULTI_AIRPORT_CITIES && MULTI_AIRPORT_CITIES[codes[0].toUpperCase()]) {
      const expanded = MULTI_AIRPORT_CITIES[codes[0].toUpperCase()];
      if (debug) {      }
      return expanded;
    }
    return codes;
  }  
  function resolveAirport(input) {
    if (!input) return [];
    
    const anyPattern = /(.+)\(any\)/i;
    if (anyPattern.test(input)) {
      for (const key in MULTI_AIRPORT_CITIES) {
        if (cityNameLookup(key).toLowerCase() === input.toLowerCase()) {
          return MULTI_AIRPORT_CITIES[key];
        }
      }
      const match = input.match(anyPattern);
      if (match && match[1]) {
        const cityPart = match[1].trim();
        const derivedKey = cityPart.substring(0, 3).toUpperCase();
        if (MULTI_AIRPORT_CITIES && MULTI_AIRPORT_CITIES[derivedKey]) {
          return MULTI_AIRPORT_CITIES[derivedKey];
        }
      }
    }
    const codeMatch = input.match(/\(([A-Z]{3})\)/i);
    if (codeMatch) {
      input = codeMatch[1];
    }
    const trimmed = input.trim();
    if (trimmed.toLowerCase() === "any" || trimmed.toLowerCase() === "anywhere") {
      return ["ANY"];
    }
    const lower = trimmed.toLowerCase();
    
    if (trimmed.length === 3) {
      const byCode = AIRPORTS.find(a => a.code.toLowerCase() === lower);
      if (byCode) {
        return expandMultiAirport([byCode.code]);
      }
    }
    
    for (const country in COUNTRY_AIRPORTS) {
      if (country.toLowerCase() === lower) {
        return COUNTRY_AIRPORTS[country];
      }
    }
    
    const fallbackByCode = AIRPORTS.find(a => a.code.toLowerCase() === lower);
    if (fallbackByCode) {
      return expandMultiAirport([fallbackByCode.code]);
    }
    
    const matches = AIRPORTS.filter(a => a.name.toLowerCase().includes(lower));
    if (matches.length > 0) {
      const codes = matches.map(a => a.code);
      return expandMultiAirport(codes);
    }
    
    return [input.toUpperCase()];
  }

  // ---------------- Candidate Caching Functions ----------------
  function getUnifiedCacheKey(origin, destination, date) {
    return segmentCacheKey(origin, destination, date);
  }

  async function handleClearCache() {  
    try {
      // Clear all cached results in Dexie
      await flightCache.clear();
      debugLogger("Dexie cache cleared.");
    } catch (error) {
      console.error("Error clearing Dexie cache:", error);
    }
    multipassClient.clearSession();
    showNotification("✅ Cache successfully cleared!");
  }  

  async function cleanupCache() {
    try {
      await flightCache.cleanup();
    } catch (e) {
      console.error("Error while cleaning cache:", e);
    }
  }

  async function setCachedResults(key, results) {
    await flightCache.put(key, results);
  }

  async function getCachedResults(key) {
    try {
      return await flightCache.get(key);
    } catch (e) {
      console.error("Error retrieving cached results from IndexedDB:", e);
    }
    return null;
  }

  function isDateAvailableForSegment(origin, destination, dateStr) {
    // Find the route that starts at the given origin.
    // debugLogger(`Checking availability: ${origin}→${destination} on ${dateStr}`);
    const route = routeCatalog.getRoute(origin, destination);
    if (!route) return false;
    // Find the arrival station object with the given destination.
    const arrivalStationObj = route.arrivalStations.find(st => {
      const id = typeof st === "object" ? st.id : st;
      return id === destination;
    });
    if (!arrivalStationObj) return false;
    // If flightDates is defined, check that dateStr is included.
    if (arrivalStationObj.flightDates) {
      return arrivalStationObj.flightDates.includes(dateStr);
    }
    // If no flightDates provided, assume available.
    debugLogger(`  No flight dates restriction`);
    return true;
  }

  async function checkRouteSegment(origin, destination, date, queryOptions = {}) {
    if (routeCatalog.isRouteExcluded(origin, destination)) {
      debugLogger(`Skipping excluded route ${origin} → ${destination}`);
      return [];
    }
    const arrivalDate = await selectPairedArrivalDate({
      origin,
      destination,
      departureDate: date,
      preferredReturnDates: queryOptions.preferredReturnDates ?? []
    });
    debugLogger(
      `Availability request ${origin} → ${destination} on ${date}`,
      arrivalDate ? `(paired with ${destination} → ${origin} on ${arrivalDate})` : "(outbound only)"
    );
    try {
      return await multipassClient.getFlights(
        { origin, destination, date, arrivalDate },
        appState.searchSession.controller?.signal
      );
    } finally {
      selectPairedArrivalDate.release({ origin, destination, arrivalDate });
    }
  }

    // ---------------- Global Results Display Functions ----------------
    /**
   * Appends a unified route (either a direct flight or an aggregated connecting route) to the global results,
   * then triggers re‑rendering.
   */
  function appendRouteToDisplay(routeObj) {
    const routeKey = defaultFlightKey(routeObj);
    if (appState.results.some(result => defaultFlightKey(result) === routeKey)) return;
    appState.results.push(routeObj);
    appState.defaultResults.push(routeObj);
    if (appState.tripType === "return") {
      // Round-trip results are rendered by runSearch when an inbound match
      // becomes available. Do not show incomplete outbound-only cards.
      if (routeObj.returnFlights?.length) displayRoundTripResultsAll(appState.results);
    } else {
      displayGlobalResults(appState.results);
    }
  }
    

  function displayGlobalResults(results) {
    syncRendererSortState();
    resultsRenderer.display(results);
  }

  function displayRoundTripResultsAll(results) {
    syncRendererSortState();
    resultsRenderer.displayRoundTrips(results);
  }

  // ---------------- Data Fetching Functions ----------------
  async function fetchDestinations() {
    return routeCatalog.getActiveRoutes().map(route => ({
      ...route,
      arrivalStations: Array.isArray(route.arrivalStations)
        ? [...route.arrivalStations]
        : []
    }));
  }
  
  // ---------------- Round-Trip and Direct Route Search Functions ----------------
  // Searches for connecting (multi‑leg) routes.
  // Uses the "overnight-checkbox" value to decide if connecting flights must depart on the same day as selected.
  /**
   * Recursive function to iterate through possible options for route segments.
   * Returns an array of options (each option is an array of flights for segments from index to the end).
   */
  const searchConnectingRoutes = createConnectionsSearch({
    isCancelled: () => appState.searchSession.cancelled,
    debugLogger,
    isDateAvailableForSegment,
    getCachedResults,
    setCachedResults,
    getUnifiedCacheKey,
    checkRouteSegment,
    updateProgress,
    fetchDestinations,
    routeCatalog,
    isRouteExcluded: (origin, destination) => routeCatalog.isRouteExcluded(origin, destination),
    airportLookup,
    appendRouteToDisplay,
    getSettings: () => settingsRepository.load(),
    getStopoverText: () => document.getElementById("selected-stopover").textContent
  });

  const searchDirectRoutes = createDirectSearch({
    fetchRoutes: fetchDestinations,
    getPreviousResults: () => appState.results,
    isCancelled: () => appState.searchSession.cancelled,
    getCached: (origin, destination, date) =>
      getCachedResults(getUnifiedCacheKey(origin, destination, date)),
    setCached: (origin, destination, date, flights) =>
      setCachedResults(getUnifiedCacheKey(origin, destination, date), flights),
    fetchFlights: checkRouteSegment,
    normalizeFlight: unifyRawFlight,
    appendResult: appendRouteToDisplay,
    updateProgress,
    getConcurrency: () => settingsRepository.load().maxConcurrentRequests,
    isRouteExcluded: (origin, destination) => routeCatalog.isRouteExcluded(origin, destination),
    logger: debugLogger
  });

  function setSearchButtonIdle(button) {
    button.disabled = false;
    button.setAttribute("aria-label", "Search flights");
    button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none"
          viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg> SEARCH`;
  }

  function setSearchButtonActive(button) {
    button.disabled = false;
    button.setAttribute("aria-label", "Stop search");
    button.textContent = "STOP";
  }

  function setSearchButtonStopping(button) {
    button.disabled = true;
    button.setAttribute("aria-label", "Stopping search");
    button.textContent = "STOPPING…";
  }

  async function handleSearch() {
    debugLogger("Search initiated.");
    const searchButton = document.getElementById("search-button");
  
    if (appState.searchSession.active) {
      debugLogger("Search already active. Cancelling current search.");
      appState.cancelSearch();
      resetCountdownTimers();
      requestScheduler.resetBatch();
      setSearchButtonStopping(searchButton);
      return;
    }
  
    // Clear previous results and mark search as active.
    appState.results = [];
    appState.defaultResults = [];
    resultsRenderer.reset();
    totalResultsEl.textContent = "Total results: 0";
    const searchSession = appState.beginSearch();
    selectPairedArrivalDate.reset();
    setSearchButtonActive(searchButton);
    debugLogger("New search started. Resetting counters and UI.");

    await cleanupCache();
  
    requestScheduler.resetBatch();
  
    let returnInputRaw = "";
    if (appState.tripType === "return") {
      returnInputRaw = document.getElementById("return-date").value.trim();
      if (!returnInputRaw) {
        showNotification("Please select a return date for round-trip search.");
        setSearchButtonIdle(searchButton);
        appState.finishSearch(searchSession);
        return;
      }
    }
  
    let originInputs = getMultiAirportValues("origin-multi");
    if (originInputs.length === 0) {
      showNotification("Please select a departure airport first.");
      setSearchButtonIdle(searchButton);
      appState.finishSearch(searchSession);
      return;
    }
    let origins = originInputs.map(s => resolveAirport(s)).flat();
    debugLogger("Resolved origins:", origins);
  
    let destinationInputs = getMultiAirportValues("destination-multi");
    let destinations = (destinationInputs.length === 0 || destinationInputs.includes("ANY"))
      ? ["ANY"]
      : destinationInputs.map(s => resolveAirport(s)).flat();
    debugLogger("Resolved destinations:", destinations);
  
    const tripType = appState.tripType || "oneway";
    let departureDates = [];
    const departureInputRaw = document.getElementById("departure-date").value.trim();
    departureDates = departureInputRaw.split(",").map(d => d.trim()).filter(d => d !== "");
    debugLogger("Departure dates:", departureDates);
  
    updateProgress(0, 1, "Initializing search");
  
    const stopoverText = document.getElementById("selected-stopover").textContent;
    let maxTransfers = 0;
    if (stopoverText === "One stop or fewer" || stopoverText === "One stop or fewer (overnight)") {
      maxTransfers = 1;
    } else if (stopoverText === "Two stops or fewer (overnight)") {
      maxTransfers = 2;
    } else {
      maxTransfers = 0;
    }
    debugLogger("Max transfers set to:", maxTransfers);
  
    // --- Anywhere logic in handleSearch ---
    const isOriginAnywhere = (origins.length === 1 && origins[0] === "ANY");
    const isDestinationAnywhere = (destinations.length === 1 && destinations[0] === "ANY");
  
    // 1) Abort if both fields are ANY and trip type is roundtrip.
    if (isOriginAnywhere && isDestinationAnywhere && appState.tripType === "return") {
      showNotification("Search for 'Anywhere to Anywhere' is available only for one-way direct flights.");
      setSearchButtonIdle(searchButton);
      appState.finishSearch(searchSession);
      hideProgress();
      return;
    }
  
    // 2) For a direct Anywhere-to-Anywhere search, expand all departure codes
    // here. Connecting searches resolve ANY from the route graph.
    if (isOriginAnywhere && isDestinationAnywhere && maxTransfers === 0) {
      showNotification("Searching all available direct flights. Please wait.");
      let allRoutes = await fetchDestinations();
      allRoutes = allRoutes.map(route => {
        if (Array.isArray(route.arrivalStations)) {
          route.arrivalStations = route.arrivalStations.filter(arrival => {
            if (typeof arrival === "object" && arrival.operationStartDate) {
              return new Date(departureDates[departureDates.length - 1]) >= new Date(arrival.operationStartDate);
            }
            return true;
          });
        }
        return route;
      }).filter(route => route.arrivalStations && route.arrivalStations.length > 0);
      const allOrigins = allRoutes.map(route => (
        typeof route.departureStation === "object" ? route.departureStation.id : route.departureStation
      ));
      origins = Array.from(new Set(allOrigins));
      debugLogger("Anywhere-to-Anywhere search: replaced origins with all available departure codes:", origins);
    }
  
    // 3) If only origin is ANY and destination is specified, filter origins.
    if (isOriginAnywhere && !isDestinationAnywhere && maxTransfers === 0) {
      debugLogger("Origin = ANY; filtering origins by direct routes");
      let fetchedRoutes = await fetchDestinations();
      fetchedRoutes = fetchedRoutes.map(route => {
        if (Array.isArray(route.arrivalStations)) {
          route.arrivalStations = route.arrivalStations.filter(arrival => {
            if (typeof arrival === "object" && arrival.operationStartDate) {
              return new Date(departureDates[departureDates.length - 1]) >= new Date(arrival.operationStartDate);
            }
            return true;
          });
        }
        return route;
      }).filter(route => route.arrivalStations && route.arrivalStations.length > 0);
      const destSet = new Set(destinations);
      const filteredOrigins = fetchedRoutes
        .filter(route =>
          route.arrivalStations.some(arr => {
            const arrId = typeof arr === "object" ? arr.id : arr;
            return destSet.has(arrId);
          })
        )
        .map(route =>
          typeof route.departureStation === "object"
            ? route.departureStation.id
            : route.departureStation
        );
      origins = Array.from(new Set(filteredOrigins));
      debugLogger("Filtered origins:", origins);
    }
  
    // 4) If only destination is ANY and origin is specified, filter destinations.
    if (isDestinationAnywhere && !isOriginAnywhere && maxTransfers === 0) {
      debugLogger("Destination = ANY; filtering destinations by direct routes");
      let fetchedRoutes = await fetchDestinations();
      fetchedRoutes = fetchedRoutes.map(route => {
        if (Array.isArray(route.arrivalStations)) {
          route.arrivalStations = route.arrivalStations.filter(arrival => {
            if (typeof arrival === "object" && arrival.operationStartDate) {
              return new Date(departureDates[departureDates.length - 1]) >= new Date(arrival.operationStartDate);
            }
            return true;
          });
        }
        return route;
      }).filter(route => route.arrivalStations && route.arrivalStations.length > 0);
      const originSet = new Set(origins);
      const filteredDestinations = fetchedRoutes
        .filter(route =>
          originSet.has(
            typeof route.departureStation === "object"
              ? route.departureStation.id
              : route.departureStation
          )
        )
        .flatMap(route =>
          route.arrivalStations.map(arr =>
            typeof arr === "object" ? arr.id : arr
          )
        );
      destinations = Array.from(new Set(filteredDestinations));
      debugLogger("Filtered destinations:", destinations);
    }
    // --- End Anywhere logic ---

    const originalOrigins = originInputs.map(value => resolveAirport(value)).flat();
    const returnDates = returnInputRaw.split(",").map(value => value.trim()).filter(Boolean);
    let wasCancelled = false;
    let searchFailed = false;

    try {
      const results = await runSearch({
        origins,
        destinations,
        originalOrigins,
        departureDates,
        returnDates,
        tripType,
        maxTransfers,
        maxConcurrentRequests: settingsRepository.load().maxConcurrentRequests
      }, {
        searchDirect: ({ origins: from, destinations: to, date, append, skipProgress, preferredReturnDates }) =>
          searchDirectRoutes(from, to, date, append, false, skipProgress, { preferredReturnDates }),
        searchConnections: ({ origins: from, destinations: to, date, maxTransfers: transfers, append, skipProgress, preferredReturnDates }) =>
          searchConnectingRoutes(from, to, date, transfers, append, skipProgress, { preferredReturnDates }),
        onRoundTripResult: (flight, index) => {
          if (searchSession.controller.signal.aborted || appState.searchSession !== searchSession) return;
          resultsRenderer.upsertRoundTrip(flight, index);
        }
      }, searchSession.controller.signal, progress => {
        updateProgress(progress.current, progress.total, progress.message);
      });

      appState.results = results;
      appState.defaultResults = [...results];
      if (tripType === "return") displayRoundTripResultsAll(results);
      else displayGlobalResults(results);
      debugLogger(`Search complete. Valid results: ${results.length}`);
    } catch (error) {
      if (error?.code === ErrorCode.CANCELLED || error?.name === "AbortError") {
        wasCancelled = true;
        debugLogger("Search cancelled.");
      } else {
        searchFailed = true;
        const resultsList = document.querySelector(".route-list");
        resultsList.textContent = `Error: ${error.message}`;
        if (error?.code === ErrorCode.AUTH_REQUIRED) showNotification(error.message);
        console.error("Search error:", error);
      }
    } finally {
      if (!wasCancelled && !searchFailed && appState.results.length === 0 && tripType === "oneway") {
        document.querySelector(".route-list").textContent = "There are no available flights on this route.";
      }
      if (appState.finishSearch(searchSession)) {
        hideProgress();
        setSearchButtonIdle(searchButton);
        updateCSVButtonVisibility();
        debugLogger("Search process finished.");
      }
    }
  }
  
  // ---------------- Additional UI Functions ----------------
  
  // --- Multi-Entry Airport Input Functions ---
//
// These functions transform a single-field input into a multi‑row container.
// Each row holds an input for one airport along with a delete button (if more than one row)
// and a plus button on the last row to add a new airport entry.
  
// Call this function (for example, on DOMContentLoaded) to initialize a multi-entry field.
// The containerId should be the id of a container (a div) that will hold the airport rows.
// The fieldName is used to generate unique ids.
  function initializeMultiAirportField(containerId, fieldName) {
    airportFields.initialize(containerId, fieldName);
  }

  function updateAirportRows(container) {
    airportFields.update(container);
  }

  function swapInputs() {
    airportFields.swap();
  }

  function toggleOptions() {
    const optionsContainer = document.getElementById("options-container");
    optionsContainer.classList.toggle("hidden");
    if (!optionsContainer.classList.contains("hidden")) {
      animateElement(optionsContainer, "dropdown-enter", 300);
    }
  }

  const showNotification = createNotifier({
    banner: document.getElementById("notification-banner"),
    text: document.getElementById("notification-text")
  });
  // --------CSV export-------------
  function downloadResultsAsCSV() {
    if (!appState.results || appState.results.length === 0) {
      showNotification("No search results to export.");
      return;
    }

    // Extracting origin, destination, and dates from the input fields
    const origin = document.getElementById("origin-multi").querySelector("input")?.value.trim() || "unknown";
    const destination = document.getElementById("destination-multi").querySelector("input")?.value.trim() || "unknown";
    const departureDate = document.getElementById("departure-date").value.trim() || "no-date";
    const returnDate = document.getElementById("return-date").value.trim() || "oneway";

    // Formatting filename: origin-destination-departureDate-returnDate.csv
    const fileName = `${origin}-${destination}-${departureDate}-${returnDate}.csv`
      .replace(/\s+/g, "_")
      .replace(/[^\w.-]/g, "");

    const headers = [
      "Departure Airport",       
      "DCode",       
      "Arrival Airport",         
      "ACode",            
      "Departure Date",          
      "DTime",          
      "DOffset",        
      "Arrival Date",            
      "ATime",            
      "AOffset",          
      "Duration",        
      "Fare",                    
      "Currency",                
      "Carrier",                 
      "Flight ID"                
    ];

    const csvRows = [headers];

    // Iterate through appState.results and extract relevant flight data
    appState.results.forEach(flight => {
      const row = [
        escapeTabularCell(flight.departureStationText),
        escapeTabularCell(flight.departureStationCode),
        escapeTabularCell(flight.arrivalStationText),
        escapeTabularCell(flight.arrivalStationCode),
        escapeTabularCell(flight.departureDate),
        escapeTabularCell(flight.displayDeparture),
        escapeTabularCell(flight.departureOffsetText),
        escapeTabularCell(flight.arrivalDate),
        escapeTabularCell(flight.displayArrival),
        escapeTabularCell(flight.arrivalOffsetText),
        `${Math.floor(flight.calculatedDuration.totalMinutes / 60)}:${String(flight.calculatedDuration.totalMinutes % 60).padStart(2, '0')}`, // hh:mm format
        `="${parseFloat(flight.fare).toFixed(2)}"`, 
        escapeTabularCell(flight.currency),
        escapeTabularCell(flight.carrierText),
        flight.flightId
      ];

      csvRows.push(row);
    });

    downloadTabSeparatedFile(csvRows, fileName);
  }

  // Function to toggle CSV button visibility before search
  function updateCSVButtonVisibility() {
    const csvButton = document.getElementById("download-csv-button");

    // Hide the button if there are no results.
    if (!appState.results || appState.results.length === 0) {
        csvButton.classList.add("hidden");
        return;
    }

    // Check if all flights are direct and none have return flights
    const onlyDirectOneWay = appState.results.every(flight => {
        const isDirect = !flight.segments || flight.segments.length === 1;
        const isOneWay = !flight.returnFlights || flight.returnFlights.length === 0; // Ensure no return flights
        return isDirect && isOneWay;
    });

    if (onlyDirectOneWay) {
        csvButton.classList.remove("hidden"); // Show button for direct one-way flights
    } else {
        csvButton.classList.add("hidden"); // Hide button if any flight has return flights or multiple segments
    }
  }

  
  // ------------- Redirect to payment --------------
  function getSubscriptionIdFromDynamicUrl(url) {
    const matches = url.match(/subscriptions\/([^/]+)\/availability\/([^/]+)/);
    if (matches && matches[2]) {
      return matches[2];
    }
    return null;
  }

  async function continueToPayment(outboundKey) {
    try {
      const keyParts = outboundKey.split(' ');
      if (keyParts.length < 2) 
        throw new Error('Invalid outboundKey format');
      const segmentStr = keyParts.slice(1).join(' ');
      const [origPart, destPart] = segmentStr.split('~');
      const [origin, departDT] = origPart.split('#');
      const [destination]    = destPart.split('#');
      const dateStr = [
        departDT.slice(0,4),
        departDT.slice(4,6),
        departDT.slice(6,8)
      ].join('-');
      const flights = await checkRouteSegment(origin, destination, dateStr);
      if (!Array.isArray(flights) || flights.length === 0) {
        console.warn(`No flights for ${origin}→${destination} on ${dateStr}`);
        showNotification(`Oops! The flight ${origin} → ${destination} on ${dateStr} is no longer available.`);
        return;
      }

      const session = await multipassClient.ensureSession();
      const subscriptionId = getSubscriptionIdFromDynamicUrl(session.dynamicUrl);
      if (!subscriptionId) throw new Error("Lost subscription ID");
      await multipassClient.continueBooking(subscriptionId, outboundKey);
    } catch (e) {
      console.error("continueToPayment error:", e);
    }
  }

  let customGroupsController;

  function initCustomGroupsUI() {
    customGroupsController ??= createCustomGroupsController({
      storage: localStorage,
      groups: MULTI_AIRPORT_CITIES,
      groupNames: customCityNames,
      airportLookup,
      airports: AIRPORTS,
      notify: showNotification
    });
    customGroupsController.initialize();
  }

  // ---------------- Initialize on DOMContentLoaded ----------------

  export async function bootstrap() {
    await initializationPromise;
    // ========== 1. Load settings from localStorage ==========
    const settings = settingsRepository.load();
    themeController ??= createThemeController({ repository: settingsRepository });
    mountSettingsPanel({ settings, animate: animateElement });
    
    mountDonationReminder({ storage: localStorage });
    initCustomGroupsUI();

    // ========== 2. Setup Autocomplete and Multi-Airport Fields ==========
    setupAutocomplete("preferred-airport", "airport-suggestions-preferred");
    initializeMultiAirportField("origin-multi", "origin");
    const originContainer = document.getElementById("origin-multi");
    const firstOriginInput = originContainer.querySelector("input");
    if (firstOriginInput) {
      firstOriginInput.value = settings.preferredAirport;
      updateAirportRows(originContainer);
    }
    initializeMultiAirportField("destination-multi", "destination");
  
    // ========== 5. Initialize Calendars ==========
    initMultiCalendar("departure-date", "departure-calendar-popup", 3);
    initMultiCalendar("return-date", "return-calendar-popup", 3);
  
    // ========== 6. Setup Date Input Handlers ==========
    const departureDateInput = document.getElementById("departure-date");
    const returnDateInput = document.getElementById("return-date");
  
    // Function to update the minimum selectable return date (only dates >= departure date are active)
    function updateReturnCalendarMinDate(departureDateStr) {
      // If multiple departure dates are provided, consider only the first one.
      const depDates = departureDateStr.split(",").map(s => s.trim()).filter(Boolean);
      const minDepDate = depDates.length > 0 ? depDates[0] : departureDateStr;
      const returnCalendarPopup = document.getElementById("return-calendar-popup");
      const minDate = parseLocalDate(minDepDate);
      renderCalendarMonth(
        returnCalendarPopup,
        "return-date",
        minDate.getFullYear(),
        minDate.getMonth(),
        3,
        new Set(),
        minDepDate
      );
    }
  
    // Function to update the "Add Return Date" button state (disabled if no departure date)
    function updateReturnDateButtonState() {
      if (departureDateInput.value.trim()) {
        tripTypeToggle.disabled = false;
        tripTypeToggle.classList.remove("opacity-50", "bg-gray-400");
        tripTypeToggle.classList.add("bg-[#20006D]", "hover:bg-[#A00065]");
      } else {
        tripTypeToggle.disabled = true;
        tripTypeToggle.classList.remove("bg-[#20006D]", "hover:bg-[#A00065]");
        tripTypeToggle.classList.add("opacity-50", "bg-gray-400");
      }
    }
  
    // When the departure date changes:
    departureDateInput.addEventListener("change", () => {
      const departureVal = departureDateInput.value.trim();
      const returnInput = document.getElementById("return-date");
      if (departureVal) {
        returnInput.disabled = false;
        updateReturnCalendarMinDate(departureVal);

            // For a comma-separated list of departure dates, consider only the first as the min
        const depDates = departureVal.split(",").map(s => s.trim()).filter(Boolean);
        const minDepDate = depDates.length > 0 ? parseLocalDate(depDates[0]) : null;
        if (minDepDate && returnInput.value.trim()) {
          // Split the return dates, filter out any that are earlier than the new minimum
          let returnDates = returnInput.value.split(",").map(s => s.trim()).filter(Boolean);
          const validReturnDates = returnDates.filter(dateStr => {
            const d = parseLocalDate(dateStr);
            return d.getTime() >= minDepDate.getTime();
          });
          // If some dates were removed, update the input and notify the user.
          if (validReturnDates.length !== returnDates.length) {
            returnInput.value = validReturnDates.join(", ");
            showNotification("Some return dates were removed because they are earlier than the departure date.");
          }
        }
      } else {
        returnInput.disabled = true;
        // If the trip type is "return", reset the return date when departure is cleared
        if (appState.tripType === "return") {
          appState.tripType = "oneway";
          updateSortControls(appState.tripType);
          returnDateInput.value = "";
          returnDateContainer.style.display = "none";
          const returnCalendarPopup = document.getElementById("return-calendar-popup");
          returnCalendarPopup.classList.add("hidden");
          tripTypeToggle.style.display = "block";
        }
      }
      updateReturnDateButtonState();
    });
  
    // Prevent clicking the return date input if no departure date is selected
    document.getElementById("return-date").addEventListener("click", (e) => {
      if (!departureDateInput.value.trim()) {
        e.preventDefault();
        showNotification("Please select a departure date first.");
      }
    });
  
    // ========== 7. Setup Other Event Handlers ==========
    // Search button event handler with validation for required fields
    const searchButton = document.getElementById("search-button");
    searchButton.addEventListener("click", () => {
      if (appState.searchSession.active) {
        handleSearch();
        return;
      }
      const errors = [];
      // Validate departure date
      if (!departureDateInput.value.trim()) {
        errors.push("Please select a departure date.");
      }
      // Validate airports for departure and destination
      const originAirports = getMultiAirportValues("origin-multi");
      const destinationAirports = getMultiAirportValues("destination-multi");
      if (originAirports.length === 0) {
        errors.push("Please select at least one departure airport.");
      }
      if (destinationAirports.length === 0) {
        errors.push("Please select at least one destination airport.");
      }
      // For round-trip, validate return date
      if (appState.tripType === "return") {
        if (!returnDateInput.value.trim()) {
          errors.push("For round-trip flights, please select a return date.");
        }
      }
      if (errors.length > 0) {
        showNotification(errors.join(" "));
        return;
      }
      // All validations passed, proceed to search
      handleSearch();
    });
  
    // Other event handlers for throttle and options
    document.getElementById("max-requests").addEventListener("change", updateRequestSettings);
    document.getElementById("pause-duration").addEventListener("change", updateRequestSettings);
    document.getElementById("max-concurrent-requests").addEventListener("change", updateRequestSettings);
    document.getElementById("cache-lifetime").addEventListener("change", updateCacheLifetimeSetting);
    document.getElementById("clear-cache-button").addEventListener("click", handleClearCache);
    document.getElementById("swap-button").addEventListener("click", swapInputs);
    document.getElementById("toggle-options").addEventListener("click", toggleOptions);
  
    // ========== 8. Options Button Styling ==========
    const optionsBtn = document.getElementById("toggle-options");
    optionsBtn.addEventListener("click", () => {
      optionsBtn.classList.remove("bg-[#C90076]");
      optionsBtn.classList.add("bg-[#20006D]");
      optionsBtn.blur();
    });
    optionsBtn.addEventListener("focus", () => {
      optionsBtn.classList.add("bg-[#C90076]");
    });
    optionsBtn.addEventListener("blur", () => {
      optionsBtn.classList.remove("bg-[#C90076]");
      optionsBtn.classList.add("bg-[#20006D]");
    });
  
    // ========== 9. Trip Type Switching & "Add Return Date" Button ==========
    appState.tripType = "oneway";
    const tripTypeToggle = document.getElementById("trip-type-toggle");
    const tripTypeText = document.getElementById("trip-type-text");
    const returnDateContainer = document.getElementById("return-date-container");
    const removeReturnDateBtn = document.getElementById("remove-return-date");
  
    // Set initial state: one-way mode (return container hidden, button visible)
    tripTypeText.textContent = "Add Return Date";
    returnDateContainer.style.display = "none";
    tripTypeToggle.style.display = "block";
    updateSortControls(appState.tripType);
    updateReturnDateButtonState();
  
    // "Add Return Date" button click handler
    tripTypeToggle.addEventListener("click", () => {
      if (!departureDateInput.value.trim()) {
        // Safety check – button should be disabled
        return;
      }
      appState.tripType = "return";
      updateSortControls(appState.tripType);
      tripTypeToggle.style.display = "none";
      returnDateContainer.style.display = "block";
      const returnCalendarPopup = document.getElementById("return-calendar-popup");
      // Initialize return calendar if not yet initialized
      if (!returnCalendarPopup.classList.contains("initialized")) {
        initMultiCalendar("return-date", "return-calendar-popup", 3);
        returnCalendarPopup.classList.add("initialized");
      }
      // Automatically open the return calendar
      setTimeout(() => {
        returnDateInput.dispatchEvent(new Event("click"));
      }, 100);
    });
  
    // "Remove Return Date" button click handler
    removeReturnDateBtn.addEventListener("click", () => {
      appState.tripType = "oneway";
      updateSortControls(appState.tripType);
      returnDateContainer.style.display = "none";
      returnDateInput.value = "";
      const returnCalendarPopup = document.getElementById("return-calendar-popup");
      returnCalendarPopup.classList.add("hidden");
      tripTypeToggle.style.display = "block";
    });
  
    // ========== 10. Stopover Dropdown ==========
    document.getElementById("stopover-dropdown-button").addEventListener("click", function () {
      document.getElementById("stopover-dropdown").classList.toggle("hidden");
    });
    document.addEventListener("click", function (event) {
      const dropdown = document.getElementById("stopover-dropdown");
      const button = document.getElementById("stopover-dropdown-button");
      if (!dropdown.classList.contains("hidden")) {
        animateElement(dropdown, "dropdown-enter", 300);
      }
      if (!dropdown.contains(event.target) && !button.contains(event.target)) {
        dropdown.classList.add("hidden");
      }
    });
    document.querySelectorAll("#stopover-dropdown input[name='stopover']").forEach(radio => {
      radio.addEventListener("change", function () {
        document.getElementById("selected-stopover").textContent = this.value;
        document.getElementById("stopover-dropdown").classList.add("hidden");
      });
    });

    // ========= 11. Go to payment page =========
    document.querySelector(".route-list").addEventListener("click", (event) => {
      const btn = event.target.closest(".continue-payment-button");
      if (btn) {
        const outboundKey = btn.getAttribute("data-outbound-key");
        continueToPayment(outboundKey);
      }
    });
    // ========= 13. Download CSV Button =========
    document.getElementById("download-csv-button").addEventListener("click", downloadResultsAsCSV);
    // Attach event listener to the Stopover dropdown selection
    document.querySelectorAll("#stopover-dropdown input[name='stopover']").forEach(radio => {
      radio.addEventListener("change", () => {
        updateCSVButtonVisibility(); // Update visibility when stopover selection changes
      });
    });
    // Also check visibility when the page loads
    updateCSVButtonVisibility();

      // ========== 14. Debug Mode Controls ==========
      const toggleDebugBtn = document.getElementById('toggle-debug');
      const debugLogContainer = document.getElementById('debug-log-container');
      const debugLogTextarea = document.getElementById('debug-log');
      const downloadDebugBtn = document.getElementById('download-debug-log');
      const clearDebugBtn = document.getElementById('clear-debug-log');

      toggleDebugBtn.textContent = `DEBUG MODE: ${debug ? 'ON' : 'OFF'}`;
      if (debug) debugLogContainer.classList.remove('hidden');
      updateDebugLogDisplay();

      toggleDebugBtn.addEventListener('click', () => {
        debug = !debug;
        settingsRepository.update({ debugMode: debug });
        toggleDebugBtn.textContent = `DEBUG MODE: ${debug ? 'ON' : 'OFF'}`;
        if (debug) {
          console.warn = function(...args) {
            debugLogger('WARN:', ...args);
            originalConsoleWarn.apply(console, args);
          };
        } else {
          console.warn = originalConsoleWarn;
        }
        debugLogContainer.classList.toggle('hidden', !debug);
      });



      downloadDebugBtn.addEventListener('click', () => {
        const blob = new Blob([debugLog.join('\n')], { type: 'text/plain' });
        downloadBlob(
          blob,
          `wizzair-debug-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`
        );
      });

      clearDebugBtn.addEventListener('click', () => {
        debugLog = [];
        updateDebugLogDisplay();
      });

      function updateDebugLogDisplay() {
        if (!debugLogTextarea) return;
        const nextValue = debugLog.join('\n');
        if (debugLogTextarea.value === nextValue) return;

        const isScrolledToBottom =
          debugLogTextarea.scrollTop + debugLogTextarea.clientHeight >=
          debugLogTextarea.scrollHeight - 1;
        const oldScrollTop = debugLogTextarea.scrollTop;

        debugLogTextarea.value = nextValue;

        if (!isScrolledToBottom) {
          debugLogTextarea.scrollTop = oldScrollTop;
        } else {
          debugLogTextarea.scrollTop = debugLogTextarea.scrollHeight;
        }
      }

      let debugDisplayFrame = null;
      scheduleDebugLogDisplayUpdate = () => {
        if (debugDisplayFrame !== null) return;
        const schedule = window.requestAnimationFrame
          ? callback => window.requestAnimationFrame(callback)
          : callback => setTimeout(callback, 0);
        debugDisplayFrame = schedule(() => {
          debugDisplayFrame = null;
          updateDebugLogDisplay();
        });
      };

      debugLog = [];

      mountChangelog({
        modal: document.getElementById("changelog-modal"),
        openButton: document.getElementById("changelog-button"),
        closeButton: document.getElementById("close-changelog"),
        content: document.getElementById("changelog-content"),
        version: extensionGateway.getManifestVersion()
      });
  }
