export function createNotifier({ banner, text, durationMs = 3000 }) {
  let hideTimeout;
  let finishTimeout;
  return message => {
    clearTimeout(hideTimeout);
    clearTimeout(finishTimeout);
    text.textContent = String(message);
    banner.classList.remove("hidden", "opacity-0");
    banner.classList.add("opacity-100", "notification-enter");
    finishTimeout = setTimeout(() => banner.classList.remove("notification-enter"), 500);
    hideTimeout = setTimeout(() => {
      banner.classList.remove("opacity-100");
      banner.classList.add("opacity-0");
      finishTimeout = setTimeout(() => banner.classList.add("hidden"), 300);
    }, durationMs);
  };
}
