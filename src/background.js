chrome.action.onClicked.addListener(async (tab) => {
    const hasSidePanel = 'sidePanel' in chrome;

    const openAsPopup = () => {
        chrome.windows.create({
        url: 'index.html',
        type: 'popup',
        width: 400,
        height: 600
        });
    };

    if (tab.url && tab.url.includes('multipass.wizzair.com')) {
        if (hasSidePanel) {
        try {
            await chrome.sidePanel.open({ windowId: tab.windowId });
            await chrome.sidePanel.setOptions({
            enabled: true,
            path: 'index.html'
            });
        } catch (err) {
            console.error('Side panel error:', err);
            openAsPopup();
        }
        } else {
        openAsPopup();
        }
    } else {
        chrome.tabs.create({
        url: "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets"
        }, async (newTab) => {
        if (newTab && newTab.windowId) {
            if (hasSidePanel) {
            try {
                await chrome.sidePanel.open({ windowId: newTab.windowId });
                await chrome.sidePanel.setOptions({
                enabled: true,
                path: 'index.html'
                });
            } catch (err) {
                console.error('Side panel error:', err);
                openAsPopup();
            }
            } else {
            openAsPopup();
            }
        }
        });
    }
});
