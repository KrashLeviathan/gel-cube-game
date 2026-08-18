/**
 * WS-F — fixed-timestep game loop.
 *
 * Two independent clocks:
 *  - The RAF/render clock runs continuously any time the tab is visible
 *    (ambient stuff — torch flicker, fx decay, camera shake — should keep
 *    animating even on the home/paused screens).
 *  - The SIMULATION clock (fixed-step accumulator driving `step()`, i.e.
 *    rules.update()) only advances while `store.state.screen === 'playing'`.
 *    Per docs/INTEGRATION.md: the HUD's pause button flips the screen flag
 *    directly and never calls into this module, so this module is the one
 *    that has to notice via SCREEN_CHANGED and gate the sim accordingly —
 *    nothing else does.
 *
 * `render(dt, alpha)` is called every RAF frame regardless of sim state.
 * `alpha` is the fraction of a fixed step left over in the accumulator
 * (0 while the sim is stopped). True render-position interpolation (lerping
 * between the previous and current fixed-step transform) is NOT implemented
 * on top of it: every entity already computes a continuous world position
 * every fixed step (see player.js/adventurer.js's anchor+progress model), and
 * FIXED_DT is 1/120s — finer than any real display's frame rate — so between
 * two rendered frames the simulation has already advanced in sub-frame-sized
 * slices. Interpolating on top would smooth an already-smooth signal; `alpha`
 * is still computed and passed through in case a future consumer wants it.
 */
import { FIXED_DT, MAX_FRAME_DT } from '../config.js';
import { on, emit, EVENTS, state } from '../state/store.js';

const MAX_STEPS_PER_FRAME = Math.ceil(MAX_FRAME_DT / FIXED_DT) + 1; // safety cap, belt-and-suspenders

export function createLoop(step, render) {
  let raf = 0;
  let last = 0;
  let acc = 0;
  let rafRunning = false;
  let simRunning = false;
  let prevScreen = state.screen;

  function frame(t) {
    raf = requestAnimationFrame(frame);

    let frameDt = (t - last) / 1000;
    last = t;
    if (!Number.isFinite(frameDt) || frameDt < 0) frameDt = 0;
    frameDt = Math.min(MAX_FRAME_DT, frameDt);

    if (simRunning) {
      acc += frameDt;
      let steps = 0;
      while (acc >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        step(FIXED_DT);
        acc -= FIXED_DT;
        steps++;
      }
      if (steps >= MAX_STEPS_PER_FRAME) acc = 0; // pathological stall — drop the remainder
    } else {
      acc = 0;
    }

    const alpha = simRunning ? acc / FIXED_DT : 0;
    render(frameDt, alpha);
  }

  function startRaf() {
    if (rafRunning) return;
    rafRunning = true;
    last = typeof performance !== 'undefined' ? performance.now() : Date.now();
    raf = requestAnimationFrame(frame);
  }

  function stopRaf() {
    if (!rafRunning) return;
    rafRunning = false;
    cancelAnimationFrame(raf);
  }

  const unsubScreen = on(EVENTS.SCREEN_CHANGED, (screen) => {
    const wasPlaying = prevScreen === 'playing';
    const wasPaused = prevScreen === 'paused';
    const isPlaying = screen === 'playing';

    simRunning = isPlaying;
    if (!isPlaying) acc = 0;
    state.paused = screen === 'paused';

    if (wasPlaying && screen === 'paused') emit(EVENTS.PAUSED, state);
    if (wasPaused && isPlaying) emit(EVENTS.RESUMED, state);

    prevScreen = screen;
  });

  function onVisibility() {
    if (document.hidden) stopRaf();
    else startRaf();
  }
  document.addEventListener('visibilitychange', onVisibility);

  return {
    start() {
      startRaf();
    },
    stop() {
      stopRaf();
      unsubScreen();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
