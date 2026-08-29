// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createResultsRenderer } from "../../src/ui/results-renderer.js";

function segment(overrides = {}) {
  return {
    key: "flight-key",
    formattedFlightDate: "Sun, Aug 30, 2026",
    flightCode: "W46363",
    departureStationCode: "MXP",
    departureStationText: "Milan Malpensa International Airport",
    arrivalStationCode: "SSH",
    arrivalStationText: "Sharm El Sheikh International Airport",
    displayDeparture: "16:05",
    displayArrival: "21:25",
    departureOffset: "+02:00",
    arrivalOffset: "+03:00",
    currency: "EUR",
    displayPrice: 0,
    calculatedDuration: {
      hours: 4,
      minutes: 20,
      totalMinutes: 260,
      departureDate: new Date("2026-08-30T16:05:00Z"),
      arrivalDate: new Date("2026-08-30T20:25:00Z")
    },
    ...overrides
  };
}

function setupRenderer() {
  const list = document.createElement("div");
  list.className = "route-list";
  const toolbar = document.createElement("div");
  toolbar.className = "hidden";
  const total = document.createElement("div");
  document.body.append(list, toolbar, total);
  return {
    list,
    toolbar,
    total,
    renderer: createResultsRenderer({
      list,
      toolbar,
      total,
      countryFor: code => `${code} country`,
      flagFor: code => code === "MXP" ? "🇮🇹" : "🇪🇬"
    })
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("results renderer", () => {
  it("renders a compact flight card with offsets below times and a compatible action", () => {
    const { list, renderer, toolbar, total } = setupRenderer();

    renderer.display([segment()]);

    expect(toolbar.classList.contains("hidden")).toBe(false);
    expect(total.textContent).toBe("Total results: 1");
    expect(list.querySelector(".flight-card")).not.toBeNull();
    const timeZone = list.querySelector(".flight-time-zone");
    expect(timeZone.querySelector(":scope > .flight-time").textContent).toBe("16:05");
    expect(timeZone.querySelector(":scope > .flight-time-offset").textContent).toBe("UTC+2");
    expect(list.querySelector(".flight-airport-name").textContent)
      .toContain("Milan Malpensa International Airport");
    expect(list.querySelector(".flight-route-row")).not.toBeNull();
    expect(list.querySelector(".flight-card--inbound")).toBeNull();
    const button = list.querySelector(".continue-payment-button");
    expect(button.textContent).toBe("Continue");
    expect(button.dataset.outboundKey).toBe("flight-key");
  });

  it("renders and toggles round-trip results while keeping stopover information", () => {
    const { list, renderer } = setupRenderer();
    const inbound = segment({
      key: "return-key",
      departureStationCode: "SSH",
      departureStationText: "Sharm El Sheikh International Airport",
      arrivalStationCode: "PMO",
      arrivalStationText: "Palermo Falcone Borsellino Airport",
      calculatedDuration: {
        hours: 3,
        minutes: 20,
        totalMinutes: 200,
        departureDate: new Date("2026-09-01T21:35:00Z"),
        arrivalDate: new Date("2026-09-02T00:55:00Z")
      }
    });
    const outbound = segment({ returnFlights: [inbound] });

    renderer.displayRoundTrips([outbound]);

    expect(list.querySelector(".flight-trip-group")).not.toBeNull();
    expect(list.querySelector(".flight-direction").textContent).toBe("Outbound Flight");
    expect(list.querySelector(".flight-direction--inbound").textContent).toBe("Inbound Flight 1");
    expect(list.querySelector(".flight-extra").textContent).toBe("Stopover: 49h 10m");
    const toggle = list.querySelector(".return-toggle");
    const returnList = list.querySelector(".flight-return-list");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(returnList.classList.contains("hidden")).toBe(true);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(returnList.classList.contains("hidden")).toBe(false);
  });

  it("uses the compact layout for every segment of a connecting route", () => {
    const { list, renderer } = setupRenderer();
    const first = segment();
    const second = segment({
      key: "second-key",
      departureStationCode: "SSH",
      arrivalStationCode: "PMO",
      calculatedDuration: {
        hours: 3,
        minutes: 20,
        totalMinutes: 200,
        departureDate: new Date("2026-08-30T22:25:00Z"),
        arrivalDate: new Date("2026-08-31T01:45:00Z")
      }
    });

    renderer.display([{
      ...first,
      segments: [first, second]
    }]);

    expect(list.querySelectorAll(".flight-segment")).toHaveLength(2);
    expect(list.querySelectorAll(".flight-route-row")).toHaveLength(2);
    expect(list.querySelectorAll(".flight-continue-button")).toHaveLength(2);
    expect(list.textContent).toContain("Self-connection: 2h 0m");
  });
});
