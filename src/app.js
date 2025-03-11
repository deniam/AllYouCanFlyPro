import {
    AIRPORTS,
    COUNTRY_AIRPORTS,
    isExcludedRoute,
    airportFlags
  } from './airports.js';
  // ----------------------- Global Settings -----------------------
  const MIN_CONNECTION_MINUTES = 90;
  const BASE_DELAY_MS = 500;
  const MAX_RETRY_ATTEMPTS = 2;  

  // Throttle and caching parameters (loaded from localStorage if available)
  let REQUESTS_FREQUENCY_MS = Number(localStorage.getItem('requestsFrequencyMs')) || 600;
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
  let debug = false;
  let suppressDisplay = false; // Flag to delay UI updates in certain search types
  // Build airport names mapping from AIRPORTS list (strip code in parentheses)
  const airportNames = {};
  AIRPORTS.forEach(airport => {
    if (!airportNames[airport.code]) {
      airportNames[airport.code] = airport.name.replace(/\s*\(.*\)$/, "").trim();
    }
  });
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
  let timeoutInterval = null;
  function showTimeoutCountdown(waitTimeMs) {
    const timeoutEl = document.getElementById("timeout-status");
    if (timeoutInterval !== null) {
      clearInterval(timeoutInterval);
      timeoutInterval = null;
    }
    let seconds = Math.floor(waitTimeMs / 1000);
    timeoutEl.style.display = "block";
    timeoutEl.textContent = `Pausing for ${seconds} seconds to avoid API rate limits...`;
    const interval = setInterval(() => {
      seconds--;
      timeoutEl.textContent = `Pausing for ${seconds} seconds to avoid API rate limits...`;
      if (seconds <= 0) {
        clearInterval(interval);
        timeoutEl.textContent = "";
        timeoutEl.style.display = "none";
      }
    }, 1000);
  }

  let throttleResetTimer = null;
  async function throttleRequest() {
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
    requestsThisWindow++;
    await new Promise(resolve => setTimeout(resolve, REQUESTS_FREQUENCY_MS));

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
  
    // Gather all used entries (in both origin and destination fields)
    function getAllUsedEntries() {
      const originUsed = Array.from(document.querySelectorAll("#origin-multi input"))
        .filter(el => el.id !== inputId)
        .map(el => el.value.trim().toLowerCase());
      const destUsed = Array.from(document.querySelectorAll("#destination-multi input"))
        .filter(el => el.id !== inputId)
        .map(el => el.value.trim().toLowerCase());
      return new Set([...originUsed, ...destUsed]);
    }
  
    // Retrieve recent entries for this input (if any)
    function getRecentEntries() {
      const stored = localStorage.getItem(recentKey);
      return stored ? JSON.parse(stored) : [];
    }

    function addRecentEntry(entry) {
      let recents = getRecentEntries();
      recents = recents.filter(e => e !== entry);
      recents.unshift(entry);
      if (recents.length > 5) recents = recents.slice(0, 5);
      localStorage.setItem(recentKey, JSON.stringify(recents));
    }
  
    // Show recent suggestions when the field is focused and empty
    inputEl.addEventListener("focus", () => {
      if (!inputEl.value.trim()) {
        const recent = getRecentEntries();
        if (recent.length > 0) {
          suggestionsEl.innerHTML = "";
          recent.forEach(entry => {
            const div = document.createElement("div");
            div.className = "px-4 py-2 cursor-pointer hover:bg-gray-100";
            div.textContent = entry;
            div.addEventListener("click", () => {
              inputEl.value = entry;
              suggestionsEl.classList.add("hidden");
            });
            suggestionsEl.appendChild(div);
          });
          suggestionsEl.classList.remove("hidden");
        }
      }
    });
  
    // Main autocomplete input event
    inputEl.addEventListener("input", () => {
      const query = inputEl.value.trim().toLowerCase();
      suggestionsEl.innerHTML = "";
      if (!query) {
        suggestionsEl.classList.add("hidden");
        return;
      }
  
      // Special case: if user types "any", show "Anywhere"
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
  
      // Build set of used entries (from other fields)
      const usedEntries = getAllUsedEntries();
  
      // Build a set of used airport codes from used country names.
      // For each used value that exactly matches a country, add all its airport codes.
      const usedCountryAirports = new Set();
      Object.keys(COUNTRY_AIRPORTS).forEach(country => {
        if (usedEntries.has(country.toLowerCase())) {
          COUNTRY_AIRPORTS[country].forEach(code => usedCountryAirports.add(code.toLowerCase()));
        }
      });
  
      // Filter country suggestions: exclude a country if it was already entered.
      const countryMatches = Object.keys(COUNTRY_AIRPORTS)
        .filter(country => country.toLowerCase().includes(query) && !usedEntries.has(country.toLowerCase()))
        .map(country => ({ isCountry: true, code: country, name: country }));
  
      // Filter airport suggestions: exclude ones already used or belonging to a used country.
      const airportMatches = AIRPORTS.filter(a => {
        const codeLower = a.code.toLowerCase();
        const nameLower = a.name.toLowerCase();
        if (usedEntries.has(codeLower) || usedEntries.has(nameLower)) {
          return false;
        }
        if (usedCountryAirports.has(codeLower)) {
          return false;
        }
        return codeLower.includes(query) || nameLower.includes(query);
      }).map(a => ({ isCountry: false, code: a.code, name: a.name }));
  
      let matches = [...countryMatches, ...airportMatches].slice(0, 5);
      if (matches.length === 0) {
        suggestionsEl.classList.add("hidden");
        return;
      }
      matches.forEach(match => {
        const div = document.createElement("div");
        div.className = "px-4 py-2 cursor-pointer hover:bg-gray-100";
        div.textContent = match.name;
        div.addEventListener("click", () => {
          inputEl.value = match.name;
          addRecentEntry(match.name);
          suggestionsEl.classList.add("hidden");
        });
        suggestionsEl.appendChild(div);
      });
      suggestionsEl.classList.remove("hidden");
    });
  
    // Hide suggestions on clicking outside the input or suggestion box
    document.addEventListener("click", event => {
      if (!inputEl.contains(event.target) && !suggestionsEl.contains(event.target)) {
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
  
  function rehydrateDates(obj) {
    if (obj.firstDeparture && typeof obj.firstDeparture === "string") {
      obj.firstDeparture = parseServerDate(obj.firstDeparture);
    }
    if (obj.segments && Array.isArray(obj.segments)) {
      obj.segments.forEach(seg => {
        if (seg.departureDate && typeof seg.departureDate === "string") {
          seg.departureDate = parseServerDate(seg.departureDate);
        }
        if (seg.arrivalDate && typeof seg.arrivalDate === "string") {
          seg.arrivalDate = parseServerDate(seg.arrivalDate);
        }
        if (seg.calculatedDuration) {
          if (seg.calculatedDuration.departureDate && typeof seg.calculatedDuration.departureDate === "string") {
            seg.calculatedDuration.departureDate = parseServerDate(seg.calculatedDuration.departureDate);
          }
          if (seg.calculatedDuration.arrivalDate && typeof seg.calculatedDuration.arrivalDate === "string") {
            seg.calculatedDuration.arrivalDate = parseServerDate(seg.calculatedDuration.arrivalDate);
          }
        }
      });
    }
  }
  // ---------------- Candidate Caching Functions ----------------
  function getUnifiedCacheKey(origin, destination, date) {
    return `${origin}-${destination}-${date}`;
  }
  function handleClearCache() {
    // Define a set of keys to preserve
    const keysToKeep = new Set(["wizz_page_data", "preferredAirport"]);
  
    // Loop over all keys in localStorage
    Object.keys(localStorage).forEach(key => {
      if (!keysToKeep.has(key)) {
        localStorage.removeItem(key);
      }
    });
  
    showNotification("Cache successfully cleared! ✅");
  }

  function setCachedResults(key, results) {
    const cacheData = { results: results, timestamp: Date.now() };
    localStorage.setItem(key, JSON.stringify(cacheData));
  }
  function getCachedResults(key) {
    const cachedData = localStorage.getItem(key);
    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData);
        if (
          parsed &&
          Array.isArray(parsed.results) &&
          Date.now() - parsed.timestamp < CACHE_LIFETIME
        ) {
          return parsed.results;
        }
      } catch (e) {
        localStorage.removeItem(key);
      }
    }
    return null;
  }

// ---------------- API Request Function ----------------
async function checkRouteSegment(origin, destination, date) {
  

  let attempts = 0;
  while (attempts < MAX_RETRY_ATTEMPTS) {
    await throttleRequest();
    try {
      const delay = Math.floor(Math.random() * (1000 - BASE_DELAY_MS + 1)) + BASE_DELAY_MS;
      await new Promise(resolve => setTimeout(resolve, delay));

      // Get (or re-fetch) the dynamic URL
      let dynamicUrl = await getDynamicUrl();

      // Get cached page data for headers
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
      if (pageData.headers && Date.now() - pageData.timestamp < 60 * 60 * 1000) {
        if (debug) console.log("Using cached headers");
        headers = { ...headers, ...pageData.headers };
      } else {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          const currentTab = tabs[0];
          chrome.tabs.sendMessage(currentTab.id, { action: "getHeaders" }, function (response) {
            if (response && response.headers) {
              headers = { ...headers, ...response.headers };
            } else {
              if (debug) console.log("Failed to get headers from page, using defaults");
            }
          });
        });
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
          if (debug) console.warn("Dynamic URL returned HTML. Clearing cache and retrying.");
          localStorage.removeItem("wizz_page_data");
          if (debug) throw new Error("Invalid response format: expected JSON but received HTML");
        }
      }

      const responseData = await fetchResponse.json();
      if (debug) console.log(`Response for segment ${origin} → ${destination}:`, responseData);
      if (debug) console.log(responseData.flightsOutbound)
      return responseData.flightsOutbound || [];
      
    } catch (error) {
      if (error.message.includes("429") || error.message.includes("426") || error.message.includes("Invalid response format")) {
        const waitTime = error.message.includes("426") ? 60000 : 40000;
        if (debug) console.warn(`Rate limit or invalid dynamic URL encountered for segment ${origin} → ${destination} – waiting for ${waitTime / 1000} seconds`);
        showTimeoutCountdown(waitTime);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        if (debug) throw error;
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
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ url: "https://multipass.wizzair.com/*" }, async (tabs) => {
        let multipassTab;
        if (tabs && tabs.length > 0) {
          multipassTab = tabs[0];
          if (debug) console.log("Found multipass tab:", multipassTab.id, multipassTab.url);
        } else {
          if (debug) console.log("No multipass tab found, opening one...");
          chrome.tabs.create({
            url: "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets"
          }, async (newTab) => {
            multipassTab = newTab;
            if (debug) console.log("Opened new multipass tab:", newTab.id, newTab.url);
            await waitForTabToComplete(newTab.id);
            chrome.tabs.sendMessage(newTab.id, { action: "getDestinations" }, (response) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              if (response && response.routes) {
                const pageData = {
                  routes: response.routes,
                  timestamp: Date.now(),
                  dynamicUrl: response.dynamicUrl || null,
                  headers: response.headers || null
                };
                localStorage.setItem("wizz_page_data", JSON.stringify(pageData));
                resolve(response.routes);
              } else if (response && response.error) {
                reject(new Error(response.error));
              } else {
                reject(new Error("Failed to fetch destinations"));
              }
            });
          });
          return;
        }
        if (multipassTab.status !== "complete") {
          await waitForTabToComplete(multipassTab.id);
        }
        if (debug) console.log("Sending getDestinations message to tab", multipassTab.id);
        chrome.tabs.sendMessage(multipassTab.id, { action: "getDestinations" }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve(response.routes);
          } else {
            reject(new Error(response && response.error ? response.error : "Unknown error fetching routes."));
          }
        });
      });
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
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        let currentTab = tabs[0];
        if (!currentTab || !currentTab.url.includes("multipass.wizzair.com")) {
          chrome.tabs.create({
            url: "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets"
          }, async (newTab) => {
            await waitForTabToComplete(newTab.id);
            await new Promise((r) => setTimeout(r, 1000));
            chrome.tabs.sendMessage(newTab.id, { action: "getDynamicUrl" }, (response) => {
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
  // ---------------- Round-Trip and Direct Route Search Functions ----------------
    // --- Updated searchConnectingRoutes ---
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
    const allowOvernight = document.getElementById("overnight-checkbox").checked;
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
              const cacheKey = getUnifiedCacheKey(segOrigin, segDestination, dateStr);
              let flights = getCachedResults(cacheKey);
              if (flights !== null) {
                flights = flights.map(unifyRawFlight);
              } else {
                await throttleRequest();
                try {
                  flights = await checkRouteSegment(segOrigin, segDestination, dateStr);
                  flights = flights.map(unifyRawFlight);
                  setCachedResults(cacheKey, flights);
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
  async function searchDirectRoutes(origins, destinations, selectedDate, shouldAppend = true) {
    const routesData = await fetchDestinations();
    if (origins.length === 1 && origins[0] === "ANY" && !(destinations.length === 1 && destinations[0] === "ANY")) {
      const destSet = new Set(destinations);
      const filteredOrigins = routesData.filter(route =>
        route.arrivalStations && route.arrivalStations.some(arr => {
          const arrCode = typeof arr === "object" ? arr.id : arr;
          return destSet.has(arrCode);
        })
      ).map(route =>
        typeof route.departureStation === "object" ? route.departureStation.id : route.departureStation
      );
      origins = [...new Set(filteredOrigins)];
    }
    let validDirectFlights = [];
    for (const origin of origins) {
      if (searchCancelled) break;
      let routeData = routesData.find(route => {
        if (typeof route.departureStation === "string") {
          return route.departureStation === origin;
        } else {
          return route.departureStation.id === origin;
        }
      });
      if (!routeData || !routeData.arrivalStations) continue;
      const totalArrivals = routeData.arrivalStations.length;
      let processed = 0;
      updateProgress(processed, totalArrivals, `Checking direct flights for ${origin}`);
      const getMatchingArrivals = (destinations, routeData) => {
        if (destinations.length === 1 && destinations[0] === "ANY") {
          return routeData.arrivalStations;
        }
        return routeData.arrivalStations.filter(arr => {
          const arrCode = typeof arr === "object" ? arr.id : arr;
          return destinations.includes(arrCode);
        });
      };
      const finalArrivals = getMatchingArrivals(destinations, routeData);
      for (const arrival of finalArrivals) {
        if (searchCancelled) break;
        let arrivalCode = arrival.id || arrival;
        if (isExcludedRoute(origin, arrivalCode)) {
          processed++;
          updateProgress(processed, totalArrivals, `Checked direct flights for ${origin} → ${arrivalCode}`);
          continue;
        }
        const cacheKey = getUnifiedCacheKey(origin, arrivalCode, selectedDate);
        let cachedDirect = getCachedResults(cacheKey);
        if (cachedDirect) {
          cachedDirect = cachedDirect.map(unifyRawFlight);
          if (shouldAppend) {
            cachedDirect.forEach(flight => appendRouteToDisplay(flight));
          }
          validDirectFlights = validDirectFlights.concat(cachedDirect);
          processed++;
          updateProgress(processed, totalArrivals, `Checked direct flights for ${origin} → ${arrivalCode}`);
          continue;
        }
        try {
          let flights = await checkRouteSegment(origin, arrivalCode, selectedDate);
          if (flights.length > 0) {
            flights = flights.map(unifyRawFlight);
            if (shouldAppend) {
              flights.forEach(flight => appendRouteToDisplay(flight));
            }
            setCachedResults(cacheKey, flights);
            validDirectFlights = validDirectFlights.concat(flights);
          } else {
            setCachedResults(cacheKey, []);
          }
        } catch (error) {
          console.error(`Error checking direct flight ${origin} → ${arrivalCode}: ${error.message}`);
        }
        processed++;
        updateProgress(processed, totalArrivals, `Checked direct flights for ${origin} → ${arrivalCode}`);
      }
    }
    return validDirectFlights;
  }
  // ---------------- Main Search Handler ----------------
  // --- Updated Round-Trip Pairing and Rendering in handleSearch ---
  async function handleSearch() {
    globalResults = [];
    totalResultsEl.textContent = "Total results: 0";

    const departureInputRaw = document.getElementById("departure-date").value.trim();
    const searchButton = document.getElementById("search-button");
    
    if (searchButton.textContent.includes("Stop Search")) {
      searchCancelled = true;
      if (throttleResetTimer) {
        clearTimeout(throttleResetTimer);
        throttleResetTimer = null;
      }
      if (timeoutInterval) {
        clearInterval(timeoutInterval);
        timeoutInterval = null;
      }
      // Hide the timeout status notification immediately
      const timeoutEl = document.getElementById("timeout-status");
      timeoutEl.textContent = "";
      timeoutEl.style.display = "none";
      progressContainer.style.display = "none";
      searchButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" 
        viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
          <path stroke-linecap="round" stroke-linejoin="round" 
            d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg> Search Flights`;
      return;
    }
    setTimeout(() => {
      requestsThisWindow = 0;
    }, 5000);
    searchCancelled = false;
    searchButton.textContent = "Stop Search";
  
    let returnInputRaw = "";
    if (window.currentTripType === "return") {
      returnInputRaw = document.getElementById("return-date").value.trim();
      if (!returnInputRaw) {
        alert("Please select a return date for round-trip search.");
        searchButton.innerHTML = " Search Flights";
        return;
      }
    }
  
    let originInputs = getMultiAirportValues("origin-multi");
    if (originInputs.length === 0) {
      alert("Please enter at least one departure airport.");
      searchButton.innerHTML = " Search Flights";
      return;
    }
    let origins = originInputs.map(s => resolveAirport(s)).flat();
    
    let destinationInputs = getMultiAirportValues("destination-multi");
    let destinations = destinationInputs.length === 0 || destinationInputs.includes("ANY")
      ? ["ANY"]
      : destinationInputs.map(s => resolveAirport(s)).flat();

    const tripType = window.currentTripType || "oneway";
    let departureDates = [];
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
    globalResults = [];
    updateProgress(0, 1, "Initializing search");
  
    try {
      if (tripType === "oneway") {
        for (const dateStr of departureDates) {
          if (searchCancelled) break;
          const maxTransfers = document.getElementById("two-transfer-checkbox").checked ? 2 :
                               (document.getElementById("transfer-checkbox").checked ? 1 : 0);
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
        const maxTransfers = document.getElementById("two-transfer-checkbox").checked ? 2 :
                             (document.getElementById("transfer-checkbox").checked ? 1 : 0);
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
        // Store original origin values (airport codes)
        window.originalOriginInput = getMultiAirportValues("origin-multi").join(", ");
        const originalOrigins = resolveAirport(window.originalOriginInput);
        for (const outbound of outboundFlights) {
          let outboundDestination = outbound.arrivalStation;
          for (const rDate of returnDates) {
            for (const origin of originalOrigins) {
              const key = `${outboundDestination}-${origin}-${rDate}`;
              if (!inboundQueries[key]) {
                if (maxTransfers > 0) {
                  inboundQueries[key] = (async () => {
                    const connectingResults = await searchConnectingRoutes([outbound.arrivalStation], [origin], rDate, maxTransfers, false);
                    const directResults = await searchDirectRoutes([outbound.arrivalStation], [origin], rDate, false);
                    return [...connectingResults, ...directResults];
                  })();
                } else {
                  inboundQueries[key] = searchDirectRoutes([outbound.arrivalStation], [origin], rDate, false);
                }
              }
            }
          }
        }

        const inboundResults = {};
        for (const key of Object.keys(inboundQueries)) {
          try {
            inboundResults[key] = await inboundQueries[key];
          } catch (error) {
            console.error(`Error searching inbound flights for ${key}: ${error.message}`);
            inboundResults[key] = [];
          }
        }
        // === In the Round-Trip Search section of handleSearch (inbound query handling) ===
        for (const outbound of outboundFlights) {
          let outboundDestination = outbound.arrivalStation;
          let matchedInbound = [];
          for (const rDate of returnDates) {
            for (const origin of originalOrigins) {
              const key = `${outboundDestination}-${origin}-${rDate}`;
              let inboundForKey = inboundResults[key] || [];
              // Filter: require connection time of at least 360 minutes and inbound departure > outbound arrival.
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

        // const resultsDiv = document.querySelector(".route-list");
        // resultsDiv.innerHTML = "";
        // const filteredOutbounds = outboundFlights.filter(flight =>
        //   flight.returnFlights && flight.returnFlights.length > 0
        // );
        // // const totalResultsEl = document.createElement("p");
        // // totalResultsEl.textContent = `Total results: ${filteredOutbounds.length}`;
        // // totalResultsEl.className = "text-lg font-semibold text-[#20006D] mb-4";
        // // resultsDiv.appendChild(totalResultsEl);
        // filteredOutbounds.forEach(outbound => {
        //   const outboundHtml = renderRouteBlock(outbound, "Outbound Flight");
        //   resultsDiv.insertAdjacentHTML("beforeend", outboundHtml);
        //   if (outbound.returnFlights && outbound.returnFlights.length > 0) {
        //     outbound.returnFlights.forEach((ret, idx) => {
        //       const stopoverMs = ret.calculatedDuration.departureDate - outbound.calculatedDuration.arrivalDate;
        //       const stopoverMinutes = Math.max(0, Math.round(stopoverMs / 60000));
        //       const ch = Math.floor(stopoverMinutes / 60);
        //       const cm = stopoverMinutes % 60;
        //       const stopoverText = `Stopover: ${ch}h ${cm}m`;
        //       const inboundHtml = renderRouteBlock(ret, `Return Flight ${idx + 1}`, stopoverText);
        //       resultsDiv.insertAdjacentHTML("beforeend", inboundHtml);
        //     });
        //   }
        // });
        const validRoundTripFlights = outboundFlights.filter(flight => flight.returnFlights && flight.returnFlights.length > 0);
        globalResults = validRoundTripFlights;
        suppressDisplay = false;
        displayRoundTripResultsAll(validRoundTripFlights);
      }
    } catch (error) {
      document.querySelector(".route-list").innerHTML = `<p>Error: ${error.message}</p>`;
      console.error("Search error:", error);
    } finally {
      if (globalResults.length === 0 && tripType === "oneway") {
        document.querySelector(".route-list").innerHTML = "<p>There are no available flights on this route.</p>";
      }
      hideProgress();
      searchButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg> Search Flights`
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
  
      // Показываем кнопку "+" только на последней строке,
      // если общее количество строк меньше 3 и поле заполнено.
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

  
  /** 
   * Returns the final arrival time of the entire round trip. 
   * If no inbound flights, use the outbound arrival date.
   */
  function getFinalArrivalTime(outbound) {
    if (outbound.returnFlights && outbound.returnFlights.length > 0) {
      // E.g. compare the last inbound flight's arrival date
      // or the earliest, depending on how you want to define "final arrival".
      const lastInbound = outbound.returnFlights[outbound.returnFlights.length - 1];
      return new Date(lastInbound.calculatedDuration.arrivalDate).getTime();
    } else {
      // No inbound flights; fall back to outbound arrival
      return new Date(outbound.calculatedDuration.arrivalDate).getTime();
    }
  }
  
  /**
   * Returns the total round trip duration in minutes, from outbound departure 
   * to final inbound arrival. If no inbound flights, fallback to outbound’s duration.
   */
  function getRoundTripTotalDuration(outbound) {
    const outboundDeparture = new Date(outbound.calculatedDuration.departureDate).getTime();
    const finalArrival = getFinalArrivalTime(outbound);
    // Subtract in minutes
    return Math.round((finalArrival - outboundDeparture) / 60000);
  }
  
  
//-------------------Rendeting results-----------------------------
function renderRouteBlock(unifiedFlight, label = "", extraInfo = "") {
  const isReturn = label && label.toLowerCase().includes("inbound flight");
  const isOutbound = label && label.toLowerCase().includes("outbound flight");
  const isDirectFlight = !unifiedFlight.segments || unifiedFlight.segments.length === 1; 
  const header = isOutbound && isDirectFlight || isDirectFlight ? "" :  `
    <div class="flex flex-col gap-2">
      <div class="flex justify-between items-center mb-1">
        <div class="text-xs font-semibold bg-gray-800 text-white px-2 py-1 mb-1 rounded">
          ${unifiedFlight.formattedFlightDate}
        </div>
        <div class="text-xs font-semibold bg-gray-800 text-white px-2 py-1 mb-1 rounded">
          Total duration: ${unifiedFlight.calculatedDuration.hours}h ${unifiedFlight.calculatedDuration.minutes}m
        </div>
      </div>
      <hr class="${ isOutbound ? "border-[#C90076] my-2" : "border-[#20006D] my-2"}">
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
    const monthNames = ["January", "February", "March", "April", "May", "June",
                        "July", "August", "September", "October", "November", "December"];
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
  
    // Handle Prev/Next navigation (Fix: stopPropagation)
    prevBtn.addEventListener("click", (event) => {
      event.stopPropagation(); // Prevent calendar from closing
      let newMonth = month - 1;
      let newYear = year;
      if (newMonth < 0) {
        newMonth = 11;
        newYear--;
      }
      renderCalendarMonth(popupEl, inputId, newYear, newMonth, maxDaysAhead, selectedDates, minSelectableDate);
    });
  
    nextBtn.addEventListener("click", (event) => {
      event.stopPropagation(); // Prevent calendar from closing
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
      if (i === 5 || i === 6) {
        dayEl.classList.add("text-[#C90076]", "font-semibold");
      } else {
        dayEl.classList.add("text-[#20006D]", "font-semibold");
      }
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
    const minDate = minSelectableDate ? parseLocalDate(minSelectableDate) : new Date(new Date().setHours(0, 0, 0, 0));
    const todayMidnight = new Date(new Date().setHours(0, 0, 0, 0));
    const lastBookable = new Date(todayMidnight.getTime() + maxDaysAhead * 24 * 60 * 60 * 1000);
  
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
  
      if (dayOfWeek === 5 || dayOfWeek === 6) {
        dateCell.classList.add("bg-pink-50");
      }
      dateCell.textContent = d;

      if (selectedDates.has(dateStr)) {
        dateCell.classList.add("bg-blue-300");
      }
  
      if (cellDate < minDate || cellDate > lastBookable) {
        dateCell.classList.add("bg-gray-200", "cursor-not-allowed", "text-gray-500");
      } else {
        dateCell.addEventListener("click", () => {
          if (selectedDates.has(dateStr)) {
            selectedDates.delete(dateStr);
            dateCell.classList.remove("bg-blue-300");
            // If it’s a weekend day, reapply the weekend style.
            if (dayOfWeek === 5 || dayOfWeek === 6) {
              dateCell.classList.add("bg-pink-50");
            }
          } else {
            selectedDates.add(dateStr);
            // Remove weekend style if present so the selection color shows.
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
      
      // 1) Parse input value into a Set of selected dates
      const rawValue = inputEl.value.trim();
      let selectedDates = new Set();
      if (rawValue) {
        rawValue.split(",").map(s => s.trim()).forEach(dateStr => {
          if (dateStr) selectedDates.add(dateStr);
        });
      }
  
      // 2) If there’s at least one selected date, jump calendar to that month
      if (selectedDates.size > 0) {
        const firstSelected = [...selectedDates][0];  // take the first date in the set
        const parsedDate = parseLocalDate(firstSelected);
        if (parsedDate.toString() !== "Invalid Date") {
          currentYear = parsedDate.getFullYear();
          currentMonth = parsedDate.getMonth();
        }
      }
  
      // 3) Render the calendar with the selectedDates
      renderCalendarMonth(
        popupEl,
        inputId,
        currentYear,
        currentMonth,
        maxDaysAhead,
        selectedDates
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
  
  // ---------------- Initialize on DOMContentLoaded ----------------
  
  document.addEventListener("DOMContentLoaded", () => {
    // === 1. Load settings from localStorage ===
    const storedPreferredAirport = localStorage.getItem("preferredAirport") || "";
    document.getElementById("preferred-airport").value = storedPreferredAirport;
    document.getElementById("min-connection-time").value = localStorage.getItem("minConnectionTime") || 90;
    document.getElementById("max-connection-time").value = localStorage.getItem("maxConnectionTime") || 360;
    document.getElementById("max-requests").value = localStorage.getItem("maxRequestsInRow") || 25;
    document.getElementById("requests-frequency").value = localStorage.getItem("requestsFrequencyMs") || 600;
    document.getElementById("pause-duration").value = localStorage.getItem("pauseDurationSeconds") || 15;
    document.getElementById("cache-lifetime").value = localStorage.getItem("cacheLifetimeHours") || 4;
  
    // Toggle Expert Settings inside Options Panel
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
    // === 2. Setup the multi-functional Update button ===
    const updateButton = document.getElementById("update-preferred-airport");
    updateButton.addEventListener("click", () => {
      const preferredAirport = document.getElementById("preferred-airport").value.trim();
      if (!preferredAirport) {
        showNotification("Please enter a valid airport. ⚠️");
        return;
      }
      // Save preferred airport in localStorage
      localStorage.setItem("preferredAirport", preferredAirport);
      // Instead of setting a value on the container, update the first input in the origin container:
      const originContainer = document.getElementById("origin-multi");
      const firstInput = originContainer.querySelector("input");
      if (firstInput) {
        firstInput.value = preferredAirport;
        updateAirportRows(originContainer);
      }
  
      // Save additional settings
      const minConn = document.getElementById("min-connection-time").value;
      localStorage.setItem("minConnectionTime", minConn);
      const maxConn = document.getElementById("max-connection-time").value;
      localStorage.setItem("maxConnectionTime", maxConn);
      const maxReq = document.getElementById("max-requests").value;
      localStorage.setItem("maxRequestsInRow", maxReq);
      const reqFreq = document.getElementById("requests-frequency").value;
      localStorage.setItem("requestsFrequencyMs", reqFreq);
      const pauseDur = document.getElementById("pause-duration").value;
      localStorage.setItem("pauseDurationSeconds", pauseDur);
      const cacheLife = document.getElementById("cache-lifetime").value;
      localStorage.setItem("cacheLifetimeHours", cacheLife);
  
      showNotification(`Settings updated successfully! ✅`);
    });
  
    // === 3. Setup autocomplete for inputs ===
    
    setupAutocomplete("preferred-airport", "airport-suggestions-preferred");
    initializeMultiAirportField("origin-multi", "origin");
      const originContainer = document.getElementById("origin-multi");
      const firstInput = originContainer.querySelector("input");
      if (firstInput) {
        firstInput.value = storedPreferredAirport;
      }
    initializeMultiAirportField("destination-multi", "destination");
  
    // === 4. Initialize calendars ===
    initMultiCalendar("departure-date", "departure-calendar-popup", 3);
    initMultiCalendar("return-date", "return-calendar-popup", 3);
  
    // === 5. Setup date input event handlers ===
    document.getElementById("departure-date").addEventListener("change", () => {
      const departureVal = document.getElementById("departure-date").value.trim();
      const returnInput = document.getElementById("return-date");
      if (departureVal) {
        returnInput.disabled = false;
        updateReturnCalendarMinDate(departureVal);
      } else {
        returnInput.disabled = true;
      }
    });
    document.getElementById("return-date").addEventListener("click", (e) => {
      const departureVal = document.getElementById("departure-date").value.trim();
      if (!departureVal) {
        e.preventDefault();
        alert("Please select a departure date first.");
      }
    });
    // Function for updating return calendar minimum date
    function updateReturnCalendarMinDate(departureDateStr) {
      const returnCalendarPopup = document.getElementById("return-calendar-popup");
      const minDate = parseLocalDate(departureDateStr);
      renderCalendarMonth(
        returnCalendarPopup,
        "return-date",
        minDate.getFullYear(),
        minDate.getMonth(),
        3,
        new Set(),
        departureDateStr
      );
    }
  
    // === 6. Setup other event handlers ===
    document.getElementById("search-button").addEventListener("click", handleSearch);
    document.getElementById("max-requests").addEventListener("change", updateThrottleSettings);
    document.getElementById("requests-frequency").addEventListener("change", updateThrottleSettings);
    document.getElementById("pause-duration").addEventListener("change", updateThrottleSettings);
    document.getElementById("cache-lifetime").addEventListener("change", updateCacheLifetimeSetting);
    document.getElementById("clear-cache-button").addEventListener("click", handleClearCache);
    document.getElementById("swap-button").addEventListener("click", swapInputs);
    document.getElementById("toggle-options").addEventListener("click", toggleOptions);
  
    // === 7. Options button styling ===
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
  
    // === 8. Trip type switching (oneway / return) ===
    // Set the initial trip type.
    window.currentTripType = "oneway";
  const tripTypeToggle = document.getElementById("trip-type-toggle");
  const tripTypeText = document.getElementById("trip-type-text");
  const returnDateContainer = document.getElementById("return-date-container");
  const removeReturnDateBtn = document.getElementById("remove-return-date");

  // Ensure initial state: one-way with the "Add Return Date" button visible and return date container hidden.
  tripTypeText.textContent = "Add Return Date";
  returnDateContainer.style.display = "none";
  tripTypeToggle.style.display = "block";

  // When the user clicks the "Add Return Date" button:
  tripTypeToggle.addEventListener("click", () => {
    if (window.currentTripType === "oneway") {
      window.currentTripType = "return";
      // Hide the "Add Return Date" button
      tripTypeToggle.style.display = "none";
      // Show the return date container
      returnDateContainer.style.display = "block";
      // Immediately open the Return Date calendar popup
      const returnCalendarPopup = document.getElementById("return-calendar-popup");
      returnCalendarPopup.classList.remove("hidden");
    }
  });

  // When the user clicks the remove (✕) button in the Return Date container:
  removeReturnDateBtn.addEventListener("click", () => {
    window.currentTripType = "oneway";
    // Hide the return date container
    returnDateContainer.style.display = "none";
    // Clear the return date input
    document.getElementById("return-date").value = "";
    // Hide the return calendar popup
    const returnCalendarPopup = document.getElementById("return-calendar-popup");
    returnCalendarPopup.classList.add("hidden");
    // Show the "Add Return Date" button again
    tripTypeToggle.style.display = "block";
  });


    // === 9. UI Scale change ===
    const scaleSlider = document.getElementById("ui-scale");
    document.body.style.zoom = scaleSlider.value / 100;
    scaleSlider.addEventListener("input", function() {
      document.body.style.zoom = this.value / 100;
    });
  
    // ---------------- Sorting Results Handler ----------------
  // document.getElementById("sort-select").addEventListener("change", function () {
  //   const sortOption = document.getElementById("sort-select").value;
  //   if (sortOption === "default") {
  //     globalResults.sort((a, b) => a.originalIndex - b.originalIndex);
  //   } else if (sortOption === "departure") {
  //     globalResults.sort((a, b) => {
  //       return new Date(a.calculatedDuration.departureDate).getTime() - new Date(b.calculatedDuration.departureDate).getTime();
  //     });
  //   } else if (sortOption === "airport") {
  //     globalResults.sort((a, b) => {
  //       let nameA = (airportNames[a.route[0]] || a.route[0]).toLowerCase();
  //       let nameB = (airportNames[b.route[0]] || b.route[0]).toLowerCase();
  //       return nameA.localeCompare(nameB);
  //     });
  //   } else if (sortOption === "arrival") {
  //     globalResults.sort((a, b) => {
  //       const getFinalArrivalTime = (flight) => {
  //         if (flight.returnFlights && flight.returnFlights.length > 0) {
  //           // For round-trip, use the final return flight segment's arrival time.
  //           return new Date(flight.returnFlights[flight.returnFlights.length - 1].calculatedDuration.arrivalDate).getTime();
  //         } else {
  //           return new Date(flight.calculatedDuration.arrivalDate).getTime();
  //         }
  //       };
  //       return getFinalArrivalTime(a) - getFinalArrivalTime(b);
  //     });
  //   } else if (sortOption === "duration") {
  //     globalResults.sort((a, b) => {
  //       const getDuration = (flight) => {
  //         if (flight.returnFlights && flight.returnFlights.length > 0) {
  //           // Overall duration from outbound departure to final inbound arrival.
  //           const outboundDeparture = new Date(flight.calculatedDuration.departureDate).getTime();
  //           const inboundArrival = new Date(flight.returnFlights[flight.returnFlights.length - 1].calculatedDuration.arrivalDate).getTime();
  //           return (inboundArrival - outboundDeparture) / 60000;
  //         } else {
  //           return flight.calculatedDuration.totalMinutes;
  //         }
  //       };
  //       return getDuration(a) - getDuration(b);
  //     });
  //   }
  //   const resultsDiv = document.querySelector(".route-list");
  //   resultsDiv.innerHTML = "";
  //   if (window.currentTripType === "return") {
  //     const filteredResults = globalResults.filter(flight => flight.returnFlights && flight.returnFlights.length > 0);
  //     const totalResultsEl = document.createElement("p");
  //     totalResultsEl.textContent = `Total results: ${filteredResults.length}`;
  //     totalResultsEl.className = "text-lg font-semibold text-[#20006D] mb-4";
  //     resultsDiv.appendChild(totalResultsEl);
  //     filteredResults.forEach(outbound => {
  //       rehydrateDates(outbound);
  //       const outboundHtml = renderRouteBlock(outbound, "Outbound Flight");
  //       resultsDiv.insertAdjacentHTML("beforeend", outboundHtml);
  //       outbound.returnFlights.forEach((ret, idx) => {
  //         rehydrateDates(ret);
  //         const outboundLastArrival = outbound.segments ? outbound.segments[outbound.segments.length - 1].arrivalDate : outbound.calculatedDuration.arrivalDate;
  //         const inboundFirstDeparture = ret.segments && ret.segments[0] ? ret.segments[0].departureDate : ret.calculatedDuration.departureDate;
  //         if (!outboundLastArrival || !inboundFirstDeparture ||
  //             isNaN(outboundLastArrival.getTime()) || isNaN(inboundFirstDeparture.getTime())) {
  //           return;
  //         }
  //         const stopoverMs = inboundFirstDeparture - outboundLastArrival;
  //         const stopoverMinutes = Math.max(0, Math.round(stopoverMs / 60000));
  //         const sh = Math.floor(stopoverMinutes / 60);
  //         const sm = stopoverMinutes % 60;
  //         const stopoverText = `Stopover: ${sh}h ${sm}m`;
  //         const inboundHtml = renderRouteBlock(ret, `Return Flight ${idx + 1}`, stopoverText);
  //         resultsDiv.insertAdjacentHTML("beforeend", inboundHtml);
  //       });
  //     });
  //   } else {
  //     displayGlobalResults(globalResults);
  //   }
  // });
});
  