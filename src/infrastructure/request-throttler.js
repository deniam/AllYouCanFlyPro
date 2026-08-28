import { cancelledError, throwIfAborted } from "./errors.js";

export function abortableDelay(milliseconds, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timeout);
      reject(cancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createRequestThrottler(settingsProvider, onPause = () => {}) {
  let requestsInRow = 0;
  let lastRequestAt = 0;

  return Object.freeze({
    async wait(signal) {
      throwIfAborted(signal);
      const settings = settingsProvider();
      if (requestsInRow >= settings.maxRequestsInRow) {
        const pause = settings.pauseDurationSeconds * 1000;
        onPause(pause, "batch");
        await abortableDelay(pause, signal);
        requestsInRow = 0;
      }
      const elapsed = performance.now() - lastRequestAt;
      const delay = Math.max(0, settings.requestsFrequencyMs - elapsed);
      await abortableDelay(delay, signal);
      lastRequestAt = performance.now();
      requestsInRow += 1;
    },
    reset() {
      requestsInRow = 0;
      lastRequestAt = 0;
    }
  });
}
