// src/content.js

// Debug flag
const debug = true;

// Log as soon as the content script loads
console.log("[Content.js] Content script loaded on URL:", window.location.href);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("[Content.js] Received message:", request, "from:", sender);

  try {
    if (request.action === "getDestinations") {
      handleGetDestinations(sendResponse);
    } else if (request.action === "getDynamicUrl") {
      handleGetDynamicUrl(sendResponse);
    } else if (request.action === "getHeaders") {
      handleGetHeaders(sendResponse);
    } else {
      console.warn("[Content.js] Unknown action:", request.action);
      sendResponse({ error: `Unknown action: ${request.action}` });
    }
  } catch (err) {
    console.error("[Content.js] Exception handling message:", err);
    sendResponse({ error: err.message });
  }

  return true; // Keep sendResponse alive for async
});

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
        debug && console.log("[Content.js] Extracted routes JSON from <head>");
      } else if (bodyMatch && bodyMatch[1]) {
        routesJson = `{"routes":${bodyMatch[1]}}`;
        debug && console.log("[Content.js] Extracted routes JSON from window.CVO");
      }

      if (!routesJson) {
        console.error("[Content.js] No routes data found");
        return sendResponse({ success: false, error: "No routes data found" });
      }

      const parsed = JSON.parse(routesJson);
      debug && console.log("[Content.js] Parsed routes:", parsed.routes);
      sendResponse({ success: true, routes: parsed.routes });
    } catch (e) {
      console.error("[Content.js] Error parsing routes:", e);
      sendResponse({ success: false, error: e.message });
    }
  }, 1000);
}

function handleGetDynamicUrl(sendResponse) {
  setTimeout(() => {
    try {
      const headContent = document.head.innerHTML;
      const bodyContent = document.body.innerHTML;

      const headMatch = headContent.match(/"searchFlight":"https:\/\/multipass\.wizzair\.com[^"]+\/([^"]+)"/);
      const bodyMatch = bodyContent.match(/window\.CVO\.flightSearchUrlJson\s*=\s*"(https:\/\/multipass\.wizzair\.com[^"]+)"/);

      let dynamicUrl;
      if (headMatch && headMatch[1]) {
        dynamicUrl = `https://multipass.wizzair.com/w6/subscriptions/json/availability/${headMatch[1]}`;
        debug && console.log("[Content.js] Extracted dynamicUrl from head:", dynamicUrl);
      } else if (bodyMatch && bodyMatch[1]) {
        dynamicUrl = bodyMatch[1];
        debug && console.log("[Content.js] Extracted dynamicUrl from body:", dynamicUrl);
      }

      if (!dynamicUrl) {
        console.error("[Content.js] Dynamic URL not found");
        return sendResponse({ error: "Dynamic URL not found" });
      }

      sendResponse({ dynamicUrl });
    } catch (e) {
      console.error("[Content.js] Error extracting dynamic URL:", e);
      sendResponse({ error: e.message });
    }
  }, 1000);
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
    debug && console.log("[Content.js] Returning headers:", headers);
    sendResponse({ headers });
  } catch (e) {
    console.error("[Content.js] Error getting headers:", e);
    sendResponse({ error: e.message });
  }
}
