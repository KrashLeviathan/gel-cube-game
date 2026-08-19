/**
 * In-game HUD overlay: score, lives, level, loot-goal bar, dried countdown,
 * combo indicator, pause button. Laid out inside the safe-area insets.
 *
 * Discrete facts (score target, level, lives, dried on/off) are updated from
 * store events. `update(dt)` only advances animation toward the last-known
 * targets (count-up, bar easing) and touches the DOM solely when a displayed
 * value actually changes — it never re-reads the whole store state.
 *
 * The score block shows two numbers per rules.js's round-score model: "Score"
 * is `state.bankedScore` (locked in from rounds already finished), "This
 * round" is `state.roundScore` (this round's live, fluctuating contribution —
 * opens high, drops as adventurers bank loot, climbs on dissolve chains/torch
 * snuffs). `state.score`, the sum of the two, is what game-over/leaderboard
 * read — this module never touches it directly.
 */

import { on, EVENTS, state, setScreen } from '../state/store.js';
import { STARTING_LIVES, DRIED_WARNING_TIME } from '../config.js';

// Loot bar reddens continuously with the ratio rather than jumping between a
// couple of fixed colors, then pulses + shakes once it's close enough to the
// loss condition to actually be alarming.
const LOOT_CRITICAL_RATIO = 0.85;
function lootColorForRatio(ratio) {
  const hue = 48 - ratio * 44; // gold -> orange -> red
  const light = 58 - ratio * 12;
  return `hsl(${hue}deg 90% ${light}%)`;
}

export function createHud(root) {
  const el = document.createElement('div');
  el.className = 'hud-root';
  el.innerHTML = `
    <div class="hud-bar-top">
      <div class="hud-block hud-score-block">
        <span class="hud-label">Score</span>
        <span class="hud-score-value">0</span>
        <div class="hud-round">
          <span class="hud-round-label">This round</span>
          <span class="hud-round-value">+0</span>
        </div>
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
  const roundEl = el.querySelector('.hud-round');
  const roundValueEl = el.querySelector('.hud-round-value');
  const comboEl = el.querySelector('.hud-combo');
  const levelValueEl = el.querySelector('.hud-level-value');
  const livesEl = el.querySelector('.hud-lives');
  const lootFillEl = el.querySelector('.hud-loot-fill');
  const lootPctEl = el.querySelector('.hud-loot-pct');
  const lootWrapEl = el.querySelector('.hud-loot-wrap');
  const driedWrapEl = el.querySelector('.hud-dried-wrap');
  const driedFillEl = el.querySelector('.hud-dried-fill');
  const pauseBtn = el.querySelector('.hud-pause-btn');

  // --- animation state -------------------------------------------------
  let displayedScore = 0; // banked (locked-in) score
  let targetScore = 0;
  let shownScore = -1; // last painted integer, to skip redundant DOM writes

  let displayedRound = 0; // live round score
  let targetRound = 0;
  let shownRound = null; // last painted integer; null forces the first paint

  let displayedLoot = 0; // eased 0..1
  let targetLoot = 0;
  let shownLootPct = -1;
  let lastLootCritical = false;

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

  function flashRound(dir) {
    roundEl.classList.remove('flash-up', 'flash-down');
    void roundEl.offsetWidth; // restart the CSS animation on repeated flashes
    roundEl.classList.add(dir);
  }

  function syncScoreTarget() {
    targetScore = state.bankedScore ?? 0;
    const nextRound = state.roundScore ?? 0;
    if (nextRound !== targetRound) flashRound(nextRound > targetRound ? 'flash-up' : 'flash-down');
    targetRound = nextRound;
    roundEl.classList.toggle('is-negative', targetRound < 0);
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
    displayedRound = 0;
    targetRound = 0;
    shownRound = null;
    roundValueEl.textContent = '+0';
    roundEl.classList.remove('flash-up', 'flash-down', 'is-negative');
    displayedLoot = 0;
    targetLoot = 0;
    shownLootPct = -1;
    lastLootCritical = false;
    lootFillEl.style.width = '0%';
    lootFillEl.style.background = '';
    lootPctEl.textContent = '0%';
    lootWrapEl.classList.remove('is-critical');
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
    // banked-score count-up
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

    // round-score count-up — same easing, signed display
    if (shownRound === null || displayedRound !== targetRound) {
      const diff = targetRound - displayedRound;
      const step = diff * 0.18 + Math.sign(diff) * 0.5;
      displayedRound += Math.abs(step) > Math.abs(diff) ? diff : step;
      if (Math.abs(targetRound - displayedRound) < 0.6) displayedRound = targetRound;
      const shown = Math.round(displayedRound);
      if (shown !== shownRound) {
        shownRound = shown;
        roundValueEl.textContent = `${shown >= 0 ? '+' : '−'}${Math.abs(shown).toLocaleString()}`;
      }
    }

    // loot bar easing — background reddens continuously with the ratio;
    // is-critical (shake + pulse) only kicks in once it's genuinely alarming
    if (Math.abs(displayedLoot - targetLoot) > 0.001) {
      displayedLoot += (targetLoot - displayedLoot) * 0.15;
      if (Math.abs(displayedLoot - targetLoot) < 0.002) displayedLoot = targetLoot;
      const pct = Math.round(displayedLoot * 100);
      if (pct !== shownLootPct) {
        shownLootPct = pct;
        lootFillEl.style.width = pct + '%';
        lootPctEl.textContent = pct + '%';
      }
      lootFillEl.style.background = lootColorForRatio(displayedLoot);
      const critical = displayedLoot >= LOOT_CRITICAL_RATIO;
      if (critical !== lastLootCritical) {
        lastLootCritical = critical;
        lootWrapEl.classList.toggle('is-critical', critical);
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
