import { MessageAction } from "./extension-api.js";
import { AppError, ErrorCode, throwIfAborted } from "./errors.js";
import { abortableDelay } from "./request-throttler.js";
import { segmentCacheKey } from "./cache-repository.js";

const MULTIPASS_URL = "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets";
const MULTIPASS_PATTERN = "https://multipass.wizzair.com/*";
const SESSION_TTL_MS = 60 * 60 * 1000;
// The observed availability endpoint uses 400 to represent no matching flights.
const EMPTY_AVAILABILITY_STATUSES = new Set([400]);
const RATE_LIMIT_DELAYS = Object.freeze({ 426: 60000, 429: 40000, 501: 15000 });

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now);
}

export function createMultipassClient({
  gateway,
  cache,
  scheduler,
  logger = () => {},
  sessionStorage = localStorage,
  fetchImpl = fetch,
  maxAttempts = 2
}) {
  let authenticationTabId = null;
  let sessionPromise = null;
  let refreshPromise = null;
  const inFlightRequests = new Map();

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
    let tab = tabs?.find(item => item.id === authenticationTabId) ?? tabs?.[0];
    if (!tab && create) {
      tab = await gateway.createTab({ url: MULTIPASS_URL, active: true });
      if (!tab) {
        tabs = await gateway.queryTabs({ url: MULTIPASS_PATTERN });
        tab = tabs?.[0];
      }
      authenticationTabId = tab?.id ?? null;
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

  async function showAuthenticationTab() {
    const tabs = await gateway.queryTabs({ url: MULTIPASS_PATTERN });
    const authenticationTab = tabs?.find(tab => tab.id === authenticationTabId);
    if (authenticationTab) {
      await gateway.updateTab(authenticationTab.id, { active: true });
      return authenticationTab;
    }

    const createdTab = await gateway.createTab({ url: MULTIPASS_URL, active: true });
    authenticationTabId = createdTab?.id ?? null;
    return createdTab;
  }

  async function discoverSession(signal) {
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
      await showAuthenticationTab();
      throw new AppError(
        ErrorCode.AUTH_REQUIRED,
        "Please sign in to Multipass in the tab that was opened, keep the tab active, and start the search again"
      );
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

  async function ensureSession(signal) {
    const stored = readSession();
    const dynamicUrlTimestamp = stored.dynamicUrlTimestamp ?? stored.timestamp ?? 0;
    if (stored.dynamicUrl && Date.now() - dynamicUrlTimestamp < SESSION_TTL_MS) {
      return stored;
    }
    if (!sessionPromise) {
      sessionPromise = discoverSession(signal).finally(() => {
        sessionPromise = null;
      });
    }
    return sessionPromise;
  }

  async function refreshSession(signal) {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        clearSession();
        const tab = await getMultipassTab(signal);
        const completion = gateway.waitForTabComplete(tab.id, { signal });
        await gateway.reloadTab(tab.id);
        await completion;
        return discoverSession(signal);
      })().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  async function requestFlights(segment, signal) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      throwIfAborted(signal);
      try {
        const session = await ensureSession(signal);
        const response = await scheduler.schedule(() => fetchImpl(session.dynamicUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(session.headers ?? {}) },
          body: JSON.stringify({
            flightType: "RT",
            origin: segment.origin,
            destination: segment.destination,
            departure: segment.date,
            arrival: segment.arrivalDate ?? "",
            intervalSubtype: null
          }),
          signal
        }), signal);

        if (EMPTY_AVAILABILITY_STATUSES.has(response.status)) {
          scheduler.recordSuccess();
          return { outbound: [], inbound: null };
        }
        if ([426, 429, 501].includes(response.status)) {
          const retryAfter = response.headers.get("retry-after");
          const waitMs = parseRetryAfter(retryAfter) ?? RATE_LIMIT_DELAYS[response.status];
          scheduler.recordRateLimit(waitMs, response.status, retryAfter);
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
        if (!Array.isArray(payload?.flightsOutbound)) {
          logger(
            `No flightsOutbound array for ${segment.origin} → ${segment.destination} on ${segment.date}; treating it as no availability`,
            payload
          );
          scheduler.recordSuccess();
          return { outbound: [], inbound: null };
        }
        let inbound = null;
        if (segment.arrivalDate) {
          if (Array.isArray(payload.flightsInbound)) {
            inbound = payload.flightsInbound;
          } else {
            logger(
              `No flightsInbound array for ${segment.destination} → ${segment.origin} on ${segment.arrivalDate}; reverse availability was not cached`,
              payload
            );
          }
        }
        scheduler.recordSuccess();
        return { outbound: payload.flightsOutbound, inbound };
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
        if (normalized.code !== ErrorCode.RATE_LIMITED) {
          await abortableDelay(1000, signal);
        }
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
      if (Array.isArray(cached)) return cached;
      const requestKey = `${key}|${segment.arrivalDate ?? ""}`;
      if (inFlightRequests.has(requestKey)) return inFlightRequests.get(requestKey);
      const request = (async () => {
        const { outbound, inbound } = await requestFlights(segment, signal);
        const writes = [cache.put(key, outbound)];
        if (segment.arrivalDate && Array.isArray(inbound)) {
          writes.push(cache.put(
            segmentCacheKey(segment.destination, segment.origin, segment.arrivalDate),
            inbound
          ));
        }
        await Promise.all(writes);
        return outbound;
      })();
      inFlightRequests.set(requestKey, request);
      try {
        return await request;
      } finally {
        if (inFlightRequests.get(requestKey) === request) inFlightRequests.delete(requestKey);
      }
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
