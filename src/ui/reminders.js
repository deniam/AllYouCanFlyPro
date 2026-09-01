export function mountDonationReminder({
  storage = localStorage,
  openExternal = url => window.open(url, "_blank"),
  getDonationCompleted = async () => false
}) {
  const reminder = document.getElementById("donation-reminder");
  if (!reminder) return null;

  // Remove the pre-success-page flag used by older versions. Existing users
  // intentionally go through the new flow after this update.
  storage.removeItem("userDonated");

  let checkInProgress = false;
  let showTimer = null;
  const cancelShowTimer = () => {
    if (showTimer === null) return;
    clearTimeout(showTimer);
    showTimer = null;
  };

  const check = async () => {
    if (checkInProgress) return;
    checkInProgress = true;
    try {
      if (await getDonationCompleted()) {
        cancelShowTimer();
        reminder.classList.add("hidden");
        return;
      }

      const lastShown = Number(storage.getItem("lastReminderShown") || 0);
      const interval = storage.getItem("userLeftReview") === "true"
        ? 24 * 60 * 60 * 1000
        : 5 * 60 * 1000;
      if (Date.now() - lastShown <= interval) return;
      if (showTimer !== null) return;
      showTimer = setTimeout(() => {
        showTimer = null;
        getDonationCompleted().then(completed => {
          if (completed) {
            reminder.classList.add("hidden");
            return;
          }
          reminder.classList.remove("hidden");
          storage.setItem("lastReminderShown", String(Date.now()));
        }).catch(() => {});
      }, 3000);
    } finally {
      checkInProgress = false;
    }
  };

  document.getElementById("close-reminder").addEventListener("click", () => {
    cancelShowTimer();
    reminder.classList.add("hidden");
  });
  document.getElementById("leave-review").addEventListener("click", () => {
    cancelShowTimer();
    reminder.classList.add("hidden");
    storage.setItem("userLeftReview", "true");
    openExternal("https://chromewebstore.google.com/detail/all-you-can-fly-pro-aycf/oimhdkdhblofmdebbpdfabddcnpmlhha/reviews");
  });
  document.querySelectorAll(".donate-link").forEach(link => link.addEventListener("click", () => {
    const wasVisible = !reminder.classList.contains("hidden");
    cancelShowTimer();
    reminder.classList.add("hidden");
    if (wasVisible) storage.setItem("lastReminderShown", String(Date.now()));
  }));
  check();
  return setInterval(check, 10_000);
}
