export function whenDomReady(callback) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", callback, { once: true });
  } else {
    queueMicrotask(callback);
  }
}

let mountPromise;

/**
 * Idempotently mounts the extension page once its DOM is ready.
 */
export function mountApp({ state, services, elements, initialize }) {
  if (mountPromise) return mountPromise;
  mountPromise = new Promise((resolve, reject) => {
    whenDomReady(() => {
      Promise.resolve(initialize(Object.freeze({ state, services, elements })))
        .then(resolve, reject);
    });
  });
  return mountPromise;
}
