import { AIRPORTS, COUNTRY_AIRPORTS, airportFlags } from './data/airports.js';
import { routesData } from './data/routes.js';
import Dexie from '../src/libs/dexie.mjs';
// ----------------------- Global Settings -----------------------
  // Throttle and caching parameters (loaded from localStorage if available)
  let debug = true;
  let activeTimeout = null;
  let timeoutInterval = null;
  let REQUESTS_FREQUENCY_MS = Number(localStorage.getItem('requestsFrequencyMs')) || 1200;
  const MAX_RETRY_ATTEMPTS = 2;  
  let PAUSE_DURATION_MS = Number(localStorage.getItem('pauseDurationSeconds'))
    ? Number(localStorage.getItem('pauseDurationSeconds')) * 1000
    : 15000;
  let CACHE_LIFETIME = (Number(localStorage.getItem('cacheLifetimeHours')) || 4) * 60 * 60 * 1000;
  // 4 hours in ms
  let MAX_REQUESTS_IN_ROW = Number(localStorage.getItem('maxRequestsInRow')) || 25;
  // Variables to track state
  let requestsThisWindow = 0;
  let searchCancelled = false;
  let globalResults = [];
  let suppressDisplay = false; // Flag to delay UI updates in certain search types
  // Build airport names mapping from AIRPORTS list (strip code in parentheses)
  const airportNames = {};
  AIRPORTS.forEach(airport => {
    if (!airportNames[airport.code]) {
      airportNames[airport.code] = airport.name.replace(/\s*\(.*\)$/, "").trim();
    }
  });
  //---------DixieDB Initialisation------------------
    const db = new Dexie("FlightSearchCache");
  db.version(1).stores({
    cache: 'key, timestamp'  // 'key' is our primary key; we also index the timestamp
  });
  db.version(2).stores({
    cache: 'key, timestamp',
    routes: '++id, departureStation'
  });

  async function importRoutes() {
    try {
      await db.routes.clear();
      await db.routes.bulkAdd(routesData);
      console.log("Routes imported successfully!");
    } catch (error) {
      console.error("Error importing routes:", error);
    }
  }

importRoutes();
  // ---------------- Helper: Airport Flag ----------------
  function getCountryFlag(airportCode) {
    return airportFlags[airportCode] || "";
  }
  // ----------------------- DOM Elements -----------------------
  const progressContainer = document.getElementById('progress-container');
  const progressText = document.getElementById('progress-text');
  const progressBar = document.getElementById('progress-bar');
  const resultsAndSortContainer = document.getElementById("results-and-sort-container");
  const totalResultsEl = document.getElementById("total-results");
  const sortSelect = document.getElementById("sort-select");
  let currentSortOption = "default";

  sortSelect.addEventListener("change", () => {
    currentSortOption = sortSelect.value;
    // Re-render the results immediately using the updated sort.
    if (window.currentTripType === "return") {
      displayRoundTripResultsAll(globalResults);
    } else {
      displayGlobalResults(globalResults);
    }
  });


  // ----------------------- UI Helper Functions -----------------------
  
  function updateProgress(current, total, message) {
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
    timeoutEl.textContent = `Pausing for ${seconds} seconds to avoid API rate limits...`;
    timeoutInterval = setInterval(() => {
      seconds--;
      timeoutEl.textContent = `Pausing for ${seconds} seconds to avoid API rate limits...`;
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
  
  function getLocalDateFromOffset(date, offsetText) {
    if (!date || !(date instanceof Date)) {
      console.error("Invalid date passed to getLocalDateFromOffset:", date);
      return "";
    }
    const offsetMatch = offsetText ? offsetText.match(/UTC?([+-]\d+)/) : null;
    const offsetHours = offsetMatch ? parseInt(offsetMatch[1], 10) : 0;
    const localDate = new Date(date.getTime() + offsetHours * 3600000);
    const yyyy = localDate.getFullYear();
    const mm = String(localDate.getMonth() + 1).padStart(2, '0');
    const dd = String(localDate.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
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
  
  function setupAutocomplete(inputId, suggestionsId) {
    const inputEl = document.getElementById(inputId);
    const suggestionsEl = document.getElementById(suggestionsId);
  
    const lowerInputId = inputId.toLowerCase();
    const recentKey = lowerInputId.includes("destination")
      ? "recentAirports_destination"
      : lowerInputId.includes("origin")
      ? "recentAirports_origin"
      : "recentAirports_" + inputId;
  
    // Gather all used entries (from other origin/destination fields)
    function getAllUsedEntries() {
      const originUsed = Array.from(document.querySelectorAll("#origin-multi input"))
        .filter(el => el.id !== inputId)
        .map(el => el.value.trim().toLowerCase());
      const destUsed = Array.from(document.querySelectorAll("#destination-multi input"))
        .filter(el => el.id !== inputId)
        .map(el => el.value.trim().toLowerCase());
      return new Set([...originUsed, ...destUsed]);
    }
  
    // Retrieve recent entries for this input from localStorage.
    function getRecentEntries() {
      const stored = localStorage.getItem(recentKey);
      let recents = stored ? JSON.parse(stored) : [];
      // Remove any occurrence of "Anywhere" (ignoring case) then ensure it's at the top.
      recents = recents.filter(e => e.toLowerCase() !== "anywhere");
      recents.unshift("Anywhere");
      return recents;
    }
  
    // Add a new entry (or update its position) to recent airports.
    function addRecentEntry(entry) {
      let recents = getRecentEntries();
      recents = recents.filter(e => e !== entry);
      recents.unshift(entry);
      if (recents.length > 6) recents = recents.slice(0, 6);
      localStorage.setItem(recentKey, JSON.stringify(recents));
    }
  
    // Remove an entry from recent airports.
    function removeRecentEntry(entry) {
      let recents = getRecentEntries().filter(e => e !== entry);
      localStorage.setItem(recentKey, JSON.stringify(recents));
      // Refresh the suggestions based on current input.
      showSuggestions(inputEl.value.trim().toLowerCase());
    }
  
    // Show suggestions combining recent entries and live airport search.
    // When query is empty, show recent entries (with delete buttons).
    // When query is non-empty, show matching country/airport suggestions (and if the entry is recent, add a delete button).
    function showSuggestions(query = "") {
      suggestionsEl.innerHTML = "";
      const usedEntries = getAllUsedEntries();
  
      // If there is no query, use recent entries.
      if (!query) {
        const recents = getRecentEntries();
        if (recents.length === 0) {
          suggestionsEl.classList.add("hidden");
          return;
        }
        recents.forEach(entry => {
          const div = document.createElement("div");
          div.className = "flex justify-between items-center px-4 py-2 cursor-pointer hover:bg-gray-100";
          div.textContent = entry;
          div.addEventListener("click", () => {
            inputEl.value = entry;
            addRecentEntry(entry);
            suggestionsEl.classList.add("hidden");
          });
          // Add a delete button for recent entries except "Anywhere"
          if (entry.toLowerCase() !== "anywhere") {
            const deleteBtn = document.createElement("button");
            deleteBtn.textContent = "✕";
            deleteBtn.className = "ml-3 px-2 text-sm text-gray-500 hover:text-red-600";
            deleteBtn.addEventListener("click", (event) => {
              event.stopPropagation();
              removeRecentEntry(entry);
            });
            div.appendChild(deleteBtn);
          }
          suggestionsEl.appendChild(div);
        });
        suggestionsEl.classList.remove("hidden");
        return;
      }
  
      // Special case: if user types "any", show "Anywhere" immediately.
      if (query === "any") {
        const div = document.createElement("div");
        div.className = "px-4 py-2 cursor-pointer hover:bg-gray-100";
        div.textContent = "Anywhere";
        div.addEventListener("click", () => {
          inputEl.value = "Anywhere";
          addRecentEntry("Anywhere");
          suggestionsEl.classList.add("hidden");
        });
        suggestionsEl.appendChild(div);
        suggestionsEl.classList.remove("hidden");
        return;
      }
  
      // Build suggestions based on countries and airports.
      const usedCountryAirports = new Set();
      Object.keys(COUNTRY_AIRPORTS).forEach(country => {
        if (usedEntries.has(country.toLowerCase())) {
          COUNTRY_AIRPORTS[country].forEach(code => usedCountryAirports.add(code.toLowerCase()));
        }
      });
  
      const countryMatches = Object.keys(COUNTRY_AIRPORTS)
        .filter(country => country.toLowerCase().includes(query) && !usedEntries.has(country.toLowerCase()))
        .map(country => ({ isCountry: true, code: country, name: country }));
  
      const airportMatches = AIRPORTS.filter(a => {
        const codeLower = a.code.toLowerCase();
        const nameLower = a.name.toLowerCase();
        if (usedEntries.has(codeLower) || usedEntries.has(nameLower)) return false;
        if (usedCountryAirports.has(codeLower)) return false;
        return codeLower.includes(query) || nameLower.includes(query);
      }).map(a => ({ isCountry: false, code: a.code, name: a.name }));
  
      let matches = [...countryMatches, ...airportMatches].slice(0, 5);
  
      // For the "preferred-airport" input, ensure "Anywhere" is at the top.
      if (inputId === "preferred-airport") {
        matches = matches.filter(match => match.name.toLowerCase() !== "anywhere");
        matches.unshift({ isCountry: false, code: "ANY", name: "Anywhere" });
        matches = matches.slice(0, 5);
      }
  
      if (matches.length === 0) {
        suggestionsEl.classList.add("hidden");
        return;
      }
  
      // Render each match
      matches.forEach(match => {
        const div = document.createElement("div");
        div.className = "flex justify-between items-center px-4 py-2 cursor-pointer hover:bg-gray-100";
        div.textContent = match.name;
        div.addEventListener("click", () => {
          inputEl.value = match.name;
          addRecentEntry(match.name);
          suggestionsEl.classList.add("hidden");
        });
        // If this match is present in recent entries, add the delete button.
        if (getRecentEntries().includes(match.name) && match.name.toLowerCase() !== "anywhere") {
          const deleteBtn = document.createElement("button");
          deleteBtn.textContent = "✕";
          deleteBtn.className = "ml-3 px-2 text-sm text-gray-500 hover:text-red-600 cursor-pointer"; // Added "cursor-pointer"
          deleteBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            removeRecentEntry(match.name);
          });
          div.appendChild(deleteBtn);
        }
        suggestionsEl.appendChild(div);
      });
      suggestionsEl.classList.remove("hidden");
    }
  
    // Show recent suggestions when the input is focused and empty.
    inputEl.addEventListener("focus", () => {
      if (!inputEl.value.trim()) {
        showSuggestions();
      }
    });
  
    // Update suggestions as the user types.
    inputEl.addEventListener("input", () => {
      const query = inputEl.value.trim().toLowerCase();
      showSuggestions(query);
    });
  
    // Hide suggestions when clicking outside the input or suggestion box.
    document.addEventListener("click", event => {
      if (inputEl && suggestionsEl && !inputEl.contains(event.target) && !suggestionsEl.contains(event.target)) {
        suggestionsEl.classList.add("hidden");
      }
    });
  }
  
  // Helper to get values from all input fields within a given container
  function getMultiAirportValues(containerId) {
    const container = document.getElementById(containerId);
    const inputs = container.querySelectorAll("input");
    let values = [];
    inputs.forEach(input => {
      const val = input.value.trim();
      if (val) values.push(val);
    });
    return values;
  }

  function resolveAirport(input) {
    if (!input) return [];
    const trimmed = input.trim();
    // Treat both "any" and "anywhere" as the wildcard
    if (trimmed.toLowerCase() === "any" || trimmed.toLowerCase() === "anywhere") {
      if (debug) console.log(`Resolved "${input}" as wildcard ANY`);
      return ["ANY"];
    }
    const lower = trimmed.toLowerCase();
    if (trimmed.length === 3) {
      const byCode = AIRPORTS.find(a => a.code.toLowerCase() === lower);
      if (byCode) {
        if (debug) console.log(`Resolved "${input}" as airport code: ${byCode.code}`);
        return [byCode.code];
      }
    }
    for (const country in COUNTRY_AIRPORTS) {
      if (country.toLowerCase() === lower) {
        if (debug) console.log(`Resolved "${input}" as country: ${country} with airports ${COUNTRY_AIRPORTS[country]}`);
        return COUNTRY_AIRPORTS[country];
      }
    }
    const byCode = AIRPORTS.find(a => a.code.toLowerCase() === lower);
    if (byCode) {
      if (debug) console.log(`Resolved "${input}" as airport code (fallback): ${byCode.code}`);
      return [byCode.code];
    }
    const matches = AIRPORTS.filter(a => a.name.toLowerCase().includes(lower));
    if (matches.length > 0) {
      const codes = matches.map(a => a.code);
      if (debug) console.log(`Resolved "${input}" as airport names matching: ${codes}`);
      return codes;
    }
    if (debug) console.log(`No match found for "${input}", returning uppercase input`);
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
    if (!(depDate instanceof Date) || !(arrDate instanceof Date)) return "";
    if (depDate.toDateString() === arrDate.toDateString()) {
      return formatFlightDateSingle(depDate);
    } else {
      return `${formatFlightDateSingle(depDate)} - ${formatFlightDateSingle(arrDate)}`;
    }
  }

  /**
   * Unifies a raw flight object from the server by recalculating the departure and arrival Date objects,
   * the display times, the flight duration (accounting for time zone differences), and a formatted date range.
   *
  * The incorrect "departureDateTimeIso" and "arrivalDateTimeIso" values are ignored.
  *
  * New keys added:
  * - departureOffset: normalized offset string (e.g., "+01:00")
  * - arrivalOffset: normalized offset string (e.g., "+00:00")
  * - displayDeparture: departure time in 24‑hour format (e.g., "23:20")
  * - displayArrival: arrival time in 24‑hour format (e.g., "01:35")
  * - calculatedDuration: { hours, minutes, totalMinutes, departureDate, arrivalDate }
  *   where departureDate and arrivalDate are the combined “pure” local times.
  * - formattedFlightDate: a string such as "Sat, 8 Mar, 2025 - Sun, 9 Mar, 2025"
  * - route: an array containing the departure and arrival airport names.
  */
  function unifyRawFlight(rawFlight) {
    const depDateStr = rawFlight.departureDateIso
      ? rawFlight.departureDateIso
      : new Date(rawFlight.departureDate).toISOString().slice(0, 10);
    const arrDateStr = rawFlight.arrivalDateIso
      ? rawFlight.arrivalDateIso
      : new Date(rawFlight.arrivalDate).toISOString().slice(0, 10);
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
    const formattedFlightDate = formatFlightDateCombined(localDeparture, localArrival);
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
    // If it's already a Date, just return it.
    if (dateStr instanceof Date) return dateStr;
    // If the string is in "YYYY-MM-DD" format, use it directly.
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return new Date(dateStr);
    }
    const parts = dateStr.trim().split(" ");
    if (parts.length === 3) {
      const day = parts[0];
      const monthName = parts[1];
      const year = parts[2];
      const month = new Date(`${monthName} 1, ${year}`).getMonth() + 1;
      return new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
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
  
    showNotification("Cache successfully cleared! ✅");
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
        if (tabs && tabs.length > 0) {
          // Use the first multipass tab found.
          const multipassTab = tabs[0];
          chrome.tabs.sendMessage(multipassTab.id, { action: "getHeaders" }, (response) => {
            if (response && response.headers) {
              resolve(response.headers);
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

  function isDateAvailableForSegment(origin, destination, dateStr, routesData) {
    // Find the route that starts at the given origin.
    const route = routesData.find(r => {
      const dep = typeof r.departureStation === "object" ? r.departureStation.id : r.departureStation;
      return dep === origin;
    });
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
            showNotification("Authorization required: please log in to search for routes.");
            throw new Error("Authorization required: expected JSON but received HTML");
            // dynamicUrl = await getDynamicUrl();
            // // Throw a specific error that we can catch below
            // throw new Error("Invalid response format: expected JSON but received HTML");
          }
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
          } else if (error.message.includes("Invalid response format")) {
            waitTime = 2000;
            if (debug) console.warn(`Dynamic URL returned HTML for segment ${origin} → ${destination} – waiting for ${waitTime / 1000} seconds`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            break;
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
  }

  /**
   * Renders round-trip results.
   */
  function displayRoundTripResultsAll(outbounds) {
    // Sort outbound flights using the updated logic.
    sortResultsArray(outbounds, currentSortOption);
    resultsAndSortContainer.classList.remove("hidden");
    totalResultsEl.textContent = `Total results: ${outbounds.length}`;
  
    const resultsDiv = document.querySelector(".route-list");
    resultsDiv.innerHTML = "";
    outbounds.forEach(outbound => {
      // For the inbound flights, sort by their departure time.
      if (outbound.returnFlights && outbound.returnFlights.length > 0) {
        outbound.returnFlights.sort((x, y) => {
          return new Date(x.calculatedDuration.departureDate).getTime() -
                 new Date(y.calculatedDuration.departureDate).getTime();
        });
      }
      const outboundHtml = renderRouteBlock(outbound, "Outbound Flight");
      resultsDiv.insertAdjacentHTML("beforeend", outboundHtml);
  
      if (outbound.returnFlights && outbound.returnFlights.length > 0) {
        outbound.returnFlights.forEach((ret, idx) => {
          const outboundLastArrival = outbound.calculatedDuration.arrivalDate;
          const inboundFirstDeparture = ret.calculatedDuration.departureDate;
          if (!outboundLastArrival || !inboundFirstDeparture) return;
          const stopoverMs = inboundFirstDeparture - outboundLastArrival;
          const stopoverMinutes = Math.max(0, Math.round(stopoverMs / 60000));
          const sh = Math.floor(stopoverMinutes / 60);
          const sm = stopoverMinutes % 60;
          const stopoverText = `Stopover: ${sh}h ${sm}m`;
          const inboundHtml = renderRouteBlock(ret, `Inbound Flight ${idx + 1}`, stopoverText);
          resultsDiv.insertAdjacentHTML("beforeend", inboundHtml);
        });
      }
    });
  }

  // ---------------- Data Fetching Functions ----------------
  async function fetchDestinations() {
    try {
      // Retrieve all routes from the Dexie database
      const routes = await db.routes.toArray();
      console.log("Routes from Dexie:", routes);
      return routes;
    } catch (error) {
      console.error("Error fetching destinations:", error);
      return [];
  }
  
  
    // If no valid cache, query the multipass tab.
    // return new Promise((resolve, reject) => {
    //   chrome.tabs.query({ url: "https://multipass.wizzair.com/w6/subscriptions/spa/*" }, async (tabs) => {
    //     let multipassTab;
    //     if (tabs && tabs.length > 0) {
    //       multipassTab = tabs[0];
    //       if (debug) console.log("Found multipass tab:", multipassTab.id, multipassTab.url);
    //     } else {
    //       if (debug) console.log("No multipass tab found, opening one...");
    //       chrome.tabs.create({
    //         url: "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets"
    //       }, async (newTab) => {
    //         multipassTab = newTab;
    //         if (debug) console.log("Opened new multipass tab:", newTab.id, newTab.url);
    //         await waitForTabToComplete(newTab.id);
    //         chrome.tabs.sendMessage(newTab.id, { action: "getDestinations" }, (response) => {
    //           if (chrome.runtime.lastError) {
    //             reject(new Error(chrome.runtime.lastError.message));
    //             return;
    //           }
    //           if (response && response.routes) {
    //             const pageData = {
    //               routes: response.routes,
    //               timestamp: Date.now(),
    //               dynamicUrl: response.dynamicUrl || null,
    //               headers: response.headers || null
    //             };
    //             localStorage.setItem("wizz_page_data", JSON.stringify(pageData));
    //             resolve(response.routes);
    //           } else if (response && response.error) {
    //             reject(new Error(response.error));
    //           } else {
    //             reject(new Error("Failed to fetch destinations"));
    //           }
    //         });
    //       });
    //       return;
    //     }
    //     // Ensure the tab is fully loaded.
    //     if (multipassTab.status !== "complete") {
    //       await waitForTabToComplete(multipassTab.id);
    //     }
    //     if (debug) console.log("Sending getDestinations message to tab", multipassTab.id);
    //     chrome.tabs.sendMessage(multipassTab.id, { action: "getDestinations" }, (response) => {
    //       if (chrome.runtime.lastError) {
    //         reject(new Error(chrome.runtime.lastError.message));
    //       } else if (response && response.success) {
    //         // Save the routes in localStorage for future calls.
    //         const pageData = {
    //           routes: response.routes,
    //           timestamp: Date.now(),
    //           dynamicUrl: response.dynamicUrl || null,
    //           headers: response.headers || null
    //         };
    //         localStorage.setItem("wizz_page_data", JSON.stringify(pageData));
    //         if (debug) {
    //           if (debug) console.log("Resolved with routes from multipass:", response.routes);
    //         }
    //         resolve(response.routes);
    //       } else {
    //         reject(new Error(response && response.error ? response.error : "Unknown error fetching routes."));
    //       }
    //     });
    //   });
    // });
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
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        let currentTab = tabs[0];
        if (!currentTab || !currentTab.url || !currentTab.url.includes("multipass.wizzair.com") || !currentTab.active) {
          try {
            await refreshMultipassTab();
          } catch (err) {
            if (debug) console.error("Failed to refresh multipass tab:", err);
          }
          chrome.tabs.query({ active: true, currentWindow: true }, (tabsAfter) => {
            currentTab = tabsAfter[0];
            chrome.tabs.sendMessage(currentTab.id, { action: "getDynamicUrl" }, (response) => {
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
            });
          });
        } else {
          if (currentTab.status !== "complete") {
            await waitForTabToComplete(currentTab.id);
          }
          await new Promise((r) => setTimeout(r, 1000));
          chrome.tabs.sendMessage(currentTab.id, { action: "getDynamicUrl" }, (response) => {
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
          });
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
  function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }
  
  async function searchConnectingRoutes(origins, destinations, selectedDate, maxTransfers, shouldAppend = true) {
    const routesData = await fetchDestinations();
    const minConnection = Number(localStorage.getItem("minConnectionTime")) || 90;
    const maxConnection = Number(localStorage.getItem("maxConnectionTime")) || 360;
    const stopoverText = document.getElementById("selected-stopover").textContent;
    const allowOvernight = stopoverText === "One stop (overnight)";

    const bookingHorizon = new Date();
    bookingHorizon.setDate(bookingHorizon.getDate() + 3);
  
    if (origins.length === 1 && origins[0] === "ANY") {
      origins = [...new Set(routesData.map(route =>
        typeof route.departureStation === "object" ? route.departureStation.id : route.departureStation
      ))];
    }
    let destinationList = [];
    if (destinations.length === 1 && destinations[0] === "ANY") {
      const destSet = new Set();
      routesData.forEach(route => {
        if (route.arrivalStations && Array.isArray(route.arrivalStations)) {
          route.arrivalStations.forEach(station =>
            destSet.add(typeof station === "object" ? station.id : station)
          );
        }
      });
      destinationList = Array.from(destSet);
    } else {
      destinationList = destinations;
    }
      
    const graph = buildGraph(routesData);
    let candidateRoutes = [];
    origins.forEach(origin => {
      findRoutesDFS(graph, origin, destinationList, [origin], maxTransfers, candidateRoutes);
    });
    const totalCandidates = candidateRoutes.length;
    let processedCandidates = 0;
    updateProgress(processedCandidates, totalCandidates, "Processing routes");
      
    const aggregatedResults = [];
    for (const candidate of candidateRoutes) {
      if (searchCancelled) break;
      let validCandidate = true;
      let unifiedFlights = [];
      let previousFlight = null;
      let currentSegmentDate = new Date(selectedDate);
      const transferCount = candidate.length - 2;
      const baseMaxDays = (transferCount === 1 && !allowOvernight)
        ? 0
        : Math.ceil(maxConnection / 1440);
          for (let i = 0; i < candidate.length - 1; i++) {
            if (searchCancelled) break;
            const segOrigin = candidate[i];
            const segDestination = candidate[i + 1];
            let chosenFlight = null;
            let dayOffsetUsed = 0;
            
            // For the very first leg, force offset = 0 so that departure date matches exactly.
            const startOffset = (i === 0) ? 0 : 0;
            for (let offset = startOffset; offset <= baseMaxDays; offset++) {
              const dateToSearch = addDays(currentSegmentDate, offset);
              // For first leg, if the search date doesn't match, skip.
              if (i === 0 && dateToSearch.toISOString().slice(0, 10) !== selectedDate) {
                continue;
              }
              if (dateToSearch > bookingHorizon) break;
              const dateStr = dateToSearch.toISOString().slice(0, 10);
              // NEW: Check if the selected date is available for this segment.
              if (!isDateAvailableForSegment(segOrigin, segDestination, dateStr, routesData)) {
                if (debug) console.log(`No available flight on ${dateStr} for segment ${segOrigin} → ${segDestination}`);
                continue;
              }
              
              const cacheKey = getUnifiedCacheKey(segOrigin, segDestination, dateStr);
              let flights = await getCachedResults(cacheKey);
              if (flights !== null) {
                flights = flights.map(unifyRawFlight);
              } else {
                try {
                  flights = await checkRouteSegment(segOrigin, segDestination, dateStr);
                  flights = flights.map(unifyRawFlight);
                  await setCachedResults(cacheKey, flights);
                } catch (error) {
                  flights = [];
                }
              }
              flights = flights.filter(f =>
                getLocalDateFromOffset(f.calculatedDuration.departureDate, f.departureOffsetText) === dateStr
              );
              if (previousFlight) {
                flights = flights.filter(f => {
                  const connectionTime = (f.calculatedDuration.departureDate.getTime() - previousFlight.calculatedDuration.arrivalDate.getTime()) / 60000;
                  return connectionTime >= minConnection && connectionTime <= maxConnection;
                });
              }
              if (flights.length > 0) {
                chosenFlight = flights[0];
                dayOffsetUsed = offset;
                break;
              }
            }
            
            if (!chosenFlight) {
              validCandidate = false;
              break;
            }
            unifiedFlights.push(chosenFlight);
            previousFlight = chosenFlight;
            currentSegmentDate = addDays(currentSegmentDate, dayOffsetUsed);
          }
          
        
      processedCandidates++;
      updateProgress(processedCandidates, totalCandidates, `Processed candidate: ${candidate.join(" → ")}`);
        
      if (validCandidate && unifiedFlights.length === candidate.length - 1) {
        const firstFlight = unifiedFlights[0];
        const lastFlight = unifiedFlights[unifiedFlights.length - 1];
        const totalDurationMinutes = Math.round((lastFlight.calculatedDuration.arrivalDate - firstFlight.calculatedDuration.departureDate) / 60000);
        let totalConnectionTime = 0;
        for (let j = 0; j < unifiedFlights.length - 1; j++) {
          const connectionTime = Math.round((unifiedFlights[j + 1].calculatedDuration.departureDate - unifiedFlights[j].calculatedDuration.arrivalDate) / 60000);
          totalConnectionTime += connectionTime;
        }
        const aggregatedRoute = {
          key: unifiedFlights.map(f => f.key).join(" | "),
          fareSellKey: unifiedFlights[0].fareSellKey,
          departure: unifiedFlights[0].departure,
          arrival: unifiedFlights[unifiedFlights.length - 1].arrival,
          departureStation: unifiedFlights[0].departureStation,
          departureStationText: unifiedFlights[0].departureStationText,
          arrivalStation: unifiedFlights[unifiedFlights.length - 1].arrivalStation,
          arrivalStationText: unifiedFlights[unifiedFlights.length - 1].arrivalStationText,
          departureDate: unifiedFlights[0].departureDate,
          arrivalDate: unifiedFlights[unifiedFlights.length - 1].arrivalDate,
          departureStationCode: unifiedFlights[0].departureStationCode,
          arrivalStationCode: unifiedFlights[unifiedFlights.length - 1].arrivalStationCode,
          reference: unifiedFlights[0].reference,
          stops: `${unifiedFlights.length - 1} transfer${unifiedFlights.length - 1 === 1 ? "" : "s"}`,
          flightCode: unifiedFlights[0].flightCode,
          carrierText: unifiedFlights[0].carrierText,
          currency: unifiedFlights[0].currency,
          fare: unifiedFlights[0].fare,
          discount: unifiedFlights[0].discount,
          price: unifiedFlights[0].price,
          taxes: unifiedFlights[0].taxes,
          totalPrice: unifiedFlights[0].totalPrice,
          displayPrice: unifiedFlights[0].displayPrice,
          priceTag: unifiedFlights[0].priceTag,
          flightId: unifiedFlights[0].flightId,
          fareBasisCode: unifiedFlights[0].fareBasisCode,
          actionText: unifiedFlights[0].actionText,
          isFree: unifiedFlights[0].isFree,
          departureOffsetText: unifiedFlights[0].departureOffsetText,
          arrivalOffsetText: unifiedFlights[unifiedFlights.length - 1].arrivalOffsetText,
          departureOffset: unifiedFlights[0].departureOffset,
          arrivalOffset: unifiedFlights[unifiedFlights.length - 1].arrivalOffset,
          displayDeparture: unifiedFlights[0].displayDeparture,
          displayArrival: unifiedFlights[unifiedFlights.length - 1].displayArrival,
          calculatedDuration: {
            hours: Math.floor(totalDurationMinutes / 60),
            minutes: totalDurationMinutes % 60,
            totalMinutes: totalDurationMinutes,
            departureDate: firstFlight.calculatedDuration.departureDate,
            arrivalDate: lastFlight.calculatedDuration.arrivalDate
          },
          formattedFlightDate: formatFlightDateCombined(firstFlight.calculatedDuration.departureDate, lastFlight.calculatedDuration.arrivalDate),
          route: [unifiedFlights[0].departureStationText, unifiedFlights[unifiedFlights.length - 1].arrivalStationText],
          totalConnectionTime: totalConnectionTime,
          segments: unifiedFlights
        };
        // Only append if shouldAppend is true.
        if (shouldAppend) {
          appendRouteToDisplay(aggregatedRoute);
        }
        aggregatedResults.push(aggregatedRoute);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return aggregatedResults;
  }
  
    // --- Updated searchDirectRoutes ---
  // Searches for direct (non‑connecting) flights using only the server–provided arrival stations.
  // Modified searchDirectRoutes function
  async function searchDirectRoutes(origins, destinations, selectedDate, shouldAppend = true, reverse = false) {
    if (debug) console.log("Starting searchDirectRoutes:", { origins, destinations, selectedDate, shouldAppend, reverse });
  
    // In reverse mode, we assume that outbound flights have been previously found.
    // globalResults is assumed to hold outbound flights (each with departureStation and arrivalStation).
    let allowedReversePairs = null;
    if (reverse && globalResults && globalResults.length > 0) {
      allowedReversePairs = new Set();
      globalResults.forEach(flight => {
        // For an outbound flight from X to Y, the reverse pair is Y → X.
        allowedReversePairs.add(`${flight.arrivalStation}-${flight.departureStation}`);
      });
      if (debug) console.log("Allowed reverse pairs from outbound flights:", Array.from(allowedReversePairs));
    }
  
    // In reverse mode, swap origins and destinations if not already done by the caller.
    if (reverse) {
      if (debug) console.log("Reverse mode enabled: swapping origins and destinations.");
      [origins, destinations] = [destinations, origins];
      if (debug) console.log("After swap, origins:", origins, "destinations:", destinations);
    }
  
    // Get routes data – we always use the cached routes from localStorage.
    let routesData = await fetchDestinations();
    if (debug) console.log(`Fetched ${routesData.length} routes from fetchDestinations.`);
  
    // If origins is "ANY" but destinations are specific, filter origins to those with at least one matching arrival.
    if (origins.length === 1 && origins[0] === "ANY" && !(destinations.length === 1 && destinations[0] === "ANY")) {
      if (debug) console.log("Origin is 'ANY', filtering origins based on provided destinations:", destinations);
      const destSet = new Set(destinations);
      const filteredOrigins = routesData.filter(route =>
        route.arrivalStations &&
        route.arrivalStations.some(arr => destSet.has(typeof arr === "object" ? arr.id : arr))
      ).map(route => (typeof route.departureStation === "object" ? route.departureStation.id : route.departureStation));
      origins = [...new Set(filteredOrigins)];
      if (debug) console.log("Filtered origins:", origins);
    }
  
    let validDirectFlights = [];
    // Process each origin.
    for (const origin of origins) {
      if (searchCancelled) {
        if (debug) console.log("Search cancelled. Exiting loop.");
        break;
      }
      if (debug) console.log(`Processing origin: ${origin}`);
  
      // Find route data for this origin.
      let routeData = routesData.find(route => {
        return typeof route.departureStation === "string"
          ? route.departureStation === origin
          : route.departureStation.id === origin;
      });
      if (!routeData || !routeData.arrivalStations) {
        if (debug) console.log(`No route data found for origin ${origin}. Skipping.`);
        continue;
      }
      if (debug) console.log(`Found ${routeData.arrivalStations.length} possible arrivals for origin ${origin}.`);
  
      // Filter arrival stations based on provided destinations.
      const matchingArrivals = (destinations.length === 1 && destinations[0] === "ANY")
        ? routeData.arrivalStations
        : routeData.arrivalStations.filter(arr => {
            const arrCode = typeof arr === "object" ? arr.id : arr;
            return destinations.includes(arrCode);
          });
      if (matchingArrivals.length === 0) {
        if (debug) console.log(`No matching arrivals found for origin ${origin} with destinations ${destinations}. Skipping.`);
        continue;
      }
      if (debug) console.log(`Matching arrivals for ${origin}:`, matchingArrivals);
  
      const totalArrivals = matchingArrivals.length;
      let processed = 0;
      updateProgress(processed, totalArrivals, `Checking direct flights for ${origin}`);
  
      for (const arrival of matchingArrivals) {
        if (searchCancelled) {
          if (debug) console.log("Search cancelled during processing. Exiting inner loop.");
          break;
        }
        let arrivalCode = typeof arrival === "object" ? arrival.id : arrival;
        // NEW: If arrival object has flightDates, check that the selectedDate is available.
        if (typeof arrival === "object" && arrival.flightDates) {
          if (!arrival.flightDates.includes(selectedDate)) {
            if (debug) console.log(`Direct flight not available on ${selectedDate} for ${origin} → ${arrivalCode}`);
            continue;
          }
        }
        if (debug) console.log(`Checking route ${origin} → ${arrivalCode}`);
  
        // In reverse mode, first check if this reverse pair is allowed (from outbound flights).
        if (reverse && allowedReversePairs) {
          const reversePairKey = `${origin}-${arrivalCode}`;
          if (!allowedReversePairs.has(reversePairKey)) {
            if (debug) console.log(`No outbound flight found for reverse route ${origin} → ${arrivalCode}. Skipping.`);
            continue;
          } else {
            if (debug) console.log(`Reverse route ${origin} → ${arrivalCode} is allowed based on outbound flights.`);
          }
        }
  
        // Build the cache key for the search parameters.
        const cacheKey = getUnifiedCacheKey(origin, arrivalCode, selectedDate);
        if (debug) console.log(`Checking cache for ${cacheKey}`);
        let cachedDirect = await getCachedResults(cacheKey);
        if (cachedDirect) {
          if (debug) console.log(`Cache hit for ${cacheKey}. Using cached flights.`);
          cachedDirect = cachedDirect.map(unifyRawFlight);
          if (shouldAppend) cachedDirect.forEach(flight => appendRouteToDisplay(flight));
          validDirectFlights = validDirectFlights.concat(cachedDirect);
          processed++;
          updateProgress(processed, totalArrivals, `Checked ${origin} → ${arrivalCode}`);
          continue;
        }
  
        if (debug) console.log(`No cached flight for ${cacheKey}; fetching from server.`);
        try {
          let flights = await checkRouteSegment(origin, arrivalCode, selectedDate);
          if (flights.length > 0) {
            if (debug) console.log(`Found ${flights.length} flights for ${origin} → ${arrivalCode}.`);
            flights = flights.map(unifyRawFlight);
            if (shouldAppend) flights.forEach(flight => appendRouteToDisplay(flight));
            await setCachedResults(cacheKey, flights);
            validDirectFlights = validDirectFlights.concat(flights);
          } else {
            if (debug) console.log(`No flights found for ${origin} → ${arrivalCode}. Caching empty result.`);
            await setCachedResults(cacheKey, []);
          }
        } catch (error) {
          console.error(`Error checking direct flight ${origin} → ${arrivalCode}: ${error.message}`);
        }
        processed++;
        updateProgress(processed, totalArrivals, `Checked ${origin} → ${arrivalCode}`);
      }
    }
    if (debug) console.log(`Direct flight search complete. Found ${validDirectFlights.length} flights.`);
    return validDirectFlights;
  }
  
  // ---------------- Main Search Handler ----------------
  // --- Updated Round-Trip Pairing and Rendering in handleSearch ---
  // Global variable to track if a search is active.
let searchActive = false;

// ---------------- Main Search Handler ----------------
async function handleSearch() {
  await cleanupCache();
  const searchButton = document.getElementById("search-button");

  // If a search is already active, treat the click as a cancel request.
  if (searchActive) {
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

  // Starting a new search: clear previous results and mark search as active.
  globalResults = [];
  totalResultsEl.textContent = "Total results: 0";
  searchActive = true;
  searchCancelled = false;
  searchButton.textContent = "Stop Search";

  // Reset request counter after 5 seconds (if needed)
  setTimeout(() => {
    requestsThisWindow = 0;
  }, 1000);

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
    showNotification("Please select a departure date first.");
    searchButton.innerHTML = " SEARCH";
    searchActive = false;
    return;
  }
  let origins = originInputs.map(s => resolveAirport(s)).flat();

  let destinationInputs = getMultiAirportValues("destination-multi");
  let destinations = (destinationInputs.length === 0 || destinationInputs.includes("ANY"))
    ? ["ANY"]
    : destinationInputs.map(s => resolveAirport(s)).flat();

  const tripType = window.currentTripType || "oneway";
  let departureDates = [];
  const departureInputRaw = document.getElementById("departure-date").value.trim();
  if (departureInputRaw === "ALL") {
    const today = new Date();
    for (let i = 0; i <= 3; i++) {
      const d = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      departureDates.push(`${yyyy}-${mm}-${dd}`);
    }
  } else {
    departureDates = departureInputRaw.split(",").map(d => d.trim()).filter(d => d !== "");
  }

  document.querySelector(".route-list").innerHTML = "";
  updateProgress(0, 1, "Initializing search");

  const stopoverText = document.getElementById("selected-stopover").textContent;
  let maxTransfers = 0;
  if (stopoverText === "One stop or fewer" || stopoverText === "One stop (overnight)") {
    maxTransfers = 1;
  } else if (stopoverText === "Two stops or fewer") {
    maxTransfers = 2;
  } else {
    maxTransfers = 0;
  }

  try {
    if (tripType === "oneway") {
      for (const dateStr of departureDates) {
        if (searchCancelled) return;
        if (maxTransfers > 0) {
          await searchConnectingRoutes(origins, destinations, dateStr, maxTransfers);
        } else {
          await searchDirectRoutes(origins, destinations, dateStr);
        }
      }
    } else {
      // Round-trip search:
      suppressDisplay = true;
      let outboundFlights = [];
      for (const outboundDate of departureDates) {
        if (searchCancelled) break;
        let outboundFlightsForDate = [];
        if (maxTransfers > 0) {
          outboundFlightsForDate = outboundFlightsForDate.concat(
            await searchConnectingRoutes(origins, destinations, outboundDate, maxTransfers)
          );
        } else {
          outboundFlightsForDate = outboundFlightsForDate.concat(
            await searchDirectRoutes(origins, destinations, outboundDate)
          );
        }
        outboundFlights = outboundFlights.concat(outboundFlightsForDate);
      }
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
      // Prepare inbound queries.
      let returnDates = returnInputRaw.split(",").map(d => d.trim()).filter(d => d !== "");
      let inboundQueries = {};
      window.originalOriginInput = getMultiAirportValues("origin-multi").join(", ");
      const originalOrigins = resolveAirport(window.originalOriginInput);
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
                    false
                  );
                  const directResults = await searchDirectRoutes(
                    [outbound.arrivalStation],
                    [origin],
                    rDate,
                    false
                  );
                  return [...connectingResults, ...directResults];
                };
              } else {
                inboundQueries[key] = async () => {
                  return await searchDirectRoutes([outbound.arrivalStation], [origin], rDate, false);
                };
              }
            }
          }
        }
      }

      const inboundResults = {};
      const inboundKeys = Object.keys(inboundQueries);
      // Process inbound queries sequentially to respect throttling.
      for (const key of inboundKeys) {
        try {
          inboundResults[key] = await inboundQueries[key]();
        } catch (error) {
          console.error(`Error searching inbound flights for ${key}: ${error.message}`);
          inboundResults[key] = [];
        }
      }

      // Match inbound flights with corresponding outbound flights.
      for (const outbound of outboundFlights) {
        let outboundDestination = outbound.arrivalStation;
        let matchedInbound = [];
        for (const rDate of returnDates) {
          for (const origin of originalOrigins) {
            const key = `${outboundDestination}-${origin}-${rDate}`;
            let inboundForKey = inboundResults[key] || [];
            const filteredInbound = inboundForKey.filter(inbound =>
              Math.round((inbound.calculatedDuration.departureDate - outbound.calculatedDuration.arrivalDate) / 60000) >= 360 &&
              inbound.calculatedDuration.departureDate > outbound.calculatedDuration.arrivalDate
            );
            matchedInbound = matchedInbound.concat(filteredInbound);
          }
        }
        const seenInbound = new Set();
        const dedupedInbound = [];
        for (const flight of matchedInbound) {
          const depTime = flight.calculatedDuration.departureDate.getTime();
          const dedupKey = flight.flightCode + "_" + depTime;
          if (!seenInbound.has(dedupKey)) {
            seenInbound.add(dedupKey);
            dedupedInbound.push(flight);
          }
        }
        outbound.returnFlights = dedupedInbound;
      }
      const validRoundTripFlights = outboundFlights.filter(flight => flight.returnFlights && flight.returnFlights.length > 0);
      globalResults = validRoundTripFlights;
      suppressDisplay = false;
      displayRoundTripResultsAll(validRoundTripFlights);
    }
  } catch (error) {
    document.querySelector(".route-list").innerHTML = `<p>Error: ${error.message}</p>`;
    console.error("Search error:", error);
  } finally {
    // If no results found for one-way, display message.
    if (globalResults.length === 0 && tripType === "oneway") {
      document.querySelector(".route-list").innerHTML = "<p>There are no available flights on this route.</p>";
    }
    hideProgress();
    searchButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
      </svg> SEARCH`;
    searchActive = false;
    updateCSVButtonVisibility();
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
    input.className = "block w-full bg-transparent border border-gray-300 text-gray-800 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#C90076]";
    const inputId = fieldName + "-input-" + Date.now();
    input.id = inputId;
    inputWrapper.appendChild(input);

    const suggestions = document.createElement("div");
    suggestions.id = inputId + "-suggestions";
    suggestions.className = "absolute top-full left-0 right-0 bg-white border border-gray-300 rounded-md shadow-lg z-20 text-gray-800 text-sm hidden";
    inputWrapper.appendChild(suggestions);

    row.appendChild(inputWrapper);
  
    // Always add a delete button (even for the first row)
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "✕";
    // Added cursor-pointer for hover feedback
    deleteBtn.className = "delete-btn  w-5 h-5 text-white text-xs bg-[#20006D] rounded-lg hover:bg-red-600 flex items-center justify-center cursor-pointer";
    deleteBtn.addEventListener("click", () => {
      row.remove();
      updateAirportRows(container);
      // Ensure at least one row remains after deletion.
      if (container.querySelectorAll(".airport-row").length === 0) {
        addAirportRow(container, fieldName);
        updateAirportRows(container);
      }
    });
    row.appendChild(deleteBtn);
  
    // Add the plus button for adding new rows.
    const plusBtn = document.createElement("button");
    plusBtn.textContent = "+";
    // Initially hidden, will be shown only when at least one field is filled
    plusBtn.className = "plus-btn w-5 h-5 text-white text-xs bg-[#C90076] rounded-lg hover:bg-[#A00065] flex items-center justify-center cursor-pointer hidden";

    plusBtn.addEventListener("click", () => {
      addAirportRow(container, fieldName);
      updateAirportRows(container);
    });

    // Append the button to the row but keep it hidden initially
    row.appendChild(plusBtn);

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
      if (deleteBtn) deleteBtn.style.display = "inline-block";
  
      const plusBtn = row.querySelector(".plus-btn");
      const inputField = row.querySelector("input");
  
      if (rows.length < 3 && index === rows.length - 1 && inputField && inputField.value.trim().length > 0) {
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
  }
  function showNotification(message) {
    const banner = document.getElementById("notification-banner");
    const text = document.getElementById("notification-text");
  
    text.textContent = message; // Set the message text
    banner.classList.remove("hidden", "opacity-0"); // Show banner
    banner.classList.add("opacity-100");
  
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

    // For "default" leave the insertion order unchanged.
    if (sortOption === "default") {
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
        // For round-trip, use the final arrival time if returnFlights exist;
        // otherwise, use the one-way arrival time.
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
            // Overall duration: outbound departure to final inbound arrival.
            const outboundDeparture = new Date(flight.calculatedDuration.departureDate).getTime();
            const inboundArrival = new Date(flight.returnFlights[flight.returnFlights.length - 1].calculatedDuration.arrivalDate).getTime();
            return (inboundArrival - outboundDeparture) / 60000;
          }
          return flight.calculatedDuration.totalMinutes;
        };
        return getTripDuration(a) - getTripDuration(b);
      });
    }
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
      <hr class="${ isOutbound ? "border-[#C90076] border-2 mt-1" : "border-[#20006D] border-2 mt-1 my-2"}">
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
        <button class="continue-payment-button px-3 py-2 bg-[#C90076] text-white rounded-md font-bold shadow-md hover:bg-[#A00065] transition cursor-pointer" data-outbound-key="${segment.key}">
          Continue to Payment
        </button>
      </div>
    `;
      if (idx < unifiedFlight.segments.length - 1) {
        const nextSegment = unifiedFlight.segments[idx + 1];
        const connectionMs = nextSegment.calculatedDuration.departureDate - segment.calculatedDuration.arrivalDate;
        const connectionMinutes = Math.max(0, Math.round(connectionMs / 60000));
        const ch = Math.floor(connectionMinutes / 60);
        const cm = connectionMinutes % 60;
        bodyHtml += `
          <div class="flex items-center my-2">
            <div class="flex-1 border-t-2 border-dashed border-gray-400"></div>
            <div class="px-3 text-sm ${isReturn ? "text-black" : "text-gray-500"} whitespace-nowrap">
              Connection: ${ch}h ${cm}m
            </div>
            <div class="flex-1 border-t-2 border-dashed border-gray-400"></div>
          </div>
        `;
      }
    });
  } else {
    bodyHtml = createSegmentRow(unifiedFlight);
    bodyHtml += `
      <div class="flex justify-between items-center mt-2">
        <div class="text-left text-sm font-semibold text-gray-800">
          ${unifiedFlight.currency} ${unifiedFlight.displayPrice}
        </div>
        <button class="continue-payment-button px-3 py-2 bg-[#C90076] text-white rounded-md font-bold shadow-md hover:bg-[#A00065] transition cursor-pointer" data-outbound-key="${unifiedFlight.key}">
          Continue to Payment
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
  const segmentDate = formatFlightDateCombined(segment.calculatedDuration.departureDate, segment.calculatedDuration.arrivalDate);
  const flightCode = formatFlightCode(segment.flightCode);
  const segmentHeader = `
    <div class="flex justify-between items-center mb-1">
      <div class="text-xs font-semibold bg-gray-200 text-gray-800 px-2 py-1 rounded">
        ${segmentDate}
      </div>
      <div class="text-xs font-semibold bg-[#20006D] text-white px-2 py-1 rounded">
        ${flightCode}
      </div>
    </div>
  `;
  const gridRow = `
    <div class="grid grid-cols-3 grid-rows-2 gap-1 items-center w-full py-1">
      <div class="flex items-center gap-1 whitespace-nowrap">
        <span class="text-xl">${getCountryFlag(segment.departureStation)}</span>
        <span class="text-base font-medium">${segment.departureStationText}</span>
      </div>
      <div class="flex justify-center">
        <span class="text-xl font-medium">✈</span>
      </div>
      <div class="flex items-center justify-end gap-1 whitespace-nowrap mb-0">
        <span class="text-base font-medium">${segment.arrivalStationText}</span>
        <span class="text-xl">${getCountryFlag(segment.arrivalStation)}</span>
      </div>
      <div class="flex items-center gap-1">
        <span class="text-2xl font-bold whitespace-nowrap">${segment.displayDeparture}</span>
        <sup class="text-[10px] align-super">${formatOffsetForDisplay(segment.departureOffset)}</sup>
      </div>
      <div class="flex flex-col items-center">
        <div class="text-sm font-medium">
          ${segment.calculatedDuration.hours}h ${segment.calculatedDuration.minutes}m
        </div>
      </div>
      <div class="flex items-center justify-end gap-1">
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
      dateCell.className = "border rounded p-1 cursor-pointer";
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
        const dynamicUrl = await getDynamicUrl(); // Fetch the dynamic URL
        console.log("dynamicUrl for payment:", dynamicUrl);
        
        const subscriptionId = getSubscriptionIdFromDynamicUrl(dynamicUrl);
        if (!subscriptionId) {
            console.error("Failed to extract subscription ID from:", dynamicUrl);
            return;
        }

        const url = `https://multipass.wizzair.com/w6/subscriptions/${subscriptionId}/confirmation`;
        console.log("Using subscription ID:", subscriptionId);
        console.log("Final Payment URL (without sending request):", url);

        const form = document.createElement("form");
        form.method = "POST";
        form.action = url;
        form.target = "_blank";

        // Send outboundKey as POST data
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "outboundKey";
        input.value = outboundKey;
        form.appendChild(input);

        console.log("Form data:", { outboundKey: input.value });
        console.log("Generated form:", form);
        console.log("Form Action (Final URL):", form.action);
        console.log("Form Data:", { outboundKey: input.value });
        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);
    } catch (error) {
        console.error("Error in continueToPayment:", error);
    }
};
 
  
  // ---------------- Initialize on DOMContentLoaded ----------------
  
  document.addEventListener("DOMContentLoaded", () => {
    // ========== 1. Load settings from localStorage ==========
    const storedPreferredAirport = localStorage.getItem("preferredAirport") || "";
    document.getElementById("preferred-airport").value = storedPreferredAirport;
    document.getElementById("min-connection-time").value = localStorage.getItem("minConnectionTime") || 90;
    document.getElementById("max-connection-time").value = localStorage.getItem("maxConnectionTime") || 360;
    document.getElementById("max-requests").value = localStorage.getItem("maxRequestsInRow") || 25;
    document.getElementById("requests-frequency").value = localStorage.getItem("requestsFrequencyMs") || 600;
    document.getElementById("pause-duration").value = localStorage.getItem("pauseDurationSeconds") || 15;
    document.getElementById("cache-lifetime").value = localStorage.getItem("cacheLifetimeHours") || 4;
  
    // ========== 2. Toggle Expert Settings ==========
    document.getElementById("toggle-expert-settings").addEventListener("click", (event) => {
      const expertSettings = document.getElementById("expert-settings");
      if (expertSettings.classList.contains("hidden")) {
        expertSettings.classList.remove("hidden");
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
      if (!preferredAirport) {
        showNotification("Please enter a valid airport. ⚠️");
        return;
      }
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
  
    // ========== 11. UI Scale Change ==========
    const scaleSlider = document.getElementById("ui-scale");
    document.body.style.zoom = scaleSlider.value / 100;
    scaleSlider.addEventListener("input", function() {
      document.body.style.zoom = this.value / 100;
    });

    // ========= 12. Go to payment page =========
    document.querySelector(".route-list").addEventListener("click", (event) => {
      const btn = event.target.closest(".continue-payment-button");
      if (btn) {
        const outboundKey = btn.getAttribute("data-outbound-key");
        continueToPayment(outboundKey);
      }
    });    
  });
  