const initializedInputs = new WeakSet();

function selectedDates() {
  const values = document.getElementById("departure-date")?.value
    .split(",")
    .map(value => value.trim())
    .filter(Boolean) ?? [];
  if (values.length) return values;
  const today = new Date();
  return Array.from({ length: 4 }, (_, offset) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
}

function optionElement(label, onSelect) {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "theme-option theme-text flex w-full justify-between items-center px-1 py-1.5 cursor-pointer text-left";
  option.textContent = label;
  option.addEventListener("click", onSelect);
  return option;
}

export function setupAirportAutocomplete(inputId, suggestionsId, dependencies, options = {}) {
  const input = document.getElementById(inputId);
  const suggestions = document.getElementById(suggestionsId);
  if (!input || !suggestions || initializedInputs.has(input)) return;
  initializedInputs.add(input);

  const isPreferred = inputId === "preferred-airport";
  const isDestination = inputId.toLowerCase().includes("destination");
  const isOrigin = inputId.toLowerCase().includes("origin");
  const airportOnly = options.airportOnly === true;

  function airportName(code) {
    return dependencies.airports().find(airport => airport.code === code)?.name ?? code;
  }

  function expandValues(containerId) {
    return dependencies.getValues(containerId)
      .filter(value => value.toLowerCase() !== "anywhere")
      .flatMap(dependencies.resolve)
      .flatMap(code => dependencies.groups[code] ?? [code]);
  }

  function directOptions() {
    const dates = selectedDates();
    const codes = new Set();
    if (isDestination) {
      for (const origin of expandValues("origin-multi")) {
        for (const destination of dependencies.catalog.getDestinations(origin)) {
          if (dates.some(date => dependencies.catalog.isDateAvailable(origin, destination, date))) {
            codes.add(destination);
          }
        }
      }
    } else if (isOrigin) {
      for (const destination of expandValues("destination-multi")) {
        for (const origin of dependencies.catalog.getOrigins(destination)) {
          if (dates.some(date => dependencies.catalog.isDateAvailable(origin, destination, date))) {
            codes.add(origin);
          }
        }
      }
    }
    return [...codes]
      .map(code => ({ code, name: airportName(code) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  function filteredOptions(query) {
    const normalized = query.toLowerCase();
    const countries = airportOnly ? [] : Object.keys(dependencies.countries())
      .filter(country => country.toLowerCase().includes(normalized))
      .map(country => ({ code: country, name: country }));
    const airports = dependencies.airports()
      .filter(airport => (!airportOnly || !dependencies.groups[airport.code])
        && (airport.code.toLowerCase().includes(normalized)
        || airport.name.toLowerCase().includes(normalized))
      )
      .map(airport => ({ code: airport.code, name: airport.name }));
    return [...countries, ...airports]
      .sort((left, right) => {
        const leftStarts = left.name.toLowerCase().startsWith(normalized);
        const rightStarts = right.name.toLowerCase().startsWith(normalized);
        return leftStarts === rightStarts ? left.name.localeCompare(right.name) : leftStarts ? -1 : 1;
      })
      .slice(0, 6);
  }

  function render(query = "") {
    suggestions.replaceChildren();
    let options = query || airportOnly ? filteredOptions(query) : directOptions();
    if (!isPreferred && !airportOnly) options = [{ code: "ANY", name: "Anywhere" }, ...options];
    if (!options.length) {
      suggestions.classList.add("hidden");
      return;
    }
    for (const option of options) {
      suggestions.appendChild(optionElement(option.name, () => {
        input.value = option.name;
        suggestions.classList.add("hidden");
        dependencies.onSelect?.({ inputId, option, input });
      }));
    }
    suggestions.style.maxHeight = "250px";
    suggestions.style.overflowY = "auto";
    suggestions.classList.remove("hidden");
    suggestions.classList.add("suggestions-enter");
    setTimeout(() => suggestions.classList.remove("suggestions-enter"), 300);
  }

  input.addEventListener("focus", () => render(input.value.trim().toLowerCase()));
  input.addEventListener("input", event => render(event.target.value.trim().toLowerCase()));
  document.addEventListener("click", event => {
    if (!input.contains(event.target) && !suggestions.contains(event.target)) {
      suggestions.classList.add("hidden");
    }
  });
}
