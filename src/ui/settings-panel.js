const mountedButtons = new WeakSet();

export function mountSettingsPanel({ settings, animate = () => {} }) {
  const values = {
    "preferred-airport": settings.preferredAirport,
    "min-connection-time": settings.minConnectionTime,
    "max-connection-time": settings.maxConnectionTime,
    "connection-radius": settings.connectionRadius,
    "max-requests": settings.maxRequestsInRow,
    "requests-frequency": settings.requestsFrequencyMs,
    "pause-duration": settings.pauseDurationSeconds,
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
