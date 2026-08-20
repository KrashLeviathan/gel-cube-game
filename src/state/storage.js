/**
 * localStorage persistence for settings + the leaderboard.
 *
 * Must never throw. localStorage can be unavailable (private browsing,
 * disabled, sandboxed iframe), full (quota exceeded), or hold corrupt/old
 * JSON. Every read is validated and sanitised; every write is best-effort
 * with an in-memory fallback so the game keeps working even with storage
 * fully unavailable (scores just won't survive a reload).
 */

import {
  STORAGE_KEY_SCORES,
  STORAGE_KEY_SETTINGS,
  MAX_LEADERBOARD_ENTRIES,
  DEFAULT_SETTINGS,
  DIFFICULTIES,
  OOZE_COLORS,
} from '../config.js';

// In-memory shadow store, used whenever localStorage access throws.
const memory = new Map();

function rawGet(key) {
  try {
    const v = window.localStorage.getItem(key);
    if (v !== null) return v;
  } catch {
    // localStorage inaccessible (private mode, disabled, sandboxed) — fall through.
  }
  return memory.has(key) ? memory.get(key) : null;
}

function rawSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    memory.delete(key);
    return;
  } catch {
    // Quota exceeded or storage unavailable — keep it in memory for this session.
  }
  memory.set(key, value);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    if (Object.prototype.hasOwnProperty.call(DIFFICULTIES, raw.difficulty)) {
      out.difficulty = raw.difficulty;
    }
    if (OOZE_COLORS.some((c) => c.id === raw.oozeColor)) {
      out.oozeColor = raw.oozeColor;
    }
    if (typeof raw.music === 'boolean') out.music = raw.music;
    if (typeof raw.sfx === 'boolean') out.sfx = raw.sfx;
    if (typeof raw.haptics === 'boolean') out.haptics = raw.haptics;
    if (typeof raw.closeCamera === 'boolean') out.closeCamera = raw.closeCamera;
  }
  return out;
}

// First-ever load (nothing in storage yet, or it's corrupt) defaults the
// close-follow camera to on — new players get the more readable close view
// by default. Any load after that goes through sanitizeSettings() instead,
// which falls back to DEFAULT_SETTINGS.closeCamera (off) for a field that's
// genuinely absent — e.g. a settings blob saved before this option existed —
// so a returning player who predates the feature isn't switched on them, but
// their own explicit choice (once they've made one) always round-trips.
const FIRST_LOAD_SETTINGS = { ...DEFAULT_SETTINGS, closeCamera: true };

export function loadSettings() {
  const raw = rawGet(STORAGE_KEY_SETTINGS);
  if (!raw) return { ...FIRST_LOAD_SETTINGS };
  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...FIRST_LOAD_SETTINGS };
  }
}

export function saveSettings(s) {
  try {
    rawSet(STORAGE_KEY_SETTINGS, JSON.stringify(sanitizeSettings(s)));
  } catch {
    // never throw
  }
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/** Sanitise to exactly 3 uppercase A-Z letters, never throws, never empty. */
function sanitizeInitials(v) {
  const letters = String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  const padded = (letters + 'AAA').slice(0, 3);
  return padded.length === 3 ? padded : 'AAA';
}

function sanitizeScoreEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const score = Number(e.score);
  if (!Number.isFinite(score) || score < 0) return null;
  const levelNum = Math.floor(Number(e.level));
  const level = Number.isFinite(levelNum) && levelNum > 0 ? levelNum : 1;
  const difficulty = Object.prototype.hasOwnProperty.call(DIFFICULTIES, e.difficulty)
    ? e.difficulty
    : DEFAULT_SETTINGS.difficulty;
  const initials = sanitizeInitials(e.initials);
  let date = typeof e.date === 'string' ? e.date : null;
  if (!date || Number.isNaN(Date.parse(date))) date = new Date().toISOString();
  return { initials, score: Math.round(score), level, difficulty, date };
}

/** Sorted desc by score, capped at MAX_LEADERBOARD_ENTRIES. Never throws. */
export function loadScores() {
  const raw = rawGet(STORAGE_KEY_SCORES);
  if (!raw) return [];
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const cleaned = arr.map(sanitizeScoreEntry).filter(Boolean);
  cleaned.sort((a, b) => b.score - a.score);
  return cleaned.slice(0, MAX_LEADERBOARD_ENTRIES);
}

/** @returns {boolean} true if `score` would place on the leaderboard. */
export function qualifies(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return false;
  const scores = loadScores();
  if (scores.length < MAX_LEADERBOARD_ENTRIES) return true;
  return s > scores[scores.length - 1].score;
}

/**
 * Insert a score entry, persist the capped/sorted leaderboard.
 * @returns {number} 1-based rank, or -1 if it didn't place.
 */
export function saveScore(entry) {
  const clean = sanitizeScoreEntry(entry);
  if (!clean) return -1;

  const current = loadScores();
  const combined = [...current, clean];
  combined.sort((a, b) => b.score - a.score);
  const rank = combined.indexOf(clean) + 1;
  const capped = combined.slice(0, MAX_LEADERBOARD_ENTRIES);

  try {
    rawSet(STORAGE_KEY_SCORES, JSON.stringify(capped));
  } catch {
    return -1;
  }
  return rank <= MAX_LEADERBOARD_ENTRIES ? rank : -1;
}
