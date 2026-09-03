import { describe, expect, it, vi } from "vitest";
import { createExtensionGateway } from "../../src/infrastructure/extension-api.js";

function event() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => listeners.forEach(listener => listener(...args)),
    size: () => listeners.size
  };
}

describe("extension gateway", () => {
  it("supports Chrome callback APIs and clears tab listeners", async () => {
    const onUpdated = event();
    const api = {
      runtime: { lastError: null, getManifest: () => ({ version: "3.5.0" }) },
      tabs: {
        query(_query, callback) { callback([{ id: 7, status: "loading" }]); },
        sendMessage(_id, _message, callback) { callback({ success: true }); },
        onUpdated
      }
    };
    const gateway = createExtensionGateway(api);
    const waiting = gateway.waitForTabComplete(7, { timeoutMs: 1000 });
    onUpdated.emit(7, { status: "complete" });
    await expect(waiting).resolves.toBeUndefined();
    expect(onUpdated.size()).toBe(0);
    await expect(gateway.sendMessage(7, { action: "ping" })).resolves.toEqual({ success: true });
  });

  it("supports a limited promise-based Orion-style API", async () => {
    const api = {
      runtime: { getManifest: () => ({ version: "3.5.0" }) },
      tabs: { query: vi.fn(async () => [{ id: 1, status: "complete" }]) },
      storage: {
        local: {
          get: vi.fn(async () => ({ ready: true })),
          getBytesInUse: vi.fn(async () => 1234)
        }
      }
    };
    const gateway = createExtensionGateway(api);
    await expect(gateway.queryTabs({})).resolves.toHaveLength(1);
    await expect(gateway.storageGet("ready")).resolves.toEqual({ ready: true });
    await expect(gateway.storageGetBytesInUse("ready")).resolves.toBe(1234);
    expect(gateway.getManifestVersion()).toBe("3.5.0");
  });

});
