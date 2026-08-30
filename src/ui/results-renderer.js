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
  logger = () => {}
}) {
  let sortOption = "default";
  let sortDirection = "asc";
  let returnSortOption = "departure";
  let tooltipListenerBound = false;
  let roundTripListenerBound = false;
  const roundTripEntries = new Map();

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
            <div class="flight-route-symbol" aria-hidden="true">━ ✈ ━</div>
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

  function paymentHtml(segment) {
    return `<div class="flight-payment">
      <div class="flight-price">${escapeHtml(segment.currency)} ${escapeHtml(segment.displayPrice)}</div>
      <button type="button" class="continue-payment-button flight-continue-button" data-outbound-key="${escapeHtml(segment.key)}">Continue</button>
    </div>`;
  }

  function routeHtml(flight, label = "", extraInfo = "") {
    const inbound = label.toLowerCase().includes("inbound");
    const segments = flight.segments?.length ? flight.segments : [flight];
    const body = segments.map((segment, index) => {
      const next = segments[index + 1];
      let connection = "";
      if (next) {
        const minutes = Math.max(0, Math.round((next.calculatedDuration.departureDate
          - segment.calculatedDuration.arrivalDate) / 60000));
        connection = `<div class="theme-text-muted text-center text-sm my-2">Self-connection: ${Math.floor(minutes / 60)}h ${minutes % 60}m${escapeHtml(airportChangeText(flight, index))}</div>`;
      }
      return `${segmentHtml(segment, index === 0 ? label : "", index === 0 ? extraInfo : "")}${paymentHtml(segment)}${connection}`;
    }).join("");
    return `<div class="flight-card ${inbound ? "flight-card--inbound" : ""}">${body}</div>`;
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

  function prepare(results) {
    toolbar.classList.remove("hidden");
    total.textContent = `Total results: ${results.length}`;
    list.replaceChildren();
    bindTooltips();
  }

  function expandedRoundTripKeys() {
    return new Set([...list.querySelectorAll(".flight-trip-group")]
      .filter(group => group.querySelector(".return-toggle")?.getAttribute("aria-expanded") === "true")
      .map(group => group.dataset.roundtripKey));
  }

  function roundTripGroupHtml(outbound, index, expanded = false) {
    const returnsId = `return-list-${index}`;
    const availableReturns = sortReturnFlightsArray(outbound.returnFlights ?? [], returnSortOption, "asc");
    const count = availableReturns.length;
    const returns = availableReturns.map((flight, returnIndex) => {
      const minutes = Math.max(0, Math.round((flight.calculatedDuration.departureDate
        - outbound.calculatedDuration.arrivalDate) / 60000));
      return routeHtml(flight, `Inbound Flight ${returnIndex + 1}`, `Stopover: ${Math.floor(minutes / 60)}h ${minutes % 60}m`);
    }).join("") ?? "";
    const isExpanded = expanded && count > 0;
    return `<div class="flight-trip-group" data-roundtrip-index="${index}" data-roundtrip-key="${escapeHtml(flightKey(outbound))}">
      ${routeHtml(outbound, "Outbound Flight")}
      ${count ? `<div class="flight-return-summary"><button type="button" class="return-toggle" aria-expanded="${isExpanded}" aria-controls="${returnsId}">${count} inbound flight${count === 1 ? "" : "s"} found</button></div>` : ""}
      <div id="${returnsId}" class="flight-return-list${isExpanded ? "" : " hidden"}">${returns}</div>
    </div>`;
  }

  function renderRoundTrips() {
    const expanded = expandedRoundTripKeys();
    const outbounds = sortResultsArray([...roundTripEntries.values()], sortOption, airportName, sortDirection);
    prepare(outbounds);
    bindRoundTripToggles();
    outbounds.forEach((outbound, index) => list.insertAdjacentHTML(
      "beforeend",
      roundTripGroupHtml(outbound, index, expanded.has(flightKey(outbound)))
    ));
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
    display(results) {
      const sortedResults = sortResultsArray(results, sortOption, airportName, sortDirection);
      prepare(sortedResults);
      list.insertAdjacentHTML("beforeend", sortedResults.map(result => routeHtml(result)).join(""));
      logger("Rendered results", sortedResults.length);
    },
    displayRoundTrips(outbounds) {
      roundTripEntries.clear();
      outbounds.forEach(outbound => roundTripEntries.set(flightKey(outbound), outbound));
      renderRoundTrips();
    },
    upsertRoundTrip(outbound) {
      roundTripEntries.set(flightKey(outbound), outbound);
      renderRoundTrips();
    },
    refreshRoundTrips() {
      if (roundTripEntries.size) renderRoundTrips();
    },
    reset() {
      roundTripEntries.clear();
      list.replaceChildren();
      toolbar.classList.add("hidden");
    }
  });
}
