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

  it("uses the updated search settings defaults", () => {
    const settings = createSettingsRepository(memoryStorage()).load();

    expect(settings.maxRequestsInRow).toBe(1000);
    expect(settings.maxConcurrentRequests).toBe(15);
  });

  it("clamps invalid numeric values and notifies subscribers", () => {
    const repository = createSettingsRepository(memoryStorage());
    const listener = vi.fn();
    repository.subscribe(listener);
    const settings = repository.update({ connectionRadius: 99999 });
    expect(settings.connectionRadius).toBe(2000);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("stores request concurrency without an upper limit", () => {
    const repository = createSettingsRepository(memoryStorage());
    expect(repository.load().maxConcurrentRequests).toBe(15);
    expect(repository.update({ maxConcurrentRequests: 2 }).maxConcurrentRequests).toBe(2);
    expect(repository.update({ maxConcurrentRequests: 5 }).maxConcurrentRequests).toBe(5);
    expect(repository.update({ maxConcurrentRequests: 99 }).maxConcurrentRequests).toBe(50);
    expect(repository.update({ maxConcurrentRequests: 0 }).maxConcurrentRequests).toBe(1);
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
