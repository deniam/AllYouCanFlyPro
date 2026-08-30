import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  updateMaxConcurrentRequestsWarning,
  validateMaxConcurrentRequestsInput
} from "../../src/ui/settings-panel.js";

function fields(value) {
  const document = new JSDOM(`
    <input id="limit" value="${value}">
    <p id="error" class="hidden"></p>
  `).window.document;
  return {
    input: document.getElementById("limit"),
    error: document.getElementById("error")
  };
}

describe("maximum concurrent request validation", () => {
  it("accepts up to fifty concurrent requests", () => {
    const { input, error } = fields(50);

    expect(validateMaxConcurrentRequestsInput(input, error)).toBe(50);
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(input.classList.contains("request-setting-invalid")).toBe(false);
    expect(error.classList.contains("hidden")).toBe(true);
  });

  it("marks values above fifty red and clamps them", () => {
    const { input, error } = fields(51);

    expect(validateMaxConcurrentRequestsInput(input, error)).toBe(50);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.classList.contains("request-setting-invalid")).toBe(true);
    expect(error.classList.contains("hidden")).toBe(false);
    expect(error.textContent).toContain("Maximum 50");
  });

  it("shows a warning only when the value is increased", () => {
    const document = new JSDOM('<p id="warning" class="hidden"></p>').window.document;
    const warning = document.getElementById("warning");

    expect(updateMaxConcurrentRequestsWarning(warning, 16, 15)).toBe(true);
    expect(warning.classList.contains("hidden")).toBe(false);
    expect(updateMaxConcurrentRequestsWarning(warning, 15, 15)).toBe(false);
    expect(warning.classList.contains("hidden")).toBe(true);
  });
});
