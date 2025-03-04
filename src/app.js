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
      console.log(`Reached ${MAX_REQUESTS_IN_ROW} consecutive requests; pausing for ${PAUSE_DURATION_MS}ms`);
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
    console.log(`Throttle settings updated: Max Requests = ${MAX_REQUESTS_IN_ROW}, Requests Frequency = ${REQUESTS_FREQUENCY_MS}ms, Pause Duration = ${PAUSE_DURATION_MS / 1000}s`);
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
      console.log(`Resolved "${input}" as wildcard ANY`);
      return ["ANY"];
    }
    const lower = trimmed.toLowerCase();
    if (trimmed.length === 3) {
      const byCode = AIRPORTS.find(a => a.code.toLowerCase() === lower);
      if (byCode) {
        console.log(`Resolved "${input}" as airport code: ${byCode.code}`);
        return [byCode.code];
      }
    }
    for (const country in COUNTRY_AIRPORTS) {
      if (country.toLowerCase() === lower) {
        console.log(`Resolved "${input}" as country: ${country} with airports ${COUNTRY_AIRPORTS[country]}`);
        return COUNTRY_AIRPORTS[country];
      }
    }
    const byCode = AIRPORTS.find(a => a.code.toLowerCase() === lower);
    if (byCode) {
      console.log(`Resolved "${input}" as airport code (fallback): ${byCode.code}`);
      return [byCode.code];
    }
    const matches = AIRPORTS.filter(a => a.name.toLowerCase().includes(lower));
    if (matches.length > 0) {
      const codes = matches.map(a => a.code);
      console.log(`Resolved "${input}" as airport names matching: ${codes}`);
      return codes;
    }
    console.log(`No match found for "${input}", returning uppercase input`);
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
      console.warn("parse12HourTime: cannot parse time string", timeStr);
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
    console.log(`Parsing time "${timeStr}" with offset "${offsetStr}" normalized to "${normalizedOffset}" for base date ${baseDateStr}`);
    const timeParts = parse12HourTime(timeStr);
    if (!timeParts) {
      console.warn("parse12HourTime: cannot parse time string", timeStr);
      return null;
    }
    let isoString = `${baseDateStr}T${String(timeParts.hour).padStart(2, '0')}:${String(timeParts.minute).padStart(2, '0')}:00`;
    isoString += normalizedOffset;
    const d = new Date(isoString);
    if (isNaN(d.getTime())) {
      console.error(`Invalid Date created from ISO string: "${isoString}"`);
      return null;
    }
    console.log(`Resulting Date: ${d.toISOString()}`);
    return d;
  }  
  function calculateFlightDuration(departureTimeStr, departureOffset, arrivalTimeStr, arrivalOffset, baseDateStr, nextDay = false) {
    let departureDate = parseTimeWithOffset(departureTimeStr, departureOffset, baseDateStr);
    let arrivalDate = parseTimeWithOffset(arrivalTimeStr, arrivalOffset, baseDateStr);
    if (!departureDate || !arrivalDate) {
      console.warn("calculateFlightDuration: invalid departure or arrival date", departureTimeStr, arrivalTimeStr);
      return { hours: 0, minutes: 0, totalMinutes: 0, departureDate: null, arrivalDate: null };
    }
    if (nextDay || arrivalDate <= departureDate) {
      arrivalDate = new Date(arrivalDate.getTime() + 24 * 60 * 60 * 1000);
    }
    const diffMs = arrivalDate - departureDate;
    const diffMinutes = Math.round(diffMs / 60000);
    const hours = Math.floor(diffMinutes / 60);
    const minutes = diffMinutes % 60;
    console.log(`Calculated duration for ${departureTimeStr} → ${arrivalTimeStr}: ${hours}h ${minutes}m (Total ${diffMinutes} minutes)`);
    return { hours, minutes, totalMinutes: diffMinutes, departureDate, arrivalDate };
  }
  function formatFlightTime(date, offsetText) {
    if (!date) return "";
    let offsetMatch = offsetText.match(/UTC([+-]\d+)/);
    let offsetHours = offsetMatch ? parseInt(offsetMatch[1], 10) : 0;
    const adjusted = new Date(date.getTime() + offsetHours * 3600000);
    const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const weekday = weekdayNames[adjusted.getUTCDay()];
    const dd = String(adjusted.getUTCDate()).padStart(2, '0');
    const mm = String(adjusted.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = adjusted.getUTCFullYear();
    const hh = String(adjusted.getUTCHours()).padStart(2, '0');
    const min = String(adjusted.getUTCMinutes()).padStart(2, '0');
    return `${weekday}, ${dd}/${mm}/${yyyy}, ${hh}:${min} (${offsetText})`;
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
          console.log("Using cached headers");
          headers = { ...headers, ...pageData.headers };
        } else {
          // Attempt to fetch headers from page
          chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            const currentTab = tabs[0];
            chrome.tabs.sendMessage(currentTab.id, { action: "getHeaders" }, function(response) {
              if (response && response.headers) {
                headers = { ...headers, ...response.headers };
              } else {
                console.log("Failed to get headers from page, using defaults");
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
            console.warn(`HTTP 400 for segment ${origin} → ${destination}: returning empty array`);
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
            console.warn("Dynamic URL returned HTML. Clearing cache and retrying.");
            localStorage.removeItem("wizz_page_data");
            throw new Error("Invalid response format: expected JSON but received HTML");
          }
        }
        
        // If we passed the above check, parse as JSON.
        const responseData = await fetchResponse.json();
        console.log(`Response for segment ${origin} → ${destination}:`, responseData);
        return responseData.flightsOutbound || [];
      } catch (error) {
        if (error.message.includes("429") || error.message.includes("426") || error.message.includes("Invalid response format")) {
          const waitTime = error.message.includes("426") ? 60000 : 40000;
          console.warn(`Rate limit or invalid dynamic URL encountered for segment ${origin} → ${destination} – waiting for ${waitTime / 1000} seconds`);
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
        console.warn("Skipping routeObj because route is missing or incomplete:", routeObj);
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
      const sortOption = document.getElementById("sort-select").value;
      // ... (sorting logic unchanged)
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
      console.warn("No return flights found for this outbound route.");
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
          console.log("Found multipass tab:", multipassTab.id, multipassTab.url);
        } else {
          console.log("No multipass tab found, opening one...");
          chrome.tabs.create({
            url: "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets"
          }, async (newTab) => {
            multipassTab = newTab;
            console.log("Opened new multipass tab:", newTab.id, newTab.url);
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
        console.log("Sending getDestinations message to tab", multipassTab.id);
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
        console.log("Using cached dynamic URL");
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
  async function searchConnectingRoutes(origins, destinations, selectedDate, maxTransfers) {
    const routesData = await fetchDestinations();
    const today = new Date();
    const maxBookingDate = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
    const selectedDateObj = new Date(selectedDate);
  
    if (origins.length === 1 && origins[0] === "ANY") {
      origins = [...new Set(routesData.map(route => {
        return typeof route.departureStation === "object" ? route.departureStation.id : route.departureStation;
      }))];
      console.log("Replaced origins 'ANY' with:", origins);
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
    console.log("Candidate routes:", candidateRoutes);
    const totalCandidates = candidateRoutes.length;
    let processedCandidates = 0;
    updateProgress(processedCandidates, totalCandidates, "Processing routes");
  
    for (const candidate of candidateRoutes) {
      if (searchCancelled) break;
      const candidateKey = candidate.join("-") + "-" + selectedDate + "-connect";
  
      // Exclude candidates if any segment is excluded.
      let candidateExcluded = false;
      for (let i = 0; i < candidate.length - 1; i++) {
        const segOrigin = candidate[i];
        const segDestination = candidate[i + 1];
        if (isExcludedRoute(segOrigin, segDestination)) {
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
        console.log("Using cached candidate:", candidateKey);
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
        console.log(`Checking segment ${segOrigin} → ${segDestination} for route ${candidate.join(" → ")}`);
  
        const segmentCacheKey = `${segOrigin}-${segDestination}-${currentSegmentDate}`;
        let flights = getCachedResults(segmentCacheKey);
        if (flights) {
          console.log(`Using cached segment: ${segmentCacheKey}`);
        } else {
          try {
            flights = await checkRouteSegment(segOrigin, segDestination, currentSegmentDate);
            console.log(`Found ${flights.length} flights for segment ${segOrigin} → ${segDestination}`);
            setCachedResults(segmentCacheKey, flights);
          } catch (error) {
            console.error(`Error checking segment ${segOrigin} → ${segDestination}: ${error.message}`);
            validCandidate = false;
            break;
          }
        }
        if (flights.length > 0) {
          const flight = flights[0];
          if (!flight.departureDate) {
            flight.departureDate = parseTimeWithOffset(
              flight.departure,
              flight.departureOffsetText || "",
              currentSegmentDate
            );
            console.log(`Computed departureDate for flight ${flight.flightCode}: ${flight.departureDate}`);
          }
          if (!flight.departureDate) {
            console.warn(`Segment ${segOrigin} → ${segDestination} has missing departureDate.`);
            validCandidate = false;
            break;
          }
          const flightDepartureDate = typeof flight.departureDate === "string"
            ? parseServerDate(flight.departureDate)
            : flight.departureDate;
          if (!flightDepartureDate || isNaN(flightDepartureDate.getTime())) {
            console.warn(`Segment ${segOrigin} → ${segDestination} has invalid departureDate: ${flight.departureDate}`);
            validCandidate = false;
            break;
          }
          const flightLocalDate = getLocalDateFromOffset(flightDepartureDate, flight.departureOffsetText || "");
          if (flightLocalDate !== currentSegmentDate && !document.getElementById("overnight-checkbox").checked) {
            console.warn(`Segment ${segOrigin} → ${segDestination} departs on ${flightLocalDate} instead of expected date ${currentSegmentDate}`);
            validCandidate = false;
            break;
          }
        }
        if (previousSegment && flights.length > 0) {
          let calc = calculateFlightDuration(
            flights[0].departure,
            flights[0].departureOffsetText || "",
            flights[0].arrival,
            flights[0].arrivalOffsetText || "",
            currentSegmentDate,
            false
          );
          if (calc.departureDate < previousSegment.arrivalDate) {
            if (document.getElementById("overnight-checkbox").checked) {
              let nextDay = new Date(new Date(currentSegmentDate).getTime() + 24 * 60 * 60 * 1000);
              currentSegmentDate = nextDay.toISOString().split("T")[0];
              console.log(`Forcing overnight for segment ${segOrigin} → ${segDestination} due to connection time`);
              try {
                flights = await checkRouteSegment(segOrigin, segDestination, currentSegmentDate);
                console.log(`After forcing overnight, found ${flights.length} flights for segment ${segOrigin} → ${segDestination}`);
              } catch (error) {
                console.error(`Error after forcing overnight for segment ${segOrigin} → ${segDestination}: ${error.message}`);
                validCandidate = false;
                break;
              }
            } else {
              console.warn(`Overnight transfer not allowed and connection time is insufficient for segment ${segOrigin} → ${segDestination}`);
              validCandidate = false;
              break;
            }
          }
        }
        const overnightEnabled = document.getElementById("overnight-checkbox").checked || document.getElementById("two-transfer-checkbox").checked;
        if (flights.length === 0 && overnightEnabled) {
          const allowedOvernightAttempts = Math.floor((maxBookingDate - selectedDateObj) / (24 * 60 * 60 * 1000));
          const defaultOvernight = (candidate.length - 2 === 2) ? 2 : 1;
          const maxOvernightAttempts = Math.min(defaultOvernight, allowedOvernightAttempts);
          let attempts = 0;
          while (attempts < maxOvernightAttempts && flights.length === 0) {
            const nextDay = new Date(new Date(currentSegmentDate).getTime() + 24 * 60 * 60 * 1000);
            if (nextDay > maxBookingDate) break;
            const nextDayStr = nextDay.toISOString().split("T")[0];
            console.log(`Trying overnight for segment ${segOrigin} → ${segDestination} on ${nextDayStr}`);
            await throttleRequest();
            try {
              flights = await checkRouteSegment(segOrigin, segDestination, nextDayStr);
              if (flights.length > 0) {
                currentSegmentDate = nextDayStr;
                break;
              } else {
                currentSegmentDate = nextDayStr;
              }
            } catch (error) {
              console.error(`Overnight check failed for segment ${segOrigin} → ${segDestination}: ${error.message}`);
              break;
            }
            attempts++;
          }
        }
        if (flights.length === 0) {
          console.warn(`No available flights for segment ${segOrigin} → ${segDestination}`);
          validCandidate = false;
          setCachedResults(candidateKey, []);
          break;
        }
        const flight = flights[0];
        const calculatedDuration = calculateFlightDuration(
          flight.departure,
          flight.departureOffsetText || "",
          flight.arrival,
          flight.arrivalOffsetText || "",
          currentSegmentDate,
          false
        );
        if (!calculatedDuration || !calculatedDuration.departureDate || !calculatedDuration.arrivalDate) {
          console.warn(`Unable to calculate duration for segment ${segOrigin} → ${segDestination}`);
          validCandidate = false;
          break;
        }
        const segmentInfo = {
          origin: segOrigin,
          destination: segDestination,
          flightCode: flight.flightCode,
          departure: flight.departure,
          arrival: flight.arrival,
          departureOffset: flight.departureOffsetText || "",
          arrivalOffset: flight.arrivalOffsetText || "",
          calculatedDuration: calculatedDuration,
          departureDate: calculatedDuration.departureDate,
          arrivalDate: calculatedDuration.arrivalDate
        };
        if (previousSegment && !validateConnection(previousSegment, segmentInfo)) {
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
    console.log("searchDirectRoutes called with origins:", origins, "destinations:", destinations, "selectedDate:", selectedDate);
    const routesData = await fetchDestinations();
    console.log("Fetched routesData:", routesData);
    
    if (origins.length === 1 && origins[0] === "ANY" && !(destinations.length === 1 && destinations[0] === "ANY")) {
      const destSet = new Set(destinations);
      const filteredOrigins = routesData
        .filter(route => route.arrivalStations && route.arrivalStations.some(arr => {
          const arrCode = typeof arr === "object" ? arr.id : arr;
          return destSet.has(arrCode);
        }))
        .map(route => typeof route.departureStation === "object" ? route.departureStation.id : route.departureStation);
      origins = [...new Set(filteredOrigins)];
      console.log(`Filtered ANY origins to only those with direct routes to [${[...destSet].join(", ")}]:`, origins);
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
        console.warn(`No data for departure airport: ${origin}`);
        continue;
      }
      
      console.log(`Route data for origin ${origin}:`, routeData);
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
          console.log(`Skipping excluded route ${origin} → ${arrivalCode}`);
          processed++;
          updateProgress(processed, totalArrivals, `Checked direct flights for ${origin} → ${arrivalCode}`);
          continue;
        }
        
        console.log(`Processing direct flights from ${origin} to ${arrivalCode}`);
        const cacheKey = origin + "-" + arrivalCode + "-" + selectedDate + "-direct";
        let cachedDirect = getCachedResults(cacheKey);
        if (cachedDirect) {
          console.log(`Found cached result for ${cacheKey}`);
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
          console.log(`Received flights for ${origin} → ${arrivalCode}:`, flights);
          if (flights.length > 0) {
            const firstFlightDate = new Date(flights[0].departureDate);
            const flightLocalDate = getLocalDateFromOffset(firstFlightDate, flights[0].departureOffsetText || "");  
            console.log(`First flight for ${origin} → ${arrivalCode} departs at:`, firstFlightDate, "local date:", flightLocalDate);
            if (flightLocalDate !== selectedDate && !document.getElementById("overnight-checkbox").checked) {
              console.warn(`Direct flight from ${origin} → ${arrivalCode} departs on ${flightLocalDate} (expected ${selectedDate}). Skipping.`);
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
              console.log(`Calculated duration for flight ${flight.flightCode}:`, calculatedDuration);
              if (!calculatedDuration || !calculatedDuration.departureDate) {
                console.warn(`Skipping flight ${flight.flightCode} due to invalid duration.`);
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
            console.warn(`No flights found for ${origin} → ${arrivalCode}`);
            setCachedResults(cacheKey, []);
          }
        } catch (error) {
          console.error(`Error checking direct flight ${origin} → ${arrivalCode}: ${error.message}`);
        }      
        
        processed++;
        updateProgress(processed, totalArrivals, `Checked direct flights for ${origin} → ${arrivalCode}`);
      }
    }
    
    console.log("Valid direct flights found:", validDirectFlights);
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
    const selectedDateRaw = document.getElementById("departure-date").value.trim();
    const searchButton = document.getElementById("search-button");
    if (searchButton.textContent === "Stop Search") {
      searchCancelled = true;
      searchButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg> Search Flights
      `;
      return;
    }

    searchCancelled = false;
    searchButton.textContent = "Stop Search";
    
    // For round-trip, read the return date
    let returnDate = "";
    if (window.currentTripType === "return") {
      returnDate = document.getElementById("return-date").value.trim();
      if (!returnDate) {
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
      searchButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg> Search Flights
      `;
      return;
    }
    
    const tripType = window.currentTripType || "oneway";
  
    // Build date array
    let datesToSearch = [];
    if (selectedDateRaw === "ALL") {
      const today = new Date();
      for (let i = 0; i <= 3; i++) {
        const d = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        datesToSearch.push(`${yyyy}-${mm}-${dd}`);
      }
    } else {
      datesToSearch.push(selectedDateRaw);
    }
    
    // Resolve inputs
    let origins = originInputRaw.split(",").map(s => resolveAirport(s)).flat();
    let destinations = [];
    if (!destinationInputRaw || destinationInputRaw.toUpperCase() === "ANY") {
      destinations = ["ANY"];
    } else {
      destinations = destinationInputRaw.split(",").map(s => resolveAirport(s)).flat();
    }
    
    // Clear old results
    document.querySelector(".route-list").innerHTML = "";
    globalResults = [];
    updateProgress(0, 1, "Initializing search");
  
    try {
      if (tripType === "oneway") {
        // One-way
        for (const dateStr of datesToSearch) {
          if (searchCancelled) break;
          console.log(`Searching for flights on ${dateStr}`);
  
          const maxTransfers = document.getElementById("two-transfer-checkbox").checked
            ? 2
            : (document.getElementById("transfer-checkbox").checked ? 1 : 0);
  
          if (maxTransfers > 0) {
            await searchConnectingRoutes(origins, destinations, dateStr, maxTransfers);
          } else {
            await searchDirectRoutes(origins, destinations, dateStr);
          }
        }
        // The actual display is triggered inside "appendRouteToDisplay" or after the loops.
      } else {
        // Round-trip
        suppressDisplay = true;
        let outboundFlights = [];
  
        for (const dateStr of datesToSearch) {
          if (searchCancelled) break;
          console.log(`Searching outbound flights on ${dateStr}`);
  
          let outboundFlightsForDate = [];
          const maxTransfers = document.getElementById("two-transfer-checkbox").checked
            ? 2
            : (document.getElementById("transfer-checkbox").checked ? 1 : 0);
  
          // Collect outbound
          if (maxTransfers > 0) {
            outboundFlightsForDate = outboundFlightsForDate.concat(
              await searchConnectingRoutes(origins, destinations, dateStr, maxTransfers)
            );
          } else {
            outboundFlightsForDate = outboundFlightsForDate.concat(
              await searchDirectRoutes(origins, destinations, dateStr)
            );
          }
          outboundFlights = outboundFlights.concat(outboundFlightsForDate);
          globalResults = outboundFlights;
  
          // For each outbound, find inbound
          for (const outbound of outboundFlightsForDate) {
            if (searchCancelled) break;
  
            const outboundDeparture = outbound.route[0];
            const outboundDestination = outbound.route[outbound.route.length - 1];
            // Split comma‐separated dates into arrays
            const departureInputVal = document.getElementById("departure-date").value.trim();
            const departureDates = departureInputVal
            .split(',')
            .map(d => d.trim())
            .filter(d => d !== "");

            // For round-trip, allow multiple return dates as well
            const returnInputVal = document.getElementById("return-date").value.trim();
            const returnDates = returnInputVal
              .split(',')
              .map(d => d.trim())
              .filter(d => d !== "");


            // If no departure date is selected, alert the user
            if (departureDates.length === 0) {
              alert("Please select at least one departure date.");
              return;
            }

            // For round-trip, ensure at least one return date exists and each return date is not before the earliest departure date.
            if (window.currentTripType === "return") {
              if (returnDates.length === 0) {
                alert("Please select at least one return date for round-trip search.");
                return;
              }
              // Get the earliest departure date as a Date object.
              const earliestDeparture = new Date(departureDates.sort()[0]);
              // Check each return date
              for (const rDate of returnDates) {
                if (new Date(rDate) < earliestDeparture) {
                  alert("Return date(s) cannot be earlier than the earliest departure date.");
                  return;
                }
              }
            }
            // Build inbound date range
            const inboundDates = returnDate
              .split(',')
              .map(dateStr => dateStr.trim())
              .filter(dateStr => dateStr !== "");

            let inboundFlights = [];
            for (const inboundDate of inboundDates) {
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
                // direct only
                results = await searchDirectRoutes(
                  [outboundDestination],
                  getReturnAirports(outboundDeparture, window.originalOriginInput),
                  inboundDate
                );
              }

              // ---- FIX #1: If you only want the *first* inbound date with flights, break early ----
              if (results.length > 0) {
                inboundFlights = inboundFlights.concat(results);
                // We found flights for this date; no need to check further inbound dates
              }
            }
  
            // Filter out flights departing too soon
            const filteredInbound = inboundFlights.filter(inbound => {
              if (inbound.segments && outbound.segments) {
                const stopoverMinutes = Math.round(
                  (inbound.segments[0].departureDate - outbound.segments[outbound.segments.length - 1].arrivalDate) / 60000
                );
                return stopoverMinutes >= 360; // e.g. 6 hours
              }
              return false;
            });
  
            // Deduplicate
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
            // Assign
            outbound.returnFlights = dedupedInbound;
  
            // Now display outbound + inbound 
            // Inside your loop that processes each outbound flight:
            if (outbound.returnFlights && outbound.returnFlights.length > 0) {
              const resultsDiv = document.querySelector(".route-list");

              // 1) Rehydrate the outbound route (so times are real Date objects)
              rehydrateDates(outbound);

              // 2) Render the outbound route block
              const outboundHtml = renderRouteBlock(outbound, "Outbound Flight");
              resultsDiv.insertAdjacentHTML("beforeend", outboundHtml);

              // 3) For each return flight
              outbound.returnFlights.forEach((ret, idx) => {
                // Rehydrate the return flight
                rehydrateDates(ret);

                // Make sure ret.segments exists and has at least 1 segment
                if (!ret.segments || ret.segments.length === 0) {
                  console.warn("No segments in return flight:", ret);
                  return;
                }

                // 4) Compute stopover
                const outboundLastArrival = outbound.segments[outbound.segments.length - 1].arrivalDate;
                const inboundFirstDeparture = ret.segments[0].departureDate;
                
                console.log("Outbound last arrival:", outboundLastArrival);
                console.log("Inbound first departure:", inboundFirstDeparture);

                // If either is missing or not a valid Date, skip
                if (!outboundLastArrival || !inboundFirstDeparture ||
                    isNaN(outboundLastArrival.getTime()) || isNaN(inboundFirstDeparture.getTime())) {
                  console.warn("Cannot compute stopover because date is invalid:", { outboundLastArrival, inboundFirstDeparture });
                  return;
                }

                const stopoverMs = inboundFirstDeparture - outboundLastArrival;
                if (stopoverMs < 0) {
                  console.warn(`Stopover is negative: inbound flight departs before outbound arrives? => ${stopoverMs}ms`);
                }

                const stopoverMinutes = Math.max(0, Math.round(stopoverMs / 60000));
                const sh = Math.floor(stopoverMinutes / 60);
                const sm = stopoverMinutes % 60;
                const stopoverText = `Stopover: ${sh}h ${sm}m`;

                // 5) Render the return flight block, passing the stopover text
                const inboundHtml = renderRouteBlock(ret, `Return Flight ${idx + 1}`, stopoverText);
                resultsDiv.insertAdjacentHTML("beforeend", inboundHtml);
              });
            } else {
              console.warn(`No return flights found for ${outbound.route.join(" → ")}`);
            }

          }
        }
        suppressDisplay = false;
      }
    } catch (error) {
      document.querySelector(".route-list").innerHTML = `<p>Error: ${error.message}</p>`;
      console.error("Search error:", error);
    } finally {
      if (globalResults.length === 0 && tripType === "oneway") {
        document.querySelector(".route-list").innerHTML = "<p>There are no available flights on this route.</p>";
      }
      hideProgress();
      searchButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-6">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg> Search Flights
      `;
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
  function formatSimpleTime(date) {
    if (!date) return "";
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
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
  
  function createFlightCard(seg, depName, arrName) {
    // Check if the flight arrives on the next day
    const depDateStr = getLocalDateString(seg.departureDate);
    const arrDateStr = getLocalDateString(seg.arrivalDate);
    const isNextDay = (depDateStr !== arrDateStr);

    // Build the date info at the top
    // If next day, e.g. "Thu, 4 Mar 2025 – Fri, 5 Mar 2025"
    let dateInfo = formatFlightDate(seg.departureDate);
    if (isNextDay) {
      dateInfo += ` – ${formatFlightDate(seg.arrivalDate)}`;
    }

    // Times
    const depTime = formatSimpleTime(seg.departureDate);
    const arrTime = formatSimpleTime(seg.arrivalDate);

    // Header: smaller flight code on the left, date(s) on the right
    // Using `text-xs` for the flight code, and `<sup>` for the time zone
    const headerHtml = `
      <div class="flex justify-between items-center mb-3">
        <span class="flight-code text-xs font-semibold bg-[#20006D] text-white px-2 py-1 rounded">
          ${seg.flightCode}
        </span>
        <div class="text-sm text-gray-700">
          ${dateInfo}
        </div>
      </div>
    `;

    // 3-column grid: left/center/right
    // Adjust proportions so the center column is narrower (0.6fr)
    // and the left/right columns are wider (1.5fr).
    const mainHtml = `
      <div class="grid grid-cols-[1.5fr,0.6fr,1.5fr] items-center gap-4">
        <!-- Left column -->
        <div class="flex flex-col items-start">
          <!-- Airport name + flag -->
          <div class="flex items-center gap-1 mb-1">
            <span class="text-xl">${getCountryFlag(seg.origin)}</span>
            <span class="text-base font-medium">${depName}</span>
          </div>
          <!-- Departure time + time zone as a small superscript -->
          <div class="dep-time text-2xl font-bold">
            ${depTime}
            <sup class="ml-1 text-[10px] align-super">${seg.departureOffset}</sup>
          </div>
        </div>

        <!-- Narrow center column (arrow + duration) -->
        <div class="flex flex-col items-center justify-center">
          <div class="text-xl font-semibold mb-1">→</div>
          <div class="text-sm font-medium">
            ${seg.calculatedDuration.hours}h ${seg.calculatedDuration.minutes}m
          </div>
        </div>

        <!-- Right column -->
        <div class="flex flex-col items-end">
          <!-- Airport name + flag -->
          <div class="flex items-center gap-1 mb-1">
            <span class="text-xl">${getCountryFlag(seg.destination)}</span>
            <span class="text-base font-medium">${arrName}</span>
          </div>
          <!-- Arrival time + time zone -->
          <div class="arr-time text-2xl font-bold">
            ${arrTime}
            <sup class="ml-1 text-[10px] align-super">${seg.arrivalOffset}</sup>
          </div>
        </div>
      </div>
    `;

    return `
      <div class="flight-card border p-3 mb-4 rounded-lg bg-white">
        ${headerHtml}
        ${mainHtml}
      </div>
    `;
  }
  function createSegmentRow(segment, depName, arrName) {
    const depTime = formatSimpleTime(segment.departureDate);
    const arrTime = formatSimpleTime(segment.arrivalDate);
  
    // We'll build a 2-row x 3-column grid:
    //  ┌─────────────┬───────────────┬─────────────┐
    //  │ dep airport │ plane icon    │ arr airport │  (row 1)
    //  ├─────────────┼───────────────┼─────────────┤
    //  │ dep time    │ flight length │ arr time    │  (row 2)
    //  └─────────────┴───────────────┴─────────────┘
  
    return `
      <div class="grid grid-cols-3 grid-rows-2 gap-2 items-center w-full py-3 border-b last:border-b-0">
        
        <!-- Row 1, Col 1: Departure Airport -->
        <div class="flex items-center gap-1 whitespace-nowrap">
          <span class="text-xl">${getCountryFlag(segment.origin)}</span>
          <span class="text-base font-medium">${depName}</span>
        </div>
  
        <!-- Row 1, Col 2: Plane Icon (centered) -->
        <div class="flex justify-center">
          <span class="text-xl font-medium">✈</span>
        </div>
  
        <!-- Row 1, Col 3: Arrival Airport (right-aligned) -->
        <div class="flex items-center justify-end gap-1 whitespace-nowrap">
          <span class="text-base font-medium">${arrName}</span>
          <span class="text-xl">${getCountryFlag(segment.destination)}</span>
        </div>
  
        <!-- Row 2, Col 1: Departure Time -->
        <div class="flex items-center gap-1">
          <span class="text-2xl font-bold whitespace-nowrap">${depTime}</span>
          <sup class="text-[10px] align-super">${segment.departureOffset}</sup>
        </div>
  
        <!-- Row 2, Col 2: Flight Duration (centered) -->
        <div class="flex flex-col items-center">
          <div class="text-sm font-medium">
            ${segment.calculatedDuration.hours}h ${segment.calculatedDuration.minutes}m
          </div>
        </div>
  
        <!-- Row 2, Col 3: Arrival Time (right-aligned) -->
        <div class="flex items-center justify-end gap-1">
          <span class="text-2xl font-bold whitespace-nowrap">${arrTime}</span>
          <sup class="text-[10px] align-super">${segment.arrivalOffset}</sup>
        </div>
  
      </div>
    `;
  }  
  function renderRouteBlock(routeObj, label = "", extraInfo = "") {
    rehydrateDates(routeObj);
  
    const allFlightCodes = routeObj.segments.map(seg => seg.flightCode).join(" + ");
    const firstDep = routeObj.segments[0].departureDate;
    const lastArr = routeObj.segments[routeObj.segments.length - 1].arrivalDate;
    const dateRange = formatFlightDate(firstDep)
      + (getLocalDateString(firstDep) !== getLocalDateString(lastArr)
        ? ` – ${formatFlightDate(lastArr)}`
        : "");
  
    const isReturn = label.toLowerCase().includes("return");
    const containerBg = isReturn ? "bg-gray-100" : "bg-white";
  
    let html = `<div class="border rounded-lg p-4 mb-6 ${containerBg}">`;
  
    // Top row: flight codes + date range
    html += `
      <div class="flex justify-between items-center mb-2">
        <div class="text-xs font-semibold bg-[#20006D] text-white px-2 py-1 rounded">
          ${allFlightCodes}
        </div>
        <div class="text-sm text-gray-700">
          ${dateRange}
        </div>
      </div>
    `;
  
    // Single row for label + stopover
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
    }
  
    // Now render each segment
    routeObj.segments.forEach((segment, idx) => {
      const depName = segment.departureStationText || airportNames[segment.origin];
      const arrName = segment.arrivalStationText || airportNames[segment.destination];
      html += createSegmentRow(segment, depName, arrName);
  
      // If multi-segment, show connection time
      if (idx < routeObj.segments.length - 1) {
        const connectionMs = routeObj.segments[idx + 1].departureDate - segment.arrivalDate;
        const connectionMinutes = Math.round(connectionMs / 60000);
        const ch = Math.floor(connectionMinutes / 60);
        const cm = connectionMinutes % 60;
        html += `
          <div class="text-center text-sm text-gray-500 my-2">
            Connection: ${ch}h ${cm}m
          </div>
        `;
      }
    });
  
    html += `</div>`;
    return html;
  }
  // ---------------- Initialize on DOMContentLoaded ----------------

  function renderCalendarMonth(popupEl, inputId, year, month, maxDaysAhead, selectedDates, minSelectableDate = null) {
    // Clear old content
    popupEl.innerHTML = "";
  
    // Container for the header (Month Year, Prev/Next buttons)
    const headerRow = document.createElement("div");
    headerRow.className = "flex justify-between items-center mb-2";
  
    // --- Prev Button ---
    const prevBtn = document.createElement("button");
    prevBtn.textContent = "←";
    prevBtn.className = "px-2 py-1 bg-gray-200 rounded hover:bg-gray-300 text-sm";
    // If a minSelectableDate is provided, disable Prev if we're at its month.
    if (minSelectableDate) {
      const minDateObj = parseLocalDate(minSelectableDate);
      if (year === minDateObj.getFullYear() && month === minDateObj.getMonth()) {
        prevBtn.disabled = true;
        prevBtn.classList.add("cursor-not-allowed", "opacity-50");
      } else {
        prevBtn.addEventListener("click", () => {
          const newMonth = (month - 1 < 0) ? 11 : (month - 1);
          const newYear = (month - 1 < 0) ? year - 1 : year;
          renderCalendarMonth(popupEl, inputId, newYear, newMonth, maxDaysAhead, selectedDates, minSelectableDate);
        });
      }
    } else {
      prevBtn.addEventListener("click", () => {
        const newMonth = (month - 1 < 0) ? 11 : (month - 1);
        const newYear = (month - 1 < 0) ? year - 1 : year;
        renderCalendarMonth(popupEl, inputId, newYear, newMonth, maxDaysAhead, selectedDates, minSelectableDate);
      });
    }
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
    nextBtn.addEventListener("click", () => {
      const newMonth = (month + 1 > 11) ? 0 : (month + 1);
      const newYear = (month + 1 > 11) ? year + 1 : year;
      renderCalendarMonth(popupEl, inputId, newYear, newMonth, maxDaysAhead, selectedDates, minSelectableDate);
    });
    headerRow.appendChild(nextBtn);
  
    popupEl.appendChild(headerRow);
  
    // --- Day Names ---
    const dayNamesRow = document.createElement("div");
    dayNamesRow.className = "grid grid-cols-7 text-center text-xs font-semibold mb-2";
    const daysShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    daysShort.forEach(day => {
      const dayEl = document.createElement("div");
      dayEl.textContent = day;
      dayNamesRow.appendChild(dayEl);
    });
    popupEl.appendChild(dayNamesRow);
  
    // --- Dates Grid ---
    const datesGrid = document.createElement("div");
    datesGrid.className = "grid grid-cols-7 text-center text-xs gap-1";
  
    // Get first day of the month and number of days in the month
    const firstOfMonth = new Date(year, month, 1);
    const startingWeekday = firstOfMonth.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
  
    // Determine the earliest allowed date.
    // For departure calendar, this is today.
    // For return calendar, minSelectableDate is passed in (the departure date).
    const minDate = minSelectableDate ? parseLocalDate(minSelectableDate) : new Date(new Date().setHours(0,0,0,0));
  
    // **Change here:** Determine the last bookable day relative to today.
    const todayMidnight = new Date(new Date().setHours(0, 0, 0, 0));
    const lastBookable = new Date(todayMidnight.getTime() + maxDaysAhead * 24 * 60 * 60 * 1000);
  
    // Insert blank cells before the 1st of the month
    for (let i = 0; i < startingWeekday; i++) {
      const blank = document.createElement("div");
      blank.className = "p-2";
      datesGrid.appendChild(blank);
    }
  
    // Create a cell for each day
    for (let d = 1; d <= daysInMonth; d++) {
      const dateCell = document.createElement("div");
      dateCell.className = "border rounded p-1 cursor-pointer";
      dateCell.textContent = d;
  
      const cellDate = new Date(year, month, d);
      const yyyy = cellDate.getFullYear();
      const mm = String(cellDate.getMonth() + 1).padStart(2, '0');
      const dd = String(cellDate.getDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;
  
      // Disable if the cell is before minDate or after lastBookable
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
          // Dispatch change event so that any listeners (such as enabling the return date) will fire
          inputEl.dispatchEvent(new Event("change"));
        });
      }
      datesGrid.appendChild(dateCell);
    }
    popupEl.appendChild(datesGrid);
  }
  
function initMultiCalendar(inputId, popupId, maxDaysAhead = 3) {
  const inputEl = document.getElementById(inputId);
  const popupEl = document.getElementById(popupId);

  if (!inputEl || !popupEl) {
    console.error("Calendar input/popup not found:", inputId, popupId);
    return;
  }

  // We'll track selected dates in a Set of YYYY-MM-DD strings
  const selectedDates = new Set();

  // By default, we start with the current month/year
  const today = new Date();
  let currentYear = today.getFullYear();
  let currentMonth = today.getMonth();

  // On input click, we rebuild and show the calendar
  inputEl.addEventListener("click", (e) => {
    e.stopPropagation();
    // Rebuild the calendar
    renderCalendarMonth(popupEl, inputId, currentYear, currentMonth, maxDaysAhead, selectedDates);
    popupEl.classList.toggle("hidden");
  });

  // Hide the popup if user clicks outside
  document.addEventListener("click", (e) => {
    if (!popupEl.contains(e.target) && !inputEl.contains(e.target)) {
      popupEl.classList.add("hidden");
    }
  });
}
function parseLocalDate(dateStr) {
  // Assumes dateStr is in "YYYY-MM-DD" format and creates a date in local time.
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}
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