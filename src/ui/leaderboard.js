/**
 * Leaderboard table + arcade-style 3-letter initials entry.
 *
 * Both functions own whatever DOM they render into `container` and clear it
 * before rendering. Pure DOM + a promise — no store access, no globals.
 */

import { DIFFICULTIES } from '../config.js';
import { loadScores } from '../state/storage.js';

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
  } catch {
    return '';
  }
}

function difficultyLabel(id) {
  return DIFFICULTIES[id]?.label ?? id ?? '';
}

/**
 * Render the top-scores table into `container`.
 * @param {HTMLElement} container
 * @param {{ highlightIndex?: number, scores?: ScoreEntry[] }} [opts]
 *   `highlightIndex` is a 0-based index into the score list to call out
 *   (e.g. a just-saved entry). `scores` lets a caller pass an already-loaded
 *   list; otherwise this reloads from storage.
 */
export function renderLeaderboard(container, opts = {}) {
  if (!container) return;
  const { highlightIndex = -1 } = opts;
  const scores = opts.scores ?? loadScores();
  container.innerHTML = '';
  container.className = 'lb-table';

  if (scores.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lb-empty';
    empty.textContent = 'No legends yet. Be the first to devour the dungeon.';
    container.appendChild(empty);
    return;
  }

  const head = document.createElement('div');
  head.className = 'lb-row lb-row--head';
  head.innerHTML = `
    <span class="lb-rank">#</span>
    <span class="lb-initials">Who</span>
    <span class="lb-score">Score</span>
    <span class="lb-meta">Lvl</span>
    <span class="lb-meta lb-meta--diff">Difficulty</span>
  `;
  container.appendChild(head);

  scores.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row';
    if (i === highlightIndex) row.classList.add('lb-row--new');
    row.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-initials">${entry.initials}</span>
      <span class="lb-score">${entry.score.toLocaleString()}</span>
      <span class="lb-meta">${entry.level}</span>
      <span class="lb-meta lb-meta--diff">${difficultyLabel(entry.difficulty)}<br /><small>${fmtDate(
        entry.date,
      )}</small></span>
    `;
    container.appendChild(row);
  });
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Arcade-style 3-letter initials entry: tappable up/down wheels per slot,
 * plus keyboard support (letter keys, left/right/up/down, backspace, Enter).
 * Renders into `container` (clearing it first) and cleans up after itself.
 * @param {HTMLElement} container
 * @param {number} score
 * @returns {Promise<string>} resolves with 3 uppercase letters
 */
export function promptInitials(container, score) {
  return new Promise((resolve) => {
    const letters = ['A', 'A', 'A'];
    let active = 0;

    container.innerHTML = '';
    container.className = 'initials-entry';

    const title = document.createElement('div');
    title.className = 'initials-title';
    title.textContent = 'NEW HIGH SCORE';
    container.appendChild(title);

    const scoreEl = document.createElement('div');
    scoreEl.className = 'initials-score';
    scoreEl.textContent = Math.round(score).toLocaleString();
    container.appendChild(scoreEl);

    const slotsWrap = document.createElement('div');
    slotsWrap.className = 'initials-slots';
    container.appendChild(slotsWrap);

    const slotEls = [];
    for (let i = 0; i < 3; i++) {
      const slot = document.createElement('div');
      slot.className = 'initials-slot';

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'initials-arrow initials-arrow--up';
      up.setAttribute('aria-label', 'Next letter');
      up.textContent = '▲';

      const letterEl = document.createElement('div');
      letterEl.className = 'initials-letter';
      letterEl.textContent = letters[i];

      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'initials-arrow initials-arrow--down';
      down.setAttribute('aria-label', 'Previous letter');
      down.textContent = '▼';

      slot.appendChild(up);
      slot.appendChild(letterEl);
      slot.appendChild(down);
      slotsWrap.appendChild(slot);
      slotEls.push({ slot, letterEl });

      const step = (dir) => {
        active = i;
        const idx = LETTERS.indexOf(letters[i]);
        letters[i] = LETTERS[(idx + dir + LETTERS.length) % LETTERS.length];
        render();
      };
      up.addEventListener('click', () => step(1));
      down.addEventListener('click', () => step(-1));
      slot.addEventListener('click', (ev) => {
        if (ev.target === up || ev.target === down) return;
        active = i;
        render();
      });
    }

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn btn--primary initials-confirm';
    confirmBtn.textContent = 'CONFIRM';
    container.appendChild(confirmBtn);

    const hint = document.createElement('div');
    hint.className = 'initials-hint';
    hint.textContent = 'Tap arrows or type letters · Enter to confirm';
    container.appendChild(hint);

    function render() {
      slotEls.forEach(({ slot, letterEl }, i) => {
        letterEl.textContent = letters[i];
        slot.classList.toggle('is-active', i === active);
      });
    }
    render();

    function finish() {
      window.removeEventListener('keydown', onKey);
      container.innerHTML = '';
      resolve(letters.join(''));
    }

    function onKey(ev) {
      const key = ev.key;
      if (/^[a-zA-Z]$/.test(key)) {
        letters[active] = key.toUpperCase();
        active = Math.min(2, active + 1);
        render();
        ev.preventDefault();
      } else if (key === 'ArrowUp') {
        const idx = LETTERS.indexOf(letters[active]);
        letters[active] = LETTERS[(idx + 1) % LETTERS.length];
        render();
        ev.preventDefault();
      } else if (key === 'ArrowDown') {
        const idx = LETTERS.indexOf(letters[active]);
        letters[active] = LETTERS[(idx - 1 + LETTERS.length) % LETTERS.length];
        render();
        ev.preventDefault();
      } else if (key === 'ArrowRight') {
        active = Math.min(2, active + 1);
        render();
        ev.preventDefault();
      } else if (key === 'ArrowLeft' || key === 'Backspace') {
        active = Math.max(0, active - 1);
        render();
        ev.preventDefault();
      } else if (key === 'Enter') {
        finish();
        ev.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);

    confirmBtn.addEventListener('click', finish);
  });
}
