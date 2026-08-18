// WS-D — Input: drag-anywhere floating joystick (primary) + keyboard fallback.
//
// createInput(targetEl) -> Input = { dir, consumeDir(), update(), destroy(), onPause(fn) }
//
// Integrator guidance (per docs/WORK-REMAINING.md WS-D brief):
//   Read `input.dir` LIVE, every frame, and pass it as the `input` argument to
//   player.update(dt, input, ctx). `dir` is a plain getter that always reflects
//   the current requested direction and — by design — PERSISTS after the
//   joystick is released (this is Pac-Man: the cube keeps crawling in the last
//   requested direction). Because it persists, polling it every frame is both
//   correct and cheap; there's nothing to "miss" between frames.
//
//   `consumeDir()` is a SEPARATE, one-shot/edge-triggered accessor: it returns
//   the direction only the first time it's read after `dir` actually changed,
//   and DIR_NONE otherwise (draining the "just changed" flag on read). It is
//   NOT meant to drive movement — if used for that, a missed poll would lose
//   the request permanently, breaking pre-turn buffering. It exists for
//   optional edge-triggered consumers (e.g. a UI/analytics hook that wants to
//   know "did the player just turn" exactly once). `dir` and `consumeDir()`
//   share the same underlying value and are always consistent with each other.
//
// Mobile is primary:
//   - Pointer Events only (mouse/touch/stylus share one path). pointerdown
//     anywhere on targetEl sets a floating origin; drag past a deadzone
//     resolves a 4-way direction with hysteresis toward the current axis so a
//     sloppy diagonal doesn't chatter; the resolved direction persists after
//     pointerup. Re-dragging while held re-resolves live.
//   - Flicks: velocity (not just displacement) is tracked so a fast short
//     flick that never crosses the deadzone still resolves a direction.
//   - A ring+knob indicator is created here and appended to document.body,
//     shown only while a pointer is down, removed in destroy().
//   - targetEl gets touch-action:none plus preventDefault on the relevant
//     events so the page never scrolls/zooms/rubber-bands/shows a long-press
//     menu.
// Keyboard fallback: arrows + WASD set the persistent direction; Esc/P call
//   onPause() listeners. Keys are ignored whenever document.activeElement is
//   a form field (input/textarea/select/contentEditable) so the leaderboard
//   initials screen can use letter keys without interference.
//
// Optional navigator.vibrate(...) fires on a direction CHANGE, gated on
// store.state.settings.haptics (read-only import of the store).

import { DIR_NONE, DIR_UP, DIR_RIGHT, DIR_DOWN, DIR_LEFT } from '../config.js';
import { state } from '../state/store.js';

const DEADZONE_PX = 20; // 18-24px per spec
const FLICK_VELOCITY_PX_MS = 0.6; // ~600px/s: a quick short flick inside the deadzone
const AXIS_HYSTERESIS = 1.3; // the off-axis delta must exceed the active axis by this factor to switch
const INDICATOR_MAX_RADIUS = 40;
const VIBRATE_MS = 15;

const KEY_DIR = {
  ArrowUp: DIR_UP,
  ArrowDown: DIR_DOWN,
  ArrowLeft: DIR_LEFT,
  ArrowRight: DIR_RIGHT,
  w: DIR_UP,
  s: DIR_DOWN,
  a: DIR_LEFT,
  d: DIR_RIGHT,
  W: DIR_UP,
  S: DIR_DOWN,
  A: DIR_LEFT,
  D: DIR_RIGHT,
};

function isFormFieldFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function createInput(targetEl) {
  let dir = DIR_NONE;
  let changedSinceConsume = false;

  let activePointerId = null;
  let originX = 0;
  let originY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;

  const pauseListeners = new Set();

  // --- Joystick indicator DOM (created here, owned entirely by this module) ---
  const ring = document.createElement('div');
  ring.setAttribute('aria-hidden', 'true');
  Object.assign(ring.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    width: '80px',
    height: '80px',
    marginLeft: '-40px',
    marginTop: '-40px',
    borderRadius: '50%',
    border: '2px solid rgba(255,255,255,0.55)',
    background: 'rgba(255,255,255,0.08)',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: '9999',
    display: 'none',
  });
  const knob = document.createElement('div');
  Object.assign(knob.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '32px',
    height: '32px',
    marginLeft: '-16px',
    marginTop: '-16px',
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.75)',
    pointerEvents: 'none',
  });
  ring.appendChild(knob);
  document.body.appendChild(ring);

  function showIndicator(x, y) {
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    knob.style.transform = 'translate(0px, 0px)';
    ring.style.display = 'block';
  }
  function moveIndicator(dx, dy) {
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, INDICATOR_MAX_RADIUS);
    const scale = dist > 0 ? clamped / dist : 0;
    knob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
  }
  function hideIndicator() {
    ring.style.display = 'none';
  }

  // --- Direction resolution ---
  function setDirection(newDir) {
    if (newDir === dir) return;
    dir = newDir;
    changedSinceConsume = true;
    maybeVibrate();
  }

  function maybeVibrate() {
    if (state.settings && state.settings.haptics && typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(VIBRATE_MS);
    }
  }

  function pickAxis(adx, ady) {
    const horizontalActive = dir === DIR_LEFT || dir === DIR_RIGHT;
    const verticalActive = dir === DIR_UP || dir === DIR_DOWN;
    if (horizontalActive && adx * AXIS_HYSTERESIS >= ady) return 'h';
    if (verticalActive && ady * AXIS_HYSTERESIS >= adx) return 'v';
    return adx >= ady ? 'h' : 'v';
  }

  function resolveAndSet(dx, dy) {
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx < 0.001 && ady < 0.001) return;
    const axis = pickAxis(adx, ady);
    const newDir = axis === 'h' ? (dx >= 0 ? DIR_RIGHT : DIR_LEFT) : dy >= 0 ? DIR_DOWN : DIR_UP;
    setDirection(newDir);
  }

  // --- Pointer events ---
  function onPointerDown(e) {
    if (activePointerId !== null) return; // ignore a second simultaneous pointer
    activePointerId = e.pointerId;
    originX = e.clientX;
    originY = e.clientY;
    lastX = originX;
    lastY = originY;
    lastT = typeof performance !== 'undefined' ? performance.now() : Date.now();
    showIndicator(originX, originY);
    if (targetEl.setPointerCapture) {
      try {
        targetEl.setPointerCapture(e.pointerId);
      } catch {
        /* not supported / not attached yet — safe to ignore */
      }
    }
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (e.pointerId !== activePointerId) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dx = e.clientX - originX;
    const dy = e.clientY - originY;
    const dtMs = Math.max(1, now - lastT);
    const vx = (e.clientX - lastX) / dtMs;
    const vy = (e.clientY - lastY) / dtMs;
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = now;

    moveIndicator(dx, dy);

    const dist = Math.hypot(dx, dy);
    if (dist >= DEADZONE_PX) {
      resolveAndSet(dx, dy);
    } else if (Math.hypot(vx, vy) >= FLICK_VELOCITY_PX_MS) {
      resolveAndSet(vx, vy);
    }
    e.preventDefault();
  }

  function endPointer(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    hideIndicator();
    e.preventDefault();
  }

  function onContextMenu(e) {
    e.preventDefault();
  }
  function onGestureStart(e) {
    e.preventDefault();
  }
  function onTouchMove(e) {
    // Extra hardening alongside touch-action:none / Pointer Events — some
    // mobile browsers still attempt rubber-banding/scroll without this.
    e.preventDefault();
  }
  function onTouchStart(e) {
    if (e.touches && e.touches.length > 1) e.preventDefault(); // no pinch
  }

  // --- Keyboard fallback ---
  function onKeyDown(e) {
    if (isFormFieldFocused()) return;
    if (Object.prototype.hasOwnProperty.call(KEY_DIR, e.key)) {
      setDirection(KEY_DIR[e.key]);
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
      for (const fn of pauseListeners) fn();
      e.preventDefault();
    }
  }

  // --- Wire it up ---
  const prevTouchAction = targetEl.style.touchAction;
  const prevUserSelect = targetEl.style.userSelect;
  targetEl.style.touchAction = 'none';
  targetEl.style.userSelect = 'none';
  targetEl.style.webkitUserSelect = 'none';
  targetEl.style.webkitTouchCallout = 'none';

  targetEl.addEventListener('pointerdown', onPointerDown);
  targetEl.addEventListener('pointermove', onPointerMove);
  targetEl.addEventListener('pointerup', endPointer);
  targetEl.addEventListener('pointercancel', endPointer);
  targetEl.addEventListener('contextmenu', onContextMenu);
  targetEl.addEventListener('gesturestart', onGestureStart);
  targetEl.addEventListener('touchstart', onTouchStart, { passive: false });
  targetEl.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('keydown', onKeyDown);

  const input = {
    consumeDir() {
      if (!changedSinceConsume) return DIR_NONE;
      changedSinceConsume = false;
      return dir;
    },
    update() {
      // No per-frame work needed: direction resolution is fully event-driven.
      // Present for API symmetry with the other entity/input modules.
    },
    destroy() {
      targetEl.removeEventListener('pointerdown', onPointerDown);
      targetEl.removeEventListener('pointermove', onPointerMove);
      targetEl.removeEventListener('pointerup', endPointer);
      targetEl.removeEventListener('pointercancel', endPointer);
      targetEl.removeEventListener('contextmenu', onContextMenu);
      targetEl.removeEventListener('gesturestart', onGestureStart);
      targetEl.removeEventListener('touchstart', onTouchStart);
      targetEl.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('keydown', onKeyDown);
      targetEl.style.touchAction = prevTouchAction;
      targetEl.style.userSelect = prevUserSelect;
      ring.remove();
      pauseListeners.clear();
    },
    onPause(fn) {
      pauseListeners.add(fn);
    },
  };
  Object.defineProperty(input, 'dir', { get: () => dir, enumerable: true });

  return input;
}
