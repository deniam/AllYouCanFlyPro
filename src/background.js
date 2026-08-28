const MULTIPASS_URL = "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets";
const MULTIPASS_PATTERN = "https://multipass.wizzair.com/*";

function callbackCall(invoke) {
  return new Promise((resolve, reject) => {
    invoke(result => {
      const message = chrome.runtime.lastError?.message;
      if (message) reject(new Error(message));
      else resolve(result);
    });
  });
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let timeout;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Timed out waiting for Multipass tab"));
    }, timeoutMs);
    queryMultipassTabs().then(tabs => {
      if (tabs.find(tab => tab.id === tabId)?.status === "complete") {
        listener(tabId, { status: "complete" });
      }
    }).catch(() => {});
  });
}

function queryMultipassTabs() {
  return callbackCall(callback => chrome.tabs.query({ url: MULTIPASS_PATTERN }, callback));
}

function createTab(properties) {
  return callbackCall(callback => chrome.tabs.create(properties, callback));
}

async function pingContentScript(tabId) {
  try {
    const response = await callbackCall(callback =>
      chrome.tabs.sendMessage(tabId, { action: "ping" }, callback)
    );
    return response?.success === true;
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  if (await pingContentScript(tabId)) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content-parsers.js", "src/content.js"]
  });
  if (!(await pingContentScript(tabId))) {
    throw new Error("Content script did not respond after injection");
  }
}

async function findOrCreateMultipassTab() {
  const existing = await queryMultipassTabs();
  if (existing[0]) {
    if (existing[0].status !== "complete") await waitForTabComplete(existing[0].id);
    return existing[0];
  }
  const created = await createTab({ url: MULTIPASS_URL, active: false });
  await waitForTabComplete(created.id);
  return created;
}

async function openExtensionTab(contextTab) {
  const context = {
    url: contextTab.url ?? "",
    title: contextTab.title ?? "",
    id: contextTab.id
  };
  await callbackCall(callback => chrome.storage.local.set({ currentTabContext: context }, callback));
  await createTab({ url: chrome.runtime.getURL("index.html"), active: true });
}

let launchPromise = null;

chrome.action.onClicked.addListener(() => {
  if (launchPromise) return launchPromise;
  launchPromise = (async () => {
    const targetTab = await findOrCreateMultipassTab();
    await ensureContentScript(targetTab.id);
    await openExtensionTab(targetTab);
  })().catch(error => {
    console.error("[AYCF background] Failed to open extension:", error);
  }).finally(() => {
    launchPromise = null;
  });
  return launchPromise;
});
