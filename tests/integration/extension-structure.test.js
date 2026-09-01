import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("loads the theme bootstrap before styles and exposes all theme modes", () => {
    const headChildren = [...document.head.children];
    const themeScript = document.querySelector('script[src="./src/ui/theme-bootstrap.js"]');
    const stylesheet = document.querySelector('link[href="assets/css/app.css"]');
    expect(themeScript).not.toBeNull();
    expect(headChildren.indexOf(themeScript)).toBeLessThan(headChildren.indexOf(stylesheet));
    expect([...document.querySelectorAll('input[name="theme-mode"]')].map(input => input.value))
      .toEqual(["auto", "light", "dark"]);
  });

  it("provides separate donation controls", () => {
    expect(document.querySelectorAll(".donate-link")).toHaveLength(2);
  });

  it("injects the donation completion marker only on the Stripe success page", () => {
    const successScript = JSON.parse(readFileSync(resolve("manifest.json"), "utf8"))
      .content_scripts.find(script => script.js?.includes("src/donation-success.js"));
    expect(successScript).toEqual({
      matches: ["https://deniam.github.io/AllYouCanFlyPro/donation-success.html*"],
      js: ["src/donation-success.js"],
      run_at: "document_start"
    });
  });

  it("exposes the accessible sorting controls without fare or airport-change ranking", () => {
    expect(document.querySelector('label[for="sort-select"]')?.textContent).toBe("Sort by");
    expect(document.getElementById("sort-direction-select")).not.toBeNull();
    expect(document.getElementById("return-sort-select")).not.toBeNull();
    expect(document.querySelector('label[for="return-sort-select"]')?.textContent).toBe("Return options");
    expect([...document.querySelectorAll("#return-sort-select option")].map(option => option.textContent))
      .toEqual(["Earliest departure", "Earliest arrival", "Shortest journey"]);
    const values = [...document.querySelectorAll("#sort-select option")].map(option => option.value);
    expect(values).toContain("arrivalAirport");
    expect(values).toContain("transfers");
    expect(values).not.toContain("price");
    expect(values).not.toContain("airportChange");
  });

  it("exposes the bounded request-concurrency setting and its warning", () => {
    const input = document.getElementById("max-concurrent-requests");
    expect(input?.getAttribute("min")).toBe("1");
    expect(input?.getAttribute("max")).toBe("50");
    expect(input?.getAttribute("value")).toBe("15");
    expect(document.getElementById("max-requests")?.getAttribute("value")).toBe("1000");
    expect(document.getElementById("max-concurrent-requests-error")).not.toBeNull();
    expect(document.getElementById("max-concurrent-requests-warning")).not.toBeNull();
    expect(document.getElementById("requests-frequency")).toBeNull();
  });
});
