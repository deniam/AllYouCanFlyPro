// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      <a class="donate-link" href="#"></a>
    </div>`;
  const interval = mountDonationReminder({
    storage,
    getDonationCompleted
  });
  return { storage, controller: interval, link: document.querySelector(".donate-link") };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("donation reminder", () => {
  it("hides on a donation click without marking the donation completed", () => {
    const { storage, controller, link } = mount();
    link.click();
    expect(document.getElementById("donation-reminder").classList.contains("hidden")).toBe(true);
    expect(storage.getItem("userDonated")).toBeNull();
    controller.stop();
  });

  it("hides and does not show when the success marker is present", async () => {
    const { controller } = mount({ getDonationCompleted: async () => true });
    const reminder = document.getElementById("donation-reminder");
    reminder.classList.remove("hidden");
    await Promise.resolve();
    expect(reminder.classList.contains("hidden")).toBe(true);
    controller.stop();
  });

  it("removes the legacy click-based marker", () => {
    const storage = makeStorage();
    storage.setItem("userDonated", "true");
    const { controller } = mount({ storage });
    expect(storage.getItem("userDonated")).toBeNull();
    controller.stop();
  });

  it("waits for displayed results and then delays the reminder by fifteen seconds", async () => {
    vi.useFakeTimers();
    const { controller } = mount();
    await Promise.resolve();
    const reminder = document.getElementById("donation-reminder");
    vi.advanceTimersByTime(30_000);
    expect(reminder.classList.contains("hidden")).toBe(true);

    controller.resultsDisplayed(1);
    await Promise.resolve();
    vi.advanceTimersByTime(14_999);
    expect(reminder.classList.contains("hidden")).toBe(true);
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(reminder.classList.contains("hidden")).toBe(false);
    controller.stop();
    vi.useRealTimers();
  });

  it("limits the reminder to three displays per local day", async () => {
    vi.useFakeTimers();
    const storage = makeStorage();
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    storage.setItem("donationReminderDate", date);
    storage.setItem("donationReminderShows", "3");
    const { controller } = mount({ storage });
    controller.resultsDisplayed(1);
    await Promise.resolve();
    vi.advanceTimersByTime(15_000);
    expect(document.getElementById("donation-reminder").classList.contains("hidden")).toBe(true);
    controller.stop();
    vi.useRealTimers();
  });
});
