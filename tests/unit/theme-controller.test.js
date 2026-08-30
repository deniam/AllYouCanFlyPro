// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  createThemeController,
  normalizeThemeMode,
  resolveTheme
} from "../../src/ui/theme-controller.js";

function repository(initial = "auto") {
  let themeMode = initial;
  return {
    load: () => ({ themeMode }),
    update: vi.fn(patch => {
      themeMode = patch.themeMode;
      return { themeMode };
    })
  };
}

function mediaQuery(matches = false) {
  const listeners = new Set();
  return {
    matches,
    addEventListener: vi.fn((_, listener) => listeners.add(listener)),
    removeEventListener: vi.fn((_, listener) => listeners.delete(listener)),
    change(next) {
      this.matches = next;
      listeners.forEach(listener => listener({ matches: next }));
    }
  };
}

function controls() {
  return ["auto", "light", "dark"].map(value => {
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "theme-mode";
    input.value = value;
    return input;
  });
}

describe("theme controller", () => {
  it("normalizes and resolves supported modes", () => {
    expect(normalizeThemeMode("invalid")).toBe("auto");
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("applies the selected and resolved themes to the document root", () => {
    expect(applyTheme(document.documentElement, "dark", false)).toBe("dark");
    expect(document.documentElement.dataset).toMatchObject({ themeMode: "dark", theme: "dark" });
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("follows system changes only while Auto is selected", () => {
    const storage = repository("auto");
    const media = mediaQuery(false);
    const inputs = controls();
    const controller = createThemeController({ repository: storage, controls: inputs, mediaQuery: media });

    expect(document.documentElement.dataset.theme).toBe("light");
    media.change(true);
    expect(document.documentElement.dataset.theme).toBe("dark");

    controller.setMode("light");
    expect(inputs.find(input => input.value === "light").checked).toBe(true);
    expect(media.removeEventListener).toHaveBeenCalledOnce();
    media.change(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(storage.update).toHaveBeenLastCalledWith({ themeMode: "light" });
  });

  it("updates the mode from the segmented controls and cleans up listeners", () => {
    const storage = repository();
    const media = mediaQuery();
    const inputs = controls();
    const controller = createThemeController({ repository: storage, controls: inputs, mediaQuery: media });
    const dark = inputs.find(input => input.value === "dark");

    dark.checked = true;
    dark.dispatchEvent(new Event("change"));
    expect(controller.mode).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    controller.destroy();
    expect(media.removeEventListener).toHaveBeenCalled();
  });
});
