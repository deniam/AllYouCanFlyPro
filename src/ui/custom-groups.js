const STORAGE_KEY = "customAirportGroups";

export function createCustomGroupsController({
  storage = localStorage,
  groups,
  groupNames,
  airportLookup,
  airports,
  airportFields,
  resolveAirport,
  notify
}) {
  let initialized = false;
  function load() {
    try {
      const value = JSON.parse(storage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function save(value) {
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
  }

  function apply(group) {
    groups[group.key] = [...group.airports];
    groupNames[group.key] = group.name;
    if (airportLookup[group.key]) return;
    const airport = { code: group.key, name: group.name, country: "", flag: "✈️" };
    airportLookup[group.key] = airport;
    airports.push(airport);
    airports.sort((left, right) => left.code.localeCompare(right.code));
  }

  function remove(key) {
    delete groups[key];
    delete groupNames[key];
    delete airportLookup[key];
    const index = airports.findIndex(airport => airport.code === key);
    if (index >= 0) airports.splice(index, 1);
  }

  function render() {
    const list = document.getElementById("custom-groups-list");
    const saved = load();
    list.replaceChildren();
    if (!saved.length) {
      const empty = document.createElement("p");
      empty.className = "theme-text-muted text-xs mb-2";
      empty.textContent = "No custom groups yet.";
      list.append(empty);
      return;
    }
    for (const group of saved) {
      const row = document.createElement("div");
      row.className = "theme-surface-raised theme-border flex items-center justify-between border rounded px-2 py-1 mb-1 text-xs gap-1";
      const key = document.createElement("span");
      key.className = "theme-brand-text font-semibold shrink-0";
      key.textContent = `[${group.key}]`;
      const name = document.createElement("span");
      name.className = "font-medium truncate flex-1";
      name.textContent = group.name;
      const codes = document.createElement("span");
      codes.className = "theme-text-muted shrink-0";
      codes.textContent = group.airports.join(", ");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "delete-custom-group shrink-0 bg-red-500 hover:bg-red-600 text-white rounded px-1.5 py-0.5 cursor-pointer";
      button.dataset.key = group.key;
      button.setAttribute("aria-label", `Delete ${group.name}`);
      button.textContent = "✕";
      button.addEventListener("click", () => {
        const groupKey = button.dataset.key;
        save(load().filter(item => item.key !== groupKey));
        remove(groupKey);
        render();
        notify(`Custom group "${groupKey}" removed.`);
      });
      row.append(key, name, codes, button);
      list.append(row);
    }
  }

  function airportCodes(values) {
    const resolved = values.map(value => {
      if (typeof resolveAirport === "function") return resolveAirport(value);
      const normalized = value.trim().toUpperCase();
      const exact = airportLookup[normalized];
      if (exact) return [exact.code];
      const airport = airports.find(item => item.name.toLowerCase() === value.trim().toLowerCase());
      return airport ? [airport.code] : [];
    });
    return {
      codes: [...new Set(resolved.flat().filter(code => airportLookup[code]))],
      hasInvalid: resolved.some(codes => !codes.length || codes.some(code => !airportLookup[code]))
    };
  }

  function initialize() {
    if (initialized) return;
    initialized = true;
    load().forEach(apply);
    render();
    document.getElementById("toggle-custom-groups").addEventListener("click", () => {
      document.getElementById("custom-groups-panel").classList.toggle("hidden");
    });
    airportFields?.initialize("custom-group-airports", "custom-group-airport");
    const keyInput = document.getElementById("custom-group-key");
    keyInput.addEventListener("input", () => {
      keyInput.value = keyInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    });
    document.getElementById("add-custom-group-btn").addEventListener("click", () => {
      const nameInput = document.getElementById("custom-group-name");
      const name = nameInput.value.trim();
      const key = keyInput.value.trim().toUpperCase();
      const values = airportFields?.values("custom-group-airports") ?? [];
      const { codes, hasInvalid } = airportCodes(values);
      if (!name) return notify("Please enter a group name.");
      if (!/^[A-Z0-9]{2,6}$/.test(key)) return notify("Tag must be 2–6 uppercase letters/digits.");
      if (groups[key] || airportLookup[key]) return notify(`Tag "${key}" is already in use.`);
      if (hasInvalid) return notify("Please select airports from the lookup.");
      if (codes.length < 2) return notify("Please enter at least 2 airport codes.");
      const group = { key, name, airports: codes };
      save([...load(), group]);
      apply(group);
      render();
      nameInput.value = "";
      keyInput.value = "";
      airportFields?.initialize("custom-group-airports", "custom-group-airport");
      notify(`Group "${name}" [${key}] added!`);
    });
  }

  return Object.freeze({ load, save, apply, remove, render, initialize });
}
