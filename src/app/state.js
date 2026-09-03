export function createAppState() {
  return {
    tripType: "oneway",
    currentTabContext: null,
    originalOriginInput: [],
    results: [],
    defaultResults: [],
    resultKeys: new Set(),
    unavailableResults: new Map(),
    refreshStates: new Map(),
    searchRunContext: null,
    refreshSession: {
      active: false,
      key: null,
      controller: null
    },
    searchSession: {
      active: false,
      cancelled: false,
      controller: null
    },
    beginSearch() {
      this.cancelRefresh();
      this.searchSession.controller?.abort();
      this.searchSession = {
        active: true,
        cancelled: false,
        controller: new AbortController()
      };
      return this.searchSession;
    },
    resetResults() {
      this.results = [];
      this.defaultResults = [];
      this.resultKeys.clear();
      this.unavailableResults.clear();
      this.refreshStates.clear();
      this.searchRunContext = null;
    },
    appendResult(result, key) {
      if (this.resultKeys.has(key)) return false;
      this.resultKeys.add(key);
      this.results.push(result);
      this.defaultResults.push(result);
      return true;
    },
    replaceResults(results, keyFor = result => result?.key) {
      this.results = [];
      this.defaultResults = [];
      this.resultKeys.clear();
      results.forEach(result => this.appendResult(result, keyFor(result)));
    },
    beginRefresh(key) {
      this.cancelRefresh();
      this.refreshSession = {
        active: true,
        key,
        controller: new AbortController()
      };
      this.refreshStates.set(key, { status: "refreshing" });
      return this.refreshSession;
    },
    finishRefresh(session = this.refreshSession) {
      if (this.refreshSession !== session) return false;
      this.refreshSession = { active: false, key: null, controller: null };
      return true;
    },
    cancelRefresh() {
      this.refreshSession.controller?.abort();
      if (this.refreshSession.key) this.refreshStates.delete(this.refreshSession.key);
      this.refreshSession = { active: false, key: null, controller: null };
    },
    markUnavailable(key, result, checkedAt = Date.now()) {
      this.unavailableResults.set(key, result);
      this.refreshStates.set(key, { status: "unavailable", checkedAt });
    },
    clearUnavailable(key) {
      this.unavailableResults.delete(key);
      if (this.refreshStates.get(key)?.status === "unavailable") this.refreshStates.delete(key);
    },
    cancelSearch() {
      this.searchSession.cancelled = true;
      this.searchSession.controller?.abort();
    },
    finishSearch(session = this.searchSession) {
      if (this.searchSession !== session) return false;
      this.searchSession.active = false;
      this.searchSession.controller = null;
      return true;
    }
  };
}

export const appState = createAppState();
