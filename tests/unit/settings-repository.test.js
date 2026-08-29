import { describe, expect, it, vi } from "vitest";
import {
  createSettingsRepository,
  SETTINGS_DEFAULTS
} from "../../src/infrastructure/settings-repository.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value)
  };
}

describe("settings repository", () => {
  it("preserves legacy keys and applies typed defaults", () => {
    const repository = createSettingsRepository(memoryStorage({
      allowChangeAirport: "true",
      maxRequestsInRow: "25"
    }));
    expect(repository.load()).toMatchObject({
      ...SETTINGS_DEFAULTS,
      allowChangeAirport: true,
      maxRequestsInRow: 25
    });
  });

  it("clamps invalid numeric values and notifies subscribers", () => {
    const repository = createSettingsRepository(memoryStorage());
    const listener = vi.fn();
    repository.subscribe(listener);
    const settings = repository.update({ connectionRadius: 99999 });
    expect(settings.connectionRadius).toBe(2000);
    expect(listener).toHaveBeenCalledOnce();
  });

  it.each(["auto", "light", "dark"])("stores the %s theme mode", mode => {
    const repository = createSettingsRepository(memoryStorage());
    expect(repository.update({ themeMode: mode }).themeMode).toBe(mode);
  });

  it("defaults invalid and missing theme modes to auto", () => {
    expect(createSettingsRepository(memoryStorage()).load().themeMode).toBe("auto");
    expect(createSettingsRepository(memoryStorage({ themeMode: "unknown" })).load().themeMode).toBe("auto");
  });
});
