// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createCustomGroupsController } from "../../src/ui/custom-groups.js";

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
});
