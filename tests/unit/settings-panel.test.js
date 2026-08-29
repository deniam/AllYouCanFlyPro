import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { validateMaxConcurrentRequestsInput } from "../../src/ui/settings-panel.js";

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
  it("accepts five concurrent requests", () => {
    const { input, error } = fields(5);

    expect(validateMaxConcurrentRequestsInput(input, error)).toBe(5);
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(input.classList.contains("request-setting-invalid")).toBe(false);
    expect(error.classList.contains("hidden")).toBe(true);
  });

  it("marks six or more requests red and explains the active limit", () => {
    const { input, error } = fields(6);

    expect(validateMaxConcurrentRequestsInput(input, error)).toBe(5);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.classList.contains("request-setting-invalid")).toBe(true);
    expect(error.classList.contains("hidden")).toBe(false);
    expect(error.textContent).toContain("Maximum 5");
  });
});
