const mountedButtons = new WeakSet();

export function validateMaxConcurrentRequestsInput(input, error) {
  const value = Number(input.value);
  const tooHigh = Number.isFinite(value) && value >= 6;
  const invalid = !Number.isFinite(value) || value < 1 || tooHigh;

  input.classList.toggle("request-setting-invalid", invalid);
  input.setAttribute("aria-invalid", String(invalid));
  error.classList.toggle("hidden", !invalid);
  error.textContent = tooHigh
    ? "Maximum 5 simultaneous requests. The active limit remains 5."
    : "Choose a value from 1 to 5.";

  return Number.isFinite(value) ? Math.max(1, Math.min(5, value)) : 3;
}

export function mountSettingsPanel({ settings, animate = () => {} }) {
  const values = {
    "preferred-airport": settings.preferredAirport,
    "min-connection-time": settings.minConnectionTime,
    "max-connection-time": settings.maxConnectionTime,
    "connection-radius": settings.connectionRadius,
    "max-requests": settings.maxRequestsInRow,
    "pause-duration": settings.pauseDurationSeconds,
    "max-concurrent-requests": settings.maxConcurrentRequests,
    "cache-lifetime": settings.cacheLifetimeHours
  };
  for (const [id, value] of Object.entries(values)) document.getElementById(id).value = value;

  const allowAirportChange = document.getElementById("allow-change-airport");
  const radiusContainer = document.getElementById("connection-radius-container");
  allowAirportChange.checked = settings.allowChangeAirport;
  radiusContainer.classList.toggle("hidden", !settings.allowChangeAirport);
  if (!mountedButtons.has(allowAirportChange)) {
    mountedButtons.add(allowAirportChange);
    allowAirportChange.addEventListener("change", () => {
      radiusContainer.classList.toggle("hidden", !allowAirportChange.checked);
    });
  }

  const toggle = document.getElementById("toggle-expert-settings");
  if (!mountedButtons.has(toggle)) {
    mountedButtons.add(toggle);
    toggle.addEventListener("click", () => {
      const panel = document.getElementById("expert-settings");
      const opening = panel.classList.contains("hidden");
      panel.classList.toggle("hidden", !opening);
      toggle.textContent = opening ? "Hide Expert Settings" : "Show Expert Settings";
      if (opening) animate(panel, "dropdown-enter", 300);
    });
  }
}
