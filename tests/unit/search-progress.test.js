// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSearchProgress } from "../../src/ui/search-progress.js";

afterEach(() => vi.useRealTimers());

describe("search progress", () => {
  it("cleans up a countdown when reset", () => {
    vi.useFakeTimers();
    const elements = Array.from({ length: 5 }, () => document.createElement("div"));
    const progress = createSearchProgress({
      container: elements[0], text: elements[1], bar: elements[2],
      resultsContainer: elements[3], timeoutStatus: elements[4]
    });
    progress.showCountdown(40000);
    expect(elements[4].textContent).toContain("Rate limit");
    progress.resetCountdown();
    vi.advanceTimersByTime(50000);
    expect(elements[4].textContent).toBe("");
  });
});
