import { escapeHtml } from "./dom.js";
import { formatOffsetForDisplay } from "../domain/flight-normalizer.js";

function dateValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compareValues(left, right, direction = "asc") {
  const leftMissing = left === null || left === undefined;
  const rightMissing = right === null || right === undefined;
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;

  const multiplier = direction === "desc" ? -1 : 1;
  if (typeof left === "string" || typeof right === "string") {
    return String(left).localeCompare(String(right), undefined, { sensitivity: "base" }) * multiplier;
  }
  if (left === right) return 0;
  return (left < right ? -1 : 1) * multiplier;
}

function codeFromStation(value) {
  if (value && typeof value === "object") return value.id ?? value.code ?? "";
  return value ?? "";
}

function stationCode(flight, direction) {
  const codeField = `${direction}StationCode`;
  const stationField = `${direction}Station`;
  return String(flight?.[codeField]
    ?? codeFromStation(flight?.[stationField])
    ?? "");
}

function stationName(flight, direction, airportName) {
  const code = stationCode(flight, direction);
  const text = flight?.[`${direction}StationText`];
  return String(airportName(code) || text || code);
}

function departureTime(flight) {
  return dateValue(flight?.calculatedDuration?.departureDate);
}

function arrivalTime(flight) {
  return dateValue(flight?.calculatedDuration?.arrivalDate);
}

function journeyDuration(flight) {
  return numberValue(flight?.calculatedDuration?.totalMinutes);
}

function transferCount(flight) {
  if (Array.isArray(flight?.segments) && flight.segments.length) {
    return Math.max(0, flight.segments.length - 1);
  }
  const match = String(flight?.stops ?? "").match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function connectionTime(flight) {
  return numberValue(flight?.totalConnectionTime) ?? 0;
}

function flightKey(flight) {
  return String(flight?.key
    ?? `${stationCode(flight, "departure")}-${stationCode(flight, "arrival")}|${departureTime(flight) ?? ""}`);
}

function contributingFlights(flight, includeReturns = false) {
  const own = Array.isArray(flight?.segments) && flight.segments.length
    ? flight.segments.flatMap(segment => contributingFlights(segment))
    : [flight];
  if (!includeReturns) return own;
  return own.concat((flight?.returnFlights ?? []).flatMap(item => contributingFlights(item)));
}

export function resultFreshness(flight, includeReturns = false) {
  const metadata = contributingFlights(flight, includeReturns)
    .map(item => item?.availability)
    .filter(item => Number.isFinite(item?.checkedAt));
  if (!metadata.length) return { checkedAt: null, source: "cache" };
  return {
    checkedAt: Math.min(...metadata.map(item => item.checkedAt)),
    source: metadata.every(item => item.source === "network") ? "network" : "cache"
  };
}

export function formatRelativeAge(checkedAt, now = Date.now()) {
  if (!Number.isFinite(checkedAt)) return "time unavailable";
  const minutes = Math.max(0, Math.floor((now - checkedAt) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function compareWithKeys(left, right, keys, direction) {
  for (const [getter, keyDirection = direction] of keys) {
    const difference = compareValues(getter(left), getter(right), keyDirection);
    if (difference !== 0) return difference;
  }
  return 0;
}

function sortKeys(option, airportName, direction) {
  const departureAirport = flight => stationName(flight, "departure", airportName);
  const arrivalAirport = flight => stationName(flight, "arrival", airportName);
  const departure = flight => departureTime(flight);
  const arrival = flight => arrivalTime(flight);
  const duration = flight => journeyDuration(flight);
  const transfers = flight => transferCount(flight);
  const connections = flight => connectionTime(flight);
  const key = flight => flightKey(flight);

  const common = {
    departure,
    airport: departureAirport,
    arrivalAirport,
    arrival,
    duration,
    transfers,
    connections
  };
  const secondary = {
    departure: [departureAirport, transfers, key],
    airport: [departure, transfers, key],
    arrivalAirport: [departure, transfers, key],
    arrival: [departure, departureAirport, transfers, key],
    duration: [departure, departureAirport, transfers, key],
    transfers: [departure, departureAirport, key],
    connections: [duration, departure, departureAirport, transfers, key]
  };
  const primary = common[option];
  if (!primary) return null;
  return [[primary, direction], ...(secondary[option] ?? []).map(getter => [getter, getter === key ? "asc" : direction])];
}

export function sortResultsArray(results, option, airportName = code => code, direction = "asc") {
  if (!Array.isArray(results)) return results;
  const sorted = [...results];
  if (option === "default") return sorted;
  const keys = sortKeys(option, airportName, direction);
  if (!keys) return sorted;
  return sorted.sort((left, right) => compareWithKeys(left, right, keys, direction));
}

export function sortReturnFlightsArray(flights, option = "departure", direction = "asc") {
  if (!Array.isArray(flights)) return flights;
  const keysByOption = {
    departure: [flight => departureTime(flight), flight => arrivalTime(flight), flight => flightKey(flight)],
    arrival: [flight => arrivalTime(flight), flight => departureTime(flight), flight => flightKey(flight)],
    duration: [flight => journeyDuration(flight), flight => departureTime(flight), flight => flightKey(flight)]
  };
  const keys = keysByOption[option] ?? keysByOption.departure;
  return [...flights].sort((left, right) => compareWithKeys(
    left,
    right,
    keys.map((getter, index) => [getter, index === keys.length - 1 ? "asc" : direction]),
    direction
  ));
}

function formatFlightCode(code) {
  const value = String(code ?? "");
  return value.length < 3 ? value : `${value.slice(0, 2)} ${value.slice(2)}`;
}

function airportChangeText(flight, index) {
  const changes = [flight.airportChange, flight.airportChangeOne, flight.airportChangeTwo];
  const change = changes[index] ?? (index === 0 ? flight.airportChange : null);
  if (!change?.from || !change?.to || change.from === change.to || change.distanceKm <= 0) return "";
  return ` · ⚠️ Airport change: ${change.from} ⇄ ${change.to}, ${change.distanceKm} km`;
}

export function createResultsRenderer({
  list,
  toolbar,
  total,
  countryFor,
  flagFor,
  airportName = code => code,
  logger = () => {},
  onRefresh = () => {}
}) {
  let sortOption = "default";
  let sortDirection = "asc";
  let returnSortOption = "departure";
  let tooltipListenerBound = false;
  let roundTripListenerBound = false;
  let flightCardListenerBound = false;
  let refreshListenerBound = false;
  const roundTripEntries = new Map();
  let unavailableResults = new Map();
  let refreshStates = new Map();
  let refreshActionsDisabled = false;
  let freshnessTimer = null;
  let pendingResults = null;
  let pendingRoundTrips = false;
  let frameHandle = null;

  function cancelScheduledFlush() {
    if (frameHandle === null) return;
    if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(frameHandle);
    }
    else clearTimeout(frameHandle);
    frameHandle = null;
  }

  function scheduleFlush() {
    if (frameHandle !== null) return;
    const callback = () => {
      frameHandle = null;
      flush();
    };
    frameHandle = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(callback)
      : setTimeout(callback, 0);
  }

  function segmentHtml(segment, label = "", extraInfo = "") {
    const departureCode = segment.departureStationCode ?? segment.departureStation ?? "";
    const arrivalCode = segment.arrivalStationCode ?? segment.arrivalStation ?? "";
    const inbound = label.toLowerCase().includes("inbound");
    return `
      <div class="flight-segment">
        <div class="flight-card-header">
          ${label ? `<div class="flight-direction ${inbound ? "flight-direction--inbound" : ""}">${escapeHtml(label)}</div>` : ""}
          <div class="flight-date">${escapeHtml(segment.formattedFlightDate)}</div>
          ${extraInfo ? `<div class="flight-extra">${escapeHtml(extraInfo)}</div>` : ""}
          <div class="flight-number">${escapeHtml(formatFlightCode(segment.flightCode))}</div>
        </div>
        <div class="flight-route-row">
          <div class="flight-endpoint flight-endpoint--departure">
            <div class="flight-time-zone">
              <span class="flight-time">${escapeHtml(segment.displayDeparture)}</span>
              <span class="flight-time-offset">${escapeHtml(formatOffsetForDisplay(segment.departureOffset))}</span>
            </div>
            <div class="flight-airport">
              <div class="flight-airport-name-row">
                <span class="tooltip-trigger flight-flag relative" tabindex="0">
                  <span class="cursor-pointer">${escapeHtml(flagFor(departureCode))}</span>
                  <span class="tooltip absolute hidden top-full left-0 bg-gray-800 text-white text-[8px] px-1 py-1 rounded shadow z-10 whitespace-nowrap">${escapeHtml(countryFor(departureCode))}</span>
                </span>
                <span class="flight-airport-name">${escapeHtml(segment.departureStationText)}</span>
              </div>
              <div class="flight-airport-code">${escapeHtml(departureCode)}</div>
            </div>
          </div>
          <div class="flight-route-middle">
            <div class="flight-route-symbol" aria-hidden="true">
              <span class="flight-route-line"></span>
              <svg class="flight-route-plane" viewBox="0 0 24 24" focusable="false">
                <path fill="currentColor" d="M21.5 3.5a1.56 1.56 0 0 0-2.2 0l-4.7 4.7L5.1 5.8 3.7 7.2l7.9 4.5-4.2 4.2-3.1-1.1-1.2 1.2 3.4 2.1 2.1 3.4 1.2-1.2-1.1-3.1 4.2-4.2 4.5 7.9 1.4-1.4-2.4-9.5 4.7-4.7a1.56 1.56 0 0 0 0-2.2Z" />
              </svg>
              <span class="flight-route-line"></span>
            </div>
            <div class="flight-duration">${escapeHtml(segment.calculatedDuration?.hours)}h ${escapeHtml(segment.calculatedDuration?.minutes)}m</div>
          </div>
          <div class="flight-endpoint flight-endpoint--arrival">
            <div class="flight-airport">
              <div class="flight-airport-name-row">
                <span class="flight-airport-name">${escapeHtml(segment.arrivalStationText)}</span>
                <span class="tooltip-trigger flight-flag relative" tabindex="0">
                  <span class="cursor-pointer">${escapeHtml(flagFor(arrivalCode))}</span>
                  <span class="tooltip absolute hidden top-full right-0 bg-gray-800 text-white text-[8px] px-1 py-1 rounded shadow z-10 whitespace-nowrap">${escapeHtml(countryFor(arrivalCode))}</span>
                </span>
              </div>
              <div class="flight-airport-code">${escapeHtml(arrivalCode)}</div>
            </div>
            <div class="flight-time-zone">
              <span class="flight-time">${escapeHtml(segment.displayArrival)}</span>
              <span class="flight-time-offset">${escapeHtml(formatOffsetForDisplay(segment.arrivalOffset))}</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  function paymentHtml(segment, expanded = false, disabled = false) {
    return `<div class="flight-payment${expanded ? "" : " hidden"}">
      <div class="flight-price">${escapeHtml(segment.currency)} ${escapeHtml(segment.displayPrice)}</div>
      <button type="button" class="continue-payment-button flight-continue-button" data-outbound-key="${escapeHtml(segment.key)}"${disabled ? " disabled aria-disabled=\"true\"" : ""}>Continue</button>
    </div>`;
  }

  function freshnessLabelHtml(flight, key, includeReturns = false) {
    const state = refreshStates.get(key) ?? { status: "idle" };
    const freshness = resultFreshness(flight, includeReturns);
    const checkedAt = Number.isFinite(state.checkedAt) ? state.checkedAt : freshness.checkedAt;
    let prefix = freshness.source === "network" ? "Checked online" : "Snapshot";
    let age = formatRelativeAge(checkedAt);
    if (state.status === "refreshing") {
      prefix = "Refreshing…";
      age = "";
    } else if (state.status === "unavailable") {
      prefix = "No longer available";
    } else if (state.status === "error") {
      prefix = "Couldn’t refresh · try again";
    }
    const text = age ? `${prefix} · ${age}` : prefix;
    const disabled = refreshActionsDisabled || state.status === "refreshing";
    return `<div class="route-freshness" data-result-key="${escapeHtml(key)}"${state.status === "refreshing" ? " aria-busy=\"true\"" : ""}>
      <span class="route-freshness-label" data-prefix="${escapeHtml(prefix)}" data-checked-at="${checkedAt ?? ""}">${escapeHtml(text)}</span>
      <button type="button" class="route-refresh-button${state.status === "refreshing" ? " route-refresh-button--spinning" : ""}" data-refresh-key="${escapeHtml(key)}" aria-label="Refresh this route" title="Refresh this route"${disabled ? " disabled" : ""}>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.9 9.2h-2.05A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z"/></svg>
      </button>
    </div>`;
  }

  function routeHtml(flight, label = "", extraInfo = "", expanded = false, options = {}) {
    const inbound = label.toLowerCase().includes("inbound");
    const unavailable = options.unavailable === true;
    const segments = flight.segments?.length ? flight.segments : [flight];
    const body = segments.map((segment, index) => {
      const next = segments[index + 1];
      let connection = "";
      if (next) {
        const departure = next.departureDateUtc ?? next.calculatedDuration?.departureDate;
        const arrival = segment.arrivalDateUtc ?? segment.calculatedDuration?.arrivalDate;
        const minutes = Math.max(0, Math.round((departure - arrival) / 60000));
        connection = `<div class="theme-text-muted text-center text-sm my-2">Self-connection: ${Math.floor(minutes / 60)}h ${minutes % 60}m${escapeHtml(airportChangeText(flight, index))}</div>`;
      }
      return `${segmentHtml(segment, index === 0 ? label : "", index === 0 ? extraInfo : "")}${paymentHtml(segment, expanded, unavailable)}${connection}`;
    }).join("");
    const key = flightKey(flight);
    const footer = options.showFreshness ? freshnessLabelHtml(flight, key, options.includeReturns) : "";
    return `<div class="flight-card ${inbound ? "flight-card--inbound" : ""}${unavailable ? " flight-card--unavailable" : ""}" data-flight-key="${escapeHtml(key)}" tabindex="0" role="button" aria-expanded="${expanded}">${body}${footer}</div>`;
  }

  function bindRefreshActions() {
    if (refreshListenerBound) return;
    refreshListenerBound = true;
    list.addEventListener("click", event => {
      const button = event.target.closest(".route-refresh-button");
      if (!button || button.disabled) return;
      event.stopPropagation();
      onRefresh(button.dataset.refreshKey);
    });
  }

  function scheduleFreshnessUpdate() {
    if (freshnessTimer !== null) clearTimeout(freshnessTimer);
    freshnessTimer = setTimeout(() => {
      freshnessTimer = null;
      list.querySelectorAll(".route-freshness-label").forEach(label => {
        if (!label.dataset.checkedAt || !label.dataset.prefix) return;
        const checkedAt = Number(label.dataset.checkedAt);
        if (!Number.isFinite(checkedAt)) return;
        label.textContent = `${label.dataset.prefix} · ${formatRelativeAge(checkedAt)}`;
      });
      scheduleFreshnessUpdate();
    }, 60000);
    freshnessTimer?.unref?.();
  }

  function bindTooltips() {
    if (tooltipListenerBound) return;
    tooltipListenerBound = true;
    list.addEventListener("click", event => {
      const trigger = event.target.closest(".tooltip-trigger");
      if (!trigger) return;
      event.stopPropagation();
      trigger.querySelector(".tooltip")?.classList.toggle("hidden");
    });
    document.addEventListener("click", () => {
      list.querySelectorAll(".tooltip").forEach(tooltip => tooltip.classList.add("hidden"));
    });
  }

  function bindRoundTripToggles() {
    if (roundTripListenerBound) return;
    roundTripListenerBound = true;
    list.addEventListener("click", event => {
      const button = event.target.closest(".return-toggle");
      if (!button) return;
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      document.getElementById(button.getAttribute("aria-controls"))?.classList.toggle("hidden", expanded);
    });
  }

  function bindFlightCardToggles() {
    if (flightCardListenerBound) return;
    flightCardListenerBound = true;
    list.addEventListener("click", event => {
      if (event.target.closest(".tooltip-trigger, button, a, input, select, textarea")) return;
      const card = event.target.closest(".flight-card");
      if (!card) return;
      toggleFlightCard(card);
    });

    list.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const card = event.target.closest(".flight-card");
      if (!card || event.target !== card) return;
      event.preventDefault();
      toggleFlightCard(card);
    });
  }

  function toggleFlightCard(card) {
    const expanded = card.getAttribute("aria-expanded") === "true";
    if (!expanded) {
      cardsAtSameLevel(card).forEach(sibling => {
        if (sibling !== card) setFlightCardExpanded(sibling, false);
      });
    }
    setFlightCardExpanded(card, !expanded);
  }

  function setFlightCardExpanded(card, expanded) {
    card.setAttribute("aria-expanded", String(expanded));
    card.querySelectorAll(".flight-payment").forEach(payment => {
      payment.classList.toggle("hidden", !expanded);
    });
  }

  function cardsAtSameLevel(card) {
    const returnList = card.closest(".flight-return-list");
    if (returnList) {
      return [...returnList.children].filter(child => child.classList.contains("flight-card"));
    }

    if (card.closest(".flight-trip-group")) {
      return [...list.children]
        .filter(child => child.classList.contains("flight-trip-group"))
        .map(group => [...group.children].find(child => child.classList.contains("flight-card")))
        .filter(Boolean);
    }

    return [...list.children].filter(child => child.classList.contains("flight-card"));
  }

  function prepare(availableCount, unavailableCount = 0) {
    toolbar.classList.remove("hidden");
    total.textContent = unavailableCount
      ? `${availableCount} available · ${unavailableCount} unavailable`
      : `Total results: ${availableCount}`;
    list.replaceChildren();
    bindTooltips();
    bindFlightCardToggles();
    bindRefreshActions();
  }

  function combinedResults(results) {
    const activeKeys = new Set(results.map(flightKey));
    return results.concat([...unavailableResults.entries()]
      .filter(([key]) => !activeKeys.has(key))
      .map(([, result]) => result));
  }

  function expandedRoundTripKeys() {
    return new Set([...list.querySelectorAll(".flight-trip-group")]
      .filter(group => group.querySelector(".return-toggle")?.getAttribute("aria-expanded") === "true")
      .map(group => group.dataset.roundtripKey));
  }

  function expandedFlightKeys() {
    return new Set([...list.querySelectorAll('.flight-card[aria-expanded="true"]')]
      .map(card => card.dataset.flightKey)
      .filter(Boolean));
  }

  function roundTripGroupHtml(outbound, index, expanded = false, expandedCards = new Set()) {
    const returnsId = `return-list-${index}`;
    const availableReturns = sortReturnFlightsArray(outbound.returnFlights ?? [], returnSortOption, "asc");
    const count = availableReturns.length;
    const returns = availableReturns.map((flight, returnIndex) => {
      const minutes = Math.max(0, Math.round((flight.calculatedDuration.departureDate
        - outbound.calculatedDuration.arrivalDate) / 60000));
      return routeHtml(
        flight,
        `Inbound Flight ${returnIndex + 1}`,
        `Stopover: ${Math.floor(minutes / 60)}h ${minutes % 60}m`,
        expandedCards.has(flightKey(flight)),
        { unavailable: refreshStates.get(flightKey(outbound))?.status === "unavailable" }
      );
    }).join("") ?? "";
    const isExpanded = expanded && count > 0;
    const key = flightKey(outbound);
    const unavailable = refreshStates.get(key)?.status === "unavailable";
    return `<div class="flight-trip-group${unavailable ? " flight-trip-group--unavailable" : ""}" data-roundtrip-index="${index}" data-roundtrip-key="${escapeHtml(key)}">
      ${routeHtml(outbound, "Outbound Flight", "", expandedCards.has(flightKey(outbound)), { unavailable })}
      ${count ? `<div class="flight-return-summary"><button type="button" class="return-toggle" aria-expanded="${isExpanded}" aria-controls="${returnsId}">${count} inbound flight${count === 1 ? "" : "s"} found</button></div>` : ""}
      <div id="${returnsId}" class="flight-return-list${isExpanded ? "" : " hidden"}">${returns}</div>
      ${freshnessLabelHtml(outbound, key, true)}
    </div>`;
  }

  function renderRoundTrips() {
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const expanded = expandedRoundTripKeys();
    const expandedCards = expandedFlightKeys();
    const activeOutbounds = [...roundTripEntries.values()];
    const unavailableCount = [...unavailableResults.keys()]
      .filter(key => !roundTripEntries.has(key)).length;
    const outbounds = sortResultsArray(combinedResults(activeOutbounds), sortOption, airportName, sortDirection);
    prepare(activeOutbounds.length, unavailableCount);
    bindRoundTripToggles();
    list.insertAdjacentHTML("beforeend", outbounds.map((outbound, index) =>
      roundTripGroupHtml(outbound, index, expanded.has(flightKey(outbound)), expandedCards)
    ).join(""));
    scheduleFreshnessUpdate();
    logger("Rendered round trips", {
      count: outbounds.length,
      durationMs: (globalThis.performance?.now?.() ?? Date.now()) - startedAt
    });
  }

  function flush() {
    const results = pendingResults;
    const shouldRenderRoundTrips = pendingRoundTrips;
    pendingResults = null;
    pendingRoundTrips = false;
    if (results) renderResults(results);
    if (shouldRenderRoundTrips) renderRoundTrips();
  }

  function renderResults(results) {
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const activeKeys = new Set(results.map(flightKey));
    const unavailableCount = [...unavailableResults.keys()].filter(key => !activeKeys.has(key)).length;
    const sortedResults = sortResultsArray(combinedResults(results), sortOption, airportName, sortDirection);
    prepare(results.length, unavailableCount);
    list.insertAdjacentHTML("beforeend", sortedResults.map(result => {
      const key = flightKey(result);
      return routeHtml(result, "", "", false, {
        showFreshness: true,
        unavailable: refreshStates.get(key)?.status === "unavailable"
      });
    }).join(""));
    scheduleFreshnessUpdate();
    logger("Rendered results", {
      count: sortedResults.length,
      durationMs: (globalThis.performance?.now?.() ?? Date.now()) - startedAt
    });
  }

  return Object.freeze({
    setSortOption(value) {
      sortOption = value;
    },
    setSortDirection(value) {
      sortDirection = value === "desc" ? "desc" : "asc";
    },
    setReturnSortOption(value) {
      returnSortOption = ["departure", "arrival", "duration"].includes(value)
        ? value
        : "departure";
    },
    setViewState({ unavailable = new Map(), states = new Map(), actionsDisabled = false } = {}) {
      unavailableResults = new Map(unavailable);
      refreshStates = new Map(states);
      refreshActionsDisabled = actionsDisabled;
    },
    display(results) {
      cancelScheduledFlush();
      pendingResults = null;
      pendingRoundTrips = false;
      renderResults(results);
    },
    displayRoundTrips(outbounds) {
      cancelScheduledFlush();
      pendingResults = null;
      pendingRoundTrips = false;
      roundTripEntries.clear();
      outbounds.forEach(outbound => roundTripEntries.set(flightKey(outbound), outbound));
      renderRoundTrips();
    },
    upsertRoundTrip(outbound) {
      roundTripEntries.set(flightKey(outbound), outbound);
      pendingRoundTrips = true;
      scheduleFlush();
    },
    enqueue(results) {
      pendingResults = results;
      scheduleFlush();
    },
    enqueueRoundTrip(outbound) {
      roundTripEntries.set(flightKey(outbound), outbound);
      pendingRoundTrips = true;
      scheduleFlush();
    },
    enqueueRoundTrips(outbounds) {
      roundTripEntries.clear();
      outbounds.forEach(outbound => roundTripEntries.set(flightKey(outbound), outbound));
      pendingRoundTrips = true;
      scheduleFlush();
    },
    refreshRoundTrips() {
      cancelScheduledFlush();
      pendingResults = null;
      pendingRoundTrips = false;
      if (roundTripEntries.size) renderRoundTrips();
    },
    flush,
    reset() {
      cancelScheduledFlush();
      pendingResults = null;
      pendingRoundTrips = false;
      roundTripEntries.clear();
      unavailableResults.clear();
      refreshStates.clear();
      if (freshnessTimer !== null) clearTimeout(freshnessTimer);
      freshnessTimer = null;
      list.replaceChildren();
      toolbar.classList.add("hidden");
    }
  });
}
