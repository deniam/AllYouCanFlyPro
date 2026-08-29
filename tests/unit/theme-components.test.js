// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createAirportFields } from "../../src/ui/airport-fields.js";
import { renderCalendarMonth } from "../../src/ui/calendar.js";
import { mountChangelog } from "../../src/ui/changelog.js";

beforeEach(() => {
  document.body.replaceChildren();
});

describe("themed dynamic components", () => {
  it("uses semantic theme classes for calendar states", () => {
    const input = document.createElement("input");
    input.id = "departure-date";
    const popup = document.createElement("div");
    document.body.append(input, popup);
    const today = new Date();
    const dateText = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0")
    ].join("-");

    renderCalendarMonth(
      popup, input.id, today.getFullYear(), today.getMonth(), 3, new Set([dateText])
    );

    expect(popup.querySelector(".calendar-day--selected")).not.toBeNull();
    expect(popup.querySelector(".theme-brand-text")).not.toBeNull();
    expect(popup.querySelector(".theme-accent-text")).not.toBeNull();
  });

  it("themes dynamically created airport inputs and popovers", () => {
    const container = document.createElement("div");
    container.id = "origin-multi";
    document.body.append(container);

    createAirportFields({ setupAutocomplete: () => {} }).initialize(container.id, "origin");

    expect(container.querySelector("input").classList.contains("theme-text")).toBe(true);
    expect(container.querySelector("[id$='-suggestions']").classList.contains("theme-surface-raised"))
      .toBe(true);
  });

  it("themes generated changelog text", () => {
    const modal = document.createElement("div");
    const openButton = document.createElement("button");
    const closeButton = document.createElement("button");
    const content = document.createElement("div");
    document.body.append(modal, openButton, closeButton, content);

    mountChangelog({
      modal,
      openButton,
      closeButton,
      content,
      version: "4.0.0",
      entries: [{ current: true, date: "Today", items: ["Themed"] }]
    });

    expect(content.querySelectorAll(".theme-text")).toHaveLength(2);
    expect(content.querySelector(".theme-text-muted")).not.toBeNull();
  });
});
