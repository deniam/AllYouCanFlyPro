(function exposeContentParsers(root) {
  const AVAILABILITY_PREFIX = "https://multipass.wizzair.com/w6/subscriptions/json/availability/";
  const PASS_ID_PATTERN = /\bpass_id\s*:\s*['"]?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})['"]?/i;

  function extractBalancedArray(source, openingBracket) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = openingBracket; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "[") {
        depth += 1;
      } else if (character === "]") {
        depth -= 1;
        if (depth === 0) return source.slice(openingBracket, index + 1);
      }
    }
    return null;
  }

  function parseArrayFollowing(source, patterns) {
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      if (!match) continue;
      const openingBracket = source.indexOf("[", match.index + match[0].length - 1);
      const serialized = openingBracket >= 0 ? extractBalancedArray(source, openingBracket) : null;
      if (!serialized) continue;
      const value = JSON.parse(serialized);
      if (Array.isArray(value)) return value;
    }
    return null;
  }

  function findDynamicUrl(scriptSources) {
    for (const source of scriptSources) {
      if (!source.includes("DD_RUM.setUser")) continue;
      const passId = source.match(PASS_ID_PATTERN)?.[1];
      if (passId) return `${AVAILABILITY_PREFIX}${passId}`;
    }
    return null;
  }

  function extractRoutes(scriptSources) {
    for (const source of scriptSources) {
      const routes = parseArrayFollowing(source, [
        /["']routes["']\s*:\s*\[/g,
        /window\.CVO\.routes\s*=\s*\[/g
      ]);
      if (routes) return routes;
    }
    throw new Error("No routes data found");
  }

  root.AYCFContentParsers = Object.freeze({ extractBalancedArray, findDynamicUrl, extractRoutes });
})(globalThis);
