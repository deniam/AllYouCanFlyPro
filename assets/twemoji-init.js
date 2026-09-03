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
    let pendingNodes = [];
    let scheduled = false;
    let parsing = false;

    const parseNodes = nodes => {
      const uniqueNodes = [...new Set(nodes)].filter(node =>
        node?.nodeType === Node.ELEMENT_NODE
        && node.isConnected
        && !node.classList.contains('emoji')
      );
      if (!uniqueNodes.length) return;
      parsing = true;
      uniqueNodes.forEach(node => twemoji.parse(node, options));
      parsing = false;
    };

    const flush = () => {
      scheduled = false;
      const nodes = pendingNodes;
      pendingNodes = [];
      parseNodes(nodes);
    };

    const schedule = nodes => {
      pendingNodes.push(...nodes);
      if (scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
      else setTimeout(flush, 0);
    };

    // Parse the static shell once, then only parse newly inserted subtrees.
    parseNodes([...document.body.children]);
    new MutationObserver(mutations => {
      if (parsing) return;
      const added = mutations.flatMap(mutation => [...mutation.addedNodes]);
      schedule(added);
    }).observe(document.body, { childList: true, subtree: true });
  });
}
