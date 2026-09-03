export function createAirportFields({ setupAutocomplete, maxRows = 3, autocompleteOptions = {} }) {
  let nextId = 0;

  function values(containerId) {
    const container = document.getElementById(containerId);
    return container
      ? [...container.querySelectorAll("input")].map(input => input.value.trim()).filter(Boolean)
      : [];
  }

  function update(container) {
    const rows = [...container.querySelectorAll(".airport-row")];
    rows.forEach((row, index) => {
      const remove = row.querySelector(".delete-btn");
      const add = row.querySelector(".plus-btn");
      if (remove) remove.hidden = false;
      if (add) add.hidden = rows.length >= maxRows || index !== rows.length - 1;
    });
  }

  function addRow(container, fieldName, value = "") {
    if (container.querySelectorAll(".airport-row").length >= maxRows) return null;
    const row = document.createElement("div");
    row.className = "airport-row flex items-center gap-1 mb-1";
    const wrapper = document.createElement("div");
    wrapper.className = "relative flex-1";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = fieldName === "origin" ? "Origin" : fieldName === "destination" ? "Destination" : "Enter Airport";
    input.className = "theme-text theme-border block w-full bg-transparent border rounded-md px-1 py-2 focus:outline-none focus:ring-2 focus:ring-[#C90076]";
    input.id = `${fieldName}-input-${++nextId}`;
    input.value = value;
    input.setAttribute("autocomplete", "off");
    const suggestions = document.createElement("div");
    suggestions.id = `${input.id}-suggestions`;
    suggestions.className = "theme-surface-raised theme-border theme-text absolute top-full left-0 right-0 border rounded-md shadow-lg z-20 text-sm hidden";
    wrapper.append(input, suggestions);

    const controls = document.createElement("div");
    controls.className = "flex flex-col items-center justify-start gap-1";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "−";
    remove.setAttribute("aria-label", `Remove ${fieldName} airport`);
    remove.className = "delete-btn w-5 h-5 text-white text-xs bg-[#20006D] rounded-xl hover:bg-red-600 flex items-center justify-center cursor-pointer";
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "+";
    add.setAttribute("aria-label", `Add ${fieldName} airport`);
    add.className = "plus-btn w-5 h-5 text-white text-xs bg-[#C90076] rounded-xl hover:bg-[#A00065] flex items-center justify-center cursor-pointer";
    controls.append(remove, add);
    row.append(wrapper, controls);
    container.appendChild(row);

    remove.addEventListener("click", () => {
      row.remove();
      if (!container.querySelector(".airport-row")) addRow(container, fieldName);
      update(container);
    });
    add.addEventListener("click", () => {
      addRow(container, fieldName);
      update(container);
    });
    input.addEventListener("input", () => update(container));
    setupAutocomplete(input.id, suggestions.id, autocompleteOptions);
    update(container);
    return input;
  }

  function initialize(containerId, fieldName, initialValues = []) {
    const container = document.getElementById(containerId);
    if (!container) throw new Error(`Airport field container is missing: ${containerId}`);
    container.replaceChildren();
    container.style.background = "transparent";
    container.style.border = "none";
    const valuesToAdd = initialValues.length ? initialValues : [""];
    valuesToAdd.slice(0, maxRows).forEach(value => addRow(container, fieldName, value));
    update(container);
  }

  function swap() {
    const origins = values("origin-multi");
    const destinations = values("destination-multi");
    initialize("origin-multi", "origin", destinations);
    initialize("destination-multi", "destination", origins);
  }

  return Object.freeze({ initialize, addRow, update, values, swap });
}
