chrome.action.onClicked.addListener(async (tab) => {
    const hasSidePanel = 'sidePanel' in chrome;
    const multipassUrlSubstring = "multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets";

    const openAsPopup = () => {
        chrome.windows.create({
        url: 'index.html',
        type: 'popup',
        width: 400,
        height: 600
        });
    };

    // Function to open the UI via side panel or as a popup
    const openUI = (windowId) => {
        if (hasSidePanel) {
        chrome.sidePanel.open({ windowId }).catch((err) => {
            console.error('Side panel error:', err);
            openAsPopup();
        });
        chrome.sidePanel.setOptions({
            enabled: true,
            path: 'index.html'
        }).catch((err) => {
            console.error('Side panel error:', err);
            openAsPopup();
        });
        } else {
        openAsPopup();
        }
    };

    // If current tab's URL already contains the multipass substring, just open the UI.
    if (tab.url && tab.url.includes(multipassUrlSubstring)) {
        openUI(tab.windowId);
    } else {
        // Query all tabs and look for one with the multipass subscriptions URL.
        chrome.tabs.query({}, (tabs) => {
        const multipassTab = tabs.find(t => t.url && t.url.includes(multipassUrlSubstring));
        if (multipassTab) {
            // If found, bring it to the front.
            chrome.tabs.update(multipassTab.id, { active: true }, () => {
            // Optionally, you can reload it if needed:
            chrome.tabs.reload(multipassTab.id, {}, () => {
                openUI(multipassTab.windowId);
            });
            });
        } else {
            // No multipass tab exists; create a new one.
            chrome.tabs.create({ url: multipassUrlSubstring }, (newTab) => {
            if (newTab && newTab.windowId) {
                chrome.tabs.onUpdated.addListener(function listener(updatedTabId, changeInfo) {
                if (updatedTabId === newTab.id && changeInfo.status === "complete") {
                    chrome.tabs.onUpdated.removeListener(listener);
                    openUI(newTab.windowId);
                }
                });
            }
            });
        }
        });
    }
});
