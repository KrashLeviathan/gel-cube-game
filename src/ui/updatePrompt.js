/**
 * "A new version is ready" toast.
 *
 * Like the How to Play overlay this is NOT a screen — `state.screen` keeps its
 * documented five values. It listens to the store and never drives anything,
 * matching the rest of ui/.
 *
 * The one rule worth stating: a reload destroys the current run, so the toast
 * stays hidden while there is one. 'paused' counts as a live run — a player
 * who paused mid-level should not be one mis-tap away from losing it.
 *
 * handlers.onRefresh(): void — the player asked for the update. The integrator
 * should call swClient's applyUpdate(); this module does not reload anything
 * itself.
 */

import { on, state, EVENTS } from '../state/store.js';

export function createUpdatePrompt(root, handlers = {}) {
  const el = document.createElement('div');
  el.className = 'update-toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <span class="update-toast-text">A new version of the dungeon is ready.</span>
    <button type="button" class="btn btn--primary update-toast-refresh" data-action="refresh">Refresh</button>
    <button type="button" class="update-toast-dismiss" data-action="dismiss" aria-label="Dismiss">×</button>
  `;
  root.appendChild(el);

  let pending = false;
  let dismissed = false;

  function inRun() {
    return state.screen === 'playing' || state.screen === 'paused';
  }

  function sync() {
    el.classList.toggle('is-visible', pending && !dismissed && !inRun());
  }

  el.querySelector('[data-action="refresh"]').addEventListener('click', () => {
    handlers.onRefresh?.();
  });
  // Dismissal only lasts the session. The worker stays parked in `waiting`, so
  // the next load offers the update again.
  el.querySelector('[data-action="dismiss"]').addEventListener('click', () => {
    dismissed = true;
    sync();
  });

  const unsub = on(EVENTS.SCREEN_CHANGED, sync);

  return {
    /** An update finished installing and is waiting to take over. */
    show() {
      pending = true;
      sync();
    },
    dispose() {
      unsub();
      el.remove();
    },
  };
}
