export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function requireElement(id, root = document) {
  const element = root.getElementById(id);
  if (!element) throw new Error(`Required UI element is missing: #${id}`);
  return element;
}

export function getAppElements(root = document) {
  const ids = [
    "search-button", "origin-multi", "destination-multi", "departure-date",
    "return-date", "results-container", "progress-container", "progress-text",
    "progress-bar", "notification-banner", "notification-text", "sort-select",
    "selected-stopover", "changelog-modal", "changelog-content"
  ];
  return Object.freeze(Object.fromEntries(ids.map(id => [id, requireElement(id, root)])));
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  queueMicrotask(() => {
    link.remove();
    URL.revokeObjectURL(url);
  });
}
