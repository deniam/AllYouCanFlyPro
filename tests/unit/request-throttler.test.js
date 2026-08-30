import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortableDelay,
  createRequestScheduler
} from "../../src/infrastructure/request-throttler.js";
import { ErrorCode } from "../../src/infrastructure/errors.js";

describe("abortable delay", () => {
  it("settles normally", async () => {
    vi.useFakeTimers();
    const promise = abortableDelay(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("rejects immediately when search is cancelled", async () => {
    const controller = new AbortController();
    const promise = abortableDelay(10000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: ErrorCode.CANCELLED });
  });
});

function schedulerSettings(overrides = {}) {
  return {
    maxRequestsInRow: 50,
    pauseDurationSeconds: 0,
    maxConcurrentRequests: 3,
    ...overrides
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

describe("request scheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("never exceeds the configured active-request limit", async () => {
    const gates = Array.from({ length: 7 }, deferred);
    let active = 0;
    let maximum = 0;
    const scheduler = createRequestScheduler(() => schedulerSettings({ maxConcurrentRequests: 50 }));
    const requests = gates.map(gate => scheduler.schedule(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate.promise;
      active -= 1;
    }));

    await vi.waitFor(() => expect(scheduler.getState().activeRequests).toBe(7));
    expect(maximum).toBe(7);
    gates.forEach(gate => gate.resolve());
    await Promise.all(requests);
    expect(maximum).toBe(7);
  });

  it("starts available slots immediately and applies the batch pause", async () => {
    vi.useFakeTimers();
    const starts = [];
    const onPause = vi.fn();
    const scheduler = createRequestScheduler(() => schedulerSettings({
      maxRequestsInRow: 2,
      pauseDurationSeconds: 1,
      maxConcurrentRequests: 5
    }), onPause);
    const requests = Array.from({ length: 3 }, () => scheduler.schedule(async () => {
      starts.push(performance.now());
    }));

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 0, 1000]);
    expect(onPause).toHaveBeenCalledWith(1000, "batch");
    await Promise.all(requests);
  });

  it("drops to one after a rate limit and recovers after successful responses", () => {
    const logger = vi.fn();
    const scheduler = createRequestScheduler(
      () => schedulerSettings({ maxConcurrentRequests: 5 }),
      vi.fn(),
      logger
    );
    scheduler.recordRateLimit(40000, 429, "40");
    expect(scheduler.getState()).toMatchObject({ effectiveConcurrency: 1, recovering: true });
    for (let index = 0; index < 10; index++) scheduler.recordSuccess();
    expect(scheduler.getState().effectiveConcurrency).toBe(2);
    for (const expected of [3, 4, 5]) {
      for (let index = 0; index < 10; index++) scheduler.recordSuccess();
      expect(scheduler.getState().effectiveConcurrency).toBe(expected);
    }
    expect(scheduler.getState().recovering).toBe(false);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Retry-After: 40"));
  });

  it("holds the whole queue during cooldown and resumes without a concurrent burst", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const starts = [];
    const scheduler = createRequestScheduler(() => schedulerSettings());
    scheduler.recordRateLimit(1000, 429);
    const first = scheduler.schedule(async () => {
      starts.push(performance.now());
      await gate.promise;
    });
    const second = scheduler.schedule(async () => {
      starts.push(performance.now());
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([1000]);
    expect(scheduler.getState()).toMatchObject({ activeRequests: 1, queuedRequests: 1 });
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([first, second]);
  });

  it("rejects a queued request when its search is cancelled", async () => {
    const gate = deferred();
    const scheduler = createRequestScheduler(() => schedulerSettings({ maxConcurrentRequests: 1 }));
    const active = scheduler.schedule(() => gate.promise);
    const controller = new AbortController();
    const queued = scheduler.schedule(async () => "never", controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: ErrorCode.CANCELLED });
    gate.resolve();
    await active;
  });
});
