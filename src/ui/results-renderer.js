import { escapeHtml } from "./dom.js";
import { formatOffsetForDisplay } from "../domain/flight-normalizer.js";

export function sortResultsArray(results, option, airportName = code => code) {
  if (!Array.isArray(results) || option === "default") return results;
  const finalArrival = flight => {
    const lastReturn = flight.returnFlights?.at(-1);
    return new Date(lastReturn?.calculatedDuration?.arrivalDate
      ?? flight.calculatedDuration.arrivalDate).getTime();
  };
  const tripDuration = flight => {
    if (!flight.returnFlights?.length) return flight.calculatedDuration.totalMinutes;
    return (finalArrival(flight) - new Date(flight.calculatedDuration.departureDate).getTime()) / 60000;
  };
  const comparators = {
    departure: (left, right) => new Date(left.calculatedDuration.departureDate)
      - new Date(right.calculatedDuration.departureDate),
    airport: (left, right) => airportName(left.route?.[0] ?? "")
      .localeCompare(airportName(right.route?.[0] ?? "")),
    arrival: (left, right) => finalArrival(left) - finalArrival(right),
    duration: (left, right) => tripDuration(left) - tripDuration(right)
  };
  results.sort(comparators[option] ?? (() => 0));
  return results;
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
  let tooltipListenerBound = false;

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

  function prepare(results) {
    toolbar.classList.remove("hidden");
    total.textContent = `Total results: ${results.length}`;
    list.replaceChildren();
    bindTooltips();
  }

  return Object.freeze({
    setSortOption(value) {
      sortOption = value;
    },
    display(results) {
      sortResultsArray(results, sortOption, airportName);
      prepare(results);
      list.insertAdjacentHTML("beforeend", results.map(result => routeHtml(result)).join(""));
      logger("Rendered results", results.length);
    },
    displayRoundTrips(outbounds) {
      sortResultsArray(outbounds, sortOption, airportName);
      prepare(outbounds);
      outbounds.forEach((outbound, index) => {
        const returnsId = `return-list-${index}`;
        const count = outbound.returnFlights?.length ?? 0;
        const returns = outbound.returnFlights?.map((flight, returnIndex) => {
          const minutes = Math.max(0, Math.round((flight.calculatedDuration.departureDate
            - outbound.calculatedDuration.arrivalDate) / 60000));
          return routeHtml(flight, `Inbound Flight ${returnIndex + 1}`, `Stopover: ${Math.floor(minutes / 60)}h ${minutes % 60}m`);
        }).join("") ?? "";
        list.insertAdjacentHTML("beforeend", `<div class="flight-trip-group">
          ${routeHtml(outbound, "Outbound Flight")}
          ${count ? `<div class="flight-return-summary"><button type="button" class="return-toggle" aria-expanded="false" aria-controls="${returnsId}">${count} inbound flight${count === 1 ? "" : "s"} found</button></div>` : ""}
          <div id="${returnsId}" class="flight-return-list hidden">${returns}</div>
        </div>`);
      });
      list.querySelectorAll(".return-toggle").forEach(button => button.addEventListener("click", () => {
        const expanded = button.getAttribute("aria-expanded") === "true";
        button.setAttribute("aria-expanded", String(!expanded));
        document.getElementById(button.getAttribute("aria-controls"))?.classList.toggle("hidden", expanded);
      }));
    }
  });
}
