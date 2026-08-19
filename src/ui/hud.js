/**
 * In-game HUD overlay: score, lives, level, loot-goal bar, dried countdown,
 * combo indicator, pause button. Laid out inside the safe-area insets.
 *
 * Discrete facts (score target, level, lives, dried on/off) are updated from
 * store events. `update(dt)` only advances animation toward the last-known
 * targets (count-up, bar easing) and touches the DOM solely when a displayed
 * value actually changes — it never re-reads the whole store state.
 */

import { on, EVENTS, state, setScreen } from '../state/store.js';
import { STARTING_LIVES, DRIED_WARNING_TIME } from '../config.js';

export function createHud(root) {
  const el = document.createElement('div');
  el.className = 'hud-root';
  el.innerHTML = `
    <div class="hud-bar-top">
      <div class="hud-block hud-score-block">
        <span class="hud-label">Score</span>
        <span class="hud-score-value">0</span>
        <span class="hud-combo">COMBO ×2</span>
      </div>
      <div class="hud-block hud-level-block">
        <span class="hud-label">Level</span>
        <span class="hud-level-value">1</span>
      </div>
      <button type="button" class="hud-pause-btn" aria-label="Pause">
        <span class="hud-pause-icon">❚❚</span>
      </button>
    </div>
    <div class="hud-lives" aria-label="Lives remaining"></div>
    <div class="hud-loot-wrap">
      <div class="hud-loot-label"><span>Loot secured</span><span class="hud-loot-pct">0%</span></div>
      <div class="hud-loot-bar"><div class="hud-loot-fill"></div></div>
    </div>
    <div class="hud-dried-wrap">
      <div class="hud-dried-label">DRYING OUT — FLEE</div>
      <div class="hud-dried-bar"><div class="hud-dried-fill"></div></div>
    </div>
  `;
  root.appendChild(el);

  const scoreValueEl = el.querySelector('.hud-score-value');
  const comboEl = el.querySelector('.hud-combo');
  const levelValueEl = el.querySelector('.hud-level-value');
  const livesEl = el.querySelector('.hud-lives');
  const lootFillEl = el.querySelector('.hud-loot-fill');
  const lootPctEl = el.querySelector('.hud-loot-pct');
  const lootBarEl = el.querySelector('.hud-loot-bar');
  const driedWrapEl = el.querySelector('.hud-dried-wrap');
  const driedFillEl = el.querySelector('.hud-dried-fill');
  const pauseBtn = el.querySelector('.hud-pause-btn');

  // --- animation state -------------------------------------------------
  let displayedScore = 0;
  let targetScore = 0;
  let shownScore = -1; // last painted integer, to skip redundant DOM writes

  let displayedLoot = 0; // eased 0..1
  let targetLoot = 0;
  let shownLootPct = -1;

  let driedTotal = 0; // seconds captured at DRIED_STARTED, for ratio math
  let lastDriedBlink = false;

  let lastCombo = -1;
  let lastLives = -1;

  function renderLives(n) {
    if (n === lastLives) return;
    lastLives = n;
    livesEl.innerHTML = '';
    const count = Math.max(0, n);
    for (let i = 0; i < count; i++) {
      const cube = document.createElement('span');
      cube.className = 'hud-life-cube';
      livesEl.appendChild(cube);
    }
  }

  function syncLevel() {
    levelValueEl.textContent = String(state.level);
  }

  function syncLives() {
    renderLives(state.lives ?? STARTING_LIVES);
  }

  function syncScoreTarget() {
    targetScore = state.score ?? 0;
  }

  function syncLootTarget() {
    const ratio = state.lootGoal > 0 ? state.coinsBanked / state.lootGoal : 0;
    targetLoot = Math.max(0, Math.min(1, ratio));
  }

  function onDriedStarted() {
    driedTotal = state.driedRemaining > 0 ? state.driedRemaining : 1;
    driedWrapEl.classList.add('is-visible');
  }

  function onDriedEnded() {
    driedWrapEl.classList.remove('is-visible');
    driedFillEl.style.width = '0%';
    driedWrapEl.classList.remove('is-blinking');
  }

  function resetAll() {
    displayedScore = 0;
    targetScore = 0;
    shownScore = -1;
    scoreValueEl.textContent = '0';
    displayedLoot = 0;
    targetLoot = 0;
    shownLootPct = -1;
    lootFillEl.style.width = '0%';
    lootPctEl.textContent = '0%';
    lootBarEl.classList.remove('is-warn', 'is-danger');
    driedWrapEl.classList.remove('is-visible', 'is-blinking');
    lastCombo = -1;
    comboEl.classList.remove('is-visible');
    syncLevel();
    syncLives();
  }

  const unsubs = [
    on(EVENTS.SCORE_CHANGED, syncScoreTarget),
    on(EVENTS.LOOT_CHANGED, syncLootTarget),
    on(EVENTS.LEVEL_STARTED, () => {
      syncLevel();
      syncLootTarget();
    }),
    on(EVENTS.LEVEL_CLEARED, syncLootTarget),
    on(EVENTS.LEVEL_FAILED, () => {
      syncLives();
      syncLootTarget();
    }),
    on(EVENTS.LIFE_LOST, syncLives),
    on(EVENTS.RUN_STARTED, resetAll),
    on(EVENTS.DRIED_STARTED, onDriedStarted),
    on(EVENTS.DRIED_ENDED, onDriedEnded),
    on(EVENTS.SCREEN_CHANGED, (screen) => {
      const show = screen === 'playing' || screen === 'paused';
      el.classList.toggle('is-visible', show);
      if (screen === 'playing') resetAllOnFirstShow();
    }),
  ];

  let firstShowDone = false;
  function resetAllOnFirstShow() {
    if (firstShowDone) return;
    firstShowDone = true;
    syncScoreTarget();
    syncLootTarget();
    syncLevel();
    syncLives();
  }

  pauseBtn.addEventListener('click', () => {
    // The pause button is the one UI-driven store mutation: setScreen() is
    // the store's designated navigation API. Actually stopping the
    // simulation clock is the integrator's job (loop.js reacting to the
    // screen change) — see report.
    setScreen('paused');
  });

  // initial paint
  el.classList.toggle('is-visible', state.screen === 'playing' || state.screen === 'paused');
  syncLevel();
  syncLives();
  syncScoreTarget();
  syncLootTarget();

  function update() {
    // score count-up
    if (displayedScore !== targetScore) {
      const diff = targetScore - displayedScore;
      const step = diff * 0.18 + Math.sign(diff) * 0.5;
      displayedScore += Math.abs(step) > Math.abs(diff) ? diff : step;
      if (Math.abs(targetScore - displayedScore) < 0.6) displayedScore = targetScore;
      const shown = Math.round(displayedScore);
      if (shown !== shownScore) {
        shownScore = shown;
        scoreValueEl.textContent = shown.toLocaleString();
      }
    }

    // loot bar easing
    if (Math.abs(displayedLoot - targetLoot) > 0.001) {
      displayedLoot += (targetLoot - displayedLoot) * 0.15;
      if (Math.abs(displayedLoot - targetLoot) < 0.002) displayedLoot = targetLoot;
      const pct = Math.round(displayedLoot * 100);
      if (pct !== shownLootPct) {
        shownLootPct = pct;
        lootFillEl.style.width = pct + '%';
        lootPctEl.textContent = pct + '%';
        lootBarEl.classList.toggle('is-warn', displayedLoot >= 0.7 && displayedLoot < 0.9);
        lootBarEl.classList.toggle('is-danger', displayedLoot >= 0.9);
      }
    }

    // dried countdown
    if (state.dried && driedWrapEl.classList.contains('is-visible')) {
      const ratio =
        driedTotal > 0 ? Math.max(0, Math.min(1, state.driedRemaining / driedTotal)) : 0;
      driedFillEl.style.width = ratio * 100 + '%';
      const blink = state.driedRemaining <= DRIED_WARNING_TIME;
      if (blink !== lastDriedBlink) {
        lastDriedBlink = blink;
        driedWrapEl.classList.toggle('is-blinking', blink);
      }
    }

    // combo indicator
    if (state.combo !== lastCombo) {
      lastCombo = state.combo;
      if (state.combo > 1) {
        comboEl.textContent = `COMBO ×${state.combo}`;
        comboEl.classList.add('is-visible');
      } else {
        comboEl.classList.remove('is-visible');
      }
    }
  }

  function dispose() {
    unsubs.forEach((fn) => fn());
    el.remove();
  }

  return { update, dispose };
}
