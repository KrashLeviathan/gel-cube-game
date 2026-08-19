/**
 * Bootstrap. Wires the DOM shell to the game — WS-F (integration).
 *
 * Supports the full loop: home -> Start Game -> play (keyboard + touch) ->
 * win/lose levels -> lose 3 lives -> game over -> initials (if qualifying)
 * -> leaderboard -> home, with pause/resume/quit in between.
 */
import './ui/styles.css';
import { createScene } from './render/scene.js';
import { createScreens } from './ui/screens.js';
import { createHud } from './ui/hud.js';
import { createInput } from './game/input.js';
import { createRules } from './game/rules.js';
import { createLoop } from './game/loop.js';
import { createAudio } from './game/audio.js';
import { buildCube } from './render/cube.js';
import { createSlimeTrail } from './render/slimeTrail.js';
import { createFx } from './render/fx.js';
import { state, on, setScreen, EVENTS } from './state/store.js';
import { loadSettings } from './state/storage.js';
import { worldX, worldZ } from './maze/grid.js';
import { DIR_NONE, PALETTE, OOZE_COLORS, PACK_CAPACITY } from './config.js';

const canvas = document.getElementById('game-canvas');
const uiRoot = document.getElementById('ui-root');

state.settings = loadSettings();

const sceneCtx = createScene(canvas);
const input = createInput(canvas);

const cubeView = buildCube(sceneCtx.scene, state.settings.oozeColor);
const slimeTrail = createSlimeTrail(sceneCtx.scene, state.settings.oozeColor);
const fx = createFx(sceneCtx.scene);

const rules = createRules({ scene: sceneCtx.scene });

const audio = createAudio();
audio.init();

const hud = createHud(uiRoot);
const screens = createScreens(uiRoot, {
  onStartGame(difficulty) {
    cubeView.setColor(state.settings.oozeColor);
    slimeTrail.setColor(state.settings.oozeColor);
    rules.startRun(difficulty);
  },
  onResume() {
    setScreen('playing');
  },
  onQuit() {
    rules.endRun();
    setScreen('home');
  },
});
screens.mount();

input.onPause(() => {
  if (state.screen === 'playing') setScreen('paused');
});

// ---------------------------------------------------------------------------
// fx / camera-shake wiring — the only place store events turn into Three.js
// calls, matching "no rendering logic in rules.js".
// ---------------------------------------------------------------------------
function oozeGlow() {
  const p = OOZE_COLORS.find((c) => c.id === state.settings.oozeColor) || OOZE_COLORS[0];
  return p.glow;
}

on(EVENTS.ADVENTURER_DISSOLVED, (p) => {
  fx.dissolveBurst(worldX(p.col), worldZ(p.row), oozeGlow());
  sceneCtx.shake(p.spillCount > 0 ? 0.28 : 0.18);
});
on(EVENTS.ADVENTURER_BANKED, (p) => {
  fx.splash(worldX(p.col), worldZ(p.row), PALETTE.exit);
});
on(EVENTS.ITEM_TAKEN, (p) => {
  fx.sparkle(worldX(p.col), worldZ(p.row));
  fx.magicWave(worldX(p.col), worldZ(p.row));
});
on(EVENTS.LIFE_LOST, () => {
  const pl = rules.getPlayer();
  if (pl) fx.splash(pl.x, pl.z, 0xff5544);
  sceneCtx.shake(0.4);
});
on(EVENTS.LEVEL_STARTED, () => {
  slimeTrail.reset();
  fx.reset();
});

// ---------------------------------------------------------------------------
// resize
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => sceneCtx.resize());
window.addEventListener('orientationchange', () => setTimeout(() => sceneCtx.resize(), 100));

// ---------------------------------------------------------------------------
// sim step / render — see src/game/loop.js for the fixed-step/RAF split
// ---------------------------------------------------------------------------
let ambientClock = 0;

function step(dt) {
  rules.update(dt, input.dir);
}

function render(dt, alpha) {
  void alpha; // see loop.js's header comment on why this stays unused today
  ambientClock += dt;

  const level = rules.getLevel();
  const player = rules.getPlayer();

  if (level && player) {
    level.torches.focus.set(player.x, 0, player.z);
    level.torches.update(dt, ambientClock);
    level.pickups.update(dt);

    const params = rules.getParams();
    const driedRatio =
      params && params.driedDuration > 0 ? state.driedRemaining / params.driedDuration : 0;

    cubeView.update(dt, {
      dried: state.dried,
      driedRatio,
      moveDir: player.dir,
      speed: rules.getCubeSpeed(),
      digesting: rules.isDigesting(),
      coinCount: rules.getRecoveredCoinCount(),
      driedSecondsLeft: state.driedRemaining,
    });
    cubeView.group.position.set(player.x, 0, player.z);

    slimeTrail.update(dt, player.x, player.z, state.cubeMoving, state.dried);

    for (const { adv, view } of level.adventurers) {
      view.group.position.set(adv.x, 0, adv.z);
      if (!adv.alive) view.playDissolve();
      view.update(dt, {
        moving: adv.dir !== DIR_NONE,
        state: adv.state,
        dir: adv.dir,
        packFullness: Math.max(0, Math.min(1, adv.pack / PACK_CAPACITY)),
      });
    }
  }

  fx.update(dt);
  sceneCtx.update(dt);
  sceneCtx.render();
}

const loop = createLoop(step, render);
loop.start();
