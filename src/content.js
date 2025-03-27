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

function handleGetDynamicUrl(sendResponse) {
setTimeout(() => {
  try {
  const headContent = document.head.innerHTML;
  const bodyContent = document.body.innerHTML;

  const headMatch = headContent.match(/"searchFlight":"https:\/\/multipass\.wizzair\.com[^"]+\/([^"]+)"/);
  const bodyMatch = bodyContent.match(/window\.CVO\.searchFlightJson\s*=\s*"(https:\/\/multipass\.wizzair\.com[^"]+)"/);

  let dynamicUrl;
  if (bodyMatch && bodyMatch[1]) {
      dynamicUrl = `https://multipass.wizzair.com/w6/subscriptions/json/availability/${bodyMatch[1]}`;
       console.log("[Content.js] Extracted dynamicUrl from head:", dynamicUrl);
  } else if (headMatch && headMatch[1]) {
      dynamicUrl = `https://multipass.wizzair.com/w6/subscriptions/json/availability/${headMatch[1]}`;
      console.log("[Content.js] Extracted dynamicUrl from body:", dynamicUrl);
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
  console.log("[Content.js] Returning headers:", headers);
  sendResponse({ headers });
} catch (e) {
  console.error("[Content.js] Error getting headers:", e);
  sendResponse({ error: e.message });
}
}