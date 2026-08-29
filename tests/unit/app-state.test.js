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
});
