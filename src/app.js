import {
    AIRPORTS,
    COUNTRY_AIRPORTS,
    EXCLUDED_ROUTES,
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
  let CACHE_LIFETIME = Number(localStorage.getItem('cacheLifetime')) || (4 * 60 * 60 * 1000); // 4 hours in ms
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
  async function throttleRequest() {
    if (requestsThisWindow >= MAX_REQUESTS_IN_ROW) {
      if (debug) console.log(`Reached ${MAX_REQUESTS_IN_ROW} consecutive requests; pausing for ${PAUSE_DURATION_MS}ms`);
      showTimeoutCountdown(PAUSE_DURATION_MS);
      await new Promise(resolve => setTimeout(resolve, PAUSE_DURATION_MS));
      requestsThisWindow = 0;
    }
    requestsThisWindow++;
    await new Promise(resolve => setTimeout(resolve, REQUESTS_FREQUENCY_MS));
  }
  function getLocalDateFromOffset(date, offsetText) {
    const offsetMatch = offsetText.match(/UTC([+-]\d+)/);
    const offsetHours = offsetMatch ? parseInt(offsetMatch[1], 10) : 0;
    const localDate = new Date(date.getTime() + offsetHours * 3600000);
    const yyyy = localDate.getFullYear();
    const mm = String(localDate.getMonth() + 1).padStart(2, '0');
    const dd = String(localDate.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  function loadSettings() {
    const requestsFrequency = localStorage.getItem("requestsFrequencyMs");
    const pauseDuration = localStorage.getItem("pauseDurationSeconds");
    if (requestsFrequency) {
      REQUESTS_FREQUENCY_MS = parseInt(requestsFrequency, 10);
      document.getElementById("requests-frequency").value = REQUESTS_FREQUENCY_MS;
    }
    if (pauseDuration) {
      PAUSE_DURATION_MS = parseInt(pauseDuration, 10) * 1000;
      document.getElementById("pause-duration").value = pauseDuration;
    }
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
  
    inputEl.addEventListener("input", function(e) {
      const query = e.target.value.trim().toLowerCase();

      if (query === "any") {
        suggestionsEl.innerHTML = "";
        const div = document.createElement("div");
        div.className = "px-4 py-2 cursor-pointer hover:bg-gray-100 flex justify-between items-center";
        div.textContent = "ANY";
        div.addEventListener("click", function() {
          inputEl.value = "ANY";
          suggestionsEl.classList.add("hidden");
        });
        suggestionsEl.appendChild(div);
        suggestionsEl.classList.remove("hidden");
        return;
      }

      if (!query) {
        suggestionsEl.classList.add("hidden");
        suggestionsEl.innerHTML = "";
        return;
      }
  
      // 1) Find matches
      const countryMatches = Object.keys(COUNTRY_AIRPORTS)
        .filter(country => country.toLowerCase().includes(query))
        .map(country => ({ isCountry: true, code: country, name: country }));
  
      const airportMatches = AIRPORTS.filter(a =>
        a.code.toLowerCase().includes(query) ||
        a.name.toLowerCase().includes(query)
      ).map(a => ({ isCountry: false, code: a.code, name: a.name }));
  
      const matches = [...countryMatches, ...airportMatches];
      if (matches.length === 0) {
        suggestionsEl.classList.add("hidden");
        suggestionsEl.innerHTML = "";
        return;
      }
  
      // 2) Build suggestion list
      suggestionsEl.innerHTML = "";
      matches.forEach(match => {
        const div = document.createElement("div");
        div.className = "px-4 py-2 cursor-pointer hover:bg-gray-100 flex justify-between items-center";
  
        // Avoid double code: if name already has (CODE), skip adding again
        let suggestionText;
        if (match.isCountry) {
          suggestionText = match.name;
        } else {
          const codeRegex = new RegExp(`\\(${match.code}\\)$`);
          if (codeRegex.test(match.name)) {
            // If name is already something like "London Luton (LTN)"
            suggestionText = match.name;
          } else {
            suggestionText = `${match.name} (${match.code})`;
          }
        }
  
        div.textContent = suggestionText;
  
        div.addEventListener("click", function() {
          // Insert only the code if not a country; else the country name
          inputEl.value = match.isCountry ? match.name : match.code;
          suggestionsEl.classList.add("hidden");
        });
  
        suggestionsEl.appendChild(div);
      });
  
      // 3) Show dropdown
      suggestionsEl.classList.remove("hidden");
      // (Optional) position or styling logic here...
    });
  
    // Hide suggestions if clicking outside
    document.addEventListener("click", function(event) {
      if (!inputEl.contains(event.target) && !suggestionsEl.contains(event.target)) {
        suggestionsEl.classList.add("hidden");
      }
    });
  }
  function resolveAirport(input) {
    if (!input) return [];
    const trimmed = input.trim();
    if (trimmed.toLowerCase() === "any") {
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
  function parseServerDate(dateStr) {
    if (!dateStr) return null;
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
  function parse12HourTime(timeStr) {
    const regex = /(\d{1,2}):(\d{2})\s*(am|pm)/i;
    const match = timeStr.match(regex);
    if (!match) {
      if (debug) console.warn("parse12HourTime: cannot parse time string", timeStr);
      return null;
    }
    let hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    const period = match[3].toLowerCase();
    if (period === "pm" && hour !== 12) hour += 12;
    if (period === "am" && hour === 12) hour = 0;
    return { hour, minute };
  }
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
  function parseTimeWithOffset(timeStr, offsetStr, baseDateStr) {
    // Default to "UTC" if no offset is provided
    if (!offsetStr) {
      offsetStr = "UTC";
    }
    const normalizedOffset = normalizeOffset(offsetStr);
    if (debug) console.log(`Parsing time "${timeStr}" with offset "${offsetStr}" normalized to "${normalizedOffset}" for base date ${baseDateStr}`);
    const timeParts = parse12HourTime(timeStr);
    if (!timeParts) {
      if (debug) console.warn("parse12HourTime: cannot parse time string", timeStr);
      return null;
    }
    let isoString = `${baseDateStr}T${String(timeParts.hour).padStart(2, '0')}:${String(timeParts.minute).padStart(2, '0')}:00`;
    isoString += normalizedOffset;
    const d = new Date(isoString);
    if (isNaN(d.getTime())) {
      if (debug) console.error(`Invalid Date created from ISO string: "${isoString}"`);
      return null;
    }
    if (debug) console.log(`Resulting Date: ${d.toISOString()}`);
    return d;
  }  
  function calculateFlightDuration(departureTimeStr, departureOffset, arrivalTimeStr, arrivalOffset, baseDateStr, nextDay = false) {
    let departureDate = parseTimeWithOffset(departureTimeStr, departureOffset, baseDateStr);
    let arrivalDate = parseTimeWithOffset(arrivalTimeStr, arrivalOffset, baseDateStr);
    if (!departureDate || !arrivalDate) {
      if (debug) console.warn("calculateFlightDuration: invalid departure or arrival date", departureTimeStr, arrivalTimeStr);
      return { hours: 0, minutes: 0, totalMinutes: 0, departureDate: null, arrivalDate: null };
    }
    if (nextDay || arrivalDate <= departureDate) {
      arrivalDate = new Date(arrivalDate.getTime() + 24 * 60 * 60 * 1000);
    }
    const diffMs = arrivalDate - departureDate;
    const diffMinutes = Math.round(diffMs / 60000);
    const hours = Math.floor(diffMinutes / 60);
    const minutes = diffMinutes % 60;
    if (debug) console.log(`Calculated duration for ${departureTimeStr} → ${arrivalTimeStr}: ${hours}h ${minutes}m (Total ${diffMinutes} minutes)`);
    return { hours, minutes, totalMinutes: diffMinutes, departureDate, arrivalDate };
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
  function getCandidateCache(candidateKey) {
    const cached = localStorage.getItem("candidate_" + candidateKey);
    if (cached) {
      const { result, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < CACHE_LIFETIME) {
        return result;
      } else {
        localStorage.removeItem("candidate_" + candidateKey);
      }
    }
    return null;
  }
  function setCandidateCache(candidateKey, result) {
    const cacheData = { result, timestamp: Date.now() };
    localStorage.setItem("candidate_" + candidateKey, JSON.stringify(cacheData));
  }
  function setCachedResults(key, results) {
    const cacheData = { results: results, timestamp: Date.now() };
    localStorage.setItem(key, JSON.stringify(cacheData));
  }
  function getCachedResults(key) {
    const cachedData = localStorage.getItem(key);
    if (cachedData) {
      const { results, timestamp } = JSON.parse(cachedData);
      if (Date.now() - timestamp < CACHE_LIFETIME) {
        return results;
      } else {
        clearCache(key);
      }
    }
    return null;
  }
  function clearCache(key) {
    localStorage.removeItem(key);
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
        let headers = { 'Content-Type': 'application/json' };
        if (pageData.headers && Date.now() - pageData.timestamp < 60 * 60 * 1000) {
          if (debug) console.log("Using cached headers");
          headers = { ...headers, ...pageData.headers };
        } else {
          // Attempt to fetch headers from page
          chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            const currentTab = tabs[0];
            chrome.tabs.sendMessage(currentTab.id, { action: "getHeaders" }, function(response) {
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
          throw new Error(`HTTP error: ${fetchResponse.status}`);
        }
        
        // Check if response looks like JSON (by checking the content-type header)
        const contentType = fetchResponse.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          // Alternatively, you can check the text content
          const text = await fetchResponse.text();
          if (text.trim().startsWith("<!DOCTYPE")) {
            if (debug) console.warn("Dynamic URL returned HTML. Clearing cache and retrying.");
            localStorage.removeItem("wizz_page_data");
            throw new Error("Invalid response format: expected JSON but received HTML");
          }
        }
        
        // If we passed the above check, parse as JSON.
        const responseData = await fetchResponse.json();
        if (debug) console.log(`Response for segment ${origin} → ${destination}:`, responseData);
        return responseData.flightsOutbound || [];
      } catch (error) {
        if (error.message.includes("429") || error.message.includes("426") || error.message.includes("Invalid response format")) {
          const waitTime = error.message.includes("426") ? 60000 : 40000;
          if (debug) console.warn(`Rate limit or invalid dynamic URL encountered for segment ${origin} → ${destination} – waiting for ${waitTime / 1000} seconds`);
          showTimeoutCountdown(waitTime);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          windowStartTime = Date.now();
          requestsThisWindow = 0;
        } else {
          throw error;
        }
        attempts++;
      }
    }
    throw new Error("Max retry attempts reached for segment " + origin + " → " + destination);
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
  function findRoutesDFS(graph, current, destinationList, path, maxTransfers, routes) {
    if (path.length - 1 > maxTransfers + 1) return;
    if (destinationList.includes(current) && path.length > 1) {
      routes.push([...path]);
    }
    if (!graph[current]) return;
    for (const next of graph[current]) {
      if (!path.includes(next)) {
        path.push(next);
        findRoutesDFS(graph, next, destinationList, path, maxTransfers, routes);
        path.pop();
      }
    }
  }
  function validateConnection(prevSegment, nextSegment) {
    const connectionTime = (nextSegment.departureDate - prevSegment.arrivalDate) / 60000;
    return connectionTime >= MIN_CONNECTION_MINUTES;
  }
  // ---------------- Global Results Display Functions ----------------
  function appendRouteToDisplay(routeObj) {
    if (!routeObj.route || !Array.isArray(routeObj.route) || routeObj.route.length < 2) {
      if (routeObj.departureStationText && routeObj.arrivalStationText) {
        routeObj.route = [routeObj.departureStationText, routeObj.arrivalStationText];
      } else {
        if (debug) console.warn("Skipping routeObj because route is missing or incomplete:", routeObj);
        return;
      }
    }
    if (!routeObj.segments) {
      routeObj.segments = [{
        origin: routeObj.route[0],
        destination: routeObj.route[1],
        flightCode: routeObj.flightCode || "",
        departure: routeObj.departure || "",
        arrival: routeObj.arrival || "",
        departureOffset: routeObj.departureOffset || "",
        arrivalOffset: routeObj.arrivalOffset || "",
        calculatedDuration: routeObj.calculatedDuration || { hours: 0, minutes: 0 },
        departureDate: routeObj.firstDeparture || null,
        arrivalDate: routeObj.firstDeparture ? new Date(routeObj.firstDeparture.getTime() + routeObj.totalDuration * 60000) : null
      }];
    }
    rehydrateDates(routeObj);
    globalResults.push(routeObj);
    if (!suppressDisplay) {
      displayGlobalResults(globalResults);
    }
  }

  function displayGlobalResults(results) {
    const resultsDiv = document.querySelector(".route-list");
    resultsDiv.innerHTML = "";

    const totalResultsEl = document.createElement("p");
    totalResultsEl.textContent = `Total results: ${results.length}`;
    totalResultsEl.className = "text-lg font-semibold text-[#20006D] mb-4";
    resultsDiv.appendChild(totalResultsEl);

    results.forEach(routeObj => {
      // Each route is a separate block
      const routeHtml = renderRouteBlock(routeObj);
      resultsDiv.insertAdjacentHTML("beforeend", routeHtml);
    });
  }

  function displayRoundTripResults(outbound) {
    const resultsDiv = document.querySelector(".route-list");
    resultsDiv.innerHTML = "";
  
    // Render the outbound flight (normal appearance)
    const outboundHtml = renderRouteBlock(outbound, "Outbound Flight");
    resultsDiv.insertAdjacentHTML("beforeend", outboundHtml);
  
    // Render each return flight
    if (outbound.returnFlights && outbound.returnFlights.length > 0) {
      outbound.returnFlights.forEach((ret, idx) => {
        // Compute stopover duration: difference between inbound's first departure and outbound's final arrival
        const outboundLastArrival = outbound.segments[outbound.segments.length - 1].arrivalDate;
        const inboundFirstDeparture = ret.segments[0].departureDate;
        const stopoverMs = inboundFirstDeparture - outboundLastArrival;
        const stopoverMinutes = Math.round(stopoverMs / 60000);
        const sh = Math.floor(stopoverMinutes / 60);
        const sm = stopoverMinutes % 60;
        const stopoverText = `Stopover: ${sh}h ${sm}m`;
  
        // Render the inbound flight block with a label and extra info showing the stopover
        const inboundHtml = renderRouteBlock(ret, `Return Flight ${idx + 1}`, stopoverText);
        resultsDiv.insertAdjacentHTML("beforeend", inboundHtml);
      });
    } else {
      if (debug) console.warn("No return flights found for this outbound route.");
    }
  }
  
  function formatDurationDetailed(totalMinutes) {
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;
    let result = "";
    if (days > 0) result += days + "d ";
    if (hours > 0) result += hours + "h ";
    result += minutes + "m";
    return result;
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
  // Updated searchConnectingRoutes function
  async function searchConnectingRoutes(origins, destinations, selectedDate, maxTransfers) {
    const routesData = await fetchDestinations();
    const today = new Date();
    const maxBookingDate = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
    const selectedDateObj = new Date(selectedDate);
  
    if (origins.length === 1 && origins[0] === "ANY") {
      origins = [...new Set(routesData.map(route => {
        return typeof route.departureStation === "object" ? route.departureStation.id : route.departureStation;
      }))];
      if (debug) console.log("Replaced origins 'ANY' with:", origins);
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
    if (debug) console.log("Candidate routes:", candidateRoutes);
    const totalCandidates = candidateRoutes.length;
    let processedCandidates = 0;
    updateProgress(processedCandidates, totalCandidates, "Processing routes");
  
    for (const candidate of candidateRoutes) {
      if (searchCancelled) break;
      const candidateKey = candidate.join("-") + "-" + selectedDate + "-connect";
  
      // Exclude candidate if any segment is excluded.
      let candidateExcluded = false;
      for (let i = 0; i < candidate.length - 1; i++) {
        const segOrigin = candidate[i];
        const segDestination = candidate[i + 1];
        if (isExcludedRoute(segOrigin, segDestination)) {
          if (debug)
            console.log(`Excluding candidate route ${candidate.join(" → ")} because segment ${segOrigin} → ${segDestination} is excluded`);
          candidateExcluded = true;
          break;
        }
      }
      if (candidateExcluded) {
        processedCandidates++;
        updateProgress(processedCandidates, totalCandidates, `Excluded candidate: ${candidate.join(" → ")}`);
        continue;
      }
  
      const cachedCandidate = getCandidateCache(candidateKey);
      if (cachedCandidate) {
        if (debug) console.log("Using cached candidate:", candidateKey);
        appendRouteToDisplay(cachedCandidate);
        processedCandidates++;
        updateProgress(processedCandidates, totalCandidates, `Processed candidate: ${candidate.join(" → ")}`);
        continue;
      }
      let validCandidate = true;
      let segmentsInfo = [];
      let previousSegment = null;
      let currentSegmentDate = selectedDate;
  
      for (let i = 0; i < candidate.length - 1; i++) {
        if (searchCancelled) break;
        const segOrigin = candidate[i];
        const segDestination = candidate[i + 1];
        if (debug) console.log(`Checking segment ${segOrigin} → ${segDestination} for route ${candidate.join(" → ")}`);
  
        const segmentCacheKey = `${segOrigin}-${segDestination}-${currentSegmentDate}`;
        let flights = getCachedResults(segmentCacheKey);
        if (!flights) {
          try {
            flights = await checkRouteSegment(segOrigin, segDestination, currentSegmentDate);
            setCachedResults(segmentCacheKey, flights);
          } catch (error) {
            if (debug) console.error(`Error checking segment ${segOrigin} → ${segDestination}: ${error.message}`);
            validCandidate = false;
            break;
          }
        }
  
        if (previousSegment) {
          const prevArrivalTime = previousSegment.arrivalDate.getTime();
          flights = flights.filter(flight => {
            let baseDateStr = flight.departureDate ? getLocalDateString(parseServerDate(flight.departureDate)) : currentSegmentDate;
            const depDate = parseTimeWithOffset(flight.departure, flight.departureOffsetText || "", baseDateStr);
            return depDate && depDate.getTime() >= prevArrivalTime;
          });
          let attempts = 0;
          const maxAttempts = 5;
          while (flights.length === 0 && attempts < maxAttempts) {
            const nextDay = new Date(new Date(currentSegmentDate).getTime() + 24 * 60 * 60 * 1000);
            if (nextDay > maxBookingDate) {
              if (debug)
                console.warn(`Current segment date ${nextDay.toISOString().split("T")[0]} exceeds max allowed ${getLocalDateString(maxBookingDate)}`);
              break;
            }
            currentSegmentDate = nextDay.toISOString().split("T")[0];
            if (debug)
              console.log(`No valid flight found on base date. Trying next day (${currentSegmentDate}) for segment ${segOrigin} → ${segDestination}.`);
            flights = await checkRouteSegment(segOrigin, segDestination, currentSegmentDate);
            setCachedResults(`${segOrigin}-${segDestination}-${currentSegmentDate}`, flights);
            flights = flights.filter(flight => {
              let baseDateStr = flight.departureDate ? getLocalDateString(parseServerDate(flight.departureDate)) : currentSegmentDate;
              const depDate = parseTimeWithOffset(flight.departure, flight.departureOffsetText || "", baseDateStr);
              return depDate && depDate.getTime() >= previousSegment.arrivalDate.getTime();
            });
            attempts++;
          }
        }
  
        let chosenFlight = null;
        for (const flightCandidate of flights) {
          let baseDepDateStr = flightCandidate.departureDate ? getLocalDateString(parseServerDate(flightCandidate.departureDate)) : currentSegmentDate;
          let candidateDepDate = parseTimeWithOffset(flightCandidate.departure, flightCandidate.departureOffsetText || "", baseDepDateStr);
          if (!previousSegment || (candidateDepDate.getTime() - previousSegment.arrivalDate.getTime() >= MIN_CONNECTION_MINUTES * 60000)) {
            chosenFlight = flightCandidate;
            break;
          }
        }
        if (!chosenFlight) {
          let attempts = 0;
          const maxAttempts = 5;
          while (!chosenFlight && attempts < maxAttempts) {
            const nextDay = new Date(new Date(currentSegmentDate).getTime() + 24 * 60 * 60 * 1000);
            if (nextDay > maxBookingDate) break;
            currentSegmentDate = nextDay.toISOString().split("T")[0];
            if (debug)
              console.log(`No flight with sufficient connection time found. Trying next day (${currentSegmentDate}) for segment ${segOrigin} → ${segDestination}.`);
            flights = await checkRouteSegment(segOrigin, segDestination, currentSegmentDate);
            setCachedResults(`${segOrigin}-${segDestination}-${currentSegmentDate}`, flights);
            if (previousSegment) {
              flights = flights.filter(flight => {
                let baseDepDateStr = flight.departureDate ? getLocalDateString(parseServerDate(flight.departureDate)) : currentSegmentDate;
                const depDate = parseTimeWithOffset(flight.departure, flight.departureOffsetText || "", baseDepDateStr);
                return depDate && depDate.getTime() - previousSegment.arrivalDate.getTime() >= MIN_CONNECTION_MINUTES * 60000;
              });
            }
            for (const flightCandidate of flights) {
              let baseDepDateStr = flightCandidate.departureDate ? getLocalDateString(parseServerDate(flightCandidate.departureDate)) : currentSegmentDate;
              let candidateDepDate = parseTimeWithOffset(flightCandidate.departure, flightCandidate.departureOffsetText || "", baseDepDateStr);
              if (!previousSegment || (candidateDepDate.getTime() - previousSegment.arrivalDate.getTime() >= MIN_CONNECTION_MINUTES * 60000)) {
                chosenFlight = flightCandidate;
                break;
              }
            }
            attempts++;
          }
        }
        if (!chosenFlight) {
          if (debug)
            console.warn(`No available flights with sufficient connection time for segment ${segOrigin} → ${segDestination}`);
          validCandidate = false;
          setCachedResults(candidateKey, []);
          break;
        }
  
        const flight = chosenFlight;
        if (debug) console.log("flight", flight);
        
        let flightDepDate;
        if (flight.departure && flight.departureOffsetText) {
          let baseDepDateStr = flight.departureDate ? getLocalDateString(parseServerDate(flight.departureDate)) : currentSegmentDate;
          flightDepDate = parseTimeWithOffset(flight.departure, flight.departureOffsetText || "", baseDepDateStr);
        } else {
          flightDepDate = flight.departureDate ? new Date(flight.departureDate) : null;
        }
        let flightArrDate;
        if (flight.arrival && flight.arrivalOffsetText) {
          let baseArrDateStr = flight.arrivalDate ? getLocalDateString(parseServerDate(flight.arrivalDate)) : currentSegmentDate;
          flightArrDate = parseTimeWithOffset(flight.arrival, flight.arrivalOffsetText || "", baseArrDateStr);
        } else {
          flightArrDate = flight.arrivalDate ? new Date(flight.arrival) : null;
        }
  
        if (previousSegment && flightDepDate < previousSegment.arrivalDate) {
          if (debug)
            console.log(`Flight ${flight.flightCode} departs before previous arrival. Adjusting departure/arrival by 24 hours.`);
          flightDepDate = new Date(flightDepDate.getTime() + 24 * 60 * 60 * 1000);
          flightArrDate = new Date(flightArrDate.getTime() + 24 * 60 * 60 * 1000);
        }
  
        const calculatedDuration = {
          hours: Math.floor((flightArrDate - flightDepDate) / 3600000),
          minutes: Math.round(((flightArrDate - flightDepDate) % 3600000) / 60000),
          totalMinutes: Math.round((flightArrDate - flightDepDate) / 60000),
          departureDate: flightDepDate,
          arrivalDate: flightArrDate
        };
  
        if (!calculatedDuration.departureDate || !calculatedDuration.arrivalDate) {
          if (debug)
            console.warn(`Unable to calculate duration for segment ${segOrigin} → ${segDestination}`);
          validCandidate = false;
          break;
        }
  
        const segmentInfo = {
          origin: segOrigin,
          destination: segDestination,
          flightCode: flight.flightCode,
          originalDeparture: flight.departure,
          originalArrival: flight.arrival,
          departureOffset: flight.departureOffsetText || "",
          arrivalOffset: flight.arrivalOffsetText || "",
          calculatedDuration: calculatedDuration,
          departureDate: calculatedDuration.departureDate,
          arrivalDate: calculatedDuration.arrivalDate
        };
  
        if (previousSegment && !validateConnection(previousSegment, segmentInfo)) {
          if (debug)
            console.warn(`Insufficient connection time between ${previousSegment.origin} → ${previousSegment.destination} and ${segmentInfo.origin} → ${segmentInfo.destination}`);
          validCandidate = false;
          break;
        }
  
        segmentsInfo.push(segmentInfo);
        previousSegment = segmentInfo;
        currentSegmentDate = getLocalDateFromOffset(segmentInfo.arrivalDate, segmentInfo.arrivalOffset);
      }
      processedCandidates++;
      updateProgress(processedCandidates, totalCandidates, `Processed candidate: ${candidate.join(" → ")}`);
      if (validCandidate && segmentsInfo.length === candidate.length - 1) {
        const firstDeparture = segmentsInfo[0].departureDate;
        const lastArrival = segmentsInfo[segmentsInfo.length - 1].arrivalDate;
        const totalDurationMinutes = Math.round((lastArrival - firstDeparture) / 60000);
        let totalConnectionTime = 0;
        for (let i = 0; i < segmentsInfo.length - 1; i++) {
          const connectionTime = Math.round((segmentsInfo[i + 1].departureDate - segmentsInfo[i].arrivalDate) / 60000);
          totalConnectionTime += connectionTime;
        }
        const routeObj = {
          route: candidate,
          segments: segmentsInfo,
          firstDeparture: firstDeparture,
          totalDuration: totalDurationMinutes,
          totalConnectionTime: totalConnectionTime,
          date: selectedDate
        };
        routeObj.totalTripDuration = formatDurationDetailed(totalDurationMinutes);
        appendRouteToDisplay(routeObj);
        setCandidateCache(candidateKey, routeObj);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return globalResults;
  }

  async function searchDirectRoutes(origins, destinations, selectedDate) {
    if (debug) console.log("searchDirectRoutes called with origins:", origins, "destinations:", destinations, "selectedDate:", selectedDate);
    const routesData = await fetchDestinations();
    if (debug) console.log("Fetched routesData:", routesData);
    
    if (origins.length === 1 && origins[0] === "ANY" && !(destinations.length === 1 && destinations[0] === "ANY")) {
      const destSet = new Set(destinations);
      const filteredOrigins = routesData
        .filter(route => route.arrivalStations && route.arrivalStations.some(arr => {
          const arrCode = typeof arr === "object" ? arr.id : arr;
          return destSet.has(arrCode);
        }))
        .map(route => typeof route.departureStation === "object" ? route.departureStation.id : route.departureStation);
      origins = [...new Set(filteredOrigins)];
      if (debug) console.log(`Filtered ANY origins to only those with direct routes to [${[...destSet].join(", ")}]:`, origins);
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
      
      if (!routeData) {
        routeData = routesData.find(route => {
          if (typeof route.departureStation === "object" && route.departureStation.name) {
            return route.departureStation.name.toLowerCase().includes(origin.toLowerCase());
          }
          return false;
        });
      }
      
      if (!routeData) {
        if (debug) console.warn(`No data for departure airport: ${origin}`);
        continue;
      }
      
      if (debug) console.log(`Route data for origin ${origin}:`, routeData);
      const totalArrivals = routeData.arrivalStations.length;
      let processed = 0;
      updateProgress(processed, totalArrivals, `Checking direct flights for ${origin}`);
      
      const matchingArrivals = (destinations.length === 1 && destinations[0] === "ANY")
        ? routeData.arrivalStations
        : routeData.arrivalStations.filter(arr => {
            const arrCode = typeof arr === "object" ? arr.id : arr;
            return destinations.includes(arrCode);
          });
      
      for (const arrival of matchingArrivals) {
        if (searchCancelled) break;
        let arrivalCode = arrival.id || arrival;
        
        if (isExcludedRoute(origin, arrivalCode)) {
          if (debug) console.log(`Skipping excluded route ${origin} → ${arrivalCode}`);
          processed++;
          updateProgress(processed, totalArrivals, `Checked direct flights for ${origin} → ${arrivalCode}`);
          continue;
        }
        
        if (debug) console.log(`Processing direct flights from ${origin} to ${arrivalCode}`);
        const cacheKey = origin + "-" + arrivalCode + "-" + selectedDate + "-direct";
        let cachedDirect = getCachedResults(cacheKey);
        if (cachedDirect) {
          if (debug) console.log(`Found cached result for ${cacheKey}`);
          if (Array.isArray(cachedDirect)) {
            cachedDirect.forEach(routeObj => {
              appendRouteToDisplay(routeObj);
            });
            validDirectFlights = validDirectFlights.concat(cachedDirect);
          } else {
            appendRouteToDisplay(cachedDirect);
            validDirectFlights.push(cachedDirect);
          }
          processed++;
          updateProgress(processed, totalArrivals, `Checked direct flights for ${origin} → ${arrivalCode}`);
          continue;
        }
        
        try {
          const flights = await checkRouteSegment(origin, arrivalCode, selectedDate);
          if (debug) console.log(`Received flights for ${origin} → ${arrivalCode}:`, flights);
          if (flights.length > 0) {
            const firstFlightDate = new Date(flights[0].departureDate);
            const flightLocalDate = getLocalDateFromOffset(firstFlightDate, flights[0].departureOffsetText || "");  
            if (debug) console.log(`First flight for ${origin} → ${arrivalCode} departs at:`, firstFlightDate, "local date:", flightLocalDate);
            if (flightLocalDate !== selectedDate && !document.getElementById("overnight-checkbox").checked) {
              if (debug) console.warn(`Direct flight from ${origin} → ${arrivalCode} departs on ${flightLocalDate} (expected ${selectedDate}). Skipping.`);
              processed++;
              updateProgress(processed, totalArrivals, `Checked direct flights for ${origin} → ${arrivalCode}`);
              continue;
            }
    
            let directFlightsForArrival = [];
            flights.forEach(flight => {
              const calculatedDuration = calculateFlightDuration(
                flight.departure,
                flight.departureOffsetText || "",
                flight.arrival,
                flight.arrivalOffsetText || "",
                selectedDate,
                false
              );
              if (debug) console.log(`Calculated duration for flight ${flight.flightCode}:`, calculatedDuration);
              if (!calculatedDuration || !calculatedDuration.departureDate) {
                if (debug) console.warn(`Skipping flight ${flight.flightCode} due to invalid duration.`);
                return;
              }
              const directFlight = {
                route: [origin, String(arrivalCode)],
                flightCode: flight.flightCode,
                departure: flight.departure,
                arrival: flight.arrival,
                departureOffset: flight.departureOffsetText || "",
                arrivalOffset: flight.arrivalOffsetText || "",
                calculatedDuration: calculatedDuration,
                date: selectedDate,
                firstDeparture: calculatedDuration.departureDate,
                totalDuration: calculatedDuration.totalMinutes,
                totalConnectionTime: 0,
                departureStationText: (routeData.departureStation.departureStationText || routeData.departureStation.name || origin),
                arrivalStationText: (arrival.arrivalStationText || arrival.name || arrivalCode)
              };
              directFlight.segments = [{
                origin: origin,
                destination: String(arrivalCode),
                flightCode: flight.flightCode,
                departure: flight.departure,
                arrival: flight.arrival,
                departureOffset: flight.departureOffsetText || "",
                arrivalOffset: flight.arrivalOffsetText || "",
                calculatedDuration: calculatedDuration,
                departureDate: calculatedDuration.departureDate,
                arrivalDate: calculatedDuration.arrivalDate
              }];
              appendRouteToDisplay(directFlight);
              directFlightsForArrival.push(directFlight);
            });
            if (directFlightsForArrival.length > 0) {
              setCachedResults(cacheKey, directFlightsForArrival);
              validDirectFlights = validDirectFlights.concat(directFlightsForArrival);
            }
          } else {
            if (debug) console.warn(`No flights found for ${origin} → ${arrivalCode}`);
            setCachedResults(cacheKey, []);
          }
        } catch (error) {
          if (debug) console.error(`Error checking direct flight ${origin} → ${arrivalCode}: ${error.message}`);
        }      
        
        processed++;
        updateProgress(processed, totalArrivals, `Checked direct flights for ${origin} → ${arrivalCode}`);
      }
    }
    
    if (debug) console.log("Valid direct flights found:", validDirectFlights);
    return validDirectFlights;
  }
  function getReturnAirports(departureAirport, originalInput) {
    // If the original input is provided and is not a 3-letter code, assume it’s a city name.
    if (originalInput && originalInput.length !== 3) {
      // Look for a match in the COUNTRY_AIRPORTS dictionary (case-insensitive)
      for (const country in COUNTRY_AIRPORTS) {
        if (country.toLowerCase() === originalInput.toLowerCase()) {
          return COUNTRY_AIRPORTS[country];
        }
      }
    }
    // Otherwise, if the user entered a code (like "LTN"), return only that code.
    return [departureAirport];
  }
  // ---------------- Main Search Handler ----------------
  async function handleSearch() {
    const departureInputRaw = document.getElementById("departure-date").value.trim();
    const searchButton = document.getElementById("search-button");
  
    if (searchButton.textContent === "Stop Search") {
      searchCancelled = true;
      searchButton.innerHTML = 
      `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg> Search Flights`;
      return;
    }
  
    searchCancelled = false;
    searchButton.textContent = "Stop Search";
  
    // For round-trip, read the return date from input
    let returnInputRaw = "";
    if (window.currentTripType === "return") {
      returnInputRaw = document.getElementById("return-date").value.trim();
      if (!returnInputRaw) {
        alert("Please select a return date for round-trip search.");
        searchButton.innerHTML = " Search Flights";
        return;
      }
    }
  
    const originInputRaw = document.getElementById("origin-input").value.trim();
    window.originalOriginInput = originInputRaw;
    const destinationInputRaw = document.getElementById("destination-input").value.trim();
  
    if (!originInputRaw) {
      alert("Please enter at least one departure airport.");
      searchButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg> Search Flights`;
      return;
    }
  
    const tripType = window.currentTripType || "oneway";
  
    // ---- FIX: Split the departure input into individual dates ----
    let departureDates = [];
    if (departureInputRaw === "ALL") {
      const today = new Date();
      for (let i = 0; i <= 3; i++) {
        const d = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        departureDates.push(`${yyyy}-${mm}-${dd}`);
      }
    } else {
      departureDates = departureInputRaw.split(',')
                            .map(d => d.trim())
                            .filter(d => d !== "");
    }
    
    // Resolve airport inputs
    let origins = originInputRaw.split(",").map(s => resolveAirport(s)).flat();
    let destinations = (!destinationInputRaw || destinationInputRaw.toUpperCase() === "ANY")
                        ? ["ANY"]
                        : destinationInputRaw.split(",").map(s => resolveAirport(s)).flat();
  
    // Clear old results
    document.querySelector(".route-list").innerHTML = "";
    globalResults = [];
    updateProgress(0, 1, "Initializing search");
  
    try {
      if (tripType === "oneway") {
        // One-way: iterate over each departure date
        for (const dateStr of departureDates) {
          if (searchCancelled) break;
          if (debug) console.log(`Searching for flights on ${dateStr}`);
          const maxTransfers = document.getElementById("two-transfer-checkbox").checked
            ? 2
            : (document.getElementById("transfer-checkbox").checked ? 1 : 0);
          if (maxTransfers > 0) {
            await searchConnectingRoutes(origins, destinations, dateStr, maxTransfers);
          } else {
            await searchDirectRoutes(origins, destinations, dateStr);
          }
        }
      } else {
        // Round-trip: process each outbound date separately
        suppressDisplay = true;
        let outboundFlights = [];
  
        for (const outboundDate of departureDates) {
          if (searchCancelled) break;
          if (debug) console.log(`Searching outbound flights on ${outboundDate}`);
          let outboundFlightsForDate = [];
          const maxTransfers = document.getElementById("two-transfer-checkbox").checked
            ? 2
            : (document.getElementById("transfer-checkbox").checked ? 1 : 0);
    
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
          globalResults = outboundFlights;
    
          // Process inbound flights for each outbound flight found on this outbound date
          for (const outbound of outboundFlightsForDate) {
            if (searchCancelled) break;
            const outboundDeparture = outbound.route[0];
            const outboundDestination = outbound.route[outbound.route.length - 1];
            // Use the current outboundDate for validations
            const outboundDateObj = new Date(outboundDate);
  
            // Split return input into individual dates
            const returnDates = returnInputRaw.split(',')
                                  .map(d => d.trim())
                                  .filter(d => d !== "");
            // Validate each return date against current outbound date
            for (const rDate of returnDates) {
              if (new Date(rDate) < outboundDateObj) {
                alert("Return date(s) cannot be earlier than the outbound departure date.");
                return;
              }
            }
    
            let inboundFlights = [];
            for (const inboundDate of returnDates) {
              if (searchCancelled) break;
              let results = [];
              if (maxTransfers > 0) {
                const connectingResults = await searchConnectingRoutes(
                  [outboundDestination],
                  getReturnAirports(outboundDeparture, window.originalOriginInput),
                  inboundDate,
                  maxTransfers
                );
                const directResults = await searchDirectRoutes(
                  [outboundDestination],
                  getReturnAirports(outboundDeparture, window.originalOriginInput),
                  inboundDate
                );
                results = [...connectingResults, ...directResults];
              } else {
                results = await searchDirectRoutes(
                  [outboundDestination],
                  getReturnAirports(outboundDeparture, window.originalOriginInput),
                  inboundDate
                );
              }
    
              if (results.length > 0) {
                inboundFlights = inboundFlights.concat(results);
              }
            }
    
            // Continue with filtering, deduplication, and rendering as before…
            const filteredInbound = inboundFlights.filter(inbound => {
              if (inbound.segments && outbound.segments) {
                const stopoverMinutes = Math.round(
                  (inbound.segments[0].departureDate - outbound.segments[outbound.segments.length - 1].arrivalDate) / 60000
                );
                return stopoverMinutes >= 360;
              }
              return false;
            });
    
            const seen = new Set();
            const dedupedInbound = [];
            for (const flight of filteredInbound) {
              const firstSeg = flight.segments[0];
              const departureTime = firstSeg ? firstSeg.departureDate.getTime() : 0;
              const key = flight.flightCode + "_" + departureTime;
              if (!seen.has(key)) {
                seen.add(key);
                dedupedInbound.push(flight);
              }
            }
            outbound.returnFlights = dedupedInbound;
    
            if (outbound.returnFlights && outbound.returnFlights.length > 0) {
              const resultsDiv = document.querySelector(".route-list");
              rehydrateDates(outbound);
              const outboundHtml = renderRouteBlock(outbound, "Outbound Flight");
              resultsDiv.insertAdjacentHTML("beforeend", outboundHtml);
    
              outbound.returnFlights.forEach((ret, idx) => {
                rehydrateDates(ret);
                if (!ret.segments || ret.segments.length === 0) {
                  if (debug) console.warn("No segments in return flight:", ret);
                  return;
                }
    
                const outboundLastArrival = outbound.segments[outbound.segments.length - 1].arrivalDate;
                const inboundFirstDeparture = ret.segments[0].departureDate;
                if (!outboundLastArrival || !inboundFirstDeparture ||
                    isNaN(outboundLastArrival.getTime()) || isNaN(inboundFirstDeparture.getTime())) {
                  if (debug) console.warn("Cannot compute stopover because date is invalid.");
                  return;
                }
                const stopoverMs = inboundFirstDeparture - outboundLastArrival;
                const stopoverMinutes = Math.max(0, Math.round(stopoverMs / 60000));
                const sh = Math.floor(stopoverMinutes / 60);
                const sm = stopoverMinutes % 60;
                const stopoverText = `Stopover: ${sh}h ${sm}m`;
    
                const inboundHtml = renderRouteBlock(ret, `Return Flight ${idx + 1}`, stopoverText);
                resultsDiv.insertAdjacentHTML("beforeend", inboundHtml);
              });
            } else {
              if (debug) console.warn(`No return flights found for ${outbound.route.join(" → ")}`);
            }
          }
        }
        suppressDisplay = false;
      }
    } catch (error) {
      document.querySelector(".route-list").innerHTML = `<p>Error: ${error.message}</p>`;
      if (debug) console.error("Search error:", error);
    } finally {
      if (globalResults.length === 0 && tripType === "oneway") {
        document.querySelector(".route-list").innerHTML = "<p>There are no available flights on this route.</p>";
      }
      hideProgress();
      searchButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg> Search Flights`;
    }
  }
  
  // ---------------- Additional UI Functions ----------------
  function swapInputs() {
    const originInput = document.getElementById("origin-input");
    const destinationInput = document.getElementById("destination-input");
    const temp = originInput.value;
    originInput.value = destinationInput.value;
    destinationInput.value = temp;
  }
  function toggleOptions() {
    const optionsContainer = document.getElementById("options-container");
    optionsContainer.classList.toggle("hidden");
  }
  function handleClearCache() {
    localStorage.clear();
    showNotification("Cache successfully cleared! ✅");
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
  
  function formatFlightDate(date) {
    if (!date) return "";
    const options = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
    return date.toLocaleDateString('en-US', options);
  }
  function getLocalDateString(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  function formatFlightTimeWithOffset(date, offsetText) {
    if (!date) return "";
    const offsetMatch = offsetText.match(/UTC([+-]\d+)/);
    const offsetHours = offsetMatch ? parseInt(offsetMatch[1], 10) : 0;
    // Use the UTC hours then add the offset to get local time
    let hours = date.getUTCHours() + offsetHours;
    let minutes = date.getUTCMinutes();
    hours = (hours + 24) % 24;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  
  function createConnectingSegmentRow(segment, depName, arrName) {
    const depTime = formatFlightTimeWithOffset(segment.departureDate, segment.departureOffset);
    const arrTime = formatFlightTimeWithOffset(segment.arrivalDate, segment.arrivalOffset);
    // Use the departure date of the segment for display.
    const flightDate = formatFlightDate(segment.departureDate);
    // Header: left grey box with date; right purple box with flight code.
    const headerRow = `
      <div class="flex justify-between items-center mb-1">
        <div class="text-xs font-semibold bg-gray-200 text-gray-800 px-2 py-1 rounded">
          ${flightDate}
        </div>
        <div class="text-xs font-semibold bg-[#20006D] text-white px-2 py-1 rounded">
          ${segment.flightCode}
        </div>
      </div>
    `;
    // Grid with departure/arrival airports and times (in local 24-hour format)
    const gridRow = `
      <div class="grid grid-cols-3 grid-rows-2 gap-2 items-center w-full py-3 border-b last:border-b-0">
        <!-- Departure Airport -->
        <div class="flex items-center gap-1 whitespace-nowrap">
          <span class="text-xl">${getCountryFlag(segment.origin)}</span>
          <span class="text-base font-medium">${depName}</span>
        </div>
        <!-- Plane Icon -->
        <div class="flex justify-center">
          <span class="text-xl font-medium">✈</span>
        </div>
        <!-- Arrival Airport -->
        <div class="flex items-center justify-end gap-1 whitespace-nowrap">
          <span class="text-base font-medium">${arrName}</span>
          <span class="text-xl">${getCountryFlag(segment.destination)}</span>
        </div>
        <!-- Departure Time -->
        <div class="flex items-center gap-1">
          <span class="text-2xl font-bold whitespace-nowrap">${depTime}</span>
          <sup class="text-[10px] align-super">${segment.departureOffset}</sup>
        </div>
        <!-- Flight Duration -->
        <div class="flex flex-col items-center">
          <div class="text-sm font-medium">
            ${segment.calculatedDuration.hours}h ${segment.calculatedDuration.minutes}m
          </div>
        </div>
        <!-- Arrival Time -->
        <div class="flex items-center justify-end gap-1">
          <span class="text-2xl font-bold whitespace-nowrap">${arrTime}</span>
          <sup class="text-[10px] align-super">${segment.arrivalOffset}</sup>
        </div>
      </div>
    `;
    return `<div class="mb-2">${headerRow}${gridRow}</div>`;
  }

  // --- Updated renderRouteBlock ---
  function renderRouteBlock(routeObj, label = "", extraInfo = "") {
    rehydrateDates(routeObj);
  
  // Compute the actual departure and arrival date range
    const firstDep = routeObj.segments[0].departureDate;
    const lastArr = routeObj.segments[routeObj.segments.length - 1].arrivalDate;
    const dateRange = formatFlightDate(firstDep)
      + (getLocalDateString(firstDep) !== getLocalDateString(lastArr)
        ? ` – ${formatFlightDate(lastArr)}`
        : "");
  
    const isReturn = label.toLowerCase().includes("return");
    if (debug) console.log("label: ", label);
    if (debug) console.log("extraInfo: ", extraInfo);
    // Updated: use bg-gray-200 for inbound (return) flights
    const containerBg = isReturn ? "bg-gray-300" : "bg-white";
  
    let html = `<div class="border rounded-lg p-4 mb-6 ${containerBg}">`;
    // Single row for label + stopover info (if provided)
  
    if (label || extraInfo) {
      html += `
        <div class="flex justify-between items-center mb-2">
          ${
            label
              ? `<div class="inline-block text-xs font-semibold bg-[#C90076] text-white px-2 py-1 rounded">
                  ${label}
                </div>`
              : ""
          }
          ${
            extraInfo
              ? `<div class="text-xs font-semibold text-gray-700 bg-gray-200 px-2 py-1 rounded">
                  ${extraInfo}
                </div>`
              : ""
          }
        </div>
      `;
    } if (routeObj.segments.length === 1) {
      // --- Direct Flight ---
      // Render the single segment
      const seg = routeObj.segments[0];
      html += createConnectingSegmentRow(
        seg,
        seg.departureStationText || airportNames[seg.origin],
        seg.arrivalStationText || airportNames[seg.destination],
        false
      );
    } else {
      // --- Connecting Flight ---
      // Header row: date range on the left (gray box), total duration on the right (gray box).
      html += `
        <div class="flex justify-between items-center mb-2">
          <div class="text-xs font-semibold bg-gray-800 text-white px-2 py-1 rounded">
            ${dateRange}
          </div>
          <div class="flex items-center text-sm font-semibold bg-gray-200 text-gray-800 px-2 py-1 rounded">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4 mr-1">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>${routeObj.totalTripDuration}
          </div>
        </div>
      `;
      // Render each segment using createConnectingSegmentRow
      routeObj.segments.forEach((segment, idx) => {
        const depName = segment.departureStationText || airportNames[segment.origin];
        const arrName = segment.arrivalStationText || airportNames[segment.destination];
        html += createConnectingSegmentRow(segment, depName, arrName);
  
        // Connection time display if not the last segment
        if (idx < routeObj.segments.length - 1) {
          const connectionMs = routeObj.segments[idx + 1].departureDate - segment.arrivalDate;
          const connectionMinutes = Math.round(connectionMs / 60000);
          const ch = Math.floor(connectionMinutes / 60);
          const cm = connectionMinutes % 60;
          html += `<div class="text-center text-sm text-gray-500 my-2">Connection: ${ch}h ${cm}m</div>`;
        }
      });
    }
  
    html += `</div>`;
    return html;
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
  
      if (cellDate < minDate || cellDate > lastBookable) {
        dateCell.classList.add("bg-gray-200", "cursor-not-allowed", "text-gray-500");
      } else {
        dateCell.classList.add("hover:bg-blue-100");
        if (selectedDates.has(dateStr)) {
          dateCell.classList.add("bg-blue-300");
        }
        dateCell.addEventListener("click", () => {
          if (selectedDates.has(dateStr)) {
            selectedDates.delete(dateStr);
            dateCell.classList.remove("bg-blue-300");
          } else {
            selectedDates.add(dateStr);
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
  }
  
  function parseLocalDate(dateStr) {
    const [year, month, day] = dateStr.split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  
  function initMultiCalendar(inputId, popupId, maxDaysAhead = 3) {
    const inputEl = document.getElementById(inputId);
    const popupEl = document.getElementById(popupId);
    if (!inputEl || !popupEl) {
      if (debug) console.error("Calendar input/popup not found:", inputId, popupId);
      return;
    }
  
    const selectedDates = new Set();
    const today = new Date();
    let currentYear = today.getFullYear();
    let currentMonth = today.getMonth();
  
    inputEl.addEventListener("click", (e) => {
      e.stopPropagation();
      renderCalendarMonth(popupEl, inputId, currentYear, currentMonth, maxDaysAhead, selectedDates);
      popupEl.classList.toggle("hidden");
    });
  
    document.addEventListener("click", (e) => {
      if (!popupEl.contains(e.target) && !inputEl.contains(e.target)) {
        popupEl.classList.add("hidden");
      }
    });
  }
  // ---------------- Initialize on DOMContentLoaded ----------------
  
  document.addEventListener("DOMContentLoaded", function () {
    const originInput = document.getElementById("origin-input");
    const preferredAirportInput = document.getElementById("preferred-airport");
    const updatePreferredButton = document.getElementById("update-preferred-airport");

    // Load the preferred airport from localStorage and set it as the default departure
    const savedPreferredAirport = localStorage.getItem("preferredAirport");
    if (savedPreferredAirport) {
        originInput.value = savedPreferredAirport;
        preferredAirportInput.value = savedPreferredAirport;
    }

    // Save the preferred airport when the "Update" button is clicked
    updatePreferredButton.addEventListener("click", function () {
        const preferredAirport = preferredAirportInput.value.trim();
        if (!preferredAirport) {
          showNotification("Please enter a valid airport. ⚠️");
          return;
        }
        localStorage.setItem("preferredAirport", preferredAirport);
        showNotification(`Preferred airport updated to: ${preferredAirport} ✈️`);
      });
    // Setup autocomplete for the preferred airport input
    setupAutocomplete("preferred-airport", "airport-suggestions-preferred");
  });
  document.addEventListener("DOMContentLoaded", function () {
    initMultiCalendar("departure-date", "departure-calendar-popup", 3);
    initMultiCalendar("return-date", "return-calendar-popup", 3);
    document.getElementById("departure-date").addEventListener("change", () => {
      const departureVal = document.getElementById("departure-date").value.trim();
      const returnInput = document.getElementById("return-date");
      if (departureVal) {
        // Enable return input when a departure date is chosen.
        returnInput.disabled = false;
        // Optionally, update the return calendar with a new minimum date:
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
    
    function updateReturnCalendarMinDate(departureDateStr) {
      const returnCalendarPopup = document.getElementById("return-calendar-popup");
      const minDate = parseLocalDate(departureDateStr);
      // Re-render the return calendar using the local date's year and month.
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
    
    setupAutocomplete("origin-input", "airport-suggestions-origin");
    setupAutocomplete("destination-input", "airport-suggestions-dest");
    document.getElementById("search-button").addEventListener("click", handleSearch);
    document.getElementById("max-requests").addEventListener("change", updateThrottleSettings);
    document.getElementById("requests-frequency").addEventListener("change", updateThrottleSettings);
    document.getElementById("pause-duration").addEventListener("change", updateThrottleSettings);
    document.getElementById("cache-lifetime").addEventListener("change", updateCacheLifetimeSetting);
    document.getElementById("clear-cache-button").addEventListener("click", handleClearCache);
    document.getElementById("swap-button").addEventListener("click", swapInputs);
    document.getElementById("toggle-options").addEventListener("click", toggleOptions);
    loadSettings();
  });
  document.addEventListener("DOMContentLoaded", function () {
    const optionsBtn = document.getElementById("toggle-options");
  
    optionsBtn.addEventListener("click", function () {
      optionsBtn.classList.remove("bg-[#C90076]");
      optionsBtn.classList.add("bg-[#20006D]");
      optionsBtn.blur();
    });
  
    optionsBtn.addEventListener("focus", function () {
      optionsBtn.classList.add("bg-[#C90076]");
    });
  
    optionsBtn.addEventListener("blur", function () {
      optionsBtn.classList.remove("bg-[#C90076]");
      optionsBtn.classList.add("bg-[#20006D]");
    });
  });  
  document.getElementById("update-preferred-airport").addEventListener("click", () => {
  const preferredAirportInput = document.getElementById("preferred-airport");
  const preferredAirport = preferredAirportInput.value.trim();
  const originInput = document.getElementById("origin-input");
  if (!preferredAirport) {
      showNotification("Please enter a valid airport. ⚠️", "error");
      return;
  }
  document.addEventListener("DOMContentLoaded", () => {
    const storedPreferredAirport = localStorage.getItem("preferredAirport");
    if (storedPreferredAirport) {
        document.getElementById("origin-input").value = storedPreferredAirport;
    }
  });
  // Save to localStorage
  localStorage.setItem("preferredAirport", preferredAirport);
  // Update departure input instantly
  originInput.value = preferredAirport;
  showNotification(`Preferred airport updated to: ${preferredAirport} ✈️`);
  });
  document.addEventListener("DOMContentLoaded", function () {
    const onewayBtn = document.getElementById("oneway-btn");
    const returnBtn = document.getElementById("return-btn");
    const returnDateContainer = document.getElementById("return-date-container");
    // Set initial trip type (One-way is selected by default, purple)
    window.currentTripType = "oneway";

    function toggleTripType(selectedType) {
      window.currentTripType = selectedType;
      if (selectedType === "oneway") {
        onewayBtn.classList.add("bg-[#20006D]", "text-white");
        onewayBtn.classList.remove("bg-gray-200", "text-gray-700");
        returnBtn.classList.add("bg-gray-200", "text-gray-700");
        returnBtn.classList.remove("bg-[#20006D]", "text-white");
        returnDateContainer.style.display = "none";
      } else {
        returnBtn.classList.add("bg-[#20006D]", "text-white");
        returnBtn.classList.remove("bg-gray-200", "text-gray-700");
        onewayBtn.classList.add("bg-gray-200", "text-gray-700");
        onewayBtn.classList.remove("bg-[#20006D]", "text-white");
        returnDateContainer.style.display = "block";
      }
    }
  
    onewayBtn.addEventListener("click", () => {
      toggleTripType("oneway");
      onewayBtn.blur();
    });
    returnBtn.addEventListener("click", () => {
      toggleTripType("return");
      returnBtn.blur();
    });
  });
  // ---------------- UI Scale Change ----------------
  document.addEventListener("DOMContentLoaded", function () {
    const scaleSlider = document.getElementById("ui-scale");
    // Set default scale to 85% on load
    document.body.style.zoom = scaleSlider.value / 100; 
    // Update zoom in real time as the slider is dragged
    scaleSlider.addEventListener("input", function() {
      document.body.style.zoom = this.value / 100;
    });
  }); 
  // ---------------- Sorting Results on Change ----------------
  document.getElementById("sort-select").addEventListener("change", function () {
    const sortOption = document.getElementById("sort-select").value;
    // Check trip type – assuming you set window.currentTripType earlier
    if (window.currentTripType === "return") {
      // Apply sorting to round-trip results
      if (sortOption === "departure") {
        globalResults.sort((a, b) => a.firstDeparture - b.firstDeparture);
      } else if (sortOption === "duration") {
        globalResults.sort((a, b) => a.totalDuration - b.totalDuration);
      } else if (sortOption === "airport") {
        globalResults.sort((a, b) => {
          let nameA = (airportNames[a.route[0]] || a.route[0]).toLowerCase();
          let nameB = (airportNames[b.route[0]] || b.route[0]).toLowerCase();
          return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
        });
      } else if (sortOption === "arrival") {
        globalResults.sort((a, b) => {
          let arrivalA = a.route[a.route.length - 1];
          let arrivalB = b.route[b.route.length - 1];
          let nameA = (airportNames[arrivalA] || arrivalA).toLowerCase();
          let nameB = (airportNames[arrivalB] || arrivalB).toLowerCase();
          return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
        });
      }
      // Render round-trip results (grouped outbound and return flights)
      displayRoundTripResults(globalResults);
    } else {
      // One-way sorting logic remains the same
      if (sortOption === "departure") {
        globalResults.sort((a, b) => a.firstDeparture - b.firstDeparture);
      } else if (sortOption === "duration") {
        globalResults.sort((a, b) => a.totalDuration - b.totalDuration);
      } else if (sortOption === "airport") {
        globalResults.sort((a, b) => {
          let nameA = (airportNames[a.route[0]] || a.route[0]).toLowerCase();
          let nameB = (airportNames[b.route[0]] || b.route[0]).toLowerCase();
          return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
        });
      } else if (sortOption === "arrival") {
        globalResults.sort((a, b) => {
          let arrivalA = a.route[a.route.length - 1];
          let arrivalB = b.route[b.route.length - 1];
          let nameA = (airportNames[arrivalA] || arrivalA).toLowerCase();
          let nameB = (airportNames[arrivalB] || arrivalB).toLowerCase();
          return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
        });
      }
      displayGlobalResults(globalResults);
    }
  });