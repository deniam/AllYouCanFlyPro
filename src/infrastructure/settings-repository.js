export const SETTINGS_DEFAULTS = Object.freeze({
  minConnectionTime: 90,
  maxConnectionTime: 1440,
  preferredAirport: "",
  allowChangeAirport: false,
  connectionRadius: 100,
  maxRequestsInRow: 50,
  requestsFrequencyMs: 1800,
  pauseDurationSeconds: 15,
  cacheLifetimeHours: 4,
  debugMode: false,
  themeMode: "auto"
});

const SCHEMA = Object.freeze({
  minConnectionTime: { type: "number", min: 0, max: 10080 },
  maxConnectionTime: { type: "number", min: 1, max: 10080 },
  preferredAirport: { type: "string" },
  allowChangeAirport: { type: "boolean" },
  connectionRadius: { type: "number", min: 0, max: 2000 },
  maxRequestsInRow: { type: "number", min: 1, max: 10000 },
  requestsFrequencyMs: { type: "number", min: 0, max: 60000 },
  pauseDurationSeconds: { type: "number", min: 0, max: 3600 },
  cacheLifetimeHours: { type: "number", min: 0.1, max: 720 },
  debugMode: { type: "boolean" },
  themeMode: { type: "enum", values: ["auto", "light", "dark"] }
});

function parseValue(key, value) {
  const rule = SCHEMA[key];
  if (!rule) return undefined;
  if (value === null || value === undefined || value === "") return SETTINGS_DEFAULTS[key];
  if (rule.type === "boolean") return value === true || value === "true";
  if (rule.type === "string") return String(value);
  if (rule.type === "enum") return rule.values.includes(value) ? value : SETTINGS_DEFAULTS[key];
  const number = Number(value);
  if (!Number.isFinite(number)) return SETTINGS_DEFAULTS[key];
  return Math.min(rule.max, Math.max(rule.min, number));
}

export function createSettingsRepository(storage = localStorage) {
  const listeners = new Set();

  function load() {
    return Object.fromEntries(Object.keys(SCHEMA).map(key => [
      key,
      parseValue(key, storage.getItem(key))
    ]));
  }

  function update(patch) {
    for (const [key, rawValue] of Object.entries(patch)) {
      if (!SCHEMA[key]) continue;
      const value = parseValue(key, rawValue);
      storage.setItem(key, String(value));
    }
    const settings = load();
    for (const listener of listeners) listener(settings);
    return settings;
  }

  return Object.freeze({
    load,
    update,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}
