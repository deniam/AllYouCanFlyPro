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
});
