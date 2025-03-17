chrome.action.onClicked.addListener((tab) => {
  const hasSidePanel = 'sidePanel' in chrome;
  const multipassUrl = "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets";

  // Immediately open the side panel in response to the user click.
  // This call is synchronous and preserves the user gesture.
  if (hasSidePanel) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => {
      console.error("Side panel error:", err);
    });
    chrome.sidePanel.setOptions({
      enabled: true,
      path: chrome.runtime.getURL('index.html')
    }).catch((err) => {
      console.error("Side panel error:", err);
    });
  }

  // Now, if the current tab is not already multipass, asynchronously create one.
  if (!(tab.url && tab.url.includes(multipassUrl))) {
    // Check if the current window is normal.
    chrome.windows.get(tab.windowId, (currentWindow) => {
      if (currentWindow && currentWindow.type === "normal") {
        // Create the multipass tab in the current (normal) window.
        chrome.tabs.create({
          url: multipassUrl,
          windowId: currentWindow.id,
          active: true
        }, (newTab) => {
          console.log("New multipass tab created in current normal window:", newTab);
        });
      } else {
        // If not normal, find a normal window and create the tab there.
        chrome.windows.getAll({ windowTypes: ["normal"] }, (windows) => {
          const targetWindowId = (windows && windows.length > 0) ? windows[0].id : tab.windowId;
          chrome.tabs.create({
            url: multipassUrl,
            windowId: targetWindowId,
            active: true
          }, (newTab) => {
            console.log("New multipass tab created in normal window:", newTab);
          });
        });
      }
    });
  }
});
