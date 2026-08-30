export function mountDonationReminder({ storage = localStorage, openExternal = url => window.open(url, "_blank") }) {
  const reminder = document.getElementById("donation-reminder");
  const check = () => {
    if (storage.getItem("userDonated") === "true") return;
    const lastShown = Number(storage.getItem("lastReminderShown") || 0);
    const interval = storage.getItem("userLeftReview") === "true"
      ? 24 * 60 * 60 * 1000
      : 5 * 60 * 1000;
    if (Date.now() - lastShown <= interval) return;
    setTimeout(() => {
      reminder.classList.remove("hidden");
      storage.setItem("lastReminderShown", String(Date.now()));
    }, 3000);
  };

  document.getElementById("close-reminder").addEventListener("click", () => reminder.classList.add("hidden"));
  document.getElementById("leave-review").addEventListener("click", () => {
    reminder.classList.add("hidden");
    storage.setItem("userLeftReview", "true");
    openExternal("https://chromewebstore.google.com/detail/all-you-can-fly-pro-aycf/oimhdkdhblofmdebbpdfabddcnpmlhha/reviews");
  });
  document.querySelectorAll(".donate-link").forEach(link => link.addEventListener("click", () => {
    reminder.classList.add("hidden");
    storage.setItem("userDonated", "true");
  }));
  check();
  return setInterval(check, 10_000);
}
