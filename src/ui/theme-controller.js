export const THEME_MODES = Object.freeze(["auto", "light", "dark"]);

export function normalizeThemeMode(value) {
  return THEME_MODES.includes(value) ? value : "auto";
}

export function resolveTheme(mode, prefersDark) {
  const normalized = normalizeThemeMode(mode);
  return normalized === "auto" ? prefersDark ? "dark" : "light" : normalized;
}

export function applyTheme(root, mode, prefersDark) {
  const normalized = normalizeThemeMode(mode);
  const resolved = resolveTheme(normalized, prefersDark);
  root.dataset.themeMode = normalized;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  return resolved;
}

export function createThemeController({
  repository,
  root = document.documentElement,
  controls = document.querySelectorAll("input[name='theme-mode']"),
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
}) {
  const inputs = [...controls];
  let mode = normalizeThemeMode(repository.load().themeMode);
  let listening = false;

  const apply = () => applyTheme(root, mode, mediaQuery.matches);
  const onSystemThemeChange = () => {
    if (mode === "auto") apply();
  };

  function attachSystemListener() {
    if (listening) return;
    if (mediaQuery.addEventListener) mediaQuery.addEventListener("change", onSystemThemeChange);
    else mediaQuery.addListener?.(onSystemThemeChange);
    listening = true;
  }

  function detachSystemListener() {
    if (!listening) return;
    if (mediaQuery.removeEventListener) mediaQuery.removeEventListener("change", onSystemThemeChange);
    else mediaQuery.removeListener?.(onSystemThemeChange);
    listening = false;
  }

  function syncControls() {
    for (const input of inputs) input.checked = input.value === mode;
  }

  function setMode(value, { persist = true } = {}) {
    mode = normalizeThemeMode(value);
    if (mode === "auto") attachSystemListener();
    else detachSystemListener();
    syncControls();
    const resolved = apply();
    if (persist) repository.update({ themeMode: mode });
    return resolved;
  }

  const onControlChange = event => {
    if (event.target.checked) setMode(event.target.value);
  };
  for (const input of inputs) input.addEventListener("change", onControlChange);
  setMode(mode, { persist: false });

  return Object.freeze({
    get mode() {
      return mode;
    },
    setMode,
    destroy() {
      detachSystemListener();
      for (const input of inputs) input.removeEventListener("change", onControlChange);
    }
  });
}
