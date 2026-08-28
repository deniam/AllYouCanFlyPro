const STORAGE_KEY = "customAirportGroups";

export function createCustomGroupsController({
  storage = localStorage,
  groups,
  groupNames,
  airportLookup,
  airports,
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
      empty.className = "text-xs text-gray-500 mb-2";
      empty.textContent = "No custom groups yet.";
      list.append(empty);
      return;
    }
    for (const group of saved) {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between bg-white border border-gray-300 rounded px-2 py-1 mb-1 text-xs gap-1";
      const key = document.createElement("span");
      key.className = "font-semibold text-[#20006D] shrink-0";
      key.textContent = `[${group.key}]`;
      const name = document.createElement("span");
      name.className = "font-medium truncate flex-1";
      name.textContent = group.name;
      const codes = document.createElement("span");
      codes.className = "text-gray-500 shrink-0";
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

  function initialize() {
    if (initialized) return;
    initialized = true;
    load().forEach(apply);
    render();
    document.getElementById("toggle-custom-groups").addEventListener("click", () => {
      document.getElementById("custom-groups-panel").classList.toggle("hidden");
    });
    const keyInput = document.getElementById("custom-group-key");
    keyInput.addEventListener("input", () => {
      keyInput.value = keyInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    });
    document.getElementById("add-custom-group-btn").addEventListener("click", () => {
      const nameInput = document.getElementById("custom-group-name");
      const airportsInput = document.getElementById("custom-group-airports");
      const name = nameInput.value.trim();
      const key = keyInput.value.trim().toUpperCase();
      const codes = [...new Set(airportsInput.value.split(",").map(value => value.trim().toUpperCase()).filter(Boolean))];
      if (!name) return notify("Please enter a group name.");
      if (!/^[A-Z0-9]{2,6}$/.test(key)) return notify("Tag must be 2–6 uppercase letters/digits.");
      if (groups[key] || airportLookup[key]) return notify(`Tag "${key}" is already in use.`);
      if (codes.length < 2) return notify("Please enter at least 2 airport codes.");
      const unknown = codes.filter(code => !airportLookup[code]);
      if (unknown.length) return notify(`Unknown airport codes: ${unknown.join(", ")}`);
      const group = { key, name, airports: codes };
      save([...load(), group]);
      apply(group);
      render();
      nameInput.value = "";
      keyInput.value = "";
      airportsInput.value = "";
      notify(`Group "${name}" [${key}] added!`);
    });
  }

  return Object.freeze({ load, save, apply, remove, render, initialize });
}
