// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  createResultsRenderer,
  sortResultsArray,
  sortReturnFlightsArray
} from "../../src/ui/results-renderer.js";

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
  it("sorts one-way results without mutating the source and supports stable criteria", () => {
    const early = segment({
      key: "early",
      departureStationCode: "AAA",
      departureStationText: "Zulu Airport",
      arrivalStationCode: "ZZZ",
      arrivalStationText: "Alpha Airport",
      calculatedDuration: {
        hours: 2,
        minutes: 0,
        totalMinutes: 120,
        departureDate: new Date("2026-08-30T08:00:00Z"),
        arrivalDate: new Date("2026-08-30T10:00:00Z")
      }
    });
    const late = segment({
      key: "late",
      departureStationCode: "BBB",
      departureStationText: "Alpha Airport",
      arrivalStationCode: "YYY",
      arrivalStationText: "Zulu Airport",
      calculatedDuration: {
        hours: 1,
        minutes: 0,
        totalMinutes: 60,
        departureDate: new Date("2026-08-30T18:00:00Z"),
        arrivalDate: new Date("2026-08-30T19:00:00Z")
      }
    });
    const results = [late, early];

    expect(sortResultsArray(results, "departure").map(flight => flight.key))
      .toEqual(["early", "late"]);
    expect(sortResultsArray(results, "duration", code => code, "desc").map(flight => flight.key))
      .toEqual(["early", "late"]);
    expect(sortResultsArray(results, "airport", code => ({ AAA: "Zulu", BBB: "Alpha" }[code] ?? code))
      .map(flight => flight.key)).toEqual(["late", "early"]);
    expect(sortResultsArray(results, "arrivalAirport", code => ({ YYY: "Zulu", ZZZ: "Alpha" }[code] ?? code))
      .map(flight => flight.key)).toEqual(["early", "late"]);
    expect(results.map(flight => flight.key)).toEqual(["late", "early"]);
  });

  it("sorts transfer and connection metrics while keeping missing direct connections at zero", () => {
    const direct = segment({ key: "direct" });
    const connecting = segment({
      key: "connecting",
      totalConnectionTime: 180,
      segments: [segment({ key: "connecting-1" }), segment({ key: "connecting-2" })]
    });
    const shortConnection = segment({
      key: "short-connection",
      totalConnectionTime: 60,
      segments: [segment({ key: "short-1" }), segment({ key: "short-2" })]
    });
    const results = [connecting, shortConnection, direct];

    expect(sortResultsArray(results, "transfers").map(flight => flight.key))
      .toEqual(["direct", "connecting", "short-connection"]);
    expect(sortResultsArray(results, "connections").map(flight => flight.key))
      .toEqual(["direct", "short-connection", "connecting"]);
  });

  it("uses outbound metrics for round trips and keeps return ordering separate", () => {
    const first = segment({
      key: "first-outbound",
      calculatedDuration: {
        hours: 8,
        minutes: 20,
        totalMinutes: 500,
        departureDate: new Date("2026-08-30T08:00:00Z"),
        arrivalDate: new Date("2026-08-30T16:20:00Z")
      },
      returnFlights: [
        segment({
          key: "first-late-return",
          calculatedDuration: {
            hours: 2,
            minutes: 0,
            totalMinutes: 120,
            departureDate: new Date("2026-09-05T10:00:00Z"),
            arrivalDate: new Date("2026-09-05T12:00:00Z")
          }
        }),
        segment({
          key: "first-early-return",
          calculatedDuration: {
            hours: 3,
            minutes: 0,
            totalMinutes: 180,
            departureDate: new Date("2026-09-01T10:00:00Z"),
            arrivalDate: new Date("2026-09-01T13:00:00Z")
          }
        })
      ]
    });
    const second = segment({
      key: "second-outbound",
      calculatedDuration: {
        hours: 5,
        minutes: 0,
        totalMinutes: 300,
        departureDate: new Date("2026-08-31T08:00:00Z"),
        arrivalDate: new Date("2026-08-31T13:00:00Z")
      },
      returnFlights: [
        segment({
          key: "second-return",
          calculatedDuration: {
            hours: 4,
            minutes: 0,
            totalMinutes: 240,
            departureDate: new Date("2026-09-02T10:00:00Z"),
            arrivalDate: new Date("2026-09-02T14:00:00Z")
          }
        }),
        segment({
          key: "second-late-return",
          calculatedDuration: {
            hours: 4,
            minutes: 0,
            totalMinutes: 240,
            departureDate: new Date("2026-09-06T10:00:00Z"),
            arrivalDate: new Date("2026-09-06T14:00:00Z")
          }
        })
      ]
    });

    expect(sortResultsArray([first, second], "duration").map(flight => flight.key))
      .toEqual(["second-outbound", "first-outbound"]);
    expect(sortReturnFlightsArray(first.returnFlights, "departure").map(flight => flight.key))
      .toEqual(["first-early-return", "first-late-return"]);
    expect(first.returnFlights.map(flight => flight.key))
      .toEqual(["first-late-return", "first-early-return"]);
  });

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

  it("expands payment details when the flight card is clicked and collapses them again", () => {
    const { list, renderer } = setupRenderer();

    renderer.display([segment()]);

    const card = list.querySelector(".flight-card");
    const payment = card.querySelector(".flight-payment");
    expect(card.getAttribute("aria-expanded")).toBe("false");
    expect(payment.classList.contains("hidden")).toBe(true);

    card.click();
    expect(card.getAttribute("aria-expanded")).toBe("true");
    expect(payment.classList.contains("hidden")).toBe(false);

    card.click();
    expect(card.getAttribute("aria-expanded")).toBe("false");
    expect(payment.classList.contains("hidden")).toBe(true);
  });

  it("keeps only one flight card expanded at the same level", () => {
    const { list, renderer } = setupRenderer();

    renderer.display([segment({ key: "first" }), segment({ key: "second" })]);

    const [first, second] = list.querySelectorAll(".flight-card");
    first.click();
    second.click();

    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(first.querySelector(".flight-payment").classList.contains("hidden")).toBe(true);
    expect(second.getAttribute("aria-expanded")).toBe("true");
    expect(second.querySelector(".flight-payment").classList.contains("hidden")).toBe(false);
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

  it("keeps outbound and inbound expansion independent for round trips", () => {
    const { list, renderer } = setupRenderer();
    const inboundOne = segment({
      key: "return-one",
      departureStationCode: "SSH",
      arrivalStationCode: "PMO",
      calculatedDuration: {
        hours: 3,
        minutes: 20,
        totalMinutes: 200,
        departureDate: new Date("2026-09-01T21:35:00Z"),
        arrivalDate: new Date("2026-09-02T00:55:00Z")
      }
    });
    const inboundTwo = { ...inboundOne, key: "return-two", flightCode: "W91234" };
    const outboundOne = segment({ key: "outbound-one", returnFlights: [inboundOne, inboundTwo] });
    const outboundTwo = segment({ key: "outbound-two", returnFlights: [inboundOne, inboundTwo] });

    renderer.displayRoundTrips([outboundOne, outboundTwo]);

    const groups = list.querySelectorAll(".flight-trip-group");
    const firstOutbound = groups[0].querySelector(":scope > .flight-card");
    const secondOutbound = groups[1].querySelector(":scope > .flight-card");
    firstOutbound.click();
    secondOutbound.click();

    expect(firstOutbound.getAttribute("aria-expanded")).toBe("false");
    expect(secondOutbound.getAttribute("aria-expanded")).toBe("true");

    const secondGroupReturnToggle = groups[1].querySelector(".return-toggle");
    secondGroupReturnToggle.click();
    const secondReturnList = groups[1].querySelector(".flight-return-list");
    const [firstInbound, secondInbound] = secondReturnList.querySelectorAll(".flight-card");
    firstInbound.click();
    secondInbound.click();

    expect(secondOutbound.getAttribute("aria-expanded")).toBe("true");
    expect(firstInbound.getAttribute("aria-expanded")).toBe("false");
    expect(secondInbound.getAttribute("aria-expanded")).toBe("true");
  });

  it("updates one streamed round-trip group without losing its expanded state", () => {
    const { list, renderer, total } = setupRenderer();
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
    const secondInbound = { ...inbound, key: "return-key-2" };
    const outbound = segment({ returnFlights: [inbound] });

    renderer.upsertRoundTrip(outbound, 3);
    list.querySelector(".return-toggle").click();
    renderer.upsertRoundTrip({ ...outbound, returnFlights: [inbound, secondInbound] }, 3);

    expect(list.querySelectorAll(".flight-trip-group")).toHaveLength(1);
    expect(list.querySelector(".return-toggle").textContent).toContain("2 inbound flights found");
    expect(list.querySelector(".return-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(list.querySelector(".flight-return-list").classList.contains("hidden")).toBe(false);
    expect(total.textContent).toBe("Total results: 1");
  });

  it("keeps expanded groups after resorting and sorts nested returns independently", () => {
    const { list, renderer } = setupRenderer();
    const earlyReturn = segment({
      key: "return-early",
      flightCode: "EARLY",
      calculatedDuration: {
        hours: 2,
        minutes: 0,
        totalMinutes: 120,
        departureDate: new Date("2026-09-01T09:00:00Z"),
        arrivalDate: new Date("2026-09-01T11:00:00Z")
      }
    });
    const lateReturn = segment({
      key: "return-late",
      flightCode: "LATE",
      calculatedDuration: {
        hours: 2,
        minutes: 0,
        totalMinutes: 120,
        departureDate: new Date("2026-09-01T21:00:00Z"),
        arrivalDate: new Date("2026-09-01T23:00:00Z")
      }
    });
    const earlyOutbound = segment({
      key: "early-outbound",
      calculatedDuration: {
        hours: 2,
        minutes: 0,
        totalMinutes: 120,
        departureDate: new Date("2026-08-30T08:00:00Z"),
        arrivalDate: new Date("2026-08-30T10:00:00Z")
      },
      returnFlights: [lateReturn, earlyReturn]
    });
    const lateOutbound = segment({
      key: "late-outbound",
      calculatedDuration: {
        hours: 2,
        minutes: 0,
        totalMinutes: 120,
        departureDate: new Date("2026-08-30T18:00:00Z"),
        arrivalDate: new Date("2026-08-30T20:00:00Z")
      },
      returnFlights: [earlyReturn]
    });

    renderer.setReturnSortOption("departure");
    renderer.displayRoundTrips([earlyOutbound, lateOutbound]);
    const earlyGroup = list.querySelector('[data-roundtrip-key="early-outbound"]');
    earlyGroup.querySelector(".return-toggle").click();
    expect([...earlyGroup.querySelectorAll(".flight-return-list .flight-number")]
      .map(node => node.textContent)).toEqual(["EA RLY", "LA TE"]);

    renderer.setSortOption("departure");
    renderer.setSortDirection("desc");
    renderer.displayRoundTrips([earlyOutbound, lateOutbound]);

    const groups = [...list.querySelectorAll(".flight-trip-group")];
    expect(groups.map(group => group.dataset.roundtripKey))
      .toEqual(["late-outbound", "early-outbound"]);
    const preservedGroup = list.querySelector('[data-roundtrip-key="early-outbound"]');
    expect(preservedGroup.querySelector(".return-toggle").getAttribute("aria-expanded")).toBe("true");
    expect([...preservedGroup.querySelectorAll(".flight-return-list .flight-number")]
      .map(node => node.textContent)).toEqual(["EA RLY", "LA TE"]);
    expect(preservedGroup.querySelector(".flight-return-list").classList.contains("hidden")).toBe(false);
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

    list.querySelector(".flight-card").click();
    expect([...list.querySelectorAll(".flight-payment")]
      .every(payment => !payment.classList.contains("hidden"))).toBe(true);
  });
});
