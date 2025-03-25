function waitForTabToComplete(tabId) {
  return new Promise(resolve => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"]
    });
    await new Promise(r => setTimeout(r, 300));
  } catch (err) {
    console.error("Error injecting content script:", err);
  }
}

function openExtensionTab(contextTab) {
  const extensionUrl = chrome.runtime.getURL("index.html");
  const context = { url: contextTab.url || "", title: contextTab.title || "", id: contextTab.id };
  chrome.storage.local.set({ currentTabContext: context }, () =>
    chrome.tabs.create({ url: extensionUrl, active: true }, newTab =>
      console.log("Extension UI opened:", newTab)
    )
  );
}

chrome.action.onClicked.addListener(async (tab) => {
  const multipassUrl = "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets";

  const tabs = await chrome.tabs.query({ url: "https://multipass.wizzair.com/*" });
  let targetTab = tabs[0];

  if (!targetTab) {
    targetTab = await new Promise(resolve =>
      chrome.tabs.create({ url: multipassUrl, active: false }, resolve)
    );
    await waitForTabToComplete(targetTab.id);
  }

  await ensureContentScriptInjected(targetTab.id);

  openExtensionTab(targetTab);
});
