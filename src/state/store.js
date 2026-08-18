/**
 * Tiny observable game state.
 *
 * CONTRACT FILE — owned by the architect. Subagents may add new fields to
 * `state` and new event names to EVENTS, but must not change the emit/on API.
 *
 * The store is deliberately dumb: rules.js mutates it and emits events; the UI
 * and audio layers only listen. Nothing in render/ or entities/ should import
 * this to *drive* simulation — it exists so the DOM layer stays decoupled.
 */

import { DEFAULT_SETTINGS, STARTING_LIVES } from '../config.js';

export const EVENTS = {
  // screen routing
  SCREEN_CHANGED: 'screen:changed',
  // run lifecycle
  RUN_STARTED: 'run:started',
  RUN_OVER: 'run:over',
  LEVEL_STARTED: 'level:started',
  LEVEL_CLEARED: 'level:cleared',
  LEVEL_FAILED: 'level:failed',
  LIFE_LOST: 'life:lost',
  PAUSED: 'game:paused',
  RESUMED: 'game:resumed',
  // moment-to-moment
  SCORE_CHANGED: 'score:changed',
  LOOT_CHANGED: 'loot:changed',
  DRIED_STARTED: 'dried:started',
  DRIED_ENDED: 'dried:ended',
  ADVENTURER_DISSOLVED: 'adventurer:dissolved',
  ADVENTURER_BANKED: 'adventurer:banked',
  ITEM_TAKEN: 'item:taken',
  COIN_TAKEN: 'coin:taken',
  SETTINGS_CHANGED: 'settings:changed',
  // WS-F additions — additive only, per the note above. See docs/INTEGRATION.md
  // "WS-F — integration" for exactly when each fires and its payload shape.
  DIGEST_STARTED: 'digest:started',
  DRIED_WARNING: 'dried:warning',
  TUNNEL_WRAPPED: 'tunnel:wrapped',
};

/** @typedef {'home'|'leaderboard'|'playing'|'paused'|'gameover'} ScreenId */

export const state = {
  /** @type {ScreenId} */
  screen: 'home',
  settings: { ...DEFAULT_SETTINGS },

  // per-run
  score: 0,
  lives: STARTING_LIVES,
  level: 1,
  /** true between RUN_STARTED and RUN_OVER */
  running: false,
  paused: false,

  // per-level
  coinsTotal: 0,
  coinsOnFloor: 0,
  coinsBanked: 0,
  lootGoal: 0,
  adventurersAlive: 0,
  adventurersTotal: 0,

  // cube status
  dried: false,
  driedRemaining: 0,
  combo: 0,
  /** true while the cube has a nonzero move direction (not mid-respawn-freeze).
   *  WS-F addition — lets audio.js drive a looping slime-crawl sfx without
   *  needing a reference to the player entity. */
  cubeMoving: false,
};

const listeners = new Map();

/**
 * Subscribe to an event. Returns an unsubscribe function.
 * @param {string} evt
 * @param {(payload?: any) => void} fn
 */
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => off(evt, fn);
}

export function off(evt, fn) {
  const set = listeners.get(evt);
  if (set) set.delete(fn);
}

export function emit(evt, payload) {
  const set = listeners.get(evt);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[store] listener for "${evt}" threw`, err);
    }
  }
}

/** Merge a patch into state and emit a single event. */
export function patch(fields, evt) {
  Object.assign(state, fields);
  if (evt) emit(evt, state);
}

/** Change the active screen. */
export function setScreen(screen) {
  if (state.screen === screen) return;
  state.screen = screen;
  emit(EVENTS.SCREEN_CHANGED, screen);
}

/** Reset per-run counters. Called by rules.js when a new run begins. */
export function resetRun() {
  state.score = 0;
  state.lives = STARTING_LIVES;
  state.level = 1;
  state.combo = 0;
  state.dried = false;
  state.driedRemaining = 0;
  state.running = true;
  state.paused = false;
}
