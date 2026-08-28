import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

describe("extension structure", () => {
  const html = readFileSync("index.html", "utf8");
  const document = new JSDOM(html).window.document;

  it("has unique element ids", () => {
    const ids = [...document.querySelectorAll("[id]")].map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("loads the modular application entry point and local CSS", () => {
    expect(document.querySelector('script[type="module"]')?.getAttribute("src"))
      .toBe("src/app/main.js");
    expect(document.querySelector('link[href="assets/css/app.css"]')).not.toBeNull();
  });

  it("provides separate donation controls", () => {
    expect(document.querySelectorAll(".donate-link")).toHaveLength(2);
  });
});
