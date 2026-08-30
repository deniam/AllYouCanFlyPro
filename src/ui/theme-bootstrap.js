(() => {
  const validModes = new Set(["auto", "light", "dark"]);
  const savedMode = localStorage.getItem("themeMode");
  const mode = validModes.has(savedMode) ? savedMode : "auto";
  const prefersDark = typeof matchMedia === "function"
    && matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = mode === "auto" ? prefersDark ? "dark" : "light" : mode;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
