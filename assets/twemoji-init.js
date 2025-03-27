function isAppleDevice() {
    return /Mac|iPhone|iPad|iPod/.test(navigator.userAgentData?.platform) ||
        /Macintosh/.test(navigator.userAgent);
}

if (!isAppleDevice()) {
  const options = {
    base: chrome.runtime.getURL('assets/emojis/'),
    folder: 'svg',
    ext: '.svg',
    attributes: { class: 'emoji', width: '1em', height: '1em' }
  };

  document.addEventListener('DOMContentLoaded', () => {
    twemoji.parse(document.body, options);
    new MutationObserver(() => twemoji.parse(document.body, options))
      .observe(document.body, { childList: true, subtree: true });
  });
}
