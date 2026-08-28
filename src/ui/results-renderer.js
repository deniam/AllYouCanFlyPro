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

  function segmentHtml(segment) {
    const departureCode = segment.departureStationCode ?? segment.departureStation ?? "";
    const arrivalCode = segment.arrivalStationCode ?? segment.arrivalStation ?? "";
    return `
      <div class="flight-segment">
        <div class="flex justify-between items-center mb-0">
          <div class="text-xs font-semibold bg-gray-200 text-gray-800 px-2 py-1 rounded">${escapeHtml(segment.formattedFlightDate)}</div>
          <div class="text-xs font-semibold bg-white border border-[#20006D] text-[#20006D] px-1 py-1 rounded">${escapeHtml(formatFlightCode(segment.flightCode))}</div>
        </div>
        <div class="grid grid-cols-3 grid-rows-2 gap-0 items-center w-full py-1">
          <div class="flex items-center gap-1 whitespace-normal">
            <div class="tooltip-trigger grid grid-cols-1 grid-rows-2 items-center relative" tabindex="0">
              <span class="text-xl cursor-pointer">${escapeHtml(flagFor(departureCode))}</span>
              <div class="tooltip absolute hidden top-full left-0 bg-gray-800 text-white text-[8px] px-1 py-1 rounded shadow z-10 whitespace-nowrap">${escapeHtml(countryFor(departureCode))}</div>
              <span class="text-[10px] font-bold text-gray-500">${escapeHtml(departureCode)}</span>
            </div>
            <span class="text-base font-medium break-words">${escapeHtml(segment.departureStationText)}</span>
          </div>
          <div class="text-center text-[#20006D]" aria-hidden="true">━━━━ ✈ ━━━━</div>
          <div class="flex justify-end items-center gap-1">
            <span class="text-base font-medium text-right break-words">${escapeHtml(segment.arrivalStationText)}</span>
            <div class="tooltip-trigger grid grid-cols-1 grid-rows-2 items-center relative" tabindex="0">
              <span class="text-xl cursor-pointer">${escapeHtml(flagFor(arrivalCode))}</span>
              <div class="tooltip absolute hidden top-full right-0 bg-gray-800 text-white text-[8px] px-1 py-1 rounded shadow z-10 whitespace-nowrap">${escapeHtml(countryFor(arrivalCode))}</div>
              <span class="text-[10px] font-bold text-gray-500">${escapeHtml(arrivalCode)}</span>
            </div>
          </div>
          <div class="flex items-center gap-1 mt-4"><span class="text-2xl font-bold">${escapeHtml(segment.displayDeparture)}</span><sup class="text-[10px]">${escapeHtml(formatOffsetForDisplay(segment.departureOffset))}</sup></div>
          <div class="text-sm font-medium text-center">${escapeHtml(segment.calculatedDuration?.hours)}h ${escapeHtml(segment.calculatedDuration?.minutes)}m</div>
          <div class="flex items-center justify-end gap-1 mt-4"><span class="text-2xl font-bold">${escapeHtml(segment.displayArrival)}</span><sup class="text-[10px]">${escapeHtml(formatOffsetForDisplay(segment.arrivalOffset))}</sup></div>
        </div>
      </div>`;
  }

  function paymentHtml(segment) {
    return `<div class="flex justify-between items-center mt-2">
      <div class="text-left text-sm font-semibold text-gray-800">${escapeHtml(segment.currency)} ${escapeHtml(segment.displayPrice)}</div>
      <button type="button" class="continue-payment-button px-1 py-1 bg-white text-[#C90076] border border-[#C90076] rounded-md font-bold shadow-md hover:text-white cursor-pointer" data-outbound-key="${escapeHtml(segment.key)}">Continue to customize</button>
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
        connection = `<div class="text-center text-sm text-gray-500 my-2">Self-connection: ${Math.floor(minutes / 60)}h ${minutes % 60}m${escapeHtml(airportChangeText(flight, index))}</div>`;
      }
      return `${segmentHtml(segment)}${paymentHtml(segment)}${connection}`;
    }).join("");
    const heading = label || extraInfo
      ? `<div class="flex justify-between items-center mb-2">
          <div class="text-xs font-semibold ${inbound ? "bg-[#20006D]" : "bg-[#C90076]"} text-white px-2 py-1 rounded">${escapeHtml(label)}</div>
          <div class="text-xs font-semibold text-gray-700 px-2 py-1 rounded">${escapeHtml(extraInfo)}</div>
        </div>`
      : "";
    return `<div class="border rounded-lg p-2.5 mb-2 ${inbound ? "bg-gray-300" : ""}">${heading}${body}</div>`;
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
        list.insertAdjacentHTML("beforeend", `<div class="border rounded-lg p-2.5 mb-4">
          ${routeHtml(outbound, "Outbound Flight")}
          ${count ? `<div class="text-center mt-2"><button type="button" class="return-toggle text-[#C90076] font-semibold" aria-expanded="false" aria-controls="${returnsId}">${count} inbound flight${count === 1 ? "" : "s"} found</button></div>` : ""}
          <div id="${returnsId}" class="mt-2 hidden">${returns}</div>
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
