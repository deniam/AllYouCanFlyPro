// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { mountDonationReminder } from "../../src/ui/reminders.js";

function makeStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

function mount({ storage = makeStorage(), getDonationCompleted = async () => false } = {}) {
  document.body.innerHTML = `
    <div id="donation-reminder" class="hidden">
      <button id="close-reminder"></button>
      <button id="leave-review"></button>
      <a class="donate-link" href="#"></a>
    </div>`;
  const interval = mountDonationReminder({
    storage,
    getDonationCompleted,
    openExternal: () => {}
  });
  return { storage, interval, link: document.querySelector(".donate-link") };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("donation reminder", () => {
  it("hides on a donation click without marking the donation completed", () => {
    const { storage, interval, link } = mount();
    link.click();
    expect(document.getElementById("donation-reminder").classList.contains("hidden")).toBe(true);
    expect(storage.getItem("userDonated")).toBeNull();
    clearInterval(interval);
  });

  it("hides and does not show when the success marker is present", async () => {
    const { interval } = mount({ getDonationCompleted: async () => true });
    const reminder = document.getElementById("donation-reminder");
    reminder.classList.remove("hidden");
    await Promise.resolve();
    expect(reminder.classList.contains("hidden")).toBe(true);
    clearInterval(interval);
  });

  it("removes the legacy click-based marker", () => {
    const storage = makeStorage();
    storage.setItem("userDonated", "true");
    const { interval } = mount({ storage });
    expect(storage.getItem("userDonated")).toBeNull();
    clearInterval(interval);
  });
});
