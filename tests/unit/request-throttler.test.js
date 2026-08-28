import { describe, expect, it, vi } from "vitest";
import { abortableDelay } from "../../src/infrastructure/request-throttler.js";
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
