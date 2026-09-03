// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createCustomGroupsController } from "../../src/ui/custom-groups.js";
import { createAirportFields } from "../../src/ui/airport-fields.js";

describe("custom groups UI", () => {
  it("renders stored user values as text", () => {
    document.body.innerHTML = `
      <div id="custom-groups-list"></div><button id="toggle-custom-groups"></button>
      <div id="custom-groups-panel"></div><input id="custom-group-key">
      <input id="custom-group-name"><input id="custom-group-airports">
      <button id="add-custom-group-btn"></button>`;
    const stored = [{ key: "XX", name: "<img src=x onerror=alert(1)>", airports: ["AAA", "BBB"] }];
    const storage = { getItem: () => JSON.stringify(stored), setItem: vi.fn() };
    const controller = createCustomGroupsController({
      storage, groups: {}, groupNames: {}, airportLookup: {}, airports: [], notify: vi.fn()
    });
    controller.initialize();
    expect(document.querySelector("#custom-groups-list img")).toBeNull();
    expect(document.querySelector("#custom-groups-list").textContent).toContain("<img");
  });

  it("adds airports selected through lookup rows and allows removing a row", () => {
    document.body.innerHTML = `
      <div id="custom-groups-list"></div><button id="toggle-custom-groups"></button>
      <div id="custom-groups-panel"></div><input id="custom-group-key">
      <input id="custom-group-name"><div id="custom-group-airports"></div>
      <button id="add-custom-group-btn"></button>`;
    const storage = { getItem: () => "[]", setItem: vi.fn() };
    const airportLookup = {
      PSA: { code: "PSA", name: "Pisa (PSA)" },
      BLQ: { code: "BLQ", name: "Bologna (BLQ)" }
    };
    const airports = Object.values(airportLookup);
    const airportFields = createAirportFields({ setupAutocomplete: vi.fn(), maxRows: 4 });
    const controller = createCustomGroupsController({
      storage, groups: {}, groupNames: {}, airportLookup, airports, airportFields,
      resolveAirport: value => {
        const match = airports.find(airport => airport.name === value || airport.code === value.toUpperCase());
        return match ? [match.code] : [];
      },
      notify: vi.fn()
    });
    controller.initialize();

    const firstInput = document.querySelector("#custom-group-airports input");
    firstInput.value = "Pisa (PSA)";
    document.querySelector("#custom-group-airports .plus-btn").click();
    const inputs = document.querySelectorAll("#custom-group-airports input");
    inputs[1].value = "Bologna (BLQ)";
    document.getElementById("custom-group-name").value = "Italy";
    document.getElementById("custom-group-key").value = "ITALY";
    document.getElementById("add-custom-group-btn").click();

    expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual([
      { key: "ITALY", name: "Italy", airports: ["PSA", "BLQ"] }
    ]);
    expect(document.querySelectorAll("#custom-group-airports input")).toHaveLength(1);

    document.querySelector("#custom-group-airports .plus-btn").click();
    expect(document.querySelectorAll("#custom-group-airports .airport-row")).toHaveLength(2);
    document.querySelector("#custom-group-airports .delete-btn").click();
    expect(document.querySelectorAll("#custom-group-airports .airport-row")).toHaveLength(1);
  });
});
