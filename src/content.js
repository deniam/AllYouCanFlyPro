(function initializeContentScript() {
  if (window.top !== window || window.__aycfContentScriptInitialized) return;
  window.__aycfContentScriptInitialized = true;

  const parsers = globalThis.AYCFContentParsers;
  if (!parsers) throw new Error("AYCF content parsers were not loaded");
  let cachedDynamicUrlPromise = null;

  function findDynamicUrl() {
    return parsers.findDynamicUrl(Array.from(document.scripts, script => script.textContent ?? ""));
  }

  function waitForDynamicUrl({ timeoutMs = 12000, intervalMs = 500 } = {}) {
    return new Promise((resolve, reject) => {
      let interval;
      let timeout;
      let observer;

      const cleanup = () => {
        clearInterval(interval);
        clearTimeout(timeout);
        observer?.disconnect();
      };
      const check = () => {
        const dynamicUrl = findDynamicUrl();
        if (!dynamicUrl) return;
        cleanup();
        resolve(dynamicUrl);
      };

      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      interval = setInterval(check, intervalMs);
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Dynamic URL was not found before timeout"));
      }, timeoutMs);
      check();
    });
  }

  function getDynamicUrl() {
    if (!cachedDynamicUrlPromise) {
      cachedDynamicUrlPromise = waitForDynamicUrl().catch(error => {
        cachedDynamicUrlPromise = null;
        throw error;
      });
    }
    return cachedDynamicUrlPromise;
  }

  function getHeaders() {
    const headers = {};
    for (const entry of performance.getEntriesByType("resource")) {
      if (!entry.name.includes("/w6/subscriptions/spa/private-page/")) continue;
      for (const timing of entry.serverTiming ?? []) {
        if (!timing.name.startsWith("request_header_")) continue;
        headers[timing.name.replace("request_header_", "")] = timing.description;
      }
    }
    return headers;
  }

  function injectPaymentForm(subscriptionId, outboundKey) {
    if (!subscriptionId || !outboundKey) throw new Error("Missing booking parameters");
    const form = document.createElement("form");
    form.method = "POST";
    form.action = `https://multipass.wizzair.com/w6/subscriptions/${encodeURIComponent(subscriptionId)}/confirmation`;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "outboundKey";
    input.value = outboundKey;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    try {
      switch (request?.action) {
        case "ping":
          sendResponse({ success: true });
          return false;
        case "injectPaymentForm":
          injectPaymentForm(request.subscriptionId, request.outboundKey);
          sendResponse({ success: true });
          return false;
        case "getHeaders":
          sendResponse({ headers: getHeaders() });
          return false;
        case "getDynamicUrl":
          getDynamicUrl()
            .then(dynamicUrl => sendResponse({ dynamicUrl }))
            .catch(error => sendResponse({ error: error.message }));
          return true;
        default:
          sendResponse({ error: `Unknown action: ${request?.action ?? "missing"}` });
          return false;
      }
    } catch (error) {
      console.error("[AYCF content] Message handling failed:", error);
      sendResponse({ error: error.message });
      return false;
    }
  });
})();
