import { mountApp } from "./app-controller.js";
import { appState } from "./state.js";
import { getAppElements } from "../ui/dom.js";

mountApp({
  state: appState,
  services: Object.freeze({}),
  elements: getAppElements(),
  initialize: async ({ elements }) => {
    const { bootstrap } = await import("../app.js");
    return bootstrap(elements);
  }
}).catch(error => {
  console.error("AYCF startup failed:", error);
  const banner = document.getElementById("notification-banner");
  const text = document.getElementById("notification-text");
  if (banner && text) {
    text.textContent = `Extension startup failed: ${error.message}`;
    banner.classList.remove("hidden");
  }
});
