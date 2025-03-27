(function() {
  if (!window.__listenerAdded) {
    window.__listenerAdded = true;
    
    if (window.top !== window) {
      return;
    }
    
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      try {
        if (request.action === "injectPaymentForm") {
          const { subscriptionId, outboundKey } = request;
          const form = document.createElement("form");
          form.method = "POST";
          form.action = `https://multipass.wizzair.com/w6/subscriptions/${subscriptionId}/confirmation`;
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = "outboundKey";
          input.value = outboundKey;
          form.appendChild(input);
          document.body.appendChild(form);
          form.submit();
          sendResponse({ success: true });
        } else if (request.action === "getDynamicUrl") {
          handleGetDynamicUrl(sendResponse);
        } else if (request.action === "getHeaders") {
          handleGetHeaders(sendResponse);
        } else if (request.action === "getDestinations") {
          handleGetDestinations(sendResponse);
        } else {
          console.warn("[Content.js] Unknown action:", request.action);
          sendResponse({ error: `Unknown action: ${request.action}` });
        }
      } catch (err) {
        console.error("[Content.js] Exception handling message:", err);
        sendResponse({ error: err.message });
      }
      return true;
    });
    
    function waitForDynamicUrl() {
      return new Promise((resolve, reject) => {
        const maxAttempts = 10;
        let attempt = 0;
    
        const startObserver = () => {
          try {
            const observer = new MutationObserver((mutations, obs) => {
              if (document.body.urls && document.body.urls.flightSearchUrlJson) {
                obs.disconnect();
                resolve(document.body.urls.flightSearchUrlJson);
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });
    
            const interval = setInterval(() => {
              attempt++;
              if (document.body && document.body.urls && document.body.urls.flightSearchUrlJson) {
                clearInterval(interval);
                observer.disconnect();
                resolve(document.body.urls.flightSearchUrlJson);
                return;
              }
    
              const headContent = document.head.innerHTML;
              const bodyContent = document.body ? document.body.innerHTML : "";
              const headMatch = headContent.match(/"searchFlight":"https:\/\/multipass\.wizzair\.com[^"]+\/([^"]+)"/);
              const bodyMatch = bodyContent.match(/window\.CVO\.flightSearchUrlJson\s*=\s*"(https:\/\/multipass\.wizzair\.com[^"]+)"/);
    
              let dynamicUrl;
              if (headMatch && headMatch[1]) {
                dynamicUrl = `https://multipass.wizzair.com/w6/subscriptions/json/availability/${headMatch[1]}`;
              } else if (bodyMatch && bodyMatch[1]) {
                dynamicUrl = bodyMatch[1];
              }
    
              if (dynamicUrl) {
                clearInterval(interval);
                observer.disconnect();
                resolve(dynamicUrl);
                return;
              }
    
              if (attempt >= maxAttempts) {
                clearInterval(interval);
                observer.disconnect();
                reject(new Error("Dynamic URL not found after waiting"));
              }
            }, 500);
          } catch (e) {
            reject(e);
          }
        };
    
        if (!document.body) {
          document.addEventListener("DOMContentLoaded", startObserver, { once: true });
        } else {
          startObserver();
        }
      });
    }
    
    if (!window.cachedDynamicUrlPromise) {
      window.cachedDynamicUrlPromise = waitForDynamicUrl();
    }
    
    function handleGetDynamicUrl(sendResponse) {
      window.cachedDynamicUrlPromise
        .then(dynamicUrl => {
          console.log("[Content.js] Found dynamicUrl:", dynamicUrl);
          sendResponse({ dynamicUrl });
        })
        .catch(err => {
          console.error("[Content.js] Dynamic URL not found", err);
          sendResponse({ error: err.message });
        });
      return true;
    }
    
    function handleGetHeaders(sendResponse) {
      try {
        const headers = {};
        performance.getEntriesByType("resource").forEach(entry => {
          if (entry.name.includes("https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets")) {
            entry.serverTiming.forEach(timing => {
              if (timing.name.startsWith("request_header_")) {
                headers[timing.name.replace("request_header_", "")] = timing.description;
              }
            });
          }
        });
        console.log("[Content.js] Returning headers:", headers);
        sendResponse({ headers });
      } catch (e) {
        console.error("[Content.js] Error getting headers:", e);
        sendResponse({ error: e.message });
      }
    }
    
    function handleGetDestinations(sendResponse) {
      setTimeout(() => {
        try {
          const headContent = document.head.innerHTML;
          const bodyContent = document.body.innerHTML;
    
          const routePattern = /"routes":\[(.*?)\].*?"isOneWayFlightsOnly"/gms;
          const bodyPattern = /window\.CVO\.routes\s*=\s*(\[.*?\]);/s;
    
          let routesJson;
          const headMatch = headContent.match(routePattern);
          const bodyMatch = bodyContent.match(bodyPattern);
    
          if (headMatch && headMatch[0]) {
            routesJson = `{"routes":${headMatch[0].split('"routes":')[1].split(',"isOneWayFlightsOnly"')[0]}}`;
            console.log("[Content.js] Extracted routes JSON from <head>");
          } else if (bodyMatch && bodyMatch[1]) {
            routesJson = `{"routes":${bodyMatch[1]}}`;
            console.log("[Content.js] Extracted routes JSON from window.CVO");
          }
    
          if (!routesJson) {
            console.error("[Content.js] No routes data found");
            return sendResponse({ success: false, error: "No routes data found" });
          }
    
          const parsed = JSON.parse(routesJson);
          console.log("[Content.js] Parsed routes:", parsed.routes);
          sendResponse({ success: true, routes: parsed.routes });
        } catch (e) {
          console.error("[Content.js] Error parsing routes:", e);
          sendResponse({ success: false, error: e.message });
        }
      }, 1000);
    }
  }
})();
