import { AppError, ErrorCode, throwIfAborted } from "./errors.js";

export const MessageAction = Object.freeze({
  GET_DYNAMIC_URL: "getDynamicUrl",
  GET_HEADERS: "getHeaders",
  GET_DESTINATIONS: "getDestinations",
  INJECT_PAYMENT_FORM: "injectPaymentForm",
  PING: "ping"
});

function runtimeError(api) {
  return api?.runtime?.lastError?.message ?? null;
}

export function createExtensionGateway(api = globalThis.chrome ?? globalThis.browser) {
  function requireApi(path, value) {
    if (!value) {
      throw new AppError(
        ErrorCode.TAB_UNAVAILABLE,
        `WebExtensions API is unavailable: ${path}`
      );
    }
    return value;
  }

  function callbackCall(invoke) {
    return new Promise((resolve, reject) => {
      try {
        invoke(result => {
          const message = runtimeError(api);
          if (message) reject(new Error(message));
          else resolve(result);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function queryTabs(queryInfo) {
    requireApi("tabs.query", api?.tabs?.query);
    // Chrome accepts callbacks. Firefox-style implementations may return a Promise.
    if (api.tabs.query.length < 2) return api.tabs.query(queryInfo);
    return callbackCall(callback => api.tabs.query(queryInfo, callback));
  }

  async function createTab(createProperties) {
    requireApi("tabs.create", api?.tabs?.create);
    if (api.tabs.create.length < 2) return api.tabs.create(createProperties);
    return callbackCall(callback => api.tabs.create(createProperties, callback));
  }

  async function reloadTab(tabId) {
    requireApi("tabs.reload", api?.tabs?.reload);
    if (api.tabs.reload.length < 3) return api.tabs.reload(tabId, {});
    return callbackCall(callback => api.tabs.reload(tabId, {}, callback));
  }

  async function sendMessage(tabId, message) {
    requireApi("tabs.sendMessage", api?.tabs?.sendMessage);
    try {
      if (api.tabs.sendMessage.length < 3) return await api.tabs.sendMessage(tabId, message);
      return await callbackCall(callback => api.tabs.sendMessage(tabId, message, callback));
    } catch (error) {
      throw new AppError(
        ErrorCode.CONTENT_SCRIPT_UNAVAILABLE,
        error.message,
        { cause: error, retryable: true }
      );
    }
  }

  function waitForTabComplete(tabId, { signal, timeoutMs = 30000 } = {}) {
    throwIfAborted(signal);
    requireApi("tabs.onUpdated", api?.tabs?.onUpdated);
    return new Promise((resolve, reject) => {
      let timeout;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        api.tabs.onUpdated.removeListener(listener);
        signal?.removeEventListener("abort", onAbort);
      };
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new AppError(ErrorCode.CANCELLED, "Waiting for tab was cancelled"));
      };
      api.tabs.onUpdated.addListener(listener);
      signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new AppError(ErrorCode.TAB_UNAVAILABLE, "Timed out waiting for tab"));
      }, timeoutMs);
      // The event can fire before a caller starts waiting (especially in Orion).
      queryTabs({}).then(tabs => {
        const current = tabs?.find(tab => tab.id === tabId);
        if (current?.status === "complete") listener(tabId, { status: "complete" });
      }).catch(() => {});
    });
  }

  return Object.freeze({
    queryTabs,
    createTab,
    reloadTab,
    sendMessage,
    waitForTabComplete,
    getManifestVersion() {
      return api?.runtime?.getManifest?.().version ?? "";
    },
    getURL(path) {
      return api?.runtime?.getURL?.(path) ?? path;
    },
    async storageGet(key) {
      if (!api?.storage?.local?.get) return null;
      if (api.storage.local.get.length < 2) return api.storage.local.get(key);
      return callbackCall(callback => api.storage.local.get(key, callback));
    },
    async storageSet(value) {
      if (!api?.storage?.local?.set) return false;
      if (api.storage.local.set.length < 2) await api.storage.local.set(value);
      else await callbackCall(callback => api.storage.local.set(value, callback));
      return true;
    },
    async storageRemove(key) {
      if (!api?.storage?.local?.remove) return false;
      if (api.storage.local.remove.length < 2) await api.storage.local.remove(key);
      else await callbackCall(callback => api.storage.local.remove(key, callback));
      return true;
    },
    async injectContentScript(tabId) {
      requireApi("scripting.executeScript", api?.scripting?.executeScript);
      return api.scripting.executeScript({
        target: { tabId },
        files: ["src/content-parsers.js", "src/content.js"]
      });
    }
  });
}
