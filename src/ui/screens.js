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
      <button type="button" class="btn btn--secondary" data-action="howto">How to Play</button>
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
  // How to Play — an overlay layered on top of Home, deliberately NOT a
  // screen of its own: `state.screen` has a fixed five-value set and this
  // isn't one of them. Closing it is pure DOM, so nothing about the run or
  // the store observes that it was ever open.
  // ---------------------------------------------------------------------
  const howtoEl = document.createElement('section');
  howtoEl.className = 'howto';
  howtoEl.setAttribute('role', 'dialog');
  howtoEl.setAttribute('aria-modal', 'true');
  howtoEl.setAttribute('aria-label', 'How to play');
  howtoEl.innerHTML = `
    <h2 class="screen-heading">How to Play</h2>
    <div class="howto-scroll">
      <p class="howto-lede">
        Pac-Man, inverted. The <em>adventurers</em> are the ones eating the dungeon —
        scooping up coins and hauling them to the stairwells to bank. You are the
        gelatinous cube in the lair, and they are the pellets.
      </p>

      <div class="howto-block">
        <h3 class="howto-heading">Moving</h3>
        <ul class="howto-list">
          <li><b>Drag anywhere</b> on the screen to steer — a quick flick counts too.</li>
          <li>The cube keeps crawling in the last direction you asked for. You steer at
              junctions; there is no stick to hold.</li>
          <li>Keyboard: <b>arrow keys</b> or <b>WASD</b>. <b>Esc</b> or <b>P</b> pauses.</li>
          <li>The side tunnels wrap — crawl off one edge, arrive at the other.</li>
          <li>Adventurers can never follow you into your lair.</li>
        </ul>
      </div>

      <div class="howto-block">
        <h3 class="howto-heading">Clearing a level</h3>
        <ul class="howto-list">
          <li>Dissolve <b>every adventurer</b> and the level is yours.</li>
          <li>Each one carries six coins, then breaks for a stairwell to bank them.
              Coins only count for the party <em>once they're banked</em>.</li>
          <li>Dissolve a loaded adventurer and their haul spills back onto the floor.
              Ambush them on the way to the stairs, not on the way out.</li>
        </ul>
      </div>

      <div class="howto-block">
        <h3 class="howto-heading">Losing a life</h3>
        <ul class="howto-list">
          <li>If the party banks its loot goal — roughly 60% of the dungeon's coins, a
              little more on Novice, a little less on Legendary — the level is lost and
              it costs you a life.</li>
          <li>Watch the <b>loot bar</b>: it turns orange, then red, as they close in.</li>
          <li>You get <b>three lives</b>, then it's initials on the leaderboard.</li>
        </ul>
      </div>

      <div class="howto-block howto-block--danger">
        <h3 class="howto-heading">Magic items</h3>
        <ul class="howto-list">
          <li>Magic items lie scattered through the dungeon. If an adventurer picks one
              up, <b>you dry out</b>.</li>
          <li>Dried out you are slow and shrivelled, and the whole party turns around and
              <b>hunts you</b>. Any of them touching you now costs a life.</li>
          <li>The red bar counts down what's left of it, and blinks near the end.</li>
          <li>Dying doesn't cure it — the timer keeps running through your respawn, so
              leaving the lair still dried is your problem.</li>
          <li>Reach an item first and it's gone before they can ever use it.</li>
        </ul>
      </div>

      <div class="howto-block">
        <h3 class="howto-heading">Scoring</h3>
        <ul class="howto-list">
          <li>Dissolves chain: <b>200 / 400 / 800 / 1600 / 3200</b>. The chain holds as
              long as the next one lands within about six seconds.</li>
          <li><b>+15</b> for every coin recovered from a dissolved pack.</li>
          <li>Clearing a level pays <b>1000</b>, plus <b>10</b> for every coin the party
              never got to bank.</li>
          <li>Difficulty scales all of it: Novice ×0.75, Veteran ×1, Legendary ×1.5.</li>
        </ul>
      </div>
    </div>
    <button type="button" class="btn btn--secondary" data-action="howto-close">Back</button>
  `;
  wrap.appendChild(howtoEl);

  function setHowtoOpen(open) {
    howtoEl.classList.toggle('is-open', open);
    if (open) howtoEl.querySelector('.howto-scroll').scrollTop = 0;
  }

  homeEl.querySelector('[data-action="howto"]').addEventListener('click', () => setHowtoOpen(true));
  howtoEl
    .querySelector('[data-action="howto-close"]')
    .addEventListener('click', () => setHowtoOpen(false));

  // Esc closes the overlay. Harmless to bind globally: input.js's own Esc
  // handler only pauses while the screen is 'playing', and the overlay is
  // only ever open on Home.
  function onHowtoKey(e) {
    if (e.key === 'Escape' && howtoEl.classList.contains('is-open')) setHowtoOpen(false);
  }
  window.addEventListener('keydown', onHowtoKey);

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
    setHowtoOpen(false); // never let the How to Play overlay outlive the Home screen
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
    window.removeEventListener('keydown', onHowtoKey);
    if (bannerTimer) clearTimeout(bannerTimer);
    wrap.remove();
    banner.remove();
  }

  return { mount, dispose };
}
