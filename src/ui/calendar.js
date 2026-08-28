import { parseLocalDate } from "../domain/dates.js";

const initializedInputs = new WeakSet();
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function button(label, ariaLabel) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.setAttribute("aria-label", ariaLabel);
  element.className = "px-2 py-1 bg-gray-200 rounded hover:bg-gray-300 text-sm";
  return element;
}

export function renderCalendarMonth(
  popup,
  inputId,
  year,
  month,
  maxDaysAhead,
  selectedDates,
  minSelectableDate = null
) {
  popup.replaceChildren();
  const input = document.getElementById(inputId);

  const header = document.createElement("div");
  header.className = "flex justify-between items-center mb-2";
  const previous = button("←", "Previous month");
  const next = button("→", "Next month");
  const title = document.createElement("div");
  title.className = "font-bold text-sm mx-2 flex-1 text-center";
  title.textContent = `${MONTHS[month]} ${year}`;
  header.append(previous, title, next);
  popup.appendChild(header);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const minimum = minSelectableDate ? parseLocalDate(minSelectableDate) : today;
  const maximum = new Date(today.getFullYear(), today.getMonth(), today.getDate() + maxDaysAhead);
  previous.disabled = new Date(year, month) <= new Date(minimum.getFullYear(), minimum.getMonth());
  previous.classList.toggle("opacity-50", previous.disabled);
  previous.classList.toggle("cursor-not-allowed", previous.disabled);

  previous.addEventListener("click", event => {
    event.stopPropagation();
    const date = new Date(year, month - 1, 1);
    renderCalendarMonth(popup, inputId, date.getFullYear(), date.getMonth(), maxDaysAhead, selectedDates, minSelectableDate);
  });
  next.addEventListener("click", event => {
    event.stopPropagation();
    const date = new Date(year, month + 1, 1);
    renderCalendarMonth(popup, inputId, date.getFullYear(), date.getMonth(), maxDaysAhead, selectedDates, minSelectableDate);
  });

  const weekdays = document.createElement("div");
  weekdays.className = "grid grid-cols-7 text-center text-xs font-semibold mb-2";
  ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach((label, index) => {
    const day = document.createElement("div");
    day.textContent = label;
    day.classList.add(index > 4 ? "text-[#C90076]" : "text-[#20006D]", "font-semibold");
    weekdays.appendChild(day);
  });
  popup.appendChild(weekdays);

  const grid = document.createElement("div");
  grid.className = "grid grid-cols-7 text-center text-xs gap-1";
  const weekdayOffset = (new Date(year, month, 1).getDay() + 6) % 7;
  for (let index = 0; index < weekdayOffset; index++) {
    const blank = document.createElement("div");
    blank.className = "p-2";
    grid.appendChild(blank);
  }

  const days = new Date(year, month + 1, 0).getDate();
  for (let dayNumber = 1; dayNumber <= days; dayNumber++) {
    const date = new Date(year, month, dayNumber);
    const dateText = `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
    const cell = button(String(dayNumber), dateText);
    cell.className = "border rounded text-xs leading-tight flex items-center justify-center p-[2px]";
    const disabled = date < minimum || date > maximum;
    cell.disabled = disabled;
    if (disabled) cell.classList.add("bg-gray-200", "cursor-not-allowed", "text-gray-500");
    else {
      cell.classList.add("font-bold", "cursor-pointer");
      if (date.getDay() === 0 || date.getDay() === 6) cell.classList.add("bg-pink-50");
      if (selectedDates.has(dateText)) cell.classList.add("bg-blue-300");
      cell.addEventListener("click", event => {
        event.stopPropagation();
        if (selectedDates.has(dateText)) selectedDates.delete(dateText);
        else selectedDates.add(dateText);
        input.value = [...selectedDates].sort().join(", ");
        input.dispatchEvent(new Event("change"));
        renderCalendarMonth(popup, inputId, year, month, maxDaysAhead, selectedDates, minSelectableDate);
      });
    }
    grid.appendChild(cell);
  }
  popup.appendChild(grid);

  const actions = document.createElement("div");
  actions.className = "flex justify-end mt-2";
  const done = button("Done", "Close calendar");
  done.className = "px-2 py-1 bg-[#C90076] text-white rounded-lg hover:bg-[#A00065] text-sm cursor-pointer";
  done.addEventListener("click", () => popup.classList.add("hidden"));
  actions.appendChild(done);
  popup.appendChild(actions);
}

export function initMultiCalendar(inputId, popupId, maxDaysAhead = 3) {
  const input = document.getElementById(inputId);
  const popup = document.getElementById(popupId);
  if (!input || !popup) throw new Error(`Calendar elements are missing: ${inputId}/${popupId}`);
  if (initializedInputs.has(input)) return;
  initializedInputs.add(input);

  let visibleYear = new Date().getFullYear();
  let visibleMonth = new Date().getMonth();
  input.addEventListener("click", event => {
    event.stopPropagation();
    const selected = new Set(input.value.split(",").map(value => value.trim()).filter(Boolean));
    if (selected.size) {
      const first = parseLocalDate([...selected][0]);
      if (!Number.isNaN(first.getTime())) {
        visibleYear = first.getFullYear();
        visibleMonth = first.getMonth();
      }
    }
    const departure = inputId === "return-date"
      ? document.getElementById("departure-date")?.value.split(",")[0]?.trim() || null
      : null;
    renderCalendarMonth(popup, inputId, visibleYear, visibleMonth, maxDaysAhead, selected, departure);
    const baseWidth = 220;
    popup.style.transformOrigin = "top left";
    popup.style.transform = `scale(${input.offsetWidth / baseWidth})`;
    popup.style.left = "0";
    popup.style.top = "100%";
    popup.style.width = `${baseWidth}px`;
    popup.classList.remove("hidden");
  });
  document.addEventListener("click", event => {
    if (!popup.contains(event.target) && !input.contains(event.target)) popup.classList.add("hidden");
  });
}
