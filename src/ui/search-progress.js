export function createSearchProgress({ container, text, bar, resultsContainer, timeoutStatus }) {
  let countdownTimer = null;

  function update(current, total, message) {
    resultsContainer.classList.remove("hidden");
    container.style.display = "block";
    text.textContent = `${message} (${current} of ${total})`;
    bar.style.width = `${total > 0 ? (current / total) * 100 : 0}%`;
  }

  function hide() {
    container.style.display = "none";
  }

  function resetCountdown() {
    if (countdownTimer !== null) clearInterval(countdownTimer);
    countdownTimer = null;
    timeoutStatus.textContent = "";
    timeoutStatus.style.display = "none";
  }

  function showCountdown(waitTimeMs, rateLimited = waitTimeMs === 40_000) {
    resetCountdown();
    let seconds = Math.ceil(waitTimeMs / 1000);
    timeoutStatus.style.display = "block";
    timeoutStatus.style.color = rateLimited ? "red" : "";
    const render = () => {
      timeoutStatus.textContent = rateLimited
        ? `Rate limit encountered, pausing for ${seconds} seconds. Adjust Expert Settings or pause between searches.`
        : `Pausing for ${seconds} seconds to avoid API rate limits...`;
    };
    render();
    countdownTimer = setInterval(() => {
      seconds -= 1;
      if (seconds <= 0) resetCountdown();
      else render();
    }, 1000);
  }

  return Object.freeze({ update, hide, resetCountdown, showCountdown });
}
