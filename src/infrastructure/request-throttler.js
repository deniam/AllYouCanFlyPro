import { cancelledError, throwIfAborted } from "./errors.js";

const RECOVERY_SUCCESS_COUNT = 10;

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

function configuredConcurrency(settings) {
  return Math.max(1, Math.min(50, Number(settings.maxConcurrentRequests) || 1));
}

/**
 * Schedules network work with a shared concurrency cap, batch pauses and an
 * adaptive cooldown. All search branches use the same instance.
 */
export function createRequestScheduler(
  settingsProvider,
  onPause = () => {},
  logger = () => {}
) {
  const queue = [];
  let activeRequests = 0;
  let requestsInBatch = 0;
  let batchPauseUntil = 0;
  let cooldownUntil = 0;
  let effectiveConcurrency = configuredConcurrency(settingsProvider());
  let recovering = false;
  let successfulResponses = 0;
  let timer = null;

  function currentConcurrency() {
    const configured = configuredConcurrency(settingsProvider());
    if (!recovering) effectiveConcurrency = configured;
    else effectiveConcurrency = Math.min(effectiveConcurrency, configured);
    return effectiveConcurrency;
  }

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedulePump(delay) {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, Math.max(0, delay));
  }

  function discardCancelled() {
    while (queue.length && queue[0].settled) queue.shift();
  }

  function finish(item, method, value) {
    if (item.settled) return;
    item.settled = true;
    item.signal?.removeEventListener("abort", item.onAbort);
    item[method](value);
  }

  function start(item) {
    activeRequests += 1;
    requestsInBatch += 1;
    Promise.resolve()
      .then(() => item.task())
      .then(value => finish(item, "resolve", value), error => finish(item, "reject", error))
      .finally(() => {
        activeRequests -= 1;
        pump();
      });
  }

  function pump() {
    clearTimer();
    discardCancelled();
    if (!queue.length) return;

    const settings = settingsProvider();
    const concurrency = currentConcurrency();
    if (activeRequests >= concurrency) return;

    const now = performance.now();
    if (batchPauseUntil > 0 && now >= batchPauseUntil) {
      batchPauseUntil = 0;
      logger("Request batch pause finished");
    }
    if (cooldownUntil > 0 && now >= cooldownUntil) {
      cooldownUntil = 0;
      logger("Rate-limit cooldown finished");
    }
    if (requestsInBatch >= settings.maxRequestsInRow && batchPauseUntil <= now) {
      const pauseMs = settings.pauseDurationSeconds * 1000;
      requestsInBatch = 0;
      batchPauseUntil = now + pauseMs;
      if (pauseMs > 0) {
        logger(`Request batch paused for ${pauseMs}ms`);
        onPause(pauseMs, "batch");
      }
    }

    const readyAt = Math.max(batchPauseUntil, cooldownUntil);
    if (readyAt > now) {
      schedulePump(readyAt - now);
      return;
    }

    const item = queue.shift();
    if (!item || item.settled) {
      pump();
      return;
    }
    start(item);
    pump();
  }

  function schedule(task, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const item = {
        task,
        signal,
        resolve,
        reject,
        settled: false,
        onAbort: null
      };
      item.onAbort = () => {
        finish(item, "reject", cancelledError());
        pump();
      };
      signal?.addEventListener("abort", item.onAbort, { once: true });
      queue.push(item);
      pump();
    });
  }

  function recordRateLimit(waitMs, status, retryAfter = null) {
    const now = performance.now();
    const previous = effectiveConcurrency;
    effectiveConcurrency = 1;
    recovering = true;
    successfulResponses = 0;
    cooldownUntil = Math.max(cooldownUntil, now + Math.max(0, waitMs));
    logger(
      `Rate limit HTTP ${status}: concurrency ${previous} → 1, cooldown ${waitMs}ms` +
      (retryAfter ? ` (Retry-After: ${retryAfter})` : "")
    );
    onPause(Math.max(0, cooldownUntil - now), "rate-limit", status);
    pump();
  }

  function recordSuccess() {
    if (!recovering) return;
    successfulResponses += 1;
    if (successfulResponses < RECOVERY_SUCCESS_COUNT) return;
    successfulResponses = 0;
    const configured = configuredConcurrency(settingsProvider());
    if (effectiveConcurrency < configured) {
      const previous = effectiveConcurrency;
      effectiveConcurrency += 1;
      logger(`Request concurrency recovered: ${previous} → ${effectiveConcurrency}`);
    }
    if (effectiveConcurrency >= configured) recovering = false;
    pump();
  }

  function resetBatch() {
    requestsInBatch = 0;
    batchPauseUntil = 0;
    pump();
  }

  function settingsChanged() {
    logger(
      `Request scheduler configured: max concurrency ${configuredConcurrency(settingsProvider())}, ` +
      `effective concurrency ${currentConcurrency()}`
    );
    pump();
  }

  logger(
    `Request scheduler configured: max concurrency ${configuredConcurrency(settingsProvider())}, ` +
    `effective concurrency ${currentConcurrency()}`
  );

  return Object.freeze({
    schedule,
    recordRateLimit,
    recordSuccess,
    resetBatch,
    settingsChanged,
    getState: () => ({
      activeRequests,
      queuedRequests: queue.filter(item => !item.settled).length,
      effectiveConcurrency: currentConcurrency(),
      recovering,
      requestsInBatch,
      cooldownUntil
    })
  });
}
