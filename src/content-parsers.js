(function exposeContentParsers(root) {
  const AVAILABILITY_PREFIX = "https://multipass.wizzair.com/w6/subscriptions/json/availability/";
  const PASS_ID_PATTERN = /\bpass_id\s*:\s*['"]?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})['"]?/i;

  function findDynamicUrl(scriptSources) {
    for (const source of scriptSources) {
      if (!source.includes("DD_RUM.setUser")) continue;
      const passId = source.match(PASS_ID_PATTERN)?.[1];
      if (passId) return `${AVAILABILITY_PREFIX}${passId}`;
    }
    return null;
  }

  root.AYCFContentParsers = Object.freeze({ findDynamicUrl });
})(globalThis);
