chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    let debug = true;
    
    if (request.action === "getDestinations") {
        setTimeout(() => {
        const routePattern = /"routes":\[(.*?)\].*?"isOneWayFlightsOnly"/gms;
        const bodyPattern = /window\.CVO\.routes\s*=\s*(\[.*?\]);/s;
        const headContent = document.head.innerHTML;
        const bodyContent = document.body.innerHTML;
        
        let routesJson;
        const headMatch = headContent.match(routePattern);
        const bodyMatch = bodyContent.match(bodyPattern);
        
        if (headMatch && headMatch[0]) {
            routesJson = `{"routes":${headMatch[0].split('"routes":')[1].split(',"isOneWayFlightsOnly"')[0]}}`;
            if (debug) console.log("Extracted routes JSON from head");
        } else if (bodyMatch && bodyMatch[1]) {
            routesJson = `{"routes":${bodyMatch[1]}}`;
            if (debug) console.log("Extracted routes JSON from body");
        }
        
        if (routesJson) {
            try {
            const routesData = JSON.parse(routesJson);
            if (debug) console.log("Parsed routes data:", routesData);
            sendResponse({ success: true, routes: routesData.routes });
            } catch (error) {
            if (debug) console.error("Error parsing routes data:", error);
            sendResponse({ success: false, error: "Failed to parse routes data" });
            }
        } else {
            if (debug) console.error("No routes data found in page");
            sendResponse({ success: false, error: "No routes data found" });
        }
        }, 1000);
        return true;
    } else if (request.action === "getDynamicUrl") {
        setTimeout(() => {
        const headContent = document.head.innerHTML;
        const bodyContent = document.body.innerHTML;
        
        const headMatch = headContent.match(/"searchFlight":"https:\/\/multipass\.wizzair\.com[^"]+\/([^"]+)"/);
        const bodyMatch = bodyContent.match(/window\.CVO\.flightSearchUrlJson\s*=\s*"(https:\/\/multipass\.wizzair\.com[^"]+)"/);
        
        if (headMatch && headMatch[1]) {
            const uuid = headMatch[1];
            const dynamicUrl = `https://multipass.wizzair.com/w6/subscriptions/json/availability/${uuid}`;
            if (debug) console.log("Extracted dynamicUrl from head:", dynamicUrl);
            sendResponse({ dynamicUrl });
        } else if (bodyMatch && bodyMatch[1]) {
            const dynamicUrl = bodyMatch[1];
            if (debug) console.log("Extracted dynamicUrl from body:", dynamicUrl);
            sendResponse({ dynamicUrl });
        } else {
            if (debug) console.error("Dynamic URL not found in page content");
            sendResponse({ error: "Dynamic URL not found" });
        }
        }, 1000);
        return true;
    } else if (request.action === "getHeaders") {
        const headers = {};
        performance.getEntriesByType("resource").forEach(entry => {
        if (entry.name.includes("multipass.wizzair.com")) {
            entry.serverTiming.forEach(timing => {
            if (timing.name.startsWith("request_header_")) {
                const headerName = timing.name.replace("request_header_", "");
                headers[headerName] = timing.description;
            }
            });
        }
        });
        if (debug) console.log("Returning headers:", headers);
        sendResponse({ headers });
        return true;
    }
});