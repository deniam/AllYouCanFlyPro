import { describe, expect, it } from "vitest";
import { createAppState } from "../../src/app/state.js";

describe("app search state", () => {
  it("keeps a cancelled search active until its owner finishes", () => {
    const state = createAppState();
    const session = state.beginSearch();

    state.cancelSearch();

    expect(session.cancelled).toBe(true);
    expect(session.controller.signal.aborted).toBe(true);
    expect(state.searchSession.active).toBe(true);
    expect(state.finishSearch(session)).toBe(true);
    expect(state.searchSession.active).toBe(false);
  });

  it("does not let a stale search finish a newer session", () => {
    const state = createAppState();
    const staleSession = state.beginSearch();
    const currentSession = state.beginSearch();

    expect(state.finishSearch(staleSession)).toBe(false);
    expect(state.searchSession).toBe(currentSession);
    expect(state.searchSession.active).toBe(true);
    expect(state.finishSearch(currentSession)).toBe(true);
  });

  it("keeps result arrays and the duplicate-key Set synchronized", () => {
    const state = createAppState();
    const first = { key: "AAA-BBB-2026-09-01" };
    const second = { key: "AAA-CCC-2026-09-01" };

    expect(state.appendResult(first, first.key)).toBe(true);
    expect(state.appendResult(first, first.key)).toBe(false);
    expect(state.results).toEqual([first]);
    expect(state.defaultResults).toEqual([first]);
    expect(state.resultKeys).toEqual(new Set([first.key]));

    state.replaceResults([first, second, first], result => result.key);
    expect(state.results).toEqual([first, second]);
    expect(state.defaultResults).toEqual([first, second]);
    expect(state.resultKeys).toEqual(new Set([first.key, second.key]));

    state.resetResults();
    expect(state.results).toEqual([]);
    expect(state.defaultResults).toEqual([]);
    expect(state.resultKeys.size).toBe(0);
  });

  it("keeps unavailable refresh placeholders out of available results and clears them on search", () => {
    const state = createAppState();
    const result = { key: "old" };
    state.markUnavailable("old", result, 1234);

    expect(state.results).toEqual([]);
    expect(state.unavailableResults.get("old")).toBe(result);
    expect(state.refreshStates.get("old")).toEqual({ status: "unavailable", checkedAt: 1234 });

    state.resetResults();
    expect(state.unavailableResults.size).toBe(0);
    expect(state.refreshStates.size).toBe(0);
  });

  it("allows only one refresh session and cancels it when a search starts", () => {
    const state = createAppState();
    const refresh = state.beginRefresh("route");
    expect(refresh.active).toBe(true);

    state.beginSearch();
    expect(refresh.controller.signal.aborted).toBe(true);
    expect(state.refreshSession.active).toBe(false);
    expect(state.searchSession.active).toBe(true);
  });
});
