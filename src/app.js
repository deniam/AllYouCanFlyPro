import { routesData } from './data/routes.js';
import Dexie from '../src/libs/dexie.mjs';
import { loadAirportsData, MULTI_AIRPORT_CITIES, cityNameLookup } from './data/airports.js';
// ----------------------- Global Settings -----------------------
  // Throttle and caching parameters (loaded from localStorage if available)
  let debug = true;
  let activeTimeout = null;
  let timeoutInterval = null;
  let REQUESTS_FREQUENCY_MS = Number(localStorage.getItem('requestsFrequencyMs')) || 1800;
  const MAX_RETRY_ATTEMPTS = 2;  
  let PAUSE_DURATION_MS = Number(localStorage.getItem('pauseDurationSeconds'))
    ? Number(localStorage.getItem('pauseDurationSeconds')) * 1000
    : 1500;
  let CACHE_LIFETIME = (Number(localStorage.getItem('cacheLifetimeHours')) || 4) * 60 * 60 * 1000;
  // 4 hours in ms
  let MAX_REQUESTS_IN_ROW = Number(localStorage.getItem('maxRequestsInRow')) || 50;
  // Variables to track state
  let requestsThisWindow = 0;
  let searchCancelled = false;
  let globalResults = [];
  let globalDefaultResults = [];
  let suppressDisplay = false; // Flag to delay UI updates in certain search types
  // Build airport names mapping from AIRPORTS list (strip code in parentheses)
  const airportNames = {};
  let AIRPORTS = [];
  let COUNTRY_AIRPORTS = {};
  let airportFlags = {};

    //---------DixieDB Initialisation------------------
    const db = new Dexie("FlightSearchCache");
    db.version(1).stores({
      cache: 'key, timestamp'  // 'key' is our primary key; we also index the timestamp
    });
    db.version(2).stores({
      cache: 'key, timestamp',
      routes: '++id, departureStation'
    });

  async function initAirports() {
    try {
      const { AIRPORTS: loadedAirports, COUNTRY_AIRPORTS: loadedCountryAirports } = await loadAirportsData();
      AIRPORTS = loadedAirports;
      COUNTRY_AIRPORTS = loadedCountryAirports;
      
      // Build the flag mapping and airportLookup mapping once AIRPORTS is populated.
      AIRPORTS.forEach(airport => {
        if (airport.flag) {
          airportFlags[airport.code] = airport.flag;
        }
        airportLookup[airport.code] = airport;
      });
            
      // Now initialize UI components that rely on the airport data.
      setupAutocomplete("origin-multi", "origin-suggestions");
      setupAutocomplete("destination-multi", "destination-suggestions");
      
    } catch (error) {
      console.error("Error loading airports data:", error);
    }
    // Removed the stray closing brace as it was not part of any valid block or function.
  }
  // Restore saved tab context (supports Chrome and Orion)
  const storageApi = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
    ? chrome.storage.local
    : (typeof browser !== 'undefined' && browser.storage && browser.storage.local)
      ? browser.storage.local
      : null;
    
  if (storageApi) {
    storageApi.get("currentTabContext", (result) => {
      const ctx = result?.currentTabContext;
      if (ctx) {
        window.currentTabContext = ctx;
        const tabInfoEl = document.getElementById("tab-info");
        if (tabInfoEl) tabInfoEl.textContent = `Current Tab: ${ctx.title} (${ctx.url})`;
        storageApi.remove("currentTabContext");
      }
    });
  } else {
    // Fallback for Orion: use localStorage
    const saved = JSON.parse(localStorage.getItem("currentTabContext") || "{}");
    if (saved.currentTabContext) {
      window.currentTabContext = saved.currentTabContext;
      const tabInfoEl = document.getElementById("tab-info");
      if (tabInfoEl) tabInfoEl.textContent = `Current Tab: ${saved.currentTabContext.title} (${saved.currentTabContext.url})`;
      localStorage.removeItem("currentTabContext");
    }
  }

  async function importRoutes() {
    try {
      await db.routes.clear();
      await db.routes.bulkAdd(routesData);
      // Load routes from Dexie and assign them to a global variable
      const routes = await db.routes.toArray();
      window.ROUTES = routes;  // now ROUTES is defined globally
    } catch (error) {
      console.error("Error importing routes:", error);
    }
  }
  
  async function initApp() {
    await importRoutes();    // Wait for routes data to be imported and stored in IndexedDB (fills window.ROUTES)
    await initAirports();    // Then load airports and initialize autocomplete (which uses window.ROUTES)
  }
  initApp();
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
  
    // === Pre-index routesData for O(1) lookups ===
    const routesByOrigin = new Map();               // origin → [route,…]
    const routesByOriginAndDestination = {};        // origin → (destination → route)
    
    routesData.forEach(route => {
      // normalize origin code
      const origin = typeof route.departureStation === 'object'
        ? route.departureStation.id
        : route.departureStation;
    
      // fill routesByOrigin
      if (!routesByOrigin.has(origin)) {
        routesByOrigin.set(origin, []);
      }
      routesByOrigin.get(origin).push(route);
    
      // fill routesByOriginAndDestination
      (route.arrivalStations || []).forEach(arr => {
        const dest = typeof arr === 'object' ? arr.id : arr;
        routesByOriginAndDestination[origin] ??= {};
        routesByOriginAndDestination[origin][dest] = route;
      });
    });
  
  // ----------------------- DOM Elements -----------------------
  const progressContainer = document.getElementById('progress-container');
  const progressText = document.getElementById('progress-text');
  const progressBar = document.getElementById('progress-bar');
  const resultsContainer = document.getElementById("results-container");
  const resultsAndSortContainer = document.getElementById("results-and-sort-container");
  const totalResultsEl = document.getElementById("total-results");
  const sortSelect = document.getElementById("sort-select");
  let currentSortOption = "default";
  const allowSwitch = document.getElementById('allow-change-airport');
  const radiusInput = document.getElementById('connection-radius');
  // Initialize from localStorage
  const savedAllow  = localStorage.getItem('allowChangeAirport') === 'true';
  const savedRadius = parseInt(localStorage.getItem('connectionRadius')) || 0;
  allowSwitch.checked = savedAllow;
  radiusInput.value  = savedRadius;
  if (savedAllow) radiusInput.classList.remove('hidden');
  // Show/hide radius when the checkbox is toggled
  allowSwitch.addEventListener('change', () => {
    localStorage.setItem('allowChangeAirport', allowSwitch.checked);
    if (allowSwitch.checked) {
      radiusInput.classList.remove('hidden');
    } else {
      radiusInput.classList.add('hidden');
    }
  });

  // Persist the radius as soon as it’s changed
  radiusInput.addEventListener('input', () => {
    const v = parseInt(radiusInput.value) || 0;
    localStorage.setItem('connectionRadius', v);
  });


  sortSelect.addEventListener("change", () => {
    currentSortOption = sortSelect.value;
    if (currentSortOption === "default") {
      // Render using the preserved unsorted order.
      if (window.currentTripType === "return") {
        displayRoundTripResultsAll(globalDefaultResults);
      } else {
        displayGlobalResults(globalDefaultResults);
      }
    } else {
      // Work on a shallow copy of the default order so the original remains intact.
      let sortedResults = [...globalDefaultResults];
      sortResultsArray(sortedResults, currentSortOption);
      if (window.currentTripType === "return") {
        displayRoundTripResultsAll(sortedResults);
      } else {
        displayGlobalResults(sortedResults);
      }
    }
  });


  // ----------------------- UI Helper Functions -----------------------
  function updateProgress(current, total, message) {
    resultsContainer.classList.remove("hidden");
      progressContainer.style.display = "block";
      progressText.textContent = `${message} (${current} of ${total})`;
      const percentage = total > 0 ? (current / total) * 100 : 0;
      progressBar.style.width = percentage + "%";
  }

  function hideProgress() {
    progressContainer.style.display = "none";
  }
  
  function resetCountdownTimers() {
    if (activeTimeout) {
      clearTimeout(activeTimeout);
      activeTimeout = null;
    }
    if (timeoutInterval) {
      clearInterval(timeoutInterval);
      timeoutInterval = null;
    }
    const timeoutEl = document.getElementById("timeout-status");
    timeoutEl.textContent = "";
    timeoutEl.style.display = "none";
  }

  function showTimeoutCountdown(waitTimeMs) {
    resetCountdownTimers();
    const timeoutEl = document.getElementById("timeout-status");
    let seconds = Math.floor(waitTimeMs / 1000);
    timeoutEl.style.display = "block";
    timeoutEl.style.color = "";
    timeoutInterval = setInterval(() => {
      seconds--;
      if (waitTimeMs == 40000) {
        timeoutEl.style.color = "red";
        timeoutEl.textContent = `Rate limit encountered, pausing for ${seconds} seconds. Increase values inside of Expert Settings or take a break between searches.`;
      } else {
        timeoutEl.style.color = "";
        timeoutEl.textContent = `Pausing for ${seconds} seconds to avoid API rate limits...`;
      }
      if (seconds <= 0) {
        clearInterval(timeoutInterval);
        timeoutInterval = null;
        timeoutEl.textContent = "";
        timeoutEl.style.display = "none";
      }
    }, 1000);
  }

  let throttleResetTimer = null;

  async function throttleRequest() {
    if (searchCancelled) return;
  
    if (throttleResetTimer) {
      clearTimeout(throttleResetTimer);
      throttleResetTimer = null;
    }
  
    if (requestsThisWindow >= MAX_REQUESTS_IN_ROW) {
      if (debug) console.log(`Reached ${MAX_REQUESTS_IN_ROW} consecutive requests; pausing for ${PAUSE_DURATION_MS}ms`);
      showTimeoutCountdown(PAUSE_DURATION_MS);
      await new Promise(resolve => setTimeout(resolve, PAUSE_DURATION_MS));
      requestsThisWindow = 0;
    }
  
    const startTime = performance.now();
    requestsThisWindow++;
  
    // Recalculate delay on every request
    const delay = REQUESTS_FREQUENCY_MS + Math.floor(151 * (performance.now() % 1));
    await new Promise(resolve => {
      activeTimeout = setTimeout(() => {
        if (!searchCancelled) {
          resolve();
        }
      }, delay);
    });
    if (debug) console.log(`Current request delay: ${delay} ms`);
    if (searchCancelled) {
      if (debug) console.log("Search was cancelled during throttleRequest. Stopping execution.");
      return;
    }
  
    const endTime = performance.now();
    const actualDelay = endTime - startTime;
    if (debug) console.log(`Actual request delay: ${actualDelay.toFixed(2)} ms (Expected: ${delay} ms)`);
  
    throttleResetTimer = setTimeout(() => {
      requestsThisWindow = 0;
      if (debug) console.log("Throttle counter reset due to 10s inactivity.");
    }, 10000);
  }

  function updateThrottleSettings() {
    MAX_REQUESTS_IN_ROW = parseInt(document.getElementById("max-requests").value, 10);
    REQUESTS_FREQUENCY_MS = parseInt(document.getElementById("requests-frequency").value, 10);
    const pauseDur = parseInt(document.getElementById("pause-duration").value, 10);
    PAUSE_DURATION_MS = pauseDur * 1000;
    localStorage.setItem("maxRequestsInRow", MAX_REQUESTS_IN_ROW);
    localStorage.setItem("requestsFrequencyMs", REQUESTS_FREQUENCY_MS);
    localStorage.setItem("pauseDurationSeconds", pauseDur);
    if (debug) console.log(`Throttle settings updated: Max Requests = ${MAX_REQUESTS_IN_ROW}, Requests Frequency = ${REQUESTS_FREQUENCY_MS}ms, Pause Duration = ${PAUSE_DURATION_MS / 1000}s`);
  }
  function updateCacheLifetimeSetting() {
    const hours = parseFloat(document.getElementById("cache-lifetime").value);
    CACHE_LIFETIME = hours * 60 * 60 * 1000;
    localStorage.setItem("cacheLifetimeHours", hours);
  }

  function animateElement(element, animationClass, duration = 300) {
    if (element) {
      element.classList.add(animationClass);
      setTimeout(() => {
        element.classList.remove(animationClass);
      }, duration);
    }
  }

  /**
   * Returns distance between two coordinates in kilometers.
   */
  function haversineDistance(lat1, lon1, lat2, lon2) {
    const toRad = x => x * Math.PI / 180;
    const R = 6371; // earth radius km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c; // distance in km
    return distance;
  }
  //===========Autocomplete Functions================
// Assumptions:
//   - Global variables AIRPORTS, COUNTRY_AIRPORTS, and ROUTES are available and populated.
//   - getMultiAirportValues(containerId) returns an array of string values from inputs within the container.
//   - resolveAirport(input) resolves a given input string into an array of airport codes.
//   - ROUTES is an array of route objects loaded from Dexie (instead of the old static routesData).

  function setupAutocomplete(inputId, suggestionsId) {
    const inputEl = document.getElementById(inputId);
    const suggestionsEl = document.getElementById(suggestionsId);

    const lowerInputId = inputId.toLowerCase();
    
    function getDirectSuggestionsForDestination() {
      // 1) Read dates: Input field, or default to 4 days from now
      const rawDates = document.getElementById("departure-date").value || "";
      let selectedDates = rawDates
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
      if (!selectedDates.length) {
        const today = new Date();
        selectedDates = Array.from({ length: 4 }, (_, i) =>
          new Date(today.getTime() + i * 86400000)
            .toISOString()
            .slice(0, 10)
        );
      }
    
      // 2) Take origins
      const origins = getMultiAirportValues("origin-multi")
        .filter(v => v.trim() && v.toLowerCase() !== "anywhere");
    
      const suggestionsMap = new Map();
    
      origins.forEach(origin => {
        // 3) Expand multiairports (LON→[LTN,LGW…])
        const resolved = resolveAirport(origin);
        const originCodes = resolved.flatMap(code => {
          const key = code.toUpperCase();
          return MULTI_AIRPORT_CITIES[key] || [key];
        });
    
        originCodes.forEach(code => {
          const matching = routesByOrigin.get(code) || [];
          if (matching.length) {
            matching.forEach(route => {
              // 4) Filtering arrivalStations by dates
              (route.arrivalStations || [])
                .filter(arr => 
                  !arr.flightDates
                  || selectedDates.some(d => arr.flightDates.includes(d))
                )
                .forEach(arr => {
                  const id   = typeof arr === "object" ? arr.id   : arr;
                  const name = typeof arr === "object"
                    ? arr.name
                    : airportLookup[id]?.name || id;
                  if (id && name && !suggestionsMap.has(id)) {
                    suggestionsMap.set(id, name);
                  }
                });
            });
          } else {
            // fallback by clean AIRPORTS
            const found = AIRPORTS.find(a => a.code === code);
            if (found && !suggestionsMap.has(found.code)) {
              suggestionsMap.set(found.code, found.name);
            }
          }
        });
      });
    
      // 5) Merge and sort
      const suggestions = Array.from(suggestionsMap, ([code, name]) => ({
        isCountry: false,
        code,
        name
      }));
      suggestions.sort((a, b) => a.name.localeCompare(b.name));
      return suggestions;
    }
    
    function getDirectSuggestionsForOrigin() {
      // 1) Set dates (similar to getDirectSuggestionsForDestination)
      const rawDates = document.getElementById("departure-date").value || "";
      let selectedDates = rawDates
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
      if (!selectedDates.length) {
        const today = new Date();
        selectedDates = Array.from({ length: 4 }, (_, i) =>
          new Date(today.getTime() + i * 86400000)
            .toISOString()
            .slice(0, 10)
        );
      }
    
      // 2) Take destinations
      const destinations = getMultiAirportValues("destination-multi")
        .filter(v => v.trim() && v.toLowerCase() !== "anywhere");
    
      const suggestionsMap = new Map();
    
      destinations.forEach(dest => {
        // 3) Multiairport (LON→[LTN,LGW…])
        const resolved = resolveAirport(dest);
        const destCodes = resolved.flatMap(code => {
          const key = code.toUpperCase();
          return MULTI_AIRPORT_CITIES[key] || [key];
        });
    
        destCodes.forEach(code => {
          // 4) Search all routes where it is on arrivalStations
          const matching = ROUTES.filter(route =>
            (route.arrivalStations || []).some(arr => {
              const arrId = typeof arr === "object" ? arr.id : arr;
              // considering flightDates
              return arrId === code
                && (
                  !arr.flightDates
                  || selectedDates.some(d => arr.flightDates.includes(d))
                );
            })
          );
    
          matching.forEach(route => {
            // 5) Take departureStation fromn matching routes
            const depObj = route.departureStation;
            const id   = typeof depObj === "object" ? depObj.id   : depObj;
            const name = typeof depObj === "object"
              ? depObj.name
              : airportLookup[id]?.name || id;
            if (id && name && !suggestionsMap.has(id)) {
              suggestionsMap.set(id, name);
            }
          });
        });
      });
    
      // 6) Merge and sort
      const suggestions = Array.from(suggestionsMap, ([code, name]) => ({
        isCountry: false,
        code,
        name
      }));
      suggestions.sort((a, b) => a.name.localeCompare(b.name));
      if (debug) console.log (`Destination suggestions: ${suggestions}`);
      return suggestions;
    }
    

    let previousQuery = "";
    let directAnimated = false;
    function showSuggestions(query = "") {
      // Guard: if suggestionsEl or inputEl are not defined, do nothing.
      if (!inputEl || !suggestionsEl) return;
      
      suggestionsEl.innerHTML = "";
      
      // When a query is entered: filter the full catalog
      if (query) {     
        const countryMatches = Object.keys(COUNTRY_AIRPORTS)
          .filter(country => country.toLowerCase().includes(query))
          .map(country => ({ isCountry: true, code: country, name: country }));
        
        const airportMatches = AIRPORTS.filter(a => {
          const codeLower = a.code.toLowerCase();
          const nameLower = a.name.toLowerCase();
          return codeLower.includes(query) || nameLower.includes(query);
        }).map(a => ({ isCountry: false, code: a.code, name: a.name }));
        
        let matches = [...countryMatches, ...airportMatches];
        matches.sort((a, b) => {
          const aStarts = a.name.toLowerCase().startsWith(query);
          const bStarts = b.name.toLowerCase().startsWith(query);
          if (aStarts && !bStarts) return -1;
          if (!aStarts && bStarts) return 1;
          return a.name.localeCompare(b.name);
        });
        // Limit to six suggestions from filtering
        matches = matches.slice(0, 6);
        // For fields other than preferred-airport, always add "Anywhere" first.
        if (inputId !== "preferred-airport") {
          matches.unshift({ isCountry: false, code: "ANY", name: "Anywhere" });
        }
        
        if (matches.length === 0) {
          suggestionsEl.classList.add("hidden");
          return;
        }
        
        matches.forEach(match => {
          const div = document.createElement("div");
          div.className = "flex justify-between items-center px-1 py-1.5 cursor-pointer hover:bg-gray-100";
          div.textContent = match.name;
          div.addEventListener("click", () => {
            inputEl.value = match.name;
            suggestionsEl.classList.add("hidden");
          });
          suggestionsEl.appendChild(div);
        });
        const shouldAnimate = previousQuery.length === 0 && query.length > 0;
        previousQuery = query;
        suggestionsEl.style.maxHeight = "250px";
        suggestionsEl.style.overflowY = "auto";
        suggestionsEl.classList.remove("hidden");
        if (shouldAnimate) {
          suggestionsEl.classList.add("suggestions-enter");
          setTimeout(() => {
            suggestionsEl.classList.remove("suggestions-enter");
          }, 300);
        }
        directAnimated = false;
        return;
      }
      
      // When no query is entered.
      if (!query) {
        // For the preferred-airport field, do not include "Anywhere"
        if (inputId === "preferred-airport") {
          // Show full list without fixed height
          suggestionsEl.style.maxHeight = "";
          suggestionsEl.style.overflowY = "";
          suggestionsEl.classList.remove("hidden");
          return;
        }
        
        // For origin/destination fields when nothing is entered:
        let directSuggestions = [];
        if (lowerInputId.includes("destination")) {
          directSuggestions = getDirectSuggestionsForDestination();
        } else if (lowerInputId.includes("origin")) {
          directSuggestions = getDirectSuggestionsForOrigin();
        }
        // Always add "Anywhere" first.
        directSuggestions.unshift({ isCountry: false, code: "ANY", name: "Anywhere" });
        
        directSuggestions.forEach(suggestion => {
          const div = document.createElement("div");
          div.className = "flex justify-between items-center px-1 py-1.5 cursor-pointer hover:bg-gray-100";
          div.textContent = suggestion.name;
          div.addEventListener("click", () => {
            inputEl.value = suggestion.name;
            suggestionsEl.classList.add("hidden");
          });
          suggestionsEl.appendChild(div);
        });
        const shouldAnimate = previousQuery.length === 0 && query.length > 0;
        previousQuery = query;
        suggestionsEl.style.maxHeight = "250px";
        suggestionsEl.style.overflowY = "auto";
        suggestionsEl.classList.remove("hidden");
        if (!directAnimated) {
          suggestionsEl.classList.add("suggestions-enter");
          setTimeout(() => {
            suggestionsEl.classList.remove("suggestions-enter");
          }, 300);
          directAnimated = true;
        }
        previousQuery = "";
        return;
      }
      
      suggestionsEl.style.maxHeight = "";
      suggestionsEl.style.overflowY = "";
      suggestionsEl.classList.remove("hidden");
    }
              // Show suggestions when the input is focused and empty.
    inputEl.addEventListener("focus", () => {
      if (!inputEl.value.trim()) {
        showSuggestions();
      }
    });

    // Update suggestions as the user types.
    inputEl.addEventListener("input", (e) => {
      const query = e.target.value.trim().toLowerCase();
      if (debug) console.log("Query:", query);
      showSuggestions(query);
    });


    // Hide suggestions when clicking outside.
    document.addEventListener("click", event => {
      if (inputEl && suggestionsEl && !inputEl.contains(event.target) && !suggestionsEl.contains(event.target)) {
        suggestionsEl.classList.add("hidden");
      }
    });
    
  }
  
  // Helper function to get values from all input fields within a container.
  function getMultiAirportValues(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    const inputs = container.querySelectorAll("input");
    return Array.from(inputs)
      .map(input => (input.value || "").trim())
      .filter(val => val !== "");
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

      /**
 * Parses a 12‑hour time string (e.g., "11:20 pm") and returns an object {hour, minute} in 24‑hour format.
 */
  function parse12HourTime(timeStr) {
    const regex = /(\d{1,2}):(\d{2})\s*(am|pm)/i;
    const match = timeStr.match(regex);
    if (!match) {
      console.warn("Cannot parse time string:", timeStr);
      return null;
    }
    let hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    const period = match[3].toLowerCase();
    if (period === "pm" && hour !== 12) hour += 12;
    if (period === "am" && hour === 12) hour = 0;
    return { hour, minute };
  }

  /**
   * Converts a 12‑hour time string into a 24‑hour formatted string (e.g., "11:20 pm" → "23:20").
   */
  function convertTo24Hour(timeStr) {
    const parsed = parse12HourTime(timeStr);
    if (!parsed) return timeStr;
    return `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;
  }

  /**
   * Normalizes a time zone offset string.
   * For example, "UTC+1" becomes "+01:00" and "UTC" becomes "+00:00".
   */
  function normalizeOffset(offset) {
    if (!offset || offset.trim() === "" || offset.toUpperCase() === "UTC") {
      return "+00:00";
    }
    if (offset.toUpperCase().startsWith("UTC")) {
      let rest = offset.substring(3).trim();
      if (!rest) return "+00:00";
      if (!rest.startsWith("+") && !rest.startsWith("-")) {
        rest = "+" + rest;
      }
      if (!rest.includes(":")) {
        let sign = rest.charAt(0);
        let num = rest.substring(1);
        if (num.length === 1) {
          num = "0" + num;
        }
        rest = sign + num + ":00";
      }
      return rest;
    }
    return offset;
  }

  /**
   * Combines a date string (in "YYYY‑MM‑DD" format) with a time object ({hour, minute})
   * into a Date object representing the “pure” local time.
   * This Date is constructed using UTC so that, for example, new Date(Date.UTC(2025, 2, 8, 23, 20, 0))
   * produces "2025‑03‑08T23:20:00.000Z".
   */
  function combineDateAndTime(dateStr, timeObj) {
    const parts = dateStr.split("-");
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    return new Date(Date.UTC(year, month, day, timeObj.hour, timeObj.minute, 0));
  }

  /**
   * Formats a Date object as a flight date string, e.g., "Sat, 8 Mar, 2025".
   */
  function formatFlightDateSingle(date) {
    if (!(date instanceof Date)) {
      // Try to parse the string into a Date object.
      date = parseServerDate(date);
    }
    if (!(date instanceof Date)) return "";
    const options = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
    return date.toLocaleDateString('en-US', options);
  }


  /**
   * Combines two Date objects (departure and arrival) into a formatted date range.
   * If both dates fall on the same day, returns a single formatted date;
   * otherwise, returns "Date1 - Date2".
   */
  function formatFlightDateCombined(depDate, arrDate) {
    const dep = typeof depDate === "string" ? parseServerDate(depDate) : depDate;
    const arr = typeof arrDate === "string" ? parseServerDate(arrDate) : arrDate;
  
    if (!(dep instanceof Date) || !(arr instanceof Date)) return "";
  
    if (dep.toDateString() === arr.toDateString()) {
      return formatFlightDateSingle(dep);
    } else {
      return `${formatFlightDateSingle(dep)} - ${formatFlightDateSingle(arr)}`;
    }
  }
  

  /**
   * Unifies a raw flight object from the server by recalculating the departure and arrival Date objects,
   * the display times, the flight duration (accounting for time zone differences), and a formatted date range.
  */
  function unifyRawFlight(rawFlight) {
    const depDateStr = rawFlight.departureDateIso 
      ? rawFlight.departureDateIso 
      : new Date(parseServerDate(rawFlight.departureDate)).toISOString().slice(0, 10);
    const arrDateStr = rawFlight.arrivalDateIso 
      ? rawFlight.arrivalDateIso 
      : new Date(parseServerDate(rawFlight.arrivalDate)).toISOString().slice(0, 10);
      
    const depTimeObj = parse12HourTime(rawFlight.departure);
    const arrTimeObj = parse12HourTime(rawFlight.arrival);
    if (!depTimeObj || !arrTimeObj) {
      console.error("Time parsing failed for flight:", rawFlight);
      return rawFlight;
    }
    
    let localDeparture = combineDateAndTime(depDateStr, depTimeObj);
    let localArrival = combineDateAndTime(arrDateStr, arrTimeObj);
    
    const normDepOffset = normalizeOffset(rawFlight.departureOffsetText);
    const normArrOffset = normalizeOffset(rawFlight.arrivalOffsetText);
    const depOffsetHours = parseInt(normDepOffset.slice(0, 3), 10);
    const arrOffsetHours = parseInt(normArrOffset.slice(0, 3), 10);
    
    const utcDeparture = new Date(localDeparture.getTime() - depOffsetHours * 3600000);
    const utcArrival = new Date(localArrival.getTime() - arrOffsetHours * 3600000);
    
    if (utcArrival <= utcDeparture) {
      localArrival = new Date(localArrival.getTime() + 24 * 3600000);
    }
    
    const adjustedUtcArrival = new Date(localArrival.getTime() - arrOffsetHours * 3600000);
    const totalMinutes = Math.round((adjustedUtcArrival - utcDeparture) / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    
    const displayDep = convertTo24Hour(rawFlight.departure);
    const displayArr = convertTo24Hour(rawFlight.arrival);
    const formattedFlightDate = formatFlightDateCombined(rawFlight.departureDate, rawFlight.arrivalDate);
    const route = [rawFlight.departureStationText, rawFlight.arrivalStationText];
    
    return {
      key: rawFlight.key,
      fareSellKey: rawFlight.fareSellKey,
      departure: rawFlight.departure,
      arrival: rawFlight.arrival,
      departureStation: rawFlight.departureStation,
      departureStationText: rawFlight.departureStationText,
      arrivalStation: rawFlight.arrivalStation,
      arrivalStationText: rawFlight.arrivalStationText,
      departureDate: rawFlight.departureDate,
      arrivalDate: rawFlight.arrivalDate,
      departureStationCode: rawFlight.departureStationCode,
      arrivalStationCode: rawFlight.arrivalStationCode,
      reference: rawFlight.reference,
      stops: rawFlight.stops,
      flightCode: rawFlight.flightCode,
      carrierText: rawFlight.carrierText,
      currency: rawFlight.currency,
      fare: rawFlight.fare,
      discount: rawFlight.discount,
      price: rawFlight.price,
      taxes: rawFlight.taxes,
      totalPrice: rawFlight.totalPrice,
      displayPrice: rawFlight.displayPrice,
      priceTag: rawFlight.priceTag,
      flightId: rawFlight.flightId,
      fareBasisCode: rawFlight.fareBasisCode,
      actionText: rawFlight.actionText,
      isFree: rawFlight.isFree,
      departureOffsetText: rawFlight.departureOffsetText,
      arrivalOffsetText: rawFlight.arrivalOffsetText,
      departureOffset: normDepOffset,
      arrivalOffset: normArrOffset,
      displayDeparture: displayDep,
      displayArrival: displayArr,
      calculatedDuration: {
        hours: hours,
        minutes: minutes,
        totalMinutes: totalMinutes,
        departureDate: localDeparture,
        arrivalDate: localArrival
      },
      formattedFlightDate: formattedFlightDate,
      route: route
    };
  }
  /**
 * Formats an offset string for display.
 * For example, "+01:00" is shown as "UTC+1" and "+00:00" as "UTC".
 */
  function formatOffsetForDisplay(offsetText) {
    if (!offsetText) return "UTC";
    const sign = offsetText.charAt(0);
    const hours = parseInt(offsetText.slice(1, 3), 10);
    return isNaN(hours) || hours === 0 ? "UTC" : `UTC${sign}${hours}`;
  }

  function parseServerDate(dateStr) {
    if (!dateStr) return null;
    if (dateStr instanceof Date) return dateStr;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return new Date(dateStr + "T00:00:00Z");
    }
    const parts = dateStr.trim().split(" ");
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10);
      const monthNames = ["January", "February", "March", "April", "May", "June",
                          "July", "August", "September", "October", "November", "December"];
      const monthIndex = monthNames.indexOf(parts[1]);
      const year = parseInt(parts[2], 10);
      if (monthIndex >= 0 && !isNaN(day) && !isNaN(year)) {
        return new Date(Date.UTC(year, monthIndex, day));
      }
    }
    return new Date(dateStr);
  }
  
  // ---------------- Candidate Caching Functions ----------------
  function getUnifiedCacheKey(origin, destination, date) {
    return `${origin}-${destination}-${date}`;
  }

  async function handleClearCache() {  
    try {
      // Clear all cached results in Dexie
      await db.cache.clear();
      if (debug) console.log("Dexie cache cleared.");
    } catch (error) {
      console.error("Error clearing Dexie cache:", error);
    }
    localStorage.removeItem("wizz_page_data");
    showNotification("✅ Cache successfully cleared!");
  }  

  async function cleanupCache() {
    try {
      const now = Date.now();
      const expiredEntries = await db.cache.where("timestamp").below(now - CACHE_LIFETIME).toArray();
      for (const entry of expiredEntries) {
        await db.cache.delete(entry.key);
        if (debug) console.log(`Expired cache key found and deleted: ${entry.key}`);
      }
    } catch (e) {
      console.error("Error while cleaning cache:", e);
    }
  }

  async function setCachedResults(key, results) {
    const cacheData = { key, results, timestamp: Date.now() };
    try {
      await db.cache.put(cacheData);
    } catch (e) {
      console.error("Error setting cached results in IndexedDB:", e);
    }
  }

  async function getCachedResults(key) {
    try {
      const entry = await db.cache.get(key);
      if (entry && Array.isArray(entry.results) && Date.now() - entry.timestamp < CACHE_LIFETIME) {
        return entry.results;
      }
    } catch (e) {
      console.error("Error retrieving cached results from IndexedDB:", e);
    }
    return null;
  }

  // ---------------- API Request Function ----------------
  function getHeadersFromPage() {
    return new Promise((resolve) => {
      // Instead of querying the active tab, query any tab with the multipass URL.
      chrome.tabs.query({ url: "https://multipass.wizzair.com/*" }, (tabs) => {
        if (chrome.runtime.lastError) {
          console.error("sendMessage error:", chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (tabs && tabs.length > 0) {
          // Use the first multipass tab found.
          const multipassTab = tabs[0];
          chrome.tabs.sendMessage(multipassTab.id, { action: "getHeaders" }, (response) => {
            if (chrome.runtime.lastError) {
              console.error("sendMessage error:", chrome.runtime.lastError.message);
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response && response.headers) {
              resolve(response.headers);
            } else if
              (chrome.runtime.lastError) {
                console.error("sendMessage error:", chrome.runtime.lastError.message);
                reject(new Error(chrome.runtime.lastError.message));
                return;
            } else {
              resolve(null);
            }
          });
        } else {
          resolve(null);
        }
      });
    });
  }

  function isDateAvailableForSegment(origin, destination, dateStr) {
    // Find the route that starts at the given origin.
    const route = routesByOriginAndDestination[origin]?.[destination];
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
    return true;
  }

  async function checkRouteSegment(origin, destination, date) {
    if (debug) console.log(`Checking route segment: ${origin} → ${destination} on ${date}`);
    let attempts = 0;
    while (attempts < MAX_RETRY_ATTEMPTS) {
      await throttleRequest();
      try {
        let dynamicUrl = await getDynamicUrl();
        const pageDataStr = localStorage.getItem("wizz_page_data") || "{}";
        const pageData = JSON.parse(pageDataStr);
        const data = {
          flightType: "OW",
          origin: origin,
          destination: destination,
          departure: date,
          arrival: "",
          intervalSubtype: null
        };
  
        let headers = { "Content-Type": "application/json" };
  
        // Use cached headers if available and still valid.
        if (pageData.headers && Date.now() - pageData.timestamp < 60 * 60 * 1000) {
          if (debug) console.log("Using cached headers");
          headers = { ...headers, ...pageData.headers };
        } else {
          const fetchedHeaders = await getHeadersFromPage();
          if (fetchedHeaders) {
            headers = { ...headers, ...fetchedHeaders };
          } else {
            if (debug) console.log("Failed to get headers from page, using defaults");
          }
        }
  
        const fetchResponse = await fetch(dynamicUrl, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(data)
        });
  
        if (!fetchResponse.ok) {
          if (fetchResponse.status === 400) {
            if (debug) console.warn(`HTTP 400 for segment ${origin} → ${destination}: returning empty array`);
            return [];
          }
          if (debug) throw new Error(`HTTP error: ${fetchResponse.status}`);
        }

        const contentType = fetchResponse.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          const text = await fetchResponse.text();
          if (text.trim().startsWith("<!DOCTYPE")) {
            if (debug) console.warn("Dynamic URL returned HTML. Clearing cache and refreshing multipass tab.");
            localStorage.removeItem("wizz_page_data");
            await refreshMultipassTab();
            continue;
            // showNotification("Authorization required: please log in to your account to search for routes.");
            // throw new Error("Authorization required: expected JSON but received HTML");
          }
            // dynamicUrl = await getDynamicUrl();
            // // Throw a specific error that we can catch below
            // throw new Error("Invalid response format: expected JSON but received HTML");
          
        }
  
        const responseData = await fetchResponse.json();
        if (debug) console.log(`Response for segment ${origin} → ${destination}:`, responseData);
        return responseData.flightsOutbound || [];
  
      } catch (error) {
          if (searchCancelled) {
            if (debug) console.log("Search was cancelled. Stopping execution in checkRouteSegment.");
            resetCountdownTimers();
            return;
          }
      
          let waitTime = 0;
          if (error.message.includes("426")) {
            waitTime = 60000;
            if (debug) console.warn(`Rate limit encountered (426) for segment ${origin} → ${destination} – waiting for ${waitTime / 1000} seconds`);
          } else if (error.message.includes("429")) {
            waitTime = 40000;
            if (debug) console.warn(`Rate limit encountered (429) for segment ${origin} → ${destination} – waiting for ${waitTime / 1000} seconds`);
          } else if (error.message.includes("501")) {
            waitTime = 15000;
            if (debug) console.warn(`Rate limit encountered (501) for segment ${origin} → ${destination} – waiting for ${waitTime / 1000} seconds`);

          } else if (error.message.includes("Invalid response format")) {
            waitTime = 2000;
            if (debug) console.warn(`Dynamic URL returned HTML for segment ${origin} → ${destination} – waiting for ${waitTime / 2000} seconds`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          } else {
            if (debug) throw error;
          }
      
          if (waitTime > 0) {
            showTimeoutCountdown(waitTime);
            // Before setting a new timer, clear any existing activeTimeout
            if (activeTimeout) {
              clearTimeout(activeTimeout);
              activeTimeout = null;
            }
            await new Promise(resolve => {
              activeTimeout = setTimeout(() => {
                resolve();
              }, waitTime);
            });
          }
          attempts++;
        }
      }
      if (debug) throw new Error("Max retry attempts reached for segment " + origin + " → " + destination);
    }

  // ---------------- Graph Building and DFS Functions ----------------
  function buildGraph(routesData) {
    const graph = {};
    routesData.forEach(route => {
      const origin = typeof route.departureStation === "object" ? route.departureStation.id : route.departureStation;
      if (!graph[origin]) {
        graph[origin] = [];
      }
      if (route.arrivalStations && Array.isArray(route.arrivalStations)) {
        route.arrivalStations.forEach(station => {
          const stationId = typeof station === "object" ? station.id : station;
          graph[origin].push(stationId);
        });
      }
    });
    return graph;
  }
  
  function findRoutesDFS(graph, current, destinationList, path, maxTransfers, routes, visited = new Set()) {
    // Limit route length: for maxTransfers, allowed nodes = maxTransfers + 2 (origin + transfers + destination)
    if (path.length > maxTransfers + 2) return;
  
    // Create a candidate key from the current path.
    const candidateKey = path.join("-");
    // If we’ve already seen this candidate, skip to avoid duplicate processing.
    if (visited.has(candidateKey)) return;
  
    // If the current airport is one of the destinations and the path has at least one segment, record it.
    if (destinationList.includes(current) && path.length > 1) {
      routes.push([...path]);
      visited.add(candidateKey);
    }
  
    if (!graph[current]) return;
  
    // Recursively explore neighbors while preventing cycles.
    for (const next of graph[current]) {
      if (!path.includes(next)) {
        path.push(next);
        findRoutesDFS(graph, next, destinationList, path, maxTransfers, routes, visited);
        path.pop();
      }
    }
  }   

    // ---------------- Global Results Display Functions ----------------
    /**
   * Appends a unified route (either a direct flight or an aggregated connecting route) to the global results,
   * then triggers re‑rendering.
   */
  function appendRouteToDisplay(routeObj) {
    globalResults.push(routeObj);
    globalDefaultResults.push(routeObj);
    if (!suppressDisplay) {
      if (window.currentTripType === "return") {
        displayRoundTripResultsAll(globalResults);
      } else {
        displayGlobalResults(globalResults);
      }
    }
  }
    

  /**
   * Renders a list of direct or aggregated routes.
   */
  function displayGlobalResults(results) {
    // 1) Sort before rendering
    sortResultsArray(results, currentSortOption);
  
    // 2) Show the container, update total results
    resultsAndSortContainer.classList.remove("hidden");
    totalResultsEl.textContent = `Total results: ${results.length}`;
  
    // 3) Render them
    const resultsDiv = document.querySelector(".route-list");
    resultsDiv.innerHTML = "";
    results.forEach(routeObj => {
      const routeHtml = renderRouteBlock(routeObj);
      resultsDiv.insertAdjacentHTML("beforeend", routeHtml);
    });
    bindTooltipListeners(resultsDiv);

  }

  function bindTooltipListeners(rootElement) {
    const triggers = rootElement.querySelectorAll('.tooltip-trigger');

    triggers.forEach(el => {
      el.addEventListener('click', (event) => {
        event.stopPropagation();

        const tooltip = el.parentElement.querySelector('.tooltip');
        if (!tooltip) return;

        tooltip.classList.toggle('hidden');
      });
    });

    document.addEventListener('click', () => {
      document.querySelectorAll('.tooltip').forEach(t => {
        t.classList.add('hidden');
      });
    });
  }

  /**
   * Renders round-trip results.
   */
  function displayRoundTripResultsAll(outbounds) {
    sortResultsArray(outbounds, currentSortOption);
    resultsAndSortContainer.classList.remove("hidden");
    totalResultsEl.textContent = `Total results: ${outbounds.length}`;

    const resultsDiv = document.querySelector(".route-list");
    resultsDiv.innerHTML = "";

    outbounds.forEach((outbound, index) => {
      const outboundHtml = renderRouteBlock(outbound, "Outbound Flight");
      const toggleId = `toggle-return-${index}`;
      const returnId = `return-list-${index}`;

      let returnHtml = "";
      if (outbound.returnFlights && outbound.returnFlights.length > 0) {
        const returns = outbound.returnFlights.map((ret, idx) => {
          const outboundLastArrival = outbound.calculatedDuration.arrivalDate;
          const inboundFirstDeparture = ret.calculatedDuration.departureDate;
          const stopoverMs = inboundFirstDeparture - outboundLastArrival;
          const stopoverMinutes = Math.max(0, Math.round(stopoverMs / 60000));
          const sh = Math.floor(stopoverMinutes / 60);
          const sm = stopoverMinutes % 60;
          const stopoverText = `Stopover: ${sh}h ${sm}m`;
          return renderRouteBlock(ret, `Inbound Flight ${idx + 1}`, stopoverText);
        }).join("");
        
        returnHtml = `
          <div id="${returnId}" class="mt-2 hidden">
            ${returns}
          </div>
        `;
      }

      const inboundCount = outbound.returnFlights?.length || 0;
      const toggleButtonHtml = inboundCount > 0
        ? `<div class="text-center mt-2">
             <button
               id="${toggleId}"
               class="inline-flex items-center px-4 py-2 text-sm text-[#C90076] font-semibold hover:underline active:scale-95 cursor-pointer transition"
               aria-expanded="false"
               data-count="${inboundCount}"
             >
               <svg focusable="false" aria-hidden="true" width="24" height="24" viewBox="0 0 24 24"
                    class="w-6 h-6 mr-1 transition-transform">
                 <path fill="currentColor" d="M12 16.41l-6.71-6.7 1.42-1.42 5.29 5.3 5.29-5.3 1.42 1.42z"/>
               </svg>
               <span class="toggle-label">${inboundCount} inbound flight${inboundCount > 1 ? "s" : ""} found</span>
             </button>
           </div>`
        : "";

      resultsDiv.insertAdjacentHTML("beforeend", `
        <div class="border rounded-lg p-2.5 mb-4">
          ${outboundHtml}
          ${toggleButtonHtml}
          ${returnHtml}
        </div>
      `);

      if (outbound.returnFlights?.length) {
        setTimeout(() => {
          const toggleBtn = document.getElementById(toggleId);
          const returnBlock = document.getElementById(returnId);

          toggleBtn.addEventListener("click", () => {
            const count = Number(toggleBtn.dataset.count);
            const expanded = toggleBtn.getAttribute("aria-expanded") === "true";
            returnBlock.classList.toggle("hidden");
            toggleBtn.setAttribute("aria-expanded", String(expanded));
            toggleBtn.querySelector(".toggle-label").textContent = expanded
              ? `${count} inbound flight${count > 1 ? "s" : ""} found`
              : `${count} inbound flight${count > 1 ? "s" : ""} found`;
            toggleBtn.querySelector("svg").classList.toggle("rotate-180");
          });
        }, 0);
      }
    });

    bindTooltipListeners(resultsDiv);
  }

  // ---------------- Data Fetching Functions ----------------
  async function fetchDestinations() {
    const routes = await window.ROUTES;
    return routes.map(route => ({
      ...route,
      arrivalStations: Array.isArray(route.arrivalStations)
      ?
       [...route.arrivalStations]
       :
        []
    }));
  }
  
  async function sendMessageWithRetry(tabId, message, retries = 3, delay = 1000) {
    return new Promise((resolve, reject) => {
      function attempt() {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            console.error("sendMessage error:", chrome.runtime.lastError.message);
            if (retries > 0) {
              retries--;
              setTimeout(attempt, delay);
            } else {
              reject(new Error(chrome.runtime.lastError.message));
            }
          } else {
            resolve(response);
          }
        });
      }
      attempt();
    });
  }

  async function getDynamicUrl() {
    const pageDataStr = localStorage.getItem("wizz_page_data");
    if (pageDataStr) {
      const data = JSON.parse(pageDataStr);
      if (Date.now() - data.timestamp < 60 * 60 * 1000 && data.dynamicUrl) {
        if (debug) console.log("Using cached dynamic URL");
        return data.dynamicUrl;
      }
    }
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ url: "https://multipass.wizzair.com/*" }, async (tabs) => {
        let targetTab;
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (tabs && tabs.length > 0) {
          targetTab = tabs[0];
          if (debug) console.log("Found multipass tab:", targetTab);
        } else {
          try {
            await refreshMultipassTab();
          } catch (err) {
            if (debug) console.error("Failed to refresh multipass tab:", err);
          }
          chrome.tabs.query({ url: "https://multipass.wizzair.com/*" }, (tabsAfter) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (tabsAfter && tabsAfter.length > 0) {
              targetTab = tabsAfter[0];
              if (debug) console.log("After refresh, found multipass tab:", targetTab);
            }
          });
        }

        if (!targetTab) {
          reject(new Error("No multipass tab found"));
          return;
        }

        if (targetTab.status !== "complete") {
          await waitForTabToComplete(targetTab.id);
        }
        await new Promise((r) => setTimeout(r, 1000));

        try {
          const response = await sendMessageWithRetry(targetTab.id, { action: "getDynamicUrl" });
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.dynamicUrl) {
            const pageData = JSON.parse(localStorage.getItem("wizz_page_data") || "{}");
            pageData.dynamicUrl = response.dynamicUrl;
            pageData.timestamp = Date.now();
            localStorage.setItem("wizz_page_data", JSON.stringify(pageData));
            resolve(response.dynamicUrl);
          } else if (response && response.error) {
            reject(new Error(response.error));
          } else {
            reject(new Error("Failed to get dynamic URL"));
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function waitForTabToComplete(tabId) {
    return new Promise((resolve) => {
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  async function refreshMultipassTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ url: "https://multipass.wizzair.com/*" }, (tabs) => {
        if (!tabs || tabs.length === 0) {
          // No multipass tab exists, so create a new one.
          chrome.tabs.create(
            { url: "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets" },
            (newTab) => {
              waitForTabToComplete(newTab.id).then(resolve).catch(reject);
            }
          );
        } else {
          // Look for a non-active tab first.
          let tabToReload = tabs.find(tab => !tab.active);
          if (!tabToReload) {
            // If all tabs are active, pick the first one.
            tabToReload = tabs[0];
          }
          chrome.tabs.reload(tabToReload.id, {}, () => {
            waitForTabToComplete(tabToReload.id).then(resolve).catch(reject);
          });
        }
      });
    });
  }
  

  // ---------------- Round-Trip and Direct Route Search Functions ----------------
  // Searches for connecting (multi‑leg) routes.
  // Uses the "overnight-checkbox" value to decide if connecting flights must depart on the same day as selected.
// Function to add days in UTC mode
  function addDaysUTC(date, days) {
    const result = new Date(date.getTime());
    result.setUTCDate(result.getUTCDate() + days);
    return result;
  }

  // Function to correctly convert a datetime string with an offset into a Date object
  function parseFlightDateTime(dateTimeIso, offsetText) {
    if (!dateTimeIso) return null;
    let offsetFormatted = "Z";
    const match = offsetText.match(/UTC([+-]\d+)/);
    if (match) {
      let hours = parseInt(match[1], 10);
      offsetFormatted = (hours >= 0 ? "+" : "") + String(hours).padStart(2, "0") + ":00";
    }
    const isoString = dateTimeIso.replace(" ", "T") + offsetFormatted;
    return new Date(isoString);
  }

  // Updated function to get the date in the target time zone (ignoring the client's local time)
  function getLocalDateFromOffset(date, offsetText) {
    if (!date || !(date instanceof Date)) {
      console.error("Invalid date passed to getLocalDateFromOffset:", date);
      return "";
    }
    const offsetMatch = offsetText ? offsetText.match(/UTC([+-]\d+)/) : null;
    const offsetHours = offsetMatch ? parseInt(offsetMatch[1], 10) : 0;
    const localTime = date.getTime() - offsetHours * 3600000;
    const localDate = new Date(localTime);
    const yyyy = localDate.getUTCFullYear();
    const mm = String(localDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(localDate.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * Preliminary check for a candidate route.
   * For each segment (departure -> arrival), this function retrieves the arrival object's flightDates array
   * and verifies that at least one date within the allowed search window is available.
   *
   * @param {Array} candidate - Array of station codes representing the candidate route.
   * @param {Array} routesData - The routes data.
   * @param {string} selectedDate - The selected date string (YYYY-MM-DD).
   * @param {Date} bookingHorizon - The maximum allowed date.
   * @param {Array<number>} allowedOffsets - Array of allowed day offsets (e.g. [0,1,2] for multi‑stop).
   * @returns {boolean} - True if all segments have at least one allowed flight date, false otherwise.
   */
  function candidateHasValidFlightDates(candidate, routesData, selectedDate, bookingHorizon, allowedOffsets) {
    const baseDateUTC = new Date(selectedDate + "T00:00:00Z");
    for (let i = 0; i < candidate.length - 1; i++) {
      const dep = candidate[i];
      const arr = candidate[i + 1];
      const route = routesData.find(r => {
        const depCode = typeof r.departureStation === "object" ? r.departureStation.id : r.departureStation;
        return depCode === dep;
      });
      if (!route) {
        return false;
      }
      const arrivalObj = route.arrivalStations.find(s => {
        const code = typeof s === "object" ? s.id : s;
        return code === arr;
      });
      if (!arrivalObj || !arrivalObj.flightDates) {
        return false;
      }
      // Compute allowed dates based on allowedOffsets
      const allowedDates = allowedOffsets
        .map(offset => {
          const d = addDaysUTC(baseDateUTC, offset);
          if (d > bookingHorizon) return null;
          return d.toISOString().slice(0,10);
        })
        .filter(x => x !== null);
      // Check if at least one allowed date is present in flightDates
      const hasValid = allowedDates.some(date => arrivalObj.flightDates.includes(date));
      if (!hasValid) {
        if (debug) console.log(`Preliminary check: Segment ${dep} -> ${arr} does not have any allowed flightDates among ${allowedDates.join(", ")}`);
        return false;
      }
    }
    return true;
  }

  /**
   * Recursive function to iterate through possible options for route segments.
   * Returns an array of options (each option is an array of flights for segments from index to the end).
   */
  async function processSegment(candidate, index, currentDate, previousFlight, bookingHorizon, minConnection, maxConnection, baseMaxDays, selectedDate, routesData) {
    if (index >= candidate.length - 1) {
      // Base case: return one option – an empty array.
      return [[]];
    }
    
    const segOrigin = candidate[index];
    const segDestination = candidate[index + 1];
    let validChains = [];
    
    if (debug) console.log(`--> Processing segment: ${segOrigin} -> ${segDestination}`);
    
    for (let offset = 0; offset <= baseMaxDays; offset++) {
      const dateToSearch = addDaysUTC(currentDate, offset);
      const dateStr = dateToSearch.toISOString().slice(0, 10);
      if (index === 0 && dateStr !== selectedDate) {
        if (debug) console.log(`   Skipping date ${dateStr} for first segment (selected date is ${selectedDate})`);
        continue;
      }
      if (dateToSearch > bookingHorizon) {
        if (debug) console.log(`   Date ${dateStr} exceeds booking horizon; breaking offset loop`);
        break;
      }
      
      // Check flightDates for this segment from routes data
      const routeForSegment = routesData.find(r => {
        const dep = typeof r.departureStation === "object" ? r.departureStation.id : r.departureStation;
        return dep === segOrigin;
      });
      if (routeForSegment) {
        const arrivalObj = routeForSegment.arrivalStations.find(st => {
          return (typeof st === "object" ? st.id : st) === segDestination;
        });
        if (arrivalObj && arrivalObj.flightDates) {
          if (!arrivalObj.flightDates.includes(dateStr)) {
            if (debug) console.log(`   No available flight on ${dateStr} for segment ${segOrigin} -> ${segDestination} (flightDates filter)`);
            continue;
          }
        }
      }
      if (!isDateAvailableForSegment(segOrigin, segDestination, dateStr)) {
        if (debug) console.log(`   Date ${dateStr} rejected for segment ${segOrigin} -> ${segDestination} (date availability check)`);
        continue;
      }
      
      const cacheKey = getUnifiedCacheKey(segOrigin, segDestination, dateStr);
      if (debug) console.log(`   Checking cache for segment ${segOrigin} -> ${segDestination} on ${dateStr} (cache key: ${cacheKey})`);
      let flights = await getCachedResults(cacheKey);
      if (flights !== null) {
        flights = flights.map(unifyRawFlight);
        if (debug) console.log(`   Cache hit: ${flights.length} flights found for ${segOrigin} -> ${segDestination} on ${dateStr}`);
      } else {
        try {
          flights = await checkRouteSegment(segOrigin, segDestination, dateStr);
          flights = flights.map(unifyRawFlight);
          if (debug) console.log(`   Fetched ${flights.length} flights from server for ${segOrigin} -> ${segDestination} on ${dateStr}`);
          await setCachedResults(cacheKey, flights);
        } catch (error) {
          console.error(`   Error fetching flights for ${segOrigin} -> ${segDestination} on ${dateStr}: ${error.message}`);
          flights = [];
          return [];
        }
      }
      // Convert flight dates if they are not already Date objects.
      flights = flights.map(f => {
        if (!(f.calculatedDuration.departureDate instanceof Date)) {
          f.calculatedDuration.departureDate = parseFlightDateTime(f.departureDateTimeIso, f.departureOffsetText);
        }
        if (!(f.calculatedDuration.arrivalDate instanceof Date)) {
          f.calculatedDuration.arrivalDate = parseFlightDateTime(f.arrivalDateTimeIso, f.arrivalOffsetText);
        }
        return f;
      });
      // Filter flights by "local" date (taking the target offset into account)
      // flights = flights.filter(f => {
      //   f.departureDateIso === dateStr
      //   if (debug) console.log(` Flight ${f.flightCode} rejected: departure date ${f.departureDateIso} does not match ${dateStr}`);
      //   }
      // );
      // if (debug) console.log(`   After local date filtering: ${flights.length} flights remain for ${segOrigin} -> ${segDestination} on ${dateStr}`);
      if (previousFlight) {
        flights = flights.filter(f => {
          const connectionTime = (f.calculatedDuration.departureDate.getTime() - previousFlight.calculatedDuration.arrivalDate.getTime()) / 60000;
          const valid = connectionTime >= minConnection && connectionTime <= maxConnection;
          if (!valid) {
            if (debug) console.log(`      Flight ${f.flightCode} rejected: connection time ${connectionTime} minutes not in [${minConnection}, ${maxConnection}]`);
          }
          return valid;
        });
        if (debug) console.log(`   After connection time filtering: ${flights.length} flights available`);
      }
      
      // Iterate over all found flights for this offset.
      for (let flight of flights) {
        if (debug) console.log(`   Considering flight ${flight.flightCode} for segment ${segOrigin} -> ${segDestination}: Departure: ${flight.calculatedDuration.departureDate.toISOString()}, Arrival: ${flight.calculatedDuration.arrivalDate.toISOString()}`);
        // Recursively process the next segment, passing the date adjusted by the current offset.
        const nextChains = await processSegment(candidate, index + 1, addDaysUTC(currentDate, offset), flight, bookingHorizon, minConnection, maxConnection, baseMaxDays, selectedDate, routesData);
        // For each found option, add the current flight at the beginning.
        for (let chain of nextChains) {
          validChains.push([flight, ...chain]);
        }
      }
    }
    
    if (validChains.length === 0) {
      if (debug) console.log(`   No suitable flight found for segment ${segOrigin} -> ${segDestination} at any offset`);
    }
    return validChains;
  }
  
  /**
   * Searches all one-stop routes allowing an airport change.
   *
   * @param {string[]} origins                – list of origin airport codes
   * @param {string[]} destinations          – list of destination airport codes
   * @param {string}   selectedDate           – YYYY-MM-DD of outbound date
   * @param {number}   minConnection          – minimum layover in minutes
   * @param {number}   maxConnection          – maximum layover in minutes
   * @param {number}   connectionRadiusKm     – max distance between connection airports
   * @param {number[]} allowedOffsets         – [0…n] day offsets for second leg
   * @param {boolean}  shouldAppend           – whether to append results as they arrive
   * @returns {Promise<Route[]>}              – all matching routes
   */
  async function processOneStopWithAirportChange(
    origins,
    destinations,
    selectedDate,
    minConnection,
    maxConnection,
    connectionRadiusKm,
    allowedOffsets,
    shouldAppend
  ) {
    if (debug) console.log("[DEBUG] airport-change search start", {
      origins,
      destinations,
      selectedDate,
      minConnection,
      maxConnection,
      connectionRadiusKm,
      allowedOffsets,
    });

    // Fetch global flight network once
    const routesData = await fetchDestinations();
    const results = [];
    let directCounter = 0;
    
    for (const origin of origins) {
      for (const destination of destinations) {
        if (origin === destination) continue;

        if (isDateAvailableForSegment(origin, destination, selectedDate)) {
          const cacheKey = getUnifiedCacheKey(origin, destination, selectedDate);
          let flights = await getCachedResults(cacheKey);
          if (!flights) {
            flights = await checkRouteSegment(origin, destination, selectedDate);
            await setCachedResults(cacheKey, flights);
          }
          flights = flights.map(unifyRawFlight);
          for (const flight of flights) {
            if (shouldAppend) appendRouteToDisplay(flight);
            results.push(flight);

            directCounter++;
            updateProgress(directCounter, origins.length * destinations.length, `Direct routes`);
          }
        }
      }
    }
    //
    // 1) Build a map: origin → Set of valid first-leg airports (B)
    //
    const firstLegMap = new Map();
    for (const origin of origins) {
      const bs = new Set();
      // first leg must depart exactly on selectedDate
      for (const route of routesData) {
        const dep = typeof route.departureStation === "object"
          ? route.departureStation.id
          : route.departureStation;
        if (dep !== origin) continue;

        for (const arrival of route.arrivalStations || []) {
          const arr = typeof arrival === "object" ? arrival.id : arrival;
          if (isDateAvailableForSegment(origin, arr, selectedDate)) {
            bs.add(arr);
          }
        }
      }
      firstLegMap.set(origin, bs);
      if (debug) console.log(`[DEBUG] first-leg options for ${origin}:`, Array.from(bs));
    }

    //
    // 2) Build a map: destination → Set of valid second-leg airports (N)
    //
    const secondLegMap = new Map();
    for (const destination of destinations) {
      const ns = new Set();
      for (const offset of allowedOffsets) {
        const date = addDaysUTC(new Date(`${selectedDate}T00:00:00Z`), offset)
          .toISOString()
          .slice(0, 10);

        for (const route of routesData) {
          const dep = typeof route.departureStation === "object"
            ? route.departureStation.id
            : route.departureStation;

          for (const arrival of route.arrivalStations || []) {
            const arr = typeof arrival === "object" ? arrival.id : arrival;
            if (arr === destination && isDateAvailableForSegment(dep, arr, date)) {
              ns.add(dep);
            }
          }
        }
      }
      secondLegMap.set(destination, ns);
      if (debug) console.log(`[DEBUG] second-leg options for ${destination}:`, Array.from(ns));
    }

    //
    // 3) Build a flat list of all candidate chains {origin, B, N, destination}
    //
    const candidates = [];
    for (const origin of origins) {
      const Bs = Array.from(firstLegMap.get(origin) || []);
      for (const destination of destinations) {
        const Ns = Array.from(secondLegMap.get(destination) || []);
        for (const B of Bs) {
          // filter N by distance <= radius
          const validNs = Ns.filter(N => {
            if (B === N) return true;
            const locB = airportLookup[B];
            const locN = airportLookup[N];
            return (
              locB &&
              locN &&
              haversineDistance(
                locB.latitude,
                locB.longitude,
                locN.latitude,
                locN.longitude
              ) <= connectionRadiusKm
            );
          });
          for (const N of validNs) {
            candidates.push({ origin, B, N, destination });
          }
        }
      }
    }

    const totalRoutes = candidates.length;
    let routeCounter = 0;

    //
    // 4) Iterate each candidate, update progress, fetch two legs, combine if valid
    //
    for (const { origin, B, N, destination } of candidates) {
      if (searchCancelled) break;

      // update UI
      routeCounter++;
      updateProgress(
        routeCounter,
        totalRoutes,
        `Checking route: ${origin} → ${B} → ${N} → ${destination}`
      );

      // first leg: exact selectedDate
      const flights1 = await loadFlights(origin, B, selectedDate, [0]);
      if (!flights1.length) continue;

      // second leg: allow day-offsets per user settings
      const flights2 = await loadFlights(N, destination, selectedDate, allowedOffsets);
      if (!flights2.length) continue;

      // combine and append to results or UI
      combineAndAppend(
        flights1,
        flights2,
        minConnection,
        maxConnection,
        results,
        shouldAppend
      );
    }

    if (debug) console.log(
      `[DEBUG] airport-change search found ${results.length} routes:`,
      results.map(r => r.key).join(", ")
    );
    return results;
  }

  async function loadFlights(dep, arr, baseDate, offsets) {
    const out = [];
    for (const off of offsets) {
      const date = addDaysUTC(new Date(`${baseDate}T00:00:00Z`), off)
                    .toISOString().slice(0,10);
      const key = getUnifiedCacheKey(dep, arr, date);
      if (!isDateAvailableForSegment(dep, arr, date)) {
        if (debug) console.log(`Skipping API request: ${dep} → ${arr} on ${date} (not in flightDates)`);
        continue;
      }
      let segs = await getCachedResults(key);
      if (!Array.isArray(segs)) { 
        segs = (await checkRouteSegment(dep, arr, date)).map(unifyRawFlight);
        await setCachedResults(key, segs);
      }

      out.push(
        ...segs.filter(f =>
          getLocalDateFromOffset(f.calculatedDuration.departureDate, f.departureOffsetText) === date
        )
      );
    }
    return out;
  }

  /**
 * Build a combined “one‑stop” route object from two unified flights.
 *
 * @param {Object} f1   – first‐leg unified flight
 * @param {Object} f2   – second‐leg unified flight
 * @param {number} gap  – layover time in minutes between f1 arrival and f2 departure
 * @returns {Object}    – the aggregated route, ready for appendRouteToDisplay
 */
  function buildAggregatedRoute(f1, f2, gap) {
    // departure of the first leg, arrival of the second leg
    const depDate = f1.calculatedDuration.departureDate;
    const arrDate = f2.calculatedDuration.arrivalDate;
    const totalMin = Math.round((arrDate - depDate) / 60000);

    const codeB = f1.arrivalStation;
    const codeN = f2.departureStation;
    const locB = airportLookup[codeB];
    const locN = airportLookup[codeN];
    const changeDistanceKm = locB && locN
      ? Math.round(haversineDistance(locB.latitude, locB.longitude, locN.latitude, locN.longitude))
      : null;
    if (!f1?.calculatedDuration?.arrivalDate || !f2?.calculatedDuration?.departureDate) {
      console.warn("Missing duration data for aggregation:", f1, f2);
      return null;
    }
    return {
      key:        `${f1.key} | ${f2.key}`,
      fareSellKey:f1.fareSellKey,
      departure:  f1.departure,
      arrival:    f2.arrival,
      departureStation:     f1.departureStation,
      departureStationText: f1.departureStationText,
      arrivalStation:       f2.arrivalStation,
      arrivalStationText:   f2.arrivalStationText,
      departureDate: f1.departureDate,
      arrivalDate:   f2.arrivalDate,
      stops:       "1 transfer",
      totalConnectionTime: gap,
      airportChange: {
        from: codeB,
        to:   codeN,
        distanceKm: changeDistanceKm
      },
      segments:    [f1, f2],
      calculatedDuration: {
        hours:       Math.floor(totalMin/60),
        minutes:     totalMin % 60,
        totalMinutes: totalMin,
        departureDate: depDate,
        arrivalDate:   arrDate
      },
      formattedFlightDate: formatFlightDateCombined(depDate, arrDate),
      currency:    f1.currency,
      displayPrice:f1.displayPrice,
      priceTag:    f1.priceTag,
      route:       [f1.departureStationText, f2.arrivalStationText]
    };
  }

  function combineAndAppend(f1List, f2List, minC, maxC, resultsArr, appendFlag) {
    for (const f1 of f1List) {
      for (const f2 of f2List) {
        const gap = Math.round((f2.calculatedDuration.departureDate - f1.calculatedDuration.arrivalDate)/60000);
        if (gap < minC || gap > maxC) continue;
        const agg = buildAggregatedRoute(f1, f2, gap);
        if (!agg) continue;
        if (appendFlag) appendRouteToDisplay(agg);
        resultsArr.push(agg);
      }
    }
  }


  async function searchConnectingRoutes(
    origins,
    destinations,
    selectedDate,
    maxTransfers,
    shouldAppend = true,
    skipProgress = false
  ) {
    if (debug) console.log("Starting searchConnectingRoutes");
    const routesData = await fetchDestinations();
    const graph = buildGraph(routesData);
  
    // 1) Load user settings
    const minConnection      = Number(localStorage.getItem("minConnectionTime")) || 90;
    const maxConnection      = Number(localStorage.getItem("maxConnectionTime")) || 1440;
    const stopoverText       = document.getElementById("selected-stopover").textContent;
    const connectionRadius   = parseInt(localStorage.getItem("connectionRadius"), 10) || 0;
    const allowChangeAirport = localStorage.getItem("allowChangeAirport") === "true";
  
    if (debug) console.log(
      `[DEBUG] searchConnectingRoutes → stopover="${stopoverText}",`,
      `allowChangeAirport=${allowChangeAirport},`,
      `connectionRadius=${connectionRadius}km, maxTransfers=${maxTransfers}`
    );
  
    const allowOvernight = stopoverText === "One stop or fewer (overnight)";
    if (debug) console.log(
      `Stopover setting: ${stopoverText} (${allowOvernight ? "overnight allowed" : "day-only"})`
    );
  
    // 2) Compute booking horizon (today + 3 days)
    const baseDateUTC    = new Date(selectedDate + "T00:00:00Z");
    const todayUTC       = new Date(new Date().toISOString().slice(0,10) + "T00:00:00Z");
    const bookingHorizon = addDaysUTC(todayUTC, 3);
    if (debug) console.log(`Booking horizon set to: ${bookingHorizon.toISOString().slice(0,10)}`);
  
    // 3) Expand "ANY" destinations
    let destinationList = [];
    if (destinations.length === 1 && destinations[0] === "ANY") {
      const allDest = new Set();
      routesData.forEach(r => {
        (r.arrivalStations || []).forEach(s => {
          allDest.add(typeof s === "object" ? s.id : s);
        });
      });
      destinations = Array.from(allDest);
      destinationList = destinations;
      if (debug) console.log(`Expanded ANY → ${destinationList.join(", ")}`);
    } else {
      destinationList = destinations;
    }
  
    // 4) Build allowedOffsets
    const maxDayOffset = Math.floor(maxConnection / (60*24)); // =1
    let allowedOffsets = [];
    if (maxTransfers > 1) {
      // multi-stop: from day 0 up to bookingHorizon
      for (let d = 0; ; d++) {
        const dDate = addDaysUTC(baseDateUTC, d);
        if (dDate > bookingHorizon) break;
        allowedOffsets.push(d);
      }
    } else {
      // one-stop: day 0 always
      allowedOffsets = [0];
      if (allowOvernight) {
        for (let d = 1; d <= maxDayOffset; d++) {
          allowedOffsets.push(d);
        }
      }
    }
    if (debug) console.log(`Allowed offsets: ${allowedOffsets.join(", ")}`);
  
    // 5) Airport-change shortcut?
    const switchableForOneStop = (
      maxTransfers === 1 &&
      (stopoverText === "One stop or fewer"
        || stopoverText === "One stop or fewer (overnight)"
        || stopoverText === "Two stops or fewer (overnight)")
      && allowChangeAirport
      && connectionRadius > 0
    );
    if (switchableForOneStop) {
      if (debug) console.log("Airport-change mode ON: delegating to processOneStopWithAirportChange");
  
      // **Pass allowedOffsets** into your new function
      const results = await processOneStopWithAirportChange(
        origins,
        destinations,
        selectedDate,
        minConnection,
        maxConnection,
        connectionRadius,
        allowedOffsets,
        shouldAppend
      );
      if (debug) console.log(`Found ${results.length} routes with airport change`);
      return results;
    }
  
    // 6) Build all candidate chains via DFS
    let candidateRoutes = [];
    origins.forEach(origin =>
      findRoutesDFS(graph, origin, destinationList, [origin], maxTransfers, candidateRoutes)
    );
    if (debug) console.log(`Total candidate routes found: ${candidateRoutes.length}`);
  
    // 7) Preliminary flight-dates filter
    candidateRoutes = candidateRoutes.filter(chain =>
      candidateHasValidFlightDates(chain, routesData, selectedDate, bookingHorizon, allowedOffsets)
    );
    if (debug) console.log(`After date check, ${candidateRoutes.length} candidates remain`);
  
    // 8) Process each candidate with your existing processSegment
    let processed = 0;
    const total = candidateRoutes.length;
    if (!skipProgress) updateProgress(0, total, "Processing routes");
  
    const aggregatedResults = [];
    for (const candidate of candidateRoutes) {
      if (searchCancelled) break;
      processed++;
      if (!skipProgress) updateProgress(processed, total, `Checking ${candidate.join("→")}`);
  
      const chains = await processSegment(
        candidate,
        0,
        baseDateUTC,
        null,                      // no previous flight
        bookingHorizon,
        minConnection,
        maxConnection,
        allowedOffsets[allowedOffsets.length - 1], // max offset
        selectedDate,
        routesData
      );
  
      for (const chain of chains) {
        // Build your aggregated route object exactly as before…
        const firstDep = chain[0].calculatedDuration.departureDate;
        const lastArr  = chain[chain.length-1].calculatedDuration.arrivalDate;
        const totalMins = Math.round((lastArr - firstDep)/60000);
        const totalConn = chain.slice(0,-1).reduce((sum, f, i) => {
          const next = chain[i+1];
          return sum + Math.round((next.calculatedDuration.departureDate - f.calculatedDuration.arrivalDate)/60000);
        }, 0);
  
        const aggregatedRoute = {
          // …copy over all fields…
          key: chain.map(f => f.key).join(" | "),
          fareSellKey: chain[0].fareSellKey,
          departure: chain[0].departure,
          arrival: chain[chain.length-1].arrival,
          departureStation: chain[0].departureStation,
          departureStationText: chain[0].departureStationText,
          arrivalStation: chain[chain.length-1].arrivalStation,
          arrivalStationText: chain[chain.length-1].arrivalStationText,
          departureDate: chain[0].departureDate,
          arrivalDate: chain[chain.length-1].arrivalDate,
          stops: `${chain.length-1} transfer${chain.length-1===1?"":"s"}`,
          totalConnectionTime: totalConn,
          segments: chain,
          calculatedDuration: {
            hours: Math.floor(totalMins/60),
            minutes: totalMins%60,
            totalMinutes: totalMins,
            departureDate: firstDep,
            arrivalDate: lastArr
          },
          formattedFlightDate: formatFlightDateCombined(firstDep, lastArr),
          currency: chain[0].currency,
          displayPrice: chain[0].displayPrice,
          priceTag: chain[0].priceTag,
          route: [chain[0].departureStationText, chain[chain.length-1].arrivalStationText]
        };
  
        if (shouldAppend) appendRouteToDisplay(aggregatedRoute);
        aggregatedResults.push(aggregatedRoute);
      }
    }
  
    return aggregatedResults;
  }

  async function searchDirectRoutes(
    origins,
    destinations,
    selectedDate,
    shouldAppend = true,
    reverse = false,
    skipProgress = false
  ) {
    if (debug) console.log("Starting searchDirectRoutes");

    let allowedReversePairs = null;
    if (reverse && globalResults.length) {
      allowedReversePairs = new Set(
        globalResults.map(f => `${f.arrivalStation}-${f.departureStation}`)
      );
      if (debug) console.log(
        "Allowed reverse pairs:", Array.from(allowedReversePairs)
      );
    }

    if (reverse) {
      [origins, destinations] = [destinations, origins];
      if (debug) console.log("After swap:", origins, destinations);
    }

    let routesData = await fetchDestinations();
    if (debug) console.log(`Fetched ${routesData.length} routes`);
    routesData = routesData
      .map(route => {
        route.arrivalStations = (route.arrivalStations || []).filter(arr => {
          if (arr.operationStartDate && new Date(selectedDate) < new Date(arr.operationStartDate)) {
            return false;
          }
          if (!reverse && arr.flightDates) {
            return arr.flightDates.includes(selectedDate);
          }
          return true;
        });
        return route;
      })
      .filter(r => r.arrivalStations.length > 0);
    if (debug) console.log(
      `After date-filter: ${routesData.length} origins remain`
    );

    const pairs = [];
    for (const origin of origins) {
      const route = routesData.find(r => {
        const dep = typeof r.departureStation === "object"
          ? r.departureStation.id
          : r.departureStation;
        return dep === origin;
      });
      if (!route) continue;

      const arrivals = (destinations.length === 1 && destinations[0] === "ANY")
        ? route.arrivalStations
        : route.arrivalStations.filter(arr => {
            const code = typeof arr === "object" ? arr.id : arr;
            return destinations.includes(code);
          });

      arrivals.forEach(arr => {
        const code = typeof arr === "object" ? arr.id : arr;
        pairs.push({ origin, arrivalCode: code });
      });
    }

    const totalArrivals = pairs.length;
    if (debug) console.log(`Total direct pairs to check: ${totalArrivals}`);

    let processed = 0;
    if (!skipProgress) {
      updateProgress(processed, totalArrivals, "Checking direct flights");
    }

    const validDirectFlights = [];
    for (const { origin, arrivalCode } of pairs) {
      if (searchCancelled) break;

      processed++;
      if (!skipProgress) {
        updateProgress(
          processed,
          totalArrivals,
          `Checking ${origin} → ${arrivalCode} on ${selectedDate}`
        );
      }
      if (debug) console.log(`Checking ${origin} → ${arrivalCode}`);

      if (reverse && !allowedReversePairs.has(`${origin}-${arrivalCode}`)) {
        if (debug) console.log(`Skipping reverse pair ${origin}-${arrivalCode}`);
        continue;
      }

      const cacheKey = getUnifiedCacheKey(origin, arrivalCode, selectedDate);
      let cached = await getCachedResults(cacheKey);
      if (cached) {
        const flights = cached.map(unifyRawFlight);
        if (shouldAppend) flights.forEach(appendRouteToDisplay);
        validDirectFlights.push(...flights);
        continue;
      }

      try {
        let flights = await checkRouteSegment(origin, arrivalCode, selectedDate);
        flights = flights.map(unifyRawFlight);
        if (shouldAppend) flights.forEach(appendRouteToDisplay);
        validDirectFlights.push(...flights);
        await setCachedResults(cacheKey, flights);
      } catch (err) {
        console.error(`Error checking ${origin}→${arrivalCode}:`, err);
        showNotification(
          `Error checking direct flight ${origin} → ${arrivalCode}: ${err.message}`
        );
        return;
      }
    }

    if (debug) console.log(
      `Direct flight search complete. Found ${validDirectFlights.length} flights.`
    );
    return validDirectFlights;
  }
  
  let searchActive = false;
  async function handleSearch() {
    if (debug) console.log("Search initiated.");
    await cleanupCache();
    const searchButton = document.getElementById("search-button");
  
    if (searchActive) {
      if (debug) console.log("Search already active. Cancelling current search.");
      searchCancelled = true;
      resetCountdownTimers();
      if (throttleResetTimer) {
        clearTimeout(throttleResetTimer);
        throttleResetTimer = null;
      }
      progressContainer.style.display = "none";
      searchButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" 
            viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
              <path stroke-linecap="round" stroke-linejoin="round" 
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg> SEARCH`;
      searchActive = false;
      return;
    }
  
    // Clear previous results and mark search as active.
    globalResults = [];
    globalDefaultResults = [];
    totalResultsEl.textContent = "Total results: 0";
    searchActive = true;
    searchCancelled = false;
    searchButton.textContent = "Stop Search";
    if (debug) console.log("New search started. Resetting counters and UI.");
  
    setTimeout(() => { requestsThisWindow = 0; }, 1000);
  
    let returnInputRaw = "";
    if (window.currentTripType === "return") {
      returnInputRaw = document.getElementById("return-date").value.trim();
      if (!returnInputRaw) {
        showNotification("Please select a return date for round-trip search.");
        searchButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" 
                viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
                  <path stroke-linecap="round" stroke-linejoin="round" 
                    d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                </svg> SEARCH`;
        searchActive = false;
        return;
      }
    }
  
    let originInputs = getMultiAirportValues("origin-multi");
    if (originInputs.length === 0) {
      showNotification("Please select a departure airport first.");
      searchButton.innerHTML = "SEARCH";
      searchActive = false;
      return;
    }
    let origins = originInputs.map(s => resolveAirport(s)).flat();
    if (debug) console.log("Resolved origins:", origins);
  
    let destinationInputs = getMultiAirportValues("destination-multi");
    let destinations = (destinationInputs.length === 0 || destinationInputs.includes("ANY"))
      ? ["ANY"]
      : destinationInputs.map(s => resolveAirport(s)).flat();
    if (debug) console.log("Resolved destinations:", destinations);
  
    const tripType = window.currentTripType || "oneway";
    let departureDates = [];
    const departureInputRaw = document.getElementById("departure-date").value.trim();
    departureDates = departureInputRaw.split(",").map(d => d.trim()).filter(d => d !== "");
    if (debug) console.log("Departure dates:", departureDates);
  
    document.querySelector(".route-list").innerHTML = "";
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
    if (debug) console.log("Max transfers set to:", maxTransfers);
  
    // --- Anywhere logic in handleSearch ---
    const isOriginAnywhere = (origins.length === 1 && origins[0] === "ANY");
    const isDestinationAnywhere = (destinations.length === 1 && destinations[0] === "ANY");
  
    // 1) Abort if either field is ANY and more then 2 transfers are allowed.
    if ((isOriginAnywhere || isDestinationAnywhere) && maxTransfers > 1) {
      showNotification("Search for routes with 'Anywhere' is available only for flights with up to one stop.");
      searchButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" 
                  viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
                    <path stroke-linecap="round" stroke-linejoin="round" 
                      d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                  </svg> SEARCH`;
      searchActive = false;
      hideProgress();
      return;
    }
  
    // 2) Abort if both fields are ANY and trip type is roundtrip.
    if (isOriginAnywhere && isDestinationAnywhere && window.currentTripType === "return") {
      showNotification("Search for 'Anywhere to Anywhere' is available only for one-way direct flights.");
      searchButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" 
                  viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
                    <path stroke-linecap="round" stroke-linejoin="round" 
                      d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                  </svg> SEARCH`;
      searchActive = false;
      hideProgress();
      return;
    }
  
    // 3) If both origin and destination are ANY (and allowed), replace origins with all unique departure codes.
    if (isOriginAnywhere && isDestinationAnywhere) {
      showNotification("Searching all available direct flights. Please wait.");
      let allRoutes = await fetchDestinations();
      allRoutes = allRoutes.map(route => {
        if (Array.isArray(route.arrivalStations)) {
          route.arrivalStations = route.arrivalStations.filter(arrival => {
            if (typeof arrival === "object" && arrival.operationStartDate) {
              return new Date(departureDates[0]) >= new Date(arrival.operationStartDate);
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
      if (debug) console.log("Anywhere-to-Anywhere search: replaced origins with all available departure codes:", origins);
    }
  
    // 4) If only origin is ANY and destination is specified, filter origins.
    if (isOriginAnywhere && !isDestinationAnywhere && maxTransfers === 0) {
      if (debug) console.log("Origin = ANY; filtering origins by direct routes");
      let fetchedRoutes = await fetchDestinations();
      fetchedRoutes = fetchedRoutes.map(route => {
        if (Array.isArray(route.arrivalStations)) {
          route.arrivalStations = route.arrivalStations.filter(arrival => {
            if (typeof arrival === "object" && arrival.operationStartDate) {
              return new Date(departureDates[0]) >= new Date(arrival.operationStartDate);
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
      if (debug) console.log("Filtered origins:", origins);
    }
  
    // 5) Optionally, if only destination is ANY and origin is specified, filter destinations.
    if (isDestinationAnywhere && !isOriginAnywhere && maxTransfers === 0) {
      if (debug) console.log("Destination = ANY; filtering destinations by direct routes");
      let fetchedRoutes = await fetchDestinations();
      fetchedRoutes = fetchedRoutes.map(route => {
        if (Array.isArray(route.arrivalStations)) {
          route.arrivalStations = route.arrivalStations.filter(arrival => {
            if (typeof arrival === "object" && arrival.operationStartDate) {
              return new Date(departureDates[0]) >= new Date(arrival.operationStartDate);
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
      if (debug) console.log("Filtered destinations:", destinations);
    }
    // --- End Anywhere logic ---
  
    // Then proceed with the search process using the processed origins and destinations.
    try {
      if (tripType === "oneway") {
        for (const dateStr of departureDates) {
          if (searchCancelled) return;
          if (debug) console.log(`Searching one-way flights for date ${dateStr}`);
          if (maxTransfers > 0) {
            await searchConnectingRoutes(origins, destinations, dateStr, maxTransfers);
          } else {
            await searchDirectRoutes(origins, destinations, dateStr, true, false);
          }
        }
      } else {
        // Round-trip search
        if (debug) console.log("Starting round-trip search; suppressing display until both outbound and inbound are processed.");
        suppressDisplay = true;
        let outboundFlights = [];
        for (const outboundDate of departureDates) {
          if (searchCancelled) break;
          if (debug) console.log(`Searching outbound flights for date ${outboundDate}`);
          let outboundFlightsForDate = [];
          if (maxTransfers > 0) {
            outboundFlightsForDate = outboundFlightsForDate.concat(
              await searchConnectingRoutes(origins, destinations, outboundDate, maxTransfers)
            );
          } else {
            outboundFlightsForDate = outboundFlightsForDate.concat(
              await searchDirectRoutes(origins, destinations, outboundDate, true, false)
            );
          }
          outboundFlights = outboundFlights.concat(outboundFlightsForDate);
        }
        if (debug) console.log(`Total outbound flights found: ${outboundFlights.length}`);
        // Deduplicate outbound flights.
        const uniqueOutbound = [];
        const outboundKeys = new Set();
        for (const flight of outboundFlights) {
          const key = flight.route.join("-") + "|" + flight.calculatedDuration.departureDate.getTime();
          if (!outboundKeys.has(key)) {
            outboundKeys.add(key);
            uniqueOutbound.push(flight);
          }
        }
        outboundFlights = uniqueOutbound;
        globalResults = outboundFlights;
        if (debug) console.log(`Deduplicated outbound flights: ${outboundFlights.length}`);
        let returnDates = returnInputRaw.split(",").map(d => d.trim()).filter(d => d !== "");
        let inboundQueries = {};
        window.originalOriginInput = getMultiAirportValues("origin-multi").join(", ");
        const originalOrigins = resolveAirport(window.originalOriginInput);
        if (debug) console.log("Original origins for round-trip:", originalOrigins);
  
        // If the original origin value is "ANY", search for inbound flights so that:
        // inbound.origin is any airport in the destination group, and inbound.destination equals outbound.origin.
        if (originalOrigins[0] === "ANY") {
          for (const outbound of outboundFlights) {
            // outboundOrigin is the actual departure airport of the outbound flight.
            let outboundOrigin = (typeof outbound.departureStation === "object" ? outbound.departureStation.id : outbound.departureStation);
            for (const rDate of returnDates) {
              // Use the same key as when building the inbound queries.
              const key = `${destinations.join(",")}-${outboundOrigin}-${rDate}`;
                // Example for direct inbound search:
                if (maxTransfers > 0) {
                  inboundQueries[key] = async () => {
                    const connectingResults = await searchConnectingRoutes(
                      destinations,
                      [outboundOrigin],
                      rDate,
                      maxTransfers,
                      false,
                      true // pass skipProgress = true if you've similarly updated searchConnectingRoutes
                    );
                    const directResults = await searchDirectRoutes(
                      destinations,
                      [outboundOrigin],
                      rDate,
                      false,
                      false,
                      true  // skipProgress set to true
                    );
                    return [...connectingResults, ...directResults];
                  };
                } else {
                  inboundQueries[key] = async () => {
                    return await searchDirectRoutes(
                      destinations,
                      [outboundOrigin],
                      rDate,
                      false,
                      false,
                      true  // skipProgress set to true
                    );
                  };
              }
            }
          }
        } else {
// Standard logic when origin is explicitly defined – ensure skipProgress is true
for (const outbound of outboundFlights) {
  let outboundDestination = outbound.arrivalStation;
  for (const rDate of returnDates) {
    for (const origin of originalOrigins) {
      const key = `${outboundDestination}-${origin}-${rDate}`;
      if (!inboundQueries[key]) {
        if (maxTransfers > 0) {
          inboundQueries[key] = async () => {
            const connectingResults = await searchConnectingRoutes(
              [outbound.arrivalStation],
              [origin],
              rDate,
              maxTransfers,
              false,
              true  // pass skipProgress = true
            );
            const directResults = await searchDirectRoutes(
              [outbound.arrivalStation],
              [origin],
              rDate,
              false,
              false,
              true  // pass skipProgress = true
            );
            return [...connectingResults, ...directResults];
          };
        } else {
          inboundQueries[key] = async () => {
            return await searchDirectRoutes(
              [outbound.arrivalStation],
              [origin],
              rDate,
              false,
              false,
              true  // pass skipProgress = true
            );
          };
        }
      }
    }
  }
}
        }
        // Process each inbound query and update overall progress accordingly.
        const inboundResults = {};
        const inboundKeys = Object.keys(inboundQueries);
        
        // 1) Pre-calculate totalInbound exactly as before
        const totalInbound = inboundKeys.length;        
        if (debug) console.log("Total inbound combinations:", totalInbound);
        
        // 2) Kick off the progress bar
        let inboundProcessed = 0;
        updateProgress(inboundProcessed, totalInbound, "Checking inbound flights");
        // 3) Now loop *per key*, update the bar there, then fetch the flights:
        for (const key of inboundKeys) {
          // 3.1 increment and update
          inboundProcessed++;
          // parse key again for the label
          const m = key.match(/^(.+?)-(.+?)-(\d{4}-\d{2}-\d{2})$/) || [];
          const fromGroup = m[1] || "";
          const toCode    = m[2] || "";
          const dateStr   = m[3] || "";
          let flights = [];
          try {
            flights = await inboundQueries[key]();
          } catch {
            flights = [];
          }
          inboundResults[key] = flights;
          updateProgress(
            inboundProcessed,
            totalInbound,
            `Checking inbound flights ${fromGroup} → ${toCode} on ${dateStr}`
          );
        }
        // Flitering inbound flights.
        for (const outbound of outboundFlights) {
          let outboundDestination = (typeof outbound.arrivalStation === "object" ? outbound.arrivalStation.id : outbound.arrivalStation);
          let matchedInbound = [];
          if (originalOrigins[0] === "ANY") {
            // For reverse search: inbound.origin should be one of the airports in the destination group,
            // and inbound.destination should equal outbound.origin.
            let outboundOrigin = (typeof outbound.departureStation === "object" ? outbound.departureStation.id : outbound.departureStation);
            for (const rDate of returnDates) {
              // Use the same key as above.
              const key = `${destinations.join(",")}-${outboundOrigin}-${rDate}`;
              let inboundForKey = inboundResults[key] || [];
              const filteredInbound = inboundForKey.filter(inbound => {
                const inboundDep = (typeof inbound.departureStation === "object" ? inbound.departureStation.id : inbound.departureStation);
                const inboundArr = (typeof inbound.arrivalStation === "object" ? inbound.arrivalStation.id : inbound.arrivalStation);
                const validDep = destinations.includes(inboundDep);
                const validArr = inboundArr === outboundOrigin;
                const connectionGap = Math.round((inbound.calculatedDuration.departureDate - outbound.calculatedDuration.arrivalDate) / 60000);
                const validGap = connectionGap >= 360 && inbound.calculatedDuration.departureDate > outbound.calculatedDuration.arrivalDate;
                if (!validDep) {
                  if (debug) console.log(`Inbound flight ${inbound.flightCode} rejected: departure station ${inboundDep} is not in the destination group ${destinations}`);
                }
                if (!validArr) {
                  if (debug) console.log(`Inbound flight ${inbound.flightCode} rejected: arrival station ${inboundArr} does not match outbound origin ${outboundOrigin}`);
                }
                if (!validGap) {
                  if (debug) console.log(`Inbound flight ${inbound.flightCode} rejected: connection gap ${connectionGap} minutes`);
                }
                return validDep && validArr && validGap;
              });
              matchedInbound = matchedInbound.concat(filteredInbound);
            }
          } else {
            for (const rDate of returnDates) {
              for (const origin of originalOrigins) {
                const key = `${outboundDestination}-${origin}-${rDate}`;
                let inboundForKey = inboundResults[key] || [];
                const filteredInbound = inboundForKey.filter(inbound => {
                  const connectionGap = Math.round((inbound.calculatedDuration.departureDate - outbound.calculatedDuration.arrivalDate) / 60000);
                  const validGap = connectionGap >= 360 && inbound.calculatedDuration.departureDate > outbound.calculatedDuration.arrivalDate;
                  if (!validGap) {
                    if (debug) console.log(`Inbound flight ${inbound.flightCode} for return ${rDate} rejected: connection gap ${connectionGap} minutes`);
                  }
                  return validGap;
                });
                matchedInbound = matchedInbound.concat(filteredInbound);
              }
            }
          }
          const seenInbound = new Set();
          const dedupedInbound = [];
          for (const flight of matchedInbound) {
            if (debug) console.log(`flight.key: ${flight.key}`);
            const dedupKey = flight.key;
            if (!seenInbound.has(dedupKey)) {
              seenInbound.add(dedupKey);
              dedupedInbound.push(flight);
            }
          }
          outbound.returnFlights = dedupedInbound;
          if (debug) console.log(`Outbound flight ${outbound.flightCode} matched with ${dedupedInbound.length} inbound flights`);
        }
        const validRoundTripFlights = outboundFlights.filter(flight => flight.returnFlights && flight.returnFlights.length > 0);
        globalResults = validRoundTripFlights;
        suppressDisplay = false;
        displayRoundTripResultsAll(validRoundTripFlights);
        if (debug) console.log(`Round-trip search complete. Valid round-trip flights: ${validRoundTripFlights.length}`);
      }
    } catch (error) {
      document.querySelector(".route-list").innerHTML = `<p>Error: ${error.message}</p>`;
      console.error("Search error:", error);
    } finally {
      if (globalResults.length === 0 && tripType === "oneway") {
        document.querySelector(".route-list").innerHTML = "<p>There are no available flights on this route.</p>";
      }
      hideProgress();
      searchButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" 
            viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
              <path stroke-linecap="round" stroke-linejoin="round" 
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg> SEARCH`;
      searchActive = false;
      updateCSVButtonVisibility();
      if (debug) console.log("Search process finished.");
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
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = ""; // Clear existing content
    // Set the container to be transparent
    container.style.background = "transparent";
    container.style.border = "none";
    // Always ensure at least one row exists
    addAirportRow(container, fieldName);
    updateAirportRows(container);
  }

  function addAirportRow(container, fieldName) {
    // Limit to a maximum of 3 airport rows.
    const currentRows = container.querySelectorAll(".airport-row");
    if (currentRows.length >= 3) return;
  
    const row = document.createElement("div");
    row.className = "airport-row flex items-center gap-1 mb-1";
  
    // Create a wrapper for the input and suggestions
    const inputWrapper = document.createElement("div");
    inputWrapper.className = "relative flex-1";
  
    const input = document.createElement("input");
    input.type = "text";
    // Set placeholder based on fieldName
    if (fieldName === "origin") {
      input.placeholder = "Origin";
    } else if (fieldName === "destination") {
      input.placeholder = "Destination";
    } else {
      input.placeholder = "Enter Airport";
    }
    input.className = "block w-full bg-transparent border border-gray-300 text-gray-800 rounded-md px-1 py-2 focus:outline-none focus:ring-2 focus:ring-[#C90076]";
    const inputId = fieldName + "-input-" + Date.now();
    input.id = inputId;
    inputWrapper.appendChild(input);

    const suggestions = document.createElement("div");
    suggestions.id = inputId + "-suggestions";
    suggestions.className = "absolute top-full left-0 right-0 bg-white border border-gray-300 rounded-md shadow-lg z-20 text-gray-800 text-sm hidden";
    inputWrapper.appendChild(suggestions);

    row.appendChild(inputWrapper);

    // --- NEW: Button container (right side, vertical layout) ---
    const buttonGroup = document.createElement("div");
    buttonGroup.className = "flex flex-col items-center justify-start gap-1";
    // Always add a delete button (even for the first row)
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "—";
    // Added cursor-pointer for hover feedback
    deleteBtn.className = "delete-btn  w-5 h-5 text-white text-xs bg-[#20006D] rounded-xl hover:bg-red-600 flex items-center justify-center cursor-pointer";
    deleteBtn.addEventListener("click", () => {
      row.remove();
      updateAirportRows(container);
      // Ensure at least one row remains after deletion.
      if (container.querySelectorAll(".airport-row").length === 0) {
        addAirportRow(container, fieldName);
        updateAirportRows(container);
      }
    });
  
    // Add the plus button for adding new rows.
    const plusBtn = document.createElement("button");
    plusBtn.textContent = "+";
    // Initially hidden, will be shown only when at least one field is filled
    plusBtn.className = "plus-btn w-5 h-5 text-white text-xs bg-[#C90076] rounded-xl hover:bg-[#A00065] flex items-center justify-center cursor-pointer hidden";

    plusBtn.addEventListener("click", () => {
      addAirportRow(container, fieldName);
      updateAirportRows(container);
    });

    // Append the button to the row but keep it hidden initially
    // Append both buttons to buttonGroup
    buttonGroup.appendChild(deleteBtn);
    buttonGroup.appendChild(plusBtn);

    // Append the button group to the row
    row.appendChild(buttonGroup);

    // Function to update plus button visibility
    function updatePlusButtonVisibility() {
      const rows = container.querySelectorAll(".airport-row");
      let lastFilledRow = null;

      rows.forEach(row => {
        const inputField = row.querySelector("input");
        const plusButton = row.querySelector(".plus-btn");

        if (inputField && inputField.value.trim().length > 0) {
          lastFilledRow = row;
        }

        if (plusButton) {
          plusButton.classList.add("hidden");
        }
      });

      if (lastFilledRow) {
        const plusButton = lastFilledRow.querySelector(".plus-btn");
        if (plusButton) {
          plusButton.classList.remove("hidden");
        }
      }
    }

    // Attach event listener to each input to detect changes
    input.addEventListener("input", updatePlusButtonVisibility);
    input.addEventListener("input", () => {
      updateAirportRows(container);
    });

    // Ensure the function runs after initialization
    updatePlusButtonVisibility();

    container.appendChild(row);
    setupAutocomplete(input.id, suggestions.id);
    updateAirportRows(container);
    }

  function updateAirportRows(container) {
    const rows = container.querySelectorAll(".airport-row");
    rows.forEach((row, index) => {
      const deleteBtn = row.querySelector(".delete-btn");
      if (deleteBtn) {
        deleteBtn.style.display = "inline-block";
      }
      const plusBtn = row.querySelector(".plus-btn");
  
      // Always show the plus button on the last row if total rows is less than 3.
      if (rows.length < 3 && index === rows.length - 1) {
        if (plusBtn) plusBtn.style.display = "inline-block";
      } else {
        if (plusBtn) plusBtn.style.display = "none";
      }
    });
  }
  
  function swapInputs() {
    // Gather current values from each container
    const originValues = getMultiAirportValues("origin-multi");
    const destValues = getMultiAirportValues("destination-multi");
  
    const originContainer = document.getElementById("origin-multi");
    const destContainer = document.getElementById("destination-multi");
  
    // Clear both containers
    originContainer.innerHTML = "";
    destContainer.innerHTML = "";
  
    // Refill origin container with previous destination values, if any
    if (destValues.length > 0) {
      destValues.forEach(val => {
        addAirportRow(originContainer, "origin");
        const rowInput = originContainer.lastElementChild.querySelector("input");
        if (rowInput) rowInput.value = val;
      });
    }
    if (originContainer.querySelectorAll(".airport-row").length === 0) {
      addAirportRow(originContainer, "origin");
    }
    updateAirportRows(originContainer);
  
    // Refill destination container with previous origin values, if any
    if (originValues.length > 0) {
      originValues.forEach(val => {
        addAirportRow(destContainer, "destination");
        const rowInput = destContainer.lastElementChild.querySelector("input");
        if (rowInput) rowInput.value = val;
      });
    }
    if (destContainer.querySelectorAll(".airport-row").length === 0) {
      addAirportRow(destContainer, "destination");
    }
    updateAirportRows(destContainer);
  }
  
  function toggleOptions() {
    const optionsContainer = document.getElementById("options-container");
    optionsContainer.classList.toggle("hidden");
    if (!optionsContainer.classList.contains("hidden")) {
      animateElement(optionsContainer, "dropdown-enter", 300);
    }
  }

  function showNotification(message) {
    const banner = document.getElementById("notification-banner");
    const text = document.getElementById("notification-text");
  
    text.textContent = message; // Set the message text
    banner.classList.remove("hidden", "opacity-0"); // Show banner
    banner.classList.add("opacity-100");
    animateElement(banner, "notification-enter", 500);
    // Hide after 3 seconds
    setTimeout(() => {
      banner.classList.remove("opacity-100");
      banner.classList.add("opacity-0");
      setTimeout(() => banner.classList.add("hidden"), 300); // Fully hide
    }, 3000);
  }  
  // Updated sorting function for the global (outbound) results
  function sortResultsArray(results, sortOption) {
    if (!Array.isArray(results) || results.length === 0) return;
    if (sortOption === "default") {
      // No sorting needed for default.
      return;
    } else if (sortOption === "departure") {
      results.sort((a, b) => {
        return new Date(a.calculatedDuration.departureDate).getTime() -
               new Date(b.calculatedDuration.departureDate).getTime();
      });
    } else if (sortOption === "airport") {
      results.sort((a, b) => {
        const nameA = (airportNames[a.route[0]] || a.route[0]).toLowerCase();
        const nameB = (airportNames[b.route[0]] || b.route[0]).toLowerCase();
        return nameA.localeCompare(nameB);
      });
    } else if (sortOption === "arrival") {
      results.sort((a, b) => {
        const getFinalArrival = (flight) => {
          if (flight.returnFlights && flight.returnFlights.length > 0) {
            return new Date(flight.returnFlights[flight.returnFlights.length - 1].calculatedDuration.arrivalDate).getTime();
          }
          return new Date(flight.calculatedDuration.arrivalDate).getTime();
        };
        return getFinalArrival(a) - getFinalArrival(b);
      });
    } else if (sortOption === "duration") {
      results.sort((a, b) => {
        const getTripDuration = (flight) => {
          if (flight.returnFlights && flight.returnFlights.length > 0) {
            const outboundDeparture = new Date(flight.calculatedDuration.departureDate).getTime();
            const inboundArrival = new Date(flight.returnFlights[flight.returnFlights.length - 1].calculatedDuration.arrivalDate).getTime();
            return (inboundArrival - outboundDeparture) / 60000;
          }
          return flight.calculatedDuration.totalMinutes;
        };
        return getTripDuration(a) - getTripDuration(b);
      });
    }
    // Add any additional sort options as needed.
  }
  
//-------------------Rendeting results-----------------------------
function renderRouteBlock(unifiedFlight, label = "", extraInfo = "") {
  const isReturn = label && label.toLowerCase().includes("inbound flight");
  const isOutbound = label && label.toLowerCase().includes("outbound flight");
  const isDirectFlight = !unifiedFlight.segments || unifiedFlight.segments.length === 1; 
  const header = isOutbound && isDirectFlight || isDirectFlight ? "" :  `
    <div class="flex flex-col">
      <div class="flex justify-between items-center mb-0.5 space-x-2">
        <div class="text-xs font-semibold bg-gray-800 text-white px-2 py-1 mb-1 rounded">
          ${unifiedFlight.formattedFlightDate}
        </div>
        <div class="text-xs font-semibold text-gray-800 text-right px-2 py-1 mb-1 rounded">
          Total duration: <br>${unifiedFlight.calculatedDuration.hours}h ${unifiedFlight.calculatedDuration.minutes}m
        </div>
      </div>
      <hr class="${ isOutbound ? "border-[#C90076] border-2 mt-1 my-2" : "border-[#20006D] border-2 mt-1 my-2"}">
    </div>
  `;
  
  const labelExtraHtml = (label || extraInfo) ? `
    <div class="flex justify-between items-center mb-2">
      ${ label ? `<div class="inline-block text-xs font-semibold ${isReturn ? "bg-[#20006D] text-white" : "bg-[#C90076] text-white"} px-2 py-1 rounded">${label}</div>` : "" }
      ${ extraInfo ? `<div class="text-xs font-semibold ${isReturn ? "bg-white text-gray-800" : "bg-gray-200 text-gray-700"} px-2 py-1 rounded">${extraInfo}</div>` : "" }
    </div>` : "";
  
  let bodyHtml = "";
  if (unifiedFlight.segments && unifiedFlight.segments.length > 0) {
    unifiedFlight.segments.forEach((segment, idx) => {
      bodyHtml += createSegmentRow(segment);
      bodyHtml += `
      <div class="flex justify-between items-center mt-2">
        <div class="text-left text-sm font-semibold text-gray-800">
          ${segment.currency} ${segment.displayPrice}
        </div>
        <button class="continue-payment-button px-1 py-1 bg-white text-[#C90076] border border-[#C90076] rounded-md font-bold shadow-md active:bg-[#A00065] active:text-white hover:bg-[linear-gradient(#A00055,#A00075)] hover:text-white transition cursor-pointer" data-outbound-key="${segment.key}">
          Continue to customize
        </button>
      </div>
    `;
      if (idx < unifiedFlight.segments.length - 1) {
        const nextSegment = unifiedFlight.segments[idx + 1];
        const connectionMs = nextSegment.calculatedDuration.departureDate - segment.calculatedDuration.arrivalDate;
        const connectionMinutes = Math.max(0, Math.round(connectionMs / 60000));
        const ch = Math.floor(connectionMinutes / 60);
        const cm = connectionMinutes % 60;
        let stopoverText = `Self-connection: ${ch}h ${cm}m`;

        if (
          unifiedFlight.airportChange &&
          unifiedFlight.airportChange.from &&
          unifiedFlight.airportChange.to &&
          unifiedFlight.airportChange.distanceKm > 0 &&
          unifiedFlight.airportChange.from !== unifiedFlight.airportChange.to
        ) {
          stopoverText += `<br>⚠️ Airport change: ${unifiedFlight.airportChange.from} ⇄ ${unifiedFlight.airportChange.to}, Distance: ${unifiedFlight.airportChange.distanceKm} km`;
        }

        bodyHtml += `
          <div class="flex items-center my-2">
            <div class="flex-1 border-t-2 border-dashed border-gray-400"></div>
            <div class="px-3 text-sm ${isReturn ? "text-black" : "text-gray-500"} text-center whitespace-nowrap">
              ${stopoverText}
            </div>
            <div class="flex-1 border-t-2 border-dashed border-gray-400"></div>
          </div>
        `;
      }
    });
  } else {
    bodyHtml = createSegmentRow(unifiedFlight);
    bodyHtml += `
      <div class="flex justify-between items-center mt-0">
        <div class="text-left text-sm font-semibold text-gray-800">
          ${unifiedFlight.currency} ${unifiedFlight.displayPrice}
        </div>
        <button class="continue-payment-button px-1 py-1 bg-white text-[#C90076] border border-[#C90076] rounded-md font-bold shadow-md active:bg-[#A00065] active:text-white hover:bg-[linear-gradient(#A00055,#A00075)] hover:text-white transition cursor-pointer" data-outbound-key="${unifiedFlight.key}">
          Continue to customize
        </button>
      </div>
    `;
  }
  
  // Always include the header regardless of return flight type.
  const containerClasses = isReturn ? "border rounded-lg p-2.5 mb-2 bg-gray-300" : "border rounded-lg p-2.5 mb-2";
  return `
    <div class="${containerClasses}">
      ${labelExtraHtml}
      ${header}
      ${bodyHtml}
    </div>
  `;
}

function createSegmentRow(segment) {
  const segmentDate = segment.formattedFlightDate;
  const flightCode = formatFlightCode(segment.flightCode);
  const departureStationCode = segment.departureStationCode || segment.departureStation;
  const arrivalStationCode = segment.arrivalStationCode || segment.arrivalStation;
  const segmentHeader = `
    <div class="flex justify-between items-center mb-0">
      <div class="text-xs font-semibold bg-gray-200 text-gray-800 px-2 py-1 rounded">
        ${segmentDate}
      </div>
      <div class="text-xs font-semibold bg-white border border-[#20006D] text-[#20006D] px-1 py-1 rounded">
        ${flightCode}
      </div>
    </div>
  `;
  const gridRow = `
    <div class="grid grid-cols-3 grid-rows-2 gap-0 items-center w-full py-1">
      <div class="flex items-center gap-1 whitespace-normal">
        <div class="tooltip-trigger grid grid-cols-1 grid-rows-2 gap-0 items-center mr-1 relative">
          <span class="tooltip-trigger text-xl items-center flex -mb-1 cursor-pointer">${getCountryFlag(departureStationCode)}</span>
          <div class="tooltip absolute hidden top-full min-w-[1rem] max-w-[10rem] left-0 bg-gray-800 text-white text-[8px] px-1 py-1 rounded shadow z-10 text-center whitespace-nowrap">
          ${getCountry(departureStationCode)}
          </div>
          <span class="text-[10px] justify-between items-center font-bold text-gray-500 -mt-1">${departureStationCode}</span>
        </div>
        <span class="text-base font-medium break-words max-w-[calc(100%-2rem)]">${segment.departureStationText}</span>
      </div>
      <span class="-mb-6">
      <svg xmlns="http://www.w3.org/2000/svg"
          class="block m-0 p-0"
          width="100%" height="100%"
          viewBox="0 40 300 40"
          preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="lineGradient" gradientUnits="userSpaceOnUse" x1="20" y1="60" x2="280" y2="60">
            <stop offset="0" stop-color="#20006D"/>
            <stop offset="1" stop-color="#C90076"/>
          </linearGradient>
        </defs>
        <g transform="translate(20,20)">
          <line x1="0" y1="40" x2="260" y2="40" stroke="url(#lineGradient)" stroke-width="4" stroke-linecap="round"/>
          <circle cx="0" cy="40" r="6" fill="#20006D"/>
          <circle cx="260" cy="40" r="6" fill="#C90076"/>
          <path d="M120 20 L140 40 L120 60 L125 40 Z" fill="#20006D"/>
        </g>
      </svg>
      </span>
      <div class="flex justify-end items-center gap-1 mb-0 -mr-1">
        <span class="text-base font-medium text-right break-words max-w-[calc(100%-2rem)]">
          ${segment.arrivalStationText}
        </span>

        <div class="tooltip-trigger grid grid-cols-1 grid-rows-2 gap-0 items-center mr-1 relative">
          <span class="text-xl items-center flex -mb-1 cursor-pointer tooltip-trigger">
            ${getCountryFlag(arrivalStationCode)}
          </span>

          <div class="tooltip absolute hidden top-full right-0 min-w-[1rem] max-w-[10rem] bg-gray-800 text-white text-[8px] px-1 py-1 rounded shadow z-10 text-center whitespace-nowrap">
            ${getCountry(arrivalStationCode)}
          </div>

          <span class="text-[10px] justify-between items-center font-bold text-gray-500 -mt-1">
            ${arrivalStationCode}
          </span>
        </div>
      </div>
    
      <div class="flex items-center gap-1 mt-4">
        <span class="text-2xl font-bold whitespace-nowrap">${segment.displayDeparture}</span>
        <sup class="text-[10px] align-super">${formatOffsetForDisplay(segment.departureOffset)}</sup>
      </div>
      <div class="flex flex-col items-center -mt-8">
        <div class="text-sm font-medium">
          ${segment.calculatedDuration.hours}h ${segment.calculatedDuration.minutes}m
        </div>
      </div>
      <div class="flex items-center justify-end gap-1 mt-4">
        <span class="text-2xl font-bold whitespace-nowrap mb-0">${segment.displayArrival}</span>
        <sup class="text-[10px] align-super">${formatOffsetForDisplay(segment.arrivalOffset)}</sup>
      </div>
    </div>
  `;
  
  return `<div class=>${segmentHeader}${gridRow}</div>`;
}

  /**
   * Formats a flight code by inserting a space after the first two characters.
   */
  function formatFlightCode(code) {
    if (!code || code.length < 3) return code;
    return code.slice(0, 2) + ' ' + code.slice(2);
  }
// --------CSV export-------------
function downloadResultsAsCSV() {
  if (!globalResults || globalResults.length === 0) {
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

  const csvRows = [headers.join("\t")];

  // Iterate through globalResults and extract relevant flight data
  globalResults.forEach(flight => {
    const row = [
      `"${flight.departureStationText}"`,
      `"${flight.departureStationCode}"`,
      `"${flight.arrivalStationText}"`,
      `"${flight.arrivalStationCode}"`,
      `"${flight.departureDate}"`,
      `"${flight.displayDeparture}"`,
      `"${flight.departureOffsetText}"`,
      `"${flight.arrivalDate}"`,
      `"${flight.displayArrival}"`,
      `"${flight.arrivalOffsetText}"`,
      `${Math.floor(flight.calculatedDuration.totalMinutes / 60)}:${String(flight.calculatedDuration.totalMinutes % 60).padStart(2, '0')}`, // hh:mm format
      `="${parseFloat(flight.fare).toFixed(2)}"`, 
      `"${flight.currency}"`,
      `"${flight.carrierText}"`,
      flight.flightId
    ].join("\t");

    csvRows.push(row);
  });

  const csvContent = "data:text/csv;charset=utf-8," + csvRows.join("\n");
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", fileName);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Ensure button is correctly registered for clicks
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("download-csv-button").addEventListener("click", downloadResultsAsCSV);
});

  // Function to toggle CSV button visibility before search
  function updateCSVButtonVisibility() {
    const csvButton = document.getElementById("download-csv-button");

    // Hide the button if there are no results.
    if (!globalResults || globalResults.length === 0) {
        csvButton.classList.add("hidden");
        return;
    }

    // Check if all flights are direct and none have return flights
    const onlyDirectOneWay = globalResults.every(flight => {
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

  

// Attach event listener to the Stopover dropdown selection
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("#stopover-dropdown input[name='stopover']").forEach(radio => {
    radio.addEventListener("change", () => {
      updateCSVButtonVisibility(); // Update visibility when stopover selection changes
    });
  });

  // Also check visibility when the page loads
  updateCSVButtonVisibility();
});

  
  // ---------------- Calendar ----------------
  function renderCalendarMonth(
    popupEl,
    inputId,
    year,
    month,
    maxDaysAhead,
    selectedDates,
    minSelectableDate = null
  ) {
    // Clear old content
    popupEl.innerHTML = "";
  
    // Container for the header (Month Year, Prev/Next buttons)
    const headerRow = document.createElement("div");
    headerRow.className = "flex justify-between items-center mb-2";
  
    // --- Prev Button ---
    const prevBtn = document.createElement("button");
    prevBtn.textContent = "←";
    prevBtn.className = "px-2 py-1 bg-gray-200 rounded hover:bg-gray-300 text-sm";
    headerRow.appendChild(prevBtn);
  
    // --- Title ---
    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    const title = document.createElement("div");
    title.className = "font-bold text-sm mx-2 flex-1 text-center";
    title.textContent = `${monthNames[month]} ${year}`;
    headerRow.appendChild(title);
  
    // --- Next Button ---
    const nextBtn = document.createElement("button");
    nextBtn.textContent = "→";
    nextBtn.className = "px-2 py-1 bg-gray-200 rounded hover:bg-gray-300 text-sm";
    headerRow.appendChild(nextBtn);
  
    popupEl.appendChild(headerRow);
  
    // Compute minDate from minSelectableDate if provided
    const minDate = minSelectableDate ? parseLocalDate(minSelectableDate) : new Date(new Date().setHours(0, 0, 0, 0));
    const todayMidnight = new Date(new Date().setHours(0, 0, 0, 0));
    const lastBookable = new Date(todayMidnight.getTime() + maxDaysAhead * 24 * 60 * 60 * 1000);
  
    // Disable Prev navigation if current month is before the minimum selectable month
    const currentMonthDate = new Date(year, month);
    const minMonthDate = new Date(minDate.getFullYear(), minDate.getMonth());
    if (currentMonthDate < minMonthDate) {
      prevBtn.disabled = true;
      prevBtn.classList.add("opacity-50", "cursor-not-allowed");
    } else {
      prevBtn.disabled = false;
      prevBtn.classList.remove("opacity-50", "cursor-not-allowed");
    }
  
    // Handle Prev/Next navigation (stopPropagation to prevent closing)
    prevBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      let newMonth = month - 1;
      let newYear = year;
      if (newMonth < 0) {
        newMonth = 11;
        newYear--;
      }
      renderCalendarMonth(popupEl, inputId, newYear, newMonth, maxDaysAhead, selectedDates, minSelectableDate);
    });
  
    nextBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      let newMonth = month + 1;
      let newYear = year;
      if (newMonth > 11) {
        newMonth = 0;
        newYear++;
      }
      renderCalendarMonth(popupEl, inputId, newYear, newMonth, maxDaysAhead, selectedDates, minSelectableDate);
    });
  
    // --- Day Names (Monday-based) ---
    const daysShort = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
    const dayNamesRow = document.createElement("div");
    dayNamesRow.className = "grid grid-cols-7 text-center text-xs font-semibold mb-2";
  
    daysShort.forEach((dayName, i) => {
      const dayEl = document.createElement("div");
      dayEl.textContent = dayName;
      dayEl.classList.add(i === 5 || i === 6 ? "text-[#C90076]" : "text-[#20006D]", "font-semibold");
      dayNamesRow.appendChild(dayEl);
    });
    popupEl.appendChild(dayNamesRow);
  
    // --- Dates Grid ---
    const datesGrid = document.createElement("div");
    datesGrid.className = "grid grid-cols-7 text-center text-xs gap-1";
  
    const firstOfMonth = new Date(year, month, 1);
    let startingWeekday = firstOfMonth.getDay();
    startingWeekday = (startingWeekday + 6) % 7; // Shift Monday to 0
  
    const daysInMonth = new Date(year, month + 1, 0).getDate();
  
    // Fill in blank cells for days before the first day of the month
    for (let i = 0; i < startingWeekday; i++) {
      const blank = document.createElement("div");
      blank.className = "p-2";
      datesGrid.appendChild(blank);
    }
  
    for (let d = 1; d <= daysInMonth; d++) {
      const dateCell = document.createElement("div");
      dateCell.className = "border rounded cursor-pointer text-xs leading-tight flex items-center justify-center p-[2px]";
      const cellDate = new Date(year, month, d);
      const yyyy = cellDate.getFullYear();
      const mm = String(cellDate.getMonth() + 1).padStart(2, "0");
      const dd = String(cellDate.getDate()).padStart(2, "0");
      const dateStr = `${yyyy}-${mm}-${dd}`;
      const dayOfWeek = (startingWeekday + (d - 1)) % 7;
  
      // Apply selected or weekend styling
      if (selectedDates.has(dateStr)) {
        dateCell.classList.add("bg-blue-300");
      } else if (dayOfWeek === 5 || dayOfWeek === 6) {
        dateCell.classList.add("bg-pink-50");
      }
      dateCell.textContent = d;
  
      // Disable cell if cellDate is earlier than minDate or later than lastBookable
      if (cellDate.getTime() < minDate.getTime() || cellDate.getTime() > lastBookable.getTime()) {
        dateCell.classList.add("bg-gray-200", "cursor-not-allowed", "text-gray-500");
      } else {
        dateCell.classList.add("font-bold");
        dateCell.addEventListener("click", () => {
          if (selectedDates.has(dateStr)) {
            selectedDates.delete(dateStr);
            dateCell.classList.remove("bg-blue-300");
            // Reapply weekend style if applicable
            if (dayOfWeek === 5 || dayOfWeek === 6) {
              dateCell.classList.add("bg-pink-50");
            }
          } else {
            selectedDates.add(dateStr);
            dateCell.classList.remove("bg-pink-50");
            dateCell.classList.add("bg-blue-300");
          }
          const inputEl = document.getElementById(inputId);
          const sortedArr = Array.from(selectedDates).sort();
          inputEl.value = sortedArr.join(", ");
          inputEl.dispatchEvent(new Event("change"));
        });
      }
      datesGrid.appendChild(dateCell);
    }
    popupEl.appendChild(datesGrid);
  
    const doneContainer = document.createElement("div");
    doneContainer.className = "flex justify-end mt-2";
    const doneBtn = document.createElement("button");
    doneBtn.textContent = "Done";
    doneBtn.className = "px-2 py-1 bg-[#C90076] text-white rounded-lg hover:bg-[#A00065] text-sm cursor-pointer";
    doneBtn.addEventListener("click", () => {
      popupEl.classList.add("hidden");
    });
    doneContainer.appendChild(doneBtn);
    popupEl.appendChild(doneContainer);
  }
    
  function parseLocalDate(dateStr) {
    const [year, month, day] = dateStr.split("-").map(Number);
    return new Date(year, month - 1, day);
  }  
  
  function initMultiCalendar(inputId, popupId, maxDaysAhead = 3) {
    const inputEl = document.getElementById(inputId);
    const popupEl = document.getElementById(popupId);
    if (!inputEl || !popupEl) {
      console.error("Calendar input/popup not found:", inputId, popupId);
      return;
    }
  
    // Default month/year to "today"
    let today = new Date();
    let currentYear = today.getFullYear();
    let currentMonth = today.getMonth();
  
    // When user clicks the input, show the calendar
    inputEl.addEventListener("click", (e) => {
      e.stopPropagation();
  
      // Parse input value into a Set of selected dates
      const rawValue = inputEl.value.trim();
      let selectedDates = new Set();
      if (rawValue) {
        rawValue.split(",").map(s => s.trim()).forEach(dateStr => {
          if (dateStr) selectedDates.add(dateStr);
        });
      }
  
      // If there’s at least one selected date, jump calendar to that month
      if (selectedDates.size > 0) {
        const firstSelected = [...selectedDates][0]; // use only the first selected date
        const parsedDate = parseLocalDate(firstSelected);
        if (parsedDate.toString() !== "Invalid Date") {
          currentYear = parsedDate.getFullYear();
          currentMonth = parsedDate.getMonth();
        }
      }
  
      // If this is the return date calendar, use only the first departure date as minSelectableDate
      let minSelectable = null;
      if (inputId === "return-date") {
        const depRaw = document.getElementById("departure-date").value.trim();
        if (depRaw) {
          const depDates = depRaw.split(",").map(s => s.trim()).filter(Boolean);
          if (depDates.length > 0) {
            minSelectable = depDates[0];
          }
        }
      }
  
      // Render the calendar with selected dates and minSelectable date (if any)
      renderCalendarMonth(
        popupEl,
        inputId,
        currentYear,
        currentMonth,
        maxDaysAhead,
        selectedDates,
        minSelectable
      );
      const origWidth = 220;
      const targetWidth = inputEl.offsetWidth;
      const scale = targetWidth / origWidth;
      popupEl.style.transformOrigin = 'top left';
      popupEl.style.transform = `scale(${scale})`;
      popupEl.style.left = '0';
      popupEl.style.top = '100%';
      popupEl.style.width = `${origWidth}px`;
      popupEl.style.height = 'auto';
      // Show the popup
      popupEl.classList.remove("hidden");
    });
  
    // Close the calendar if user clicks outside
    document.addEventListener("click", (e) => {
      if (!popupEl.contains(e.target) && !inputEl.contains(e.target)) {
        popupEl.classList.add("hidden");
      }
    });
  }
  // ------------- Redirect to payment --------------
  function getSubscriptionIdFromDynamicUrl(url) {
    const matches = url.match(/subscriptions\/([^/]+)\/availability\/([^/]+)/);
    if (matches && matches[2]) {
      return matches[2];
    }
    return null;
  }

  window.continueToPayment = async function(outboundKey) {
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

      const dynamicUrl = await getDynamicUrl();
      const subscriptionId = getSubscriptionIdFromDynamicUrl(dynamicUrl);
      if (!subscriptionId) throw new Error("Lost subscription ID");

      chrome.tabs.create({ url: "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets" }, newTab => {
        const listener = (tabId, changeInfo) => {
          if (tabId === newTab.id && changeInfo.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            chrome.tabs.sendMessage(newTab.id, {
              action: "injectPaymentForm",
              subscriptionId,
              outboundKey
            });
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    } catch (e) {
      console.error("continueToPayment error:", e);
    }
  };
  
  // ---------------- Initialize on DOMContentLoaded ----------------
  
  document.addEventListener("DOMContentLoaded", () => {
    // ========== 1. Load settings from localStorage ==========
    const storedPreferredAirport = localStorage.getItem("preferredAirport") || "";
    document.getElementById("preferred-airport").value = storedPreferredAirport;
    document.getElementById("min-connection-time").value = localStorage.getItem("minConnectionTime") || 90;
    document.getElementById("max-connection-time").value = localStorage.getItem("maxConnectionTime") || 1440;
    document.getElementById("max-requests").value = localStorage.getItem("maxRequestsInRow") || 25;
    document.getElementById("requests-frequency").value = localStorage.getItem("requestsFrequencyMs") || 1200;
    document.getElementById("pause-duration").value = localStorage.getItem("pauseDurationSeconds") || 15;
    document.getElementById("cache-lifetime").value = localStorage.getItem("cacheLifetimeHours") || 4;
    
    // ========== 2. Toggle Expert Settings ==========
    document.getElementById("toggle-expert-settings").addEventListener("click", (event) => {
      const expertSettings = document.getElementById("expert-settings");
      if (expertSettings.classList.contains("hidden")) {
        expertSettings.classList.remove("hidden");
        animateElement(expertSettings, "dropdown-enter", 300);
        event.target.textContent = "Hide Expert Settings";
      } else {
        expertSettings.classList.add("hidden");
        event.target.textContent = "Show Expert Settings";
      }
    });
  
    // ========== 3. Setup Update Preferred Airport Button ==========
    const updateButton = document.getElementById("update-preferred-airport");
    updateButton.addEventListener("click", () => {
      const preferredAirport = document.getElementById("preferred-airport").value.trim();
      localStorage.setItem("preferredAirport", preferredAirport);
      const originContainer = document.getElementById("origin-multi");
      const firstInput = originContainer.querySelector("input");
      if (firstInput) {
        firstInput.value = preferredAirport;
        updateAirportRows(originContainer);
      }
      // Save additional settings
      localStorage.setItem("minConnectionTime", document.getElementById("min-connection-time").value);
      localStorage.setItem("maxConnectionTime", document.getElementById("max-connection-time").value);
      localStorage.setItem("maxRequestsInRow", document.getElementById("max-requests").value);
      localStorage.setItem("requestsFrequencyMs", document.getElementById("requests-frequency").value);
      localStorage.setItem("pauseDurationSeconds", document.getElementById("pause-duration").value);
      localStorage.setItem("cacheLifetimeHours", document.getElementById("cache-lifetime").value);
      showNotification("Settings updated successfully! ✅");
    });
  
    // ========== 4. Setup Autocomplete and Multi-Airport Fields ==========
    setupAutocomplete("preferred-airport", "airport-suggestions-preferred");
    initializeMultiAirportField("origin-multi", "origin");
    const originContainer = document.getElementById("origin-multi");
    const firstOriginInput = originContainer.querySelector("input");
    if (firstOriginInput) {
      firstOriginInput.value = storedPreferredAirport;
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
        if (window.currentTripType === "return") {
          window.currentTripType = "oneway";
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
      if (window.currentTripType === "return") {
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
    document.getElementById("max-requests").addEventListener("change", updateThrottleSettings);
    document.getElementById("requests-frequency").addEventListener("change", updateThrottleSettings);
    document.getElementById("pause-duration").addEventListener("change", updateThrottleSettings);
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
    window.currentTripType = "oneway";
    const tripTypeToggle = document.getElementById("trip-type-toggle");
    const tripTypeText = document.getElementById("trip-type-text");
    const returnDateContainer = document.getElementById("return-date-container");
    const removeReturnDateBtn = document.getElementById("remove-return-date");
  
    // Set initial state: one-way mode (return container hidden, button visible)
    tripTypeText.textContent = "Add Return Date";
    returnDateContainer.style.display = "none";
    tripTypeToggle.style.display = "block";
    updateReturnDateButtonState();
  
    // "Add Return Date" button click handler
    tripTypeToggle.addEventListener("click", () => {
      if (!departureDateInput.value.trim()) {
        // Safety check – button should be disabled
        return;
      }
      window.currentTripType = "return";
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
      window.currentTripType = "oneway";
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

    // ========= 12. Version Number =========
    const manifest = chrome.runtime.getManifest();
    const versionEl = document.getElementById('version-display');
    if (versionEl) {
      versionEl.innerHTML = `
      <span>v${manifest.version}</span>
      `;
    }
    // ========= 12. Go to payment page =========
    document.querySelector(".route-list").addEventListener("click", (event) => {
      const btn = event.target.closest(".continue-payment-button");
      if (btn) {
        const outboundKey = btn.getAttribute("data-outbound-key");
        continueToPayment(outboundKey);
      }
    });
  });