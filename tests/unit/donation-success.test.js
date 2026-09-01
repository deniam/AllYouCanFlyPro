import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("donation success content script", () => {
  it("stores the completion marker in extension storage", () => {
    const set = vi.fn();
    vm.runInNewContext(readFileSync("src/donation-success.js", "utf8"), {
      chrome: { storage: { local: { set } } }
    });
    expect(set).toHaveBeenCalledWith({ donationCompleted: true });
  });
});
