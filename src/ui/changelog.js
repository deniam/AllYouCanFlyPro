export const CHANGELOG = Object.freeze([
  {
    current: true,
    date: "September 2, 2026",
    items: [
      "Replaced eager connecting-route expansion with a lazy, date-aware layered graph for one-stop and two-stop searches, including overnight connections, ANY origins/destinations, airport changes, flightDates and booking-window filtering.",
      "Added shared availability nodes and partial flight-chain states so one availability request can serve multiple branches while flights at different times remain separate results.",
      "Removed the planner's hard concurrency cap of four. Direct and connecting searches now use the user's Max Concurrent Requests through one global staggered scheduler.",
      "Improved adaptive request concurrency with transient-failure windows, recovery, rate-limit cooldowns and search-scoped concurrency diagnostics.",
      "Added date-aware cache preflight, single-flight request coalescing, branch pruning and stable flight-instance/result deduplication.",
      "Improved incomplete-search handling: confirmed unavailable routes are pruned, while timeouts and transport failures remain retryable UNKNOWN checks.",
      "Expanded automated coverage for layered planning, overnight and airport-change routes, cache behavior, scheduler adaptation and concurrent availability requests."
    ]
  },
  {
    version: "4.0.0",
    date: "August 31, 2026",
    items: [
      "Rebuilt the project structure into a modular, layered architecture: application state, domain logic, infrastructure services, and UI components are now separated into independent modules.",
      "Introduced a new search orchestration layer for direct, connecting, and round-trip searches, with normalized flight data and shared result matching.",
      "Added streamed round-trip results and improved result sorting and rendering, including better cached connecting-flight cards.",
      "Improved round-trip caching by selecting uncached paired dates and warming reverse-segment cache entries when possible.",
      "Added adaptive request concurrency, centralized request throttling, configurable concurrency limits, and an availability-request timeout.",
      "Improved Multipass authentication, handling of empty or malformed responses, session state, and opening Multipass in the current browser tab.",
      "Added remote route-dataset loading with manifest and checksum validation, local cache support, and a packaged offline fallback.",
      "Added configurable dark mode, improved mobile flight-card layout, and fixed weekend date-selection and live-search issues.",
      "Added route-exclusion persistence and improved cache/settings storage while preserving compatibility with existing data.",
      "Added automated unit and integration tests, syntax checks, extension validation, and a manual smoke-test checklist."
    ]
  },
  {
    version: "3.6.0",
    date: "August 29, 2026",
    items: ["Updated routesData with schedule until 2026-10-31."]
  },
  {
    version: "3.5.0",
    date: "July 1, 2026",
    items: [
      "Improved search speed for connecting flights: the search algorithm for 1-stop and 2-stop flights now skips unnecessary checks when a key part of the route has no available flights.",
      "Added Custom Airport Groups in Options: users can create and save airport groups and search them like built-in city groups."
    ]
  },
  { version: "3.4.4", date: "June 30, 2026", items: ["Updated routesData with schedule until 2026-08-30."] },
  { version: "3.4.3", date: "April 27, 2026", items: ["Updated routesData with schedule until 2026-06-30."] },
  { version: "3.4.1", date: "February 25, 2026", items: ["Updated routesData with schedule until 2026-04-30."] },
  {
    version: "3.4.0",
    date: "December 9, 2025",
    items: [
      "Fixed dynamic URL creation for users whose subscription is no longer active.",
      "Updated routesData with schedule until 2026-02-28."
    ]
  },
  { version: "3.3.6", date: "November 26, 2025", items: ["Updated routesData with schedule until 2025-12-31."] },
  {
    version: "3.3.5",
    date: "October 24, 2025",
    items: ["Fixed bookable-date calculations around DST.", "Added missing emoji rendering on Windows and Android."]
  },
  { version: "3.3.4", date: "October 5, 2025", items: ["Updated routesData with schedule until 2025-11-30."] },
  {
    version: "3.3.3",
    date: "September 2, 2025",
    items: [
      "Added missing About-menu emoji on Windows and Android.",
      "Fixed operationStartDate filtering when multiple dates are selected.",
      "Updated routesData with schedule from 2025-09-01 until 2025-10-31."
    ]
  },
  {
    version: "3.3.2",
    date: "July 31, 2025",
    items: ["Added the debug logger to Expert Settings.", "Updated the toolbar links.", "Bug fixes."]
  }
]);

function createEntry(entry, currentVersion) {
  const container = document.createElement("section");
  container.className = "mb-4 pb-3 border-b";
  const heading = document.createElement("div");
  heading.className = "flex items-center mb-2";
  const badge = document.createElement("span");
  badge.className = "version-badge bg-[#C90076] text-white text-xs font-bold px-2 py-1 rounded mr-2";
  badge.textContent = `v.${entry.current ? currentVersion : entry.version}`;
  if (entry.current) {
    badge.id = "version-display";
    badge.dataset.currentVersion = "";
  }
  const date = document.createElement("span");
  date.className = "theme-text font-medium";
  date.textContent = entry.date;
  heading.append(badge, date);
  const title = document.createElement("h2");
  title.className = "font-bold";
  title.textContent = "Changelog";
  const list = document.createElement("ul");
  list.className = "theme-text list-disc pl-5 space-y-1";
  for (const text of entry.items) {
    const item = document.createElement("li");
    item.textContent = text;
    list.append(item);
  }
  container.append(heading, title, list);
  return container;
}

export function mountChangelog({ modal, openButton, closeButton, content, version, entries = CHANGELOG }) {
  content.replaceChildren(...entries.map(entry => createEntry(entry, version)));
  const footer = document.createElement("span");
  footer.className = "theme-text-muted text-xs";
  footer.textContent = "2025, Denys Shkodynskyi";
  content.append(footer);

  let previousFocus = null;
  const close = () => {
    modal.classList.add("hidden");
    document.body.classList.remove("overflow-hidden");
    previousFocus?.focus();
  };
  openButton.addEventListener("click", () => {
    previousFocus = document.activeElement;
    modal.classList.remove("hidden");
    document.body.classList.add("overflow-hidden");
    closeButton.focus();
  });
  closeButton.addEventListener("click", close);
  modal.addEventListener("click", event => {
    if (event.target === modal) close();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) close();
  });
}
