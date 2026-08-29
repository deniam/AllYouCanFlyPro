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

  it("exposes the bounded request-concurrency setting", () => {
    const input = document.getElementById("max-concurrent-requests");
    expect(input?.getAttribute("min")).toBe("1");
    expect(input?.getAttribute("max")).toBe("5");
    expect(input?.getAttribute("value")).toBe("3");
    expect(document.getElementById("max-concurrent-requests-error")).not.toBeNull();
    expect(document.getElementById("requests-frequency")).toBeNull();
  });
});
