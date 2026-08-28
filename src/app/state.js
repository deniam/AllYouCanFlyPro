export function createAppState() {
  return {
    tripType: "oneway",
    currentTabContext: null,
    originalOriginInput: [],
    results: [],
    defaultResults: [],
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
    cancelSearch() {
      this.searchSession.cancelled = true;
      this.searchSession.controller?.abort();
    },
    finishSearch() {
      this.searchSession.active = false;
      this.searchSession.controller = null;
    }
  };
}

export const appState = createAppState();
