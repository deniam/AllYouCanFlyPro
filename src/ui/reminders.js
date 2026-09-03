export function mountDonationReminder({
  storage = localStorage,
  getDonationCompleted = async () => false
}) {
  const reminder = document.getElementById("donation-reminder");
  if (!reminder) return null;

  // Remove the pre-success-page flag used by older versions. Existing users
  // intentionally go through the new flow after this update.
  storage.removeItem("userDonated");

  let checkInProgress = false;
  let showTimer = null;
  let stopped = false;
  let searchGeneration = 0;
  let previousFocusedElement = null;
  const closeButton = document.getElementById("close-reminder");

  const cancelShowTimer = () => {
    if (showTimer === null) return;
    clearTimeout(showTimer);
    showTimer = null;
  };

  const hideReminder = () => {
    cancelShowTimer();
    reminder.classList.add("hidden");
    if (previousFocusedElement?.isConnected && typeof previousFocusedElement.focus === "function") {
      previousFocusedElement.focus({ preventScroll: true });
    }
    previousFocusedElement = null;
  };

  const showReminder = () => {
    if (reminder.classList.contains("hidden")) {
      previousFocusedElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    reminder.classList.remove("hidden");
    closeButton?.focus({ preventScroll: true });
  };

  const getLocalDate = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };

  const getDailyShowCount = () => {
    const today = getLocalDate();
    if (storage.getItem("donationReminderDate") !== today) return 0;
    return Number(storage.getItem("donationReminderShows") || 0);
  };

  const recordDailyShow = () => {
    const today = getLocalDate();
    const date = storage.getItem("donationReminderDate");
    const count = date === today ? Number(storage.getItem("donationReminderShows") || 0) : 0;
    storage.setItem("donationReminderDate", today);
    storage.setItem("donationReminderShows", String(count + 1));
    storage.setItem("lastReminderShown", String(Date.now()));
  };

  const scheduleAfterResults = async generation => {
    if (stopped || showTimer !== null || getDailyShowCount() >= 3) return;
    try {
      if (await getDonationCompleted()) {
        hideReminder();
        return;
      }
    } catch {
      return;
    }
    if (stopped || generation !== searchGeneration || showTimer !== null || getDailyShowCount() >= 3) return;
    showTimer = setTimeout(async () => {
      showTimer = null;
      if (stopped || generation !== searchGeneration || getDailyShowCount() >= 3) return;
      try {
        if (await getDonationCompleted()) {
          hideReminder();
          return;
        }
      } catch {
        return;
      }
      if (stopped || generation !== searchGeneration || getDailyShowCount() >= 3) return;
      showReminder();
      recordDailyShow();
    }, 15_000);
  };

  const check = async () => {
    if (stopped || checkInProgress) return;
    checkInProgress = true;
    try {
      if (await getDonationCompleted()) {
        hideReminder();
      }
    } catch {
      // A storage/API failure should not prevent the rest of the application.
    } finally {
      checkInProgress = false;
    }
  };

  const onClose = () => {
    hideReminder();
  };
  const onDonationClick = () => {
    const wasVisible = !reminder.classList.contains("hidden");
    hideReminder();
    if (wasVisible) storage.setItem("lastReminderShown", String(Date.now()));
  };
  const onKeyDown = event => {
    if (event.key === "Escape" && !reminder.classList.contains("hidden")) hideReminder();
  };

  closeButton?.addEventListener("click", onClose);
  document.addEventListener("keydown", onKeyDown);
  document.querySelectorAll(".donate-link").forEach(link => link.addEventListener("click", onDonationClick));
  const intervalId = setInterval(check, 10_000);
  check();

  return {
    searchStarted() {
      searchGeneration += 1;
      cancelShowTimer();
      hideReminder();
    },
    resultsDisplayed(resultCount) {
      if (resultCount > 0) scheduleAfterResults(searchGeneration);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(intervalId);
      cancelShowTimer();
      closeButton?.removeEventListener("click", onClose);
      document.removeEventListener("keydown", onKeyDown);
      document.querySelectorAll(".donate-link").forEach(link => link.removeEventListener("click", onDonationClick));
    }
  };
}
