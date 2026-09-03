import { cancelledError, throwIfAborted } from "./errors.js";

const RECOVERY_SUCCESS_COUNT = 5;
const TRANSIENT_FAILURE_RATIO = 0.2;
const MIN_OUTCOME_WINDOW = 5;
const DEFAULT_STAGGER_MIN_MS = 25;
const DEFAULT_STAGGER_MAX_MS = 100;

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
  logger = () => {},
  {
    random = Math.random,
    staggerMinMs = DEFAULT_STAGGER_MIN_MS,
    staggerMaxMs = DEFAULT_STAGGER_MAX_MS
  } = {}
) {
  let queue = [];
  let queueHead = 0;
  let queuedRequests = 0;
  let activeRequests = 0;
  let requestsInBatch = 0;
  let batchPauseUntil = 0;
  let cooldownUntil = 0;
  let settings = settingsProvider();
  let effectiveConcurrency = configuredConcurrency(settings);
  let recovering = false;
  let successfulResponses = 0;
  let outcomeWindow = [];
  let outcomeWindowSize = Math.max(MIN_OUTCOME_WINDOW, effectiveConcurrency);
  let peakActiveRequests = 0;
  let concurrencyChanges = [];
  let timer = null;
  let nextStartAt = 0;
  const stateListeners = new Set();

  const minimumStagger = Math.max(0, Number(staggerMinMs) || 0);
  const maximumStagger = Math.max(minimumStagger, Number(staggerMaxMs) || 0);

  function nextStaggerDelay() {
    const fraction = Math.max(0, Math.min(1, Number(random()) || 0));
    return minimumStagger + fraction * (maximumStagger - minimumStagger);
  }

  function currentConcurrency() {
    const configured = configuredConcurrency(settings);
    effectiveConcurrency = Math.min(effectiveConcurrency, configured);
    return effectiveConcurrency;
  }

  function stateSnapshot() {
    return {
      activeRequests,
      queuedRequests,
      effectiveConcurrency: currentConcurrency(),
      recovering,
      requestsInBatch,
      cooldownUntil,
      nextStartAt,
      peakActiveRequests,
      concurrencyChanges: [...concurrencyChanges]
    };
  }

  function notifyState() {
    const state = stateSnapshot();
    for (const listener of stateListeners) {
      try {
        listener(state);
      } catch (error) {
        logger("Request scheduler state listener failed", error);
      }
    }
  }

  function setEffectiveConcurrency(value, reason) {
    const configured = configuredConcurrency(settings);
    const next = Math.max(1, Math.min(configured, Math.floor(Number(value) || 1)));
    const previous = effectiveConcurrency;
    effectiveConcurrency = next;
    recovering = effectiveConcurrency < configured;
    if (previous !== next) {
      concurrencyChanges.push({ from: previous, to: next, reason });
      notifyState();
    }
    return { previous, next };
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
    while (queueHead < queue.length && queue[queueHead].settled) queueHead += 1;
    if (queueHead > 1024 && queueHead * 2 > queue.length) {
      queue = queue.slice(queueHead);
      queueHead = 0;
    }
  }

  function takeNext() {
    while (queueHead < queue.length) {
      const item = queue[queueHead++];
      if (item.queued) {
        item.queued = false;
        queuedRequests -= 1;
      }
      if (!item.settled) return item;
    }
    discardCancelled();
    return null;
  }

  function finish(item, method, value) {
    if (item.settled) return;
    item.settled = true;
    item.signal?.removeEventListener("abort", item.onAbort);
    item[method](value);
  }

  function start(item) {
    activeRequests += 1;
    peakActiveRequests = Math.max(peakActiveRequests, activeRequests);
    notifyState();
    requestsInBatch += 1;
    if (currentConcurrency() > 1) {
      nextStartAt = performance.now() + nextStaggerDelay();
    }
    Promise.resolve()
      .then(() => item.task())
      .then(value => finish(item, "resolve", value), error => finish(item, "reject", error))
      .finally(() => {
        activeRequests -= 1;
        notifyState();
        pump();
      });
  }

  function pump() {
    clearTimer();
    discardCancelled();
    if (queueHead >= queue.length) {
      queue = [];
      queueHead = 0;
      return;
    }

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

    const staggerUntil = concurrency > 1 ? nextStartAt : 0;
    const readyAt = Math.max(batchPauseUntil, cooldownUntil, staggerUntil);
    if (readyAt > now) {
      schedulePump(readyAt - now);
      return;
    }

    const item = takeNext();
    if (!item) return;
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
        queued: true,
        onAbort: null
      };
      item.onAbort = () => {
        if (item.queued) {
          item.queued = false;
          queuedRequests -= 1;
        }
        finish(item, "reject", cancelledError());
        pump();
      };
      signal?.addEventListener("abort", item.onAbort, { once: true });
      queue.push(item);
      queuedRequests += 1;
      notifyState();
      pump();
    });
  }

  function recordRateLimit(waitMs, status, retryAfter = null) {
    const now = performance.now();
    const { previous } = setEffectiveConcurrency(1, `rate-limit-${status}`);
    successfulResponses = 0;
    outcomeWindow = [];
    outcomeWindowSize = MIN_OUTCOME_WINDOW;
    cooldownUntil = Math.max(cooldownUntil, now + Math.max(0, waitMs));
    logger(
      `Rate limit HTTP ${status}: concurrency ${previous} → 1, cooldown ${waitMs}ms` +
      (retryAfter ? ` (Retry-After: ${retryAfter})` : "")
    );
    onPause(Math.max(0, cooldownUntil - now), "rate-limit", status);
    pump();
  }

  function recordProbeOutcome(kind, error = null) {
    if (!['success', 'transient'].includes(kind)) return;
    outcomeWindow.push(kind);
    if (kind === 'success') {
      successfulResponses += 1;
      if (recovering && successfulResponses >= RECOVERY_SUCCESS_COUNT) {
        successfulResponses = 0;
        const { previous, next } = setEffectiveConcurrency(
          effectiveConcurrency + 1,
          'healthy-recovery'
        );
        if (previous !== next) logger(`Request concurrency recovered: ${previous} → ${next}`);
      }
    } else {
      successfulResponses = 0;
    }

    if (outcomeWindow.length >= outcomeWindowSize) {
      const transientFailures = outcomeWindow.filter(value => value === 'transient').length;
      const failureRatio = transientFailures / outcomeWindow.length;
      outcomeWindow = [];
      if (failureRatio >= TRANSIENT_FAILURE_RATIO) {
        const { previous, next } = setEffectiveConcurrency(
          Math.floor(effectiveConcurrency / 2),
          'transient-window'
        );
        successfulResponses = 0;
        if (previous !== next) {
          logger(
            `Transient availability window${error?.status ? ` HTTP ${error.status}` : ""}: ` +
            `concurrency ${previous} → ${next}`
          );
        }
      }
      outcomeWindowSize = Math.max(MIN_OUTCOME_WINDOW, effectiveConcurrency);
    }
    notifyState();
    pump();
  }

  function recordTransientFailure(error) {
    recordProbeOutcome('transient', error);
  }

  function recordSuccess() {
    recordProbeOutcome('success');
  }

  function beginSearch(maxConcurrency = configuredConcurrency(settings)) {
    settings = settingsProvider();
    const now = performance.now();
    const configured = Math.min(
      configuredConcurrency(settings),
      Math.max(1, Math.min(50, Number(maxConcurrency) || 1))
    );
    const next = cooldownUntil > now ? 1 : configured;
    const previous = effectiveConcurrency;
    effectiveConcurrency = next;
    recovering = next < configured;
    successfulResponses = 0;
    outcomeWindow = [];
    outcomeWindowSize = Math.max(MIN_OUTCOME_WINDOW, next);
    peakActiveRequests = activeRequests;
    concurrencyChanges = previous === next
      ? []
      : [{ from: previous, to: next, reason: 'search-start' }];
    logger(`Request scheduler search started: max concurrency ${configured}, effective concurrency ${next}`);
    notifyState();
    pump();
  }

  function resetBatch() {
    requestsInBatch = 0;
    batchPauseUntil = 0;
    nextStartAt = 0;
    notifyState();
    pump();
  }

  function settingsChanged() {
    settings = settingsProvider();
    const configured = configuredConcurrency(settings);
    if (!recovering) setEffectiveConcurrency(configured, 'settings-change');
    else if (effectiveConcurrency > configured) setEffectiveConcurrency(configured, 'settings-change');
    logger(
      `Request scheduler configured: max concurrency ${configured}, ` +
      `effective concurrency ${currentConcurrency()}`
    );
    pump();
  }

  logger(
    `Request scheduler configured: max concurrency ${configuredConcurrency(settings)}, ` +
    `effective concurrency ${currentConcurrency()}`
  );

  return Object.freeze({
    schedule,
    beginSearch,
    recordRateLimit,
    recordProbeOutcome,
    recordTransientFailure,
    recordSuccess,
    resetBatch,
    settingsChanged,
    subscribe(listener) {
      stateListeners.add(listener);
      listener(stateSnapshot());
      return () => stateListeners.delete(listener);
    },
    getState: stateSnapshot
  });
}
