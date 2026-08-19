// WS-H — Audio. Self-contained: subscribes to the store directly (same
// pattern input.js uses for DOM — no changes needed in main.js beyond
// `const audio = createAudio(); audio.init();` once at startup).
//
// Every mp3 in the table below is OPTIONAL. `public/audio/` may be empty (it
// is, by default — only a README.md ships) and the game must run identically
// either way: a missing file logs once at console.debug and every future
// play()/music() call for that name becomes a silent no-op forever after.
//
// If you'd rather use different filenames, this is the ONE table to edit —
// nothing else in the file (or elsewhere) hardcodes a path. Keep the logical
// names on the left stable; they're referenced throughout this module and in
// docs/INTEGRATION.md's WS-H mapping.

import { on, EVENTS, state } from '../state/store.js';

const AUDIO_BASE = '/audio/';

/** logical name -> filename in public/audio/ */
const FILES = {
  // music (looping)
  'music-title': 'music-title.mp3',
  'music-level': 'music-level.mp3',
  'music-dried': 'music-dried.mp3',
  'music-gameover': 'music-gameover.mp3',
  // sfx (one-shot, except sfx-slime-step which loops while cubeMoving)
  'sfx-ui-tap': 'sfx-ui-tap.mp3',
  'sfx-level-start': 'sfx-level-start.mp3',
  'sfx-level-clear': 'sfx-level-clear.mp3',
  'sfx-level-fail': 'sfx-level-fail.mp3',
  'sfx-engulf': 'sfx-engulf.mp3',
  'sfx-digest': 'sfx-digest.mp3',
  'sfx-combo': 'sfx-combo.mp3',
  'sfx-coin': 'sfx-coin.mp3',
  'sfx-bank': 'sfx-bank.mp3',
  'sfx-spill': 'sfx-spill.mp3',
  'sfx-item': 'sfx-item.mp3',
  'sfx-dried': 'sfx-dried.mp3',
  'sfx-dried-warning': 'sfx-dried-warning.mp3',
  'sfx-rehydrate': 'sfx-rehydrate.mp3',
  'sfx-life-lost': 'sfx-life-lost.mp3',
  'sfx-tunnel': 'sfx-tunnel.mp3',
  'sfx-slime-step': 'sfx-slime-step.mp3',
  'sfx-highscore': 'sfx-highscore.mp3',
};

const MUSIC_NAMES = new Set(['music-title', 'music-level', 'music-dried', 'music-gameover']);

const CROSSFADE_S = 0.8;
const DUCK_GAIN = 0.35; // level track's gain while dried track plays on top
const DIGEST_DELAY_MS = 200; // gap between engulf and digest so it reads as "hit, then gulp"
const COMBO_BASE_RATE = 1.0;
const COMBO_RATE_STEP = 0.08; // playbackRate increases per combo step to fake pitch rise

export function createAudio() {
  /** @type {AudioContext|null} */
  let ctx = null;
  /** names we've already confirmed missing — logged once, silent forever after */
  const missing = new Set();
  /** decoded AudioBuffers, keyed by logical name, once successfully loaded */
  const buffers = new Map();
  /** in-flight decode promises, keyed by logical name, to avoid duplicate fetches */
  const loading = new Map();

  let musicEnabled = true;
  let sfxEnabled = true;
  let unlocked = false;
  let destroyed = false;

  // active music voices: { name, source, gain, startedAt }
  let musicVoices = []; // usually 0-2 during a crossfade
  let duckVoice = null; // the level-track voice currently ducked under music-dried
  let currentMusicName = null; // logical "what should be playing" independent of duck state

  let slimeStepSource = null; // currently playing looping slime-step voice, or null
  let slimeStepGain = null;
  let cubeMovingLast = false;

  let unsubs = [];

  function log(name) {
    if (missing.has(name)) return;
    missing.add(name);
    console.debug(`[audio] "${name}" (${FILES[name] || name}) not found — skipping`);
  }

  function ensureCtx() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    const c = ensureCtx();
    if (c && c.state === 'suspended') {
      c.resume().catch(() => {});
    }
  }

  /** Fetch + decode a logical sound's mp3. Resolves to null if missing/unsupported. */
  async function load(name) {
    if (missing.has(name)) return null;
    if (buffers.has(name)) return buffers.get(name);
    if (loading.has(name)) return loading.get(name);

    const c = ensureCtx();
    if (!c) {
      log(name);
      return null;
    }

    const file = FILES[name];
    if (!file) {
      log(name);
      return null;
    }

    const p = (async () => {
      try {
        const res = await fetch(AUDIO_BASE + file);
        if (!res.ok) {
          log(name);
          return null;
        }
        const arr = await res.arrayBuffer();
        const buf = await c.decodeAudioData(arr);
        buffers.set(name, buf);
        return buf;
      } catch {
        log(name);
        return null;
      } finally {
        loading.delete(name);
      }
    })();
    loading.set(name, p);
    return p;
  }

  // ---- one-shot SFX --------------------------------------------------

  /**
   * Play a one-shot sfx by logical name. `opts.rate` sets playbackRate
   * (used to fake a pitch rise for combo chains). Fire-and-forget: nodes
   * clean themselves up on `ended`, overlapping calls are fine — the Web
   * Audio API plays concurrent BufferSourceNodes natively.
   */
  function play(name, opts = {}) {
    if (!sfxEnabled || destroyed) return;
    const c = ensureCtx();
    if (!c) return;
    load(name).then((buf) => {
      if (!buf || destroyed || !sfxEnabled) return;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = opts.rate || 1;
      const gain = c.createGain();
      gain.gain.value = opts.gain != null ? opts.gain : 1;
      src.connect(gain).connect(c.destination);
      src.onended = () => {
        src.disconnect();
        gain.disconnect();
      };
      src.start();
    });
  }

  // ---- looping slime-step -------------------------------------------

  function startSlimeStep() {
    if (!sfxEnabled || destroyed || slimeStepSource) return;
    const c = ensureCtx();
    if (!c) return;
    load('sfx-slime-step').then((buf) => {
      if (!buf || destroyed || !sfxEnabled || slimeStepSource) return;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = c.createGain();
      gain.gain.value = 0.6;
      src.connect(gain).connect(c.destination);
      src.start();
      slimeStepSource = src;
      slimeStepGain = gain;
    });
  }

  function stopSlimeStep() {
    if (slimeStepSource) {
      try {
        slimeStepSource.stop();
      } catch {
        /* already stopped */
      }
      slimeStepSource.disconnect();
      slimeStepSource = null;
    }
    if (slimeStepGain) {
      slimeStepGain.disconnect();
      slimeStepGain = null;
    }
  }

  // ---- music (crossfade + ducking) -----------------------------------

  function stopVoice(voice, fadeS = CROSSFADE_S) {
    if (!voice) return;
    const c = ctx;
    const now = c.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + fadeS);
    const src = voice.source;
    setTimeout(
      () => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        src.disconnect();
        voice.gain.disconnect();
      },
      fadeS * 1000 + 50,
    );
  }

  /** Start a looping music voice at `targetGain`, fading in from 0. */
  function startVoice(name, targetGain, fadeS = CROSSFADE_S) {
    const c = ensureCtx();
    if (!c) return null;
    return load(name).then((buf) => {
      if (!buf || destroyed || !musicEnabled) return null;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = c.createGain();
      const now = c.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(targetGain, now + fadeS);
      src.connect(gain).connect(c.destination);
      src.start();
      return { name, source: src, gain };
    });
  }

  /** Switch/start a named music loop with crossfade, or stop if falsy. */
  function music(track) {
    currentMusicName = track || null;
    if (!track) {
      stopAllMusic();
      return;
    }
    if (!MUSIC_NAMES.has(track)) {
      log(track);
      return;
    }
    // fade out whatever's currently playing (except a duck voice, handled separately)
    for (const v of musicVoices) stopVoice(v);
    musicVoices = [];

    if (!musicEnabled) return; // remember the intent, but don't actually play

    startVoice(track, 1).then((voice) => {
      if (!voice || destroyed) return;
      // if music got disabled or the target changed while loading, drop it
      if (!musicEnabled || currentMusicName !== track) {
        stopVoice(voice, 0.05);
        return;
      }
      musicVoices.push(voice);
    });
  }

  function stopAllMusic() {
    for (const v of musicVoices) stopVoice(v);
    musicVoices = [];
    if (duckVoice) {
      stopVoice(duckVoice, 0.05);
      duckVoice = null;
    }
  }

  /** Duck the currently-playing level track and layer music-dried on top. */
  function startDucking() {
    if (!musicEnabled || destroyed) return;
    // duck existing level voice(s) in place rather than restarting them
    for (const v of musicVoices) {
      const c = ctx;
      const now = c.currentTime;
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.linearRampToValueAtTime(DUCK_GAIN, now + CROSSFADE_S);
    }
    startVoice('music-dried', 1).then((voice) => {
      if (!voice || destroyed) return;
      if (!state.dried || !musicEnabled) {
        stopVoice(voice, 0.05);
        return;
      }
      duckVoice = voice;
    });
  }

  /** Restore the level track to full volume and stop music-dried. */
  function stopDucking() {
    if (duckVoice) {
      stopVoice(duckVoice);
      duckVoice = null;
    }
    for (const v of musicVoices) {
      const c = ctx;
      if (!c) continue;
      const now = c.currentTime;
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.linearRampToValueAtTime(1, now + CROSSFADE_S);
    }
  }

  // ---- enable/disable --------------------------------------------------

  function setMusicEnabled(b) {
    musicEnabled = !!b;
    if (!musicEnabled) {
      stopAllMusic();
    } else if (currentMusicName) {
      // re-trigger so a voice actually starts (setting was off when music() last ran)
      music(currentMusicName);
      if (state.dried && state.screen === 'playing') startDucking();
    }
  }

  function setSfxEnabled(b) {
    sfxEnabled = !!b;
    if (!sfxEnabled) stopSlimeStep();
  }

  // ---- store wiring ------------------------------------------------

  function wire() {
    unsubs.push(
      on(EVENTS.LEVEL_STARTED, () => play('sfx-level-start')),
      on(EVENTS.LEVEL_CLEARED, () => play('sfx-level-clear')),
      on(EVENTS.LEVEL_FAILED, () => play('sfx-level-fail')),

      on(EVENTS.ADVENTURER_DISSOLVED, (payload = {}) => {
        play('sfx-engulf');
        const combo = payload.combo || 1;
        const rate = COMBO_BASE_RATE + (combo - 1) * COMBO_RATE_STEP;
        play('sfx-combo', { rate });
        if (payload.spillCount > 0) play('sfx-spill');
      }),

      on(EVENTS.DIGEST_STARTED, () => {
        setTimeout(() => {
          if (!destroyed) play('sfx-digest');
        }, DIGEST_DELAY_MS);
      }),

      on(EVENTS.COIN_TAKEN, () => play('sfx-coin')),
      on(EVENTS.ADVENTURER_BANKED, () => play('sfx-bank')),
      on(EVENTS.ITEM_TAKEN, () => play('sfx-item')),

      on(EVENTS.DRIED_STARTED, () => {
        play('sfx-dried');
        if (state.screen === 'playing') startDucking();
      }),
      on(EVENTS.DRIED_WARNING, () => play('sfx-dried-warning')),
      on(EVENTS.DRIED_ENDED, () => {
        play('sfx-rehydrate');
        stopDucking();
      }),

      on(EVENTS.LIFE_LOST, () => play('sfx-life-lost')),
      on(EVENTS.TUNNEL_WRAPPED, () => play('sfx-tunnel')),

      on(EVENTS.RUN_OVER, (payload = {}) => {
        if (payload.qualifies) play('sfx-highscore');
      }),

      on(EVENTS.SCREEN_CHANGED, (screen) => {
        // sfx-ui-tap has no dedicated store event (per docs/INTEGRATION.md's
        // WS-H section: "Not a store event — hook directly into the UI's own
        // click handlers, or SCREEN_CHANGED as an approximation"). We can't
        // touch src/ui/, so we use this approximation deliberately: every
        // nav plays the tap sfx. It won't cover taps that don't change
        // screens (e.g. pause), which is a known, documented simplification.
        play('sfx-ui-tap');

        if (screen === 'home' || screen === 'leaderboard') {
          stopDucking();
          duckVoice = null;
          music('music-title');
        } else if (screen === 'playing') {
          music('music-level');
          if (state.dried) startDucking();
        } else if (screen === 'gameover') {
          stopDucking();
          duckVoice = null;
          music('music-gameover');
        }
        // 'paused' intentionally leaves whatever music is already playing alone.
      }),

      on(EVENTS.SETTINGS_CHANGED, () => {
        if (!state.settings) return;
        if (!!state.settings.music !== musicEnabled) setMusicEnabled(state.settings.music);
        if (!!state.settings.sfx !== sfxEnabled) setSfxEnabled(state.settings.sfx);
      }),
    );
  }

  // ---- cubeMoving poll (plain state field, not an event) -------------

  let pollHandle = null;
  function startPoll() {
    pollHandle = setInterval(() => {
      const moving = !!state.cubeMoving && state.screen === 'playing';
      if (moving !== cubeMovingLast) {
        cubeMovingLast = moving;
        if (moving) startSlimeStep();
        else stopSlimeStep();
      }
    }, 100);
  }

  // ---- unlock-on-first-gesture ----------------------------------------

  function installUnlockListener() {
    const handler = () => {
      unlock();
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('touchstart', handler);
      window.removeEventListener('keydown', handler);
    };
    window.addEventListener('pointerdown', handler, { once: true });
    window.addEventListener('touchstart', handler, { once: true });
    window.addEventListener('keydown', handler, { once: true });
  }

  function init() {
    if (state.settings) {
      musicEnabled = state.settings.music !== false;
      sfxEnabled = state.settings.sfx !== false;
    }
    installUnlockListener();
    wire();
    startPoll();
  }

  return { init, play, music, setMusicEnabled, setSfxEnabled };
}
