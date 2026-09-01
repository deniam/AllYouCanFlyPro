// This page is loaded only after Stripe sends the customer to the configured
// Payment Link completion URL. It is intentionally local-only: no Stripe
// secret or payment details are exposed to the extension.
(() => {
  const api = globalThis.chrome ?? globalThis.browser;
  const storage = api?.storage?.local;
  if (typeof storage?.set !== "function") return;

  const markCompleted = () => {
    try {
      const result = storage.set({ donationCompleted: true });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // A storage failure must not break the Stripe confirmation page.
    }
  };

  markCompleted();
})();
