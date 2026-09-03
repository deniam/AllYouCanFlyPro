export function createAppState() {
  return {
    tripType: "oneway",
    currentTabContext: null,
    originalOriginInput: [],
    results: [],
    defaultResults: [],
    resultKeys: new Set(),
    searchSession: {
      active: false,
      cancelled: false,
      controller: null
    },
    beginSearch() {
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
