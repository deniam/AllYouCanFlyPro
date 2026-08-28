import { MessageAction } from "./extension-api.js";
import { AppError, ErrorCode, throwIfAborted } from "./errors.js";
import { abortableDelay } from "./request-throttler.js";
import { segmentCacheKey } from "./cache-repository.js";

const MULTIPASS_URL = "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets";
const MULTIPASS_PATTERN = "https://multipass.wizzair.com/*";
const SESSION_TTL_MS = 60 * 60 * 1000;
// The observed availability endpoint uses 400 to represent no matching flights.
const EMPTY_AVAILABILITY_STATUSES = new Set([400]);

export function createMultipassClient({
  gateway,
  cache,
  throttler,
  logger = () => {},
  sessionStorage = localStorage,
  fetchImpl = fetch,
  onPause = () => {},
  maxAttempts = 2
}) {
  function readSession() {
    try {
      return JSON.parse(sessionStorage.getItem("wizz_page_data") || "{}");
    } catch {
      return {};
    }
  }

  function writeSession(patch) {
    sessionStorage.setItem("wizz_page_data", JSON.stringify({ ...readSession(), ...patch }));
  }

  function clearSession() {
    sessionStorage.removeItem("wizz_page_data");
  }

  async function ensureContentScript(tabId, signal) {
    try {
      const response = await gateway.sendMessage(tabId, { action: MessageAction.PING });
      if (response?.success) return;
    } catch {
      // Declarative injection may not have completed yet.
    }
    await gateway.injectContentScript(tabId);
    await abortableDelay(250, signal);
    const response = await gateway.sendMessage(tabId, { action: MessageAction.PING });
    if (!response?.success) {
      throw new AppError(
        ErrorCode.CONTENT_SCRIPT_UNAVAILABLE,
        "Multipass content script did not respond"
      );
    }
  }

  async function getMultipassTab(signal, { create = true } = {}) {
    let tabs = await gateway.queryTabs({ url: MULTIPASS_PATTERN });
    let tab = tabs?.[0];
    if (!tab && create) {
      tab = await gateway.createTab({ url: MULTIPASS_URL, active: false });
    }
    if (!tab) throw new AppError(ErrorCode.TAB_UNAVAILABLE, "No Multipass tab found");
    if (tab.status !== "complete") {
      await gateway.waitForTabComplete(tab.id, { signal });
      tabs = await gateway.queryTabs({ url: MULTIPASS_PATTERN });
      tab = tabs?.find(item => item.id === tab.id) ?? tab;
    }
    await ensureContentScript(tab.id, signal);
    return tab;
  }

  async function ensureSession(signal) {
    throwIfAborted(signal);
    const stored = readSession();
    const dynamicUrlTimestamp = stored.dynamicUrlTimestamp ?? stored.timestamp ?? 0;
    if (stored.dynamicUrl && Date.now() - dynamicUrlTimestamp < SESSION_TTL_MS) {
      return stored;
    }

    const tab = await getMultipassTab(signal);
    const dynamicResponse = await gateway.sendMessage(tab.id, {
      action: MessageAction.GET_DYNAMIC_URL
    });
    if (dynamicResponse?.error) {
      throw new AppError(ErrorCode.AUTH_REQUIRED, dynamicResponse.error, { retryable: true });
    }
    if (!dynamicResponse?.dynamicUrl) {
      throw new AppError(ErrorCode.INVALID_RESPONSE, "Dynamic availability URL is missing");
    }

    let headers = stored.headers ?? {};
    try {
      const headerResponse = await gateway.sendMessage(tab.id, {
        action: MessageAction.GET_HEADERS
      });
      if (headerResponse?.headers) headers = headerResponse.headers;
    } catch (error) {
      logger("Unable to read optional request headers", error);
    }

    const session = {
      dynamicUrl: dynamicResponse.dynamicUrl,
      dynamicUrlTimestamp: Date.now(),
      timestamp: Date.now(),
      headers,
      headersTimestamp: Date.now()
    };
    writeSession(session);
    return session;
  }

  async function refreshSession(signal) {
    clearSession();
    const tab = await getMultipassTab(signal);
    const completion = gateway.waitForTabComplete(tab.id, { signal });
    await gateway.reloadTab(tab.id);
    await completion;
    return ensureSession(signal);
  }

  async function requestFlights(segment, signal) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      throwIfAborted(signal);
      await throttler.wait(signal);
      try {
        const session = await ensureSession(signal);
        const response = await fetchImpl(session.dynamicUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(session.headers ?? {}) },
          body: JSON.stringify({
            flightType: "RT",
            origin: segment.origin,
            destination: segment.destination,
            departure: segment.date,
            arrival: "",
            intervalSubtype: null
          }),
          signal
        });

        if (EMPTY_AVAILABILITY_STATUSES.has(response.status)) return [];
        if ([426, 429, 501].includes(response.status)) {
          const waitMs = response.status === 426 ? 60000 : response.status === 429 ? 40000 : 15000;
          onPause(waitMs, "rate-limit", response.status);
          throw new AppError(ErrorCode.RATE_LIMITED, `HTTP ${response.status}`, {
            status: response.status,
            retryable: true
          });
        }
        if (!response.ok) {
          throw new AppError(ErrorCode.HTTP_ERROR, `HTTP ${response.status}`, {
            status: response.status,
            retryable: response.status >= 500
          });
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          const body = await response.text();
          if (/^\s*<!doctype/i.test(body)) {
            await refreshSession(signal);
            lastError = new AppError(ErrorCode.AUTH_REQUIRED, "Multipass session requires refresh", {
              retryable: true
            });
            continue;
          }
          throw new AppError(ErrorCode.INVALID_RESPONSE, "Expected a JSON availability response");
        }

        const payload = await response.json();
        if (!Array.isArray(payload.flightsOutbound)) {
          throw new AppError(ErrorCode.INVALID_RESPONSE, "flightsOutbound is missing");
        }
        return payload.flightsOutbound;
      } catch (error) {
        if (signal?.aborted) throw new AppError(ErrorCode.CANCELLED, "Search cancelled");
        const normalized = error instanceof AppError
          ? error
          : new AppError(ErrorCode.HTTP_ERROR, error?.message ?? "Network request failed", {
            cause: error,
            retryable: true
          });
        lastError = normalized;
        if (!normalized.retryable || attempt === maxAttempts - 1) throw normalized;
        const waitMs = normalized.code === ErrorCode.RATE_LIMITED
          ? normalized.status === 426 ? 60000 : normalized.status === 429 ? 40000 : 15000
          : 1000;
        await abortableDelay(waitMs, signal);
      }
    }
    throw lastError ?? new AppError(ErrorCode.INVALID_RESPONSE, "Flight request failed");
  }

  return Object.freeze({
    ensureSession,
    clearSession,
    async getFlights(segment, signal) {
      const key = segmentCacheKey(segment.origin, segment.destination, segment.date);
      const cached = await cache.get(key);
      if (cached) return cached;
      const flights = await requestFlights(segment, signal);
      await cache.put(key, flights);
      return flights;
    },
    async continueBooking(subscriptionId, outboundKey, signal) {
      const tab = await gateway.createTab({ url: MULTIPASS_URL, active: true });
      await gateway.waitForTabComplete(tab.id, { signal });
      await ensureContentScript(tab.id, signal);
      const response = await gateway.sendMessage(tab.id, {
        action: MessageAction.INJECT_PAYMENT_FORM,
        subscriptionId,
        outboundKey
      });
      if (response?.error) throw new AppError(ErrorCode.INVALID_RESPONSE, response.error);
      return response;
    }
  });
}
