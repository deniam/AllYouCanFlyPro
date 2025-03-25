// src/background.js

// Ждём, пока вкладка полностью загрузится
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

// Принудительная инъекция контент‑скрипта
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

// Сохраняем контекст и открываем UI расширения
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

  // Ищем вкладку multipass (любую, даже неактивную)
  const tabs = await chrome.tabs.query({ url: "https://multipass.wizzair.com/*" });
  let targetTab = tabs[0];

  if (!targetTab) {
    // Если нет — создаём её неактивной
    targetTab = await new Promise(resolve =>
      chrome.tabs.create({ url: multipassUrl, active: false }, resolve)
    );
    await waitForTabToComplete(targetTab.id);
  }

  // Убедимся, что контент‑скрипт готов
  await ensureContentScriptInjected(targetTab.id);

  // Открываем UI расширения
  openExtensionTab(targetTab);
});
