/**
 * Full-screen DOM overlay: Home, Leaderboard, Pause, Game Over, plus
 * transient banners for level/life events. Pure routing off
 * `store.state.screen` — no game logic lives here.
 *
 * ---------------------------------------------------------------------
 * handlers contract (all optional; missing handlers are no-ops):
 *
 *   onStartGame(difficulty: DifficultyId): void
 *     Fired when the player taps "Start Game" on Home. `difficulty` is
 *     whatever is currently selected in the segmented control (already
 *     persisted to settings). The integrator should start a fresh run
 *     (store.resetRun(), build level 1, store.setScreen('playing')).
 *
 *   onResume(): void
 *     Fired from the Pause overlay's "Resume" button. The integrator
 *     should un-pause the loop and store.setScreen('playing').
 *
 *   onQuit(): void
 *     Fired from the Pause overlay's "Quit to Home" button. The
 *     integrator should abort/tear down the current run and
 *     store.setScreen('home').
 *
 * Pure navigation (Top Scores, Back, Continue) is handled internally via
 * store.setScreen() directly, since it carries no gameplay consequence.
 * The HUD's pause button likewise calls store.setScreen('paused') itself
 * (see src/ui/hud.js) rather than going through a handler.
 * ---------------------------------------------------------------------
 */

import { on, state, setScreen, patch, EVENTS } from '../state/store.js';
import { DIFFICULTIES, OOZE_COLORS } from '../config.js';
import { saveSettings, qualifies, saveScore } from '../state/storage.js';
import { renderLeaderboard, promptInitials } from './leaderboard.js';
import { VERSION } from '../version.js';

const VERSION_BADGE_HTML = `<div class="version-badge">v${VERSION}</div>`;

const BANNER_TEXT = {
  [EVENTS.LEVEL_STARTED]: (s) => `LEVEL ${s.level} — THE PARTY DESCENDS`,
  [EVENTS.LEVEL_CLEARED]: () => 'EVERY ADVENTURER DISSOLVED',
  [EVENTS.LEVEL_FAILED]: () => 'THE PARTY ESCAPED WITH THE LOOT',
  [EVENTS.LIFE_LOST]: () => 'YOU DRIED OUT',
};

export function createScreens(root, handlers = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'screens-root';
  root.appendChild(wrap);

  const banner = document.createElement('div');
  banner.className = 'banner-layer';
  root.appendChild(banner);
  let bannerTimer = null;

  function showBanner(text) {
    banner.textContent = text;
    banner.classList.remove('is-visible');
    // force reflow so re-triggering the animation on rapid-fire events works
    void banner.offsetWidth;
    banner.classList.add('is-visible');
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.remove('is-visible'), 1800);
  }

  // ---------------------------------------------------------------------
  // Home
  // ---------------------------------------------------------------------
  const homeEl = document.createElement('section');
  homeEl.className = 'screen screen--home';
  homeEl.innerHTML = `
    <div class="home-hero">
      <h1 class="title">GELATINOUS</h1>
      <p class="tagline">You are the ooze. The dungeon is dinner.</p>
    </div>
    <div class="home-actions">
      <button type="button" class="btn btn--primary btn--large" data-action="start">Start Game</button>
      <button type="button" class="btn btn--secondary" data-action="scores">Top Scores</button>
    </div>
    <div class="settings-row">
      <div class="settings-group">
        <span class="settings-label">Difficulty</span>
        <div class="segmented" data-role="difficulty"></div>
      </div>
      <div class="settings-group">
        <span class="settings-label">Ooze colour</span>
        <div class="swatch-row" data-role="colors"></div>
      </div>
      <div class="settings-group settings-group--toggles">
        <button type="button" class="toggle" data-role="music"></button>
        <button type="button" class="toggle" data-role="sfx"></button>
      </div>
    </div>
    ${VERSION_BADGE_HTML}
  `;
  wrap.appendChild(homeEl);

  const diffRow = homeEl.querySelector('[data-role="difficulty"]');
  Object.values(DIFFICULTIES).forEach((d) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'segmented-btn';
    btn.dataset.value = d.id;
    btn.textContent = d.label;
    btn.addEventListener('click', () => updateSetting({ difficulty: d.id }));
    diffRow.appendChild(btn);
  });

  const colorRow = homeEl.querySelector('[data-role="colors"]');
  OOZE_COLORS.forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.dataset.value = c.id;
    btn.style.setProperty('--swatch-color', `#${c.core.toString(16).padStart(6, '0')}`);
    btn.setAttribute('aria-label', c.label);
    btn.addEventListener('click', () => updateSetting({ oozeColor: c.id }));
    colorRow.appendChild(btn);
  });

  const musicToggle = homeEl.querySelector('[data-role="music"]');
  const sfxToggle = homeEl.querySelector('[data-role="sfx"]');
  musicToggle.addEventListener('click', () => updateSetting({ music: !state.settings.music }));
  sfxToggle.addEventListener('click', () => updateSetting({ sfx: !state.settings.sfx }));

  function updateSetting(fields) {
    const next = { ...state.settings, ...fields };
    saveSettings(next);
    patch({ settings: next }, EVENTS.SETTINGS_CHANGED);
    syncHomeSettings();
  }

  function syncHomeSettings() {
    const s = state.settings;
    diffRow.querySelectorAll('.segmented-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.value === s.difficulty);
    });
    colorRow.querySelectorAll('.swatch').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.value === s.oozeColor);
    });
    musicToggle.textContent = `Music: ${s.music ? 'On' : 'Off'}`;
    musicToggle.classList.toggle('is-active', s.music);
    sfxToggle.textContent = `SFX: ${s.sfx ? 'On' : 'Off'}`;
    sfxToggle.classList.toggle('is-active', s.sfx);
  }

  homeEl.querySelector('[data-action="start"]').addEventListener('click', () => {
    handlers.onStartGame?.(state.settings.difficulty);
  });
  homeEl.querySelector('[data-action="scores"]').addEventListener('click', () => {
    setScreen('leaderboard');
  });

  // ---------------------------------------------------------------------
  // Leaderboard
  // ---------------------------------------------------------------------
  const lbEl = document.createElement('section');
  lbEl.className = 'screen screen--leaderboard';
  lbEl.innerHTML = `
    <h2 class="screen-heading">Top Scores</h2>
    <div class="lb-container" data-role="lb-list"></div>
    <button type="button" class="btn btn--secondary" data-action="back">Back</button>
  `;
  wrap.appendChild(lbEl);
  lbEl.querySelector('[data-action="back"]').addEventListener('click', () => setScreen('home'));

  // ---------------------------------------------------------------------
  // Pause — Quit to Home asks for confirmation first, then (if the current
  // score qualifies) offers an optional leaderboard initials entry before
  // handing off to handlers.onQuit(). Mirrors the Game Over flow below,
  // just reachable mid-run instead of only after a loss.
  // ---------------------------------------------------------------------
  const pauseEl = document.createElement('section');
  pauseEl.className = 'screen screen--paused';
  pauseEl.innerHTML = `
    <h2 class="screen-heading">Paused</h2>
    <div class="pause-stage" data-role="pause-stage"></div>
    ${VERSION_BADGE_HTML}
  `;
  wrap.appendChild(pauseEl);
  const pauseStageEl = pauseEl.querySelector('[data-role="pause-stage"]');

  let pauseToken = 0;

  function renderPauseDefault() {
    pauseToken++;
    pauseStageEl.innerHTML = '';
    const actions = document.createElement('div');
    actions.className = 'home-actions';
    actions.innerHTML = `
      <button type="button" class="btn btn--primary btn--large" data-action="resume">Resume</button>
      <button type="button" class="btn btn--secondary" data-action="quit">Quit to Home</button>
    `;
    pauseStageEl.appendChild(actions);
    actions
      .querySelector('[data-action="resume"]')
      .addEventListener('click', () => handlers.onResume?.());
    actions
      .querySelector('[data-action="quit"]')
      .addEventListener('click', () => renderQuitConfirm());
  }

  function renderQuitConfirm() {
    const token = ++pauseToken;
    pauseStageEl.innerHTML = '';
    const confirmWrap = document.createElement('div');
    confirmWrap.className = 'confirm-panel';
    confirmWrap.innerHTML = `
      <p class="confirm-text">Quit to the main menu? Your progress this level will be lost.</p>
      <div class="home-actions">
        <button type="button" class="btn btn--primary btn--large" data-action="quit-confirm">Quit to Home</button>
        <button type="button" class="btn btn--secondary" data-action="quit-cancel">Cancel</button>
      </div>
    `;
    pauseStageEl.appendChild(confirmWrap);
    confirmWrap.querySelector('[data-action="quit-cancel"]').addEventListener('click', () => {
      if (token !== pauseToken) return;
      renderPauseDefault();
    });
    confirmWrap.querySelector('[data-action="quit-confirm"]').addEventListener('click', () => {
      if (token !== pauseToken) return;
      proceedToQuit(token);
    });
  }

  function proceedToQuit(token) {
    const finalScore = state.score;
    if (!qualifies(finalScore)) {
      handlers.onQuit?.();
      return;
    }
    pauseStageEl.innerHTML = '';
    const askWrap = document.createElement('div');
    askWrap.className = 'confirm-panel';
    askWrap.innerHTML = `
      <p class="confirm-text">Your score qualifies for the leaderboard. Save your initials?</p>
      <div class="home-actions">
        <button type="button" class="btn btn--primary btn--large" data-action="save-initials">Enter Initials</button>
        <button type="button" class="btn btn--secondary" data-action="skip-initials">Skip</button>
      </div>
    `;
    pauseStageEl.appendChild(askWrap);
    askWrap.querySelector('[data-action="skip-initials"]').addEventListener('click', () => {
      if (token !== pauseToken) return;
      handlers.onQuit?.();
    });
    askWrap.querySelector('[data-action="save-initials"]').addEventListener('click', () => {
      if (token !== pauseToken) return;
      pauseStageEl.innerHTML = '';
      const initialsHost = document.createElement('div');
      pauseStageEl.appendChild(initialsHost);
      promptInitials(initialsHost, finalScore).then((initials) => {
        if (token !== pauseToken) return;
        saveScore({
          initials,
          score: finalScore,
          level: state.level,
          difficulty: state.settings.difficulty,
          date: new Date().toISOString(),
        });
        handlers.onQuit?.();
      });
    });
  }

  // ---------------------------------------------------------------------
  // Game Over
  // ---------------------------------------------------------------------
  const goEl = document.createElement('section');
  goEl.className = 'screen screen--gameover';
  goEl.innerHTML = `
    <h2 class="screen-heading screen-heading--danger">Game Over</h2>
    <div class="gameover-summary">
      <div class="gameover-stat"><span class="gameover-stat-label">Score</span><span class="gameover-stat-value" data-role="go-score">0</span></div>
      <div class="gameover-stat"><span class="gameover-stat-label">Level reached</span><span class="gameover-stat-value" data-role="go-level">1</span></div>
    </div>
    <div class="gameover-stage" data-role="go-stage"></div>
  `;
  wrap.appendChild(goEl);
  const goScoreEl = goEl.querySelector('[data-role="go-score"]');
  const goLevelEl = goEl.querySelector('[data-role="go-level"]');
  const goStageEl = goEl.querySelector('[data-role="go-stage"]');

  let goToken = 0;
  function runGameOverFlow() {
    const token = ++goToken;
    goScoreEl.textContent = Math.round(state.score).toLocaleString();
    goLevelEl.textContent = String(state.level);

    goStageEl.innerHTML = '';
    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'btn btn--primary btn--large';
    continueBtn.textContent = 'Continue';
    goStageEl.appendChild(continueBtn);

    continueBtn.addEventListener('click', () => {
      if (token !== goToken) return;
      const finalScore = state.score;
      if (qualifies(finalScore)) {
        goStageEl.innerHTML = '';
        const initialsHost = document.createElement('div');
        goStageEl.appendChild(initialsHost);
        promptInitials(initialsHost, finalScore).then((initials) => {
          if (token !== goToken) return;
          const rank = saveScore({
            initials,
            score: finalScore,
            level: state.level,
            difficulty: state.settings.difficulty,
            date: new Date().toISOString(),
          });
          showGameOverLeaderboard(rank > 0 ? rank - 1 : -1);
        });
      } else {
        showGameOverLeaderboard(-1);
      }
    });
  }

  function showGameOverLeaderboard(highlightIndex) {
    goStageEl.innerHTML = '';
    const listHost = document.createElement('div');
    goStageEl.appendChild(listHost);
    renderLeaderboard(listHost, { highlightIndex });
    const homeBtn = document.createElement('button');
    homeBtn.type = 'button';
    homeBtn.className = 'btn btn--secondary';
    homeBtn.textContent = 'Back to Home';
    homeBtn.addEventListener('click', () => setScreen('home'));
    goStageEl.appendChild(homeBtn);
  }

  // ---------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------
  const SCREEN_EL = {
    home: homeEl,
    leaderboard: lbEl,
    paused: pauseEl,
    gameover: goEl,
  };
  const OPEN_SCREENS = new Set(['home', 'leaderboard', 'paused', 'gameover']);

  function render(screen) {
    goToken++; // invalidate any in-flight game-over async flow if we navigated away
    pauseToken++; // ditto for an in-flight pause quit/initials flow
    wrap.classList.toggle('is-open', OPEN_SCREENS.has(screen));
    for (const [name, elm] of Object.entries(SCREEN_EL)) {
      elm.classList.toggle('is-active', name === screen);
    }
    if (screen === 'home') syncHomeSettings();
    if (screen === 'leaderboard') renderLeaderboard(lbEl.querySelector('[data-role="lb-list"]'));
    if (screen === 'paused') renderPauseDefault();
    if (screen === 'gameover') runGameOverFlow();
  }

  const unsubs = [
    on(EVENTS.SCREEN_CHANGED, render),
    on(EVENTS.LEVEL_STARTED, () => showBanner(BANNER_TEXT[EVENTS.LEVEL_STARTED](state))),
    on(EVENTS.LEVEL_CLEARED, () => showBanner(BANNER_TEXT[EVENTS.LEVEL_CLEARED](state))),
    on(EVENTS.LEVEL_FAILED, () => showBanner(BANNER_TEXT[EVENTS.LEVEL_FAILED](state))),
    on(EVENTS.LIFE_LOST, () => showBanner(BANNER_TEXT[EVENTS.LIFE_LOST](state))),
  ];

  function mount() {
    syncHomeSettings();
    render(state.screen);
  }

  function dispose() {
    unsubs.forEach((fn) => fn());
    if (bannerTimer) clearTimeout(bannerTimer);
    wrap.remove();
    banner.remove();
  }

  return { mount, dispose };
}
