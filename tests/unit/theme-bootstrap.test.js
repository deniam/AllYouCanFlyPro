// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

const source = fs.readFileSync("src/ui/theme-bootstrap.js", "utf8");

function runBootstrap(mode, prefersDark) {
  localStorage.clear();
  if (mode !== null) localStorage.setItem("themeMode", mode);
  window.matchMedia = vi.fn(() => ({ matches: prefersDark }));
  window.eval(source);
  return { ...document.documentElement.dataset };
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-mode");
  document.documentElement.style.colorScheme = "";
});

describe("early theme bootstrap", () => {
  it("uses the saved manual mode instead of the system preference", () => {
    expect(runBootstrap("light", true)).toMatchObject({ themeMode: "light", theme: "light" });
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("resolves Auto from the system preference", () => {
    expect(runBootstrap("auto", true)).toMatchObject({ themeMode: "auto", theme: "dark" });
  });

  it("treats a missing or invalid value as Auto", () => {
    expect(runBootstrap("broken", false)).toMatchObject({ themeMode: "auto", theme: "light" });
    expect(runBootstrap(null, true)).toMatchObject({ themeMode: "auto", theme: "dark" });
  });
});
