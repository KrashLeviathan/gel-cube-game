/**
 * Service worker registration and update detection. No DOM and no store —
 * main.js hands the "an update is ready" signal to ui/updatePrompt.js.
 *
 * The worker never calls skipWaiting() on its own (see src/sw.js), so a new
 * build installs, parks in `waiting`, and changes nothing until the player
 * taps Refresh. That tap is `applyUpdate()`: it releases the waiting worker,
 * and the reload rides the `controllerchange` that follows.
 *
 * Everything here is best-effort. A worker that fails to register, update, or
 * activate must never stop the game booting — offline play is a bonus, not a
 * dependency.
 */

/** Don't re-poll the network for a new worker more often than this. */
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** If `controllerchange` never lands after skipWaiting, reload anyway. */
const APPLY_TIMEOUT_MS = 3000;

export function registerServiceWorker({ onUpdateReady } = {}) {
  if (!('serviceWorker' in navigator)) return { applyUpdate() {} };

  if (!import.meta.env.PROD) {
    // `npm run preview` registers a real worker on localhost. Left alone it
    // would go on serving a built bundle over the top of the dev server.
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => regs.forEach((reg) => reg.unregister()))
      .catch(() => {});
    return { applyUpdate() {} };
  }

  let registration = null;
  let applying = false;
  let reloading = false;
  let lastCheck = 0;

  function reloadOnce() {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Also fires the first time a worker claims an uncontrolled page. Only a
    // reload we asked for should turn into an actual reload.
    if (applying) reloadOnce();
  });

  function announce() {
    onUpdateReady?.();
  }

  function watch(reg) {
    registration = reg;

    // A controller means an older worker is already running this page, so an
    // installed sibling is an update. Without one it's a first install, and
    // there is nothing to tell the player about.
    if (reg.waiting && navigator.serviceWorker.controller) {
      announce();
      return;
    }

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) announce();
      });
    });
  }

  // Registering after load keeps the worker's install off the critical path
  // for first paint — it competes with the Three.js bundle otherwise.
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(new URL('sw.js', document.baseURI).href, { updateViaCache: 'none' })
      .then(watch)
      .catch(() => {});
  });

  // A session can run for an hour without a navigation, which is the only
  // thing that would otherwise trigger a check.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (!registration || now - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
    lastCheck = now;
    registration.update().catch(() => {});
  });

  return {
    applyUpdate() {
      const waiting = registration?.waiting;
      if (!waiting) {
        // Nothing parked to activate; a plain reload is still the right
        // answer to "give me the latest".
        reloadOnce();
        return;
      }
      applying = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
      setTimeout(reloadOnce, APPLY_TIMEOUT_MS);
    },
  };
}
