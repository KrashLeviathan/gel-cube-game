/**
 * Central tuning + shared constants.
 *
 * CONTRACT FILE — owned by the architect. Subagents may ADD new constants at the
 * bottom of a section, but must not rename or remove existing exports, and must
 * not change values without saying so in their report.
 */

// ---------------------------------------------------------------------------
// Grid / maze geometry
// ---------------------------------------------------------------------------

/** Maze width in tiles. Even number (the maze is mirrored left/right). */
export const COLS = 28;
/** Maze height in tiles. */
export const ROWS = 31;

/** World units per tile. Everything else is expressed in tiles. */
export const TILE = 1;

/** Wall height in world units (floor sits at y = 0). */
export const WALL_HEIGHT = 1.0;

/** Tile type enum. Stored in a Uint8Array of length COLS*ROWS. */
export const TILE_WALL = 0;
export const TILE_FLOOR = 1;
/** Inside the cube's lair box. Walkable by the cube only. No coins. */
export const TILE_LAIR = 2;
/** The lair doorway. Cube passes freely; adventurers may never enter. */
export const TILE_LAIR_DOOR = 3;
/** Floor inside a wrap tunnel. Walkable by all. No coins. */
export const TILE_TUNNEL = 4;
/** Stairwell where adventurers bank collected loot. Walkable by all. No coins. */
export const TILE_EXIT = 5;

/** Direction vectors, indexed by DIR_*. dc = delta column, dr = delta row. */
export const DIRS = [
  { dc: 0, dr: -1 }, // 0 UP    (-Z)
  { dc: 1, dr: 0 }, // 1 RIGHT (+X)
  { dc: 0, dr: 1 }, // 2 DOWN  (+Z)
  { dc: -1, dr: 0 }, // 3 LEFT  (-X)
];
export const DIR_UP = 0;
export const DIR_RIGHT = 1;
export const DIR_DOWN = 2;
export const DIR_LEFT = 3;
export const DIR_NONE = -1;

// ---------------------------------------------------------------------------
// Entity speeds (tiles per second) and sizes
// ---------------------------------------------------------------------------

export const CUBE_RADIUS = 0.46; // half-extent, in tiles
export const ADVENTURER_RADIUS = 0.3;

/** Distance (in tiles) between centers at which a collision registers. */
export const CONTACT_DIST = 0.62;

/** Seconds the cube spends digesting an adventurer (it slows briefly). */
export const DIGEST_TIME = 0.45;
export const DIGEST_SPEED_MULT = 0.55;

// ---------------------------------------------------------------------------
// Loot / economy
// ---------------------------------------------------------------------------

/** Fraction of eligible floor tiles that receive a coin. */
export const COIN_DENSITY = 1.0;
/** Coins an adventurer can carry before it must run to a stairwell to bank.
 *  WS-F tuning: dropped from 8 to 6 per WS-E1's pacing measurement (4 Veteran
 *  adventurers banked 60% of a full maze in ~47s avg with zero cube
 *  interference, comfortably under the 60-90s target even before real
 *  interception is added back in). Re-verified by playtest — see
 *  docs/INTEGRATION.md "WS-F — integration". */
export const PACK_CAPACITY = 6;
/** Adventurers win the level once they bank this fraction of all coins. */
export const LOOT_GOAL_FRACTION = 0.6;
/** Seconds an adventurer stands on the stairwell while banking. */
export const BANK_TIME = 0.9;

/** Score awarded per adventurer dissolved, indexed by combo chain position. */
export const DISSOLVE_SCORES = [200, 400, 800, 1600, 3200];
/** Score awarded for each coin the player recovers from a dissolved pack. */
export const SCORE_PER_RECOVERED_COIN = 15;
/** Flat bonus for clearing a level. */
export const LEVEL_CLEAR_BONUS = 1000;
/** Bonus per coin the adventurers never managed to bank. */
export const SCORE_PER_UNBANKED_COIN = 10;

/** Seconds within which consecutive dissolves keep the combo chain alive. */
export const COMBO_WINDOW = 6.0;

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

/** @typedef {'easy'|'normal'|'hard'} DifficultyId */

export const DIFFICULTIES = {
  easy: {
    id: 'easy',
    label: 'Novice',
    cubeSpeed: 5.4,
    advSpeed: 4.3,
    advCount: 3,
    driedDuration: 5.0,
    magicItems: 2,
    lootGoalFraction: 0.65,
    scoreMult: 0.75,
  },
  normal: {
    id: 'normal',
    label: 'Veteran',
    cubeSpeed: 5.1,
    advSpeed: 4.6,
    advCount: 4,
    driedDuration: 7.0,
    magicItems: 3,
    lootGoalFraction: 0.6,
    scoreMult: 1.0,
  },
  hard: {
    id: 'hard',
    label: 'Legendary',
    cubeSpeed: 4.9,
    advSpeed: 4.9,
    advCount: 5,
    driedDuration: 9.0,
    magicItems: 4,
    lootGoalFraction: 0.55,
    scoreMult: 1.5,
  },
};

/** Per-level ramp applied on top of the difficulty preset. `level` is 1-based. */
export const LEVEL_RAMP = {
  /** Adventurer speed gained per level beyond the first. */
  advSpeedPerLevel: 0.13,
  /** Max adventurer speed however many levels deep. */
  advSpeedCap: 6.4,
  /** One extra adventurer every N levels. */
  advCountEveryNLevels: 2,
  advCountCap: 8,
  /** Extra seconds of dried-out vulnerability per level. */
  driedPerLevel: 0.4,
  driedCap: 12.0,
  /** One extra magic item every N levels. */
  magicItemEveryNLevels: 3,
  magicItemCap: 5,
};

// ---------------------------------------------------------------------------
// Cube states
// ---------------------------------------------------------------------------

/** Multiplier on cube speed while dried out (vulnerable). */
export const DRIED_SPEED_MULT = 0.74;
/** Multiplier on adventurer speed while hunting a dried cube. */
export const HUNT_SPEED_MULT = 1.1;
/** Multiplier on adventurer speed while fleeing a healthy cube. */
export const FLEE_SPEED_MULT = 1.04;
/** Seconds of blinking warning before the dried state ends. */
export const DRIED_WARNING_TIME = 2.5;

/** How close (tiles, path distance) the cube must be before adventurers flee. */
export const FLEE_RADIUS = 6;
/** Path distance at which a threatened adventurer will detour for a magic item. */
export const ITEM_INTEREST_RADIUS = 12;

// ---------------------------------------------------------------------------
// Lives / run
// ---------------------------------------------------------------------------

export const STARTING_LIVES = 3;
/** Seconds of invulnerability + freeze after respawning at the lair. */
export const RESPAWN_GRACE = 2.0;

// ---------------------------------------------------------------------------
// Player-selectable ooze colors
// ---------------------------------------------------------------------------

export const OOZE_COLORS = [
  { id: 'acid', label: 'Acid Green', core: 0x7cfc4a, rim: 0xd6ff9a, glow: 0x3fa021 },
  { id: 'ochre', label: 'Ochre Jelly', core: 0xd79a34, rim: 0xffd88a, glow: 0x8a5a12 },
  { id: 'arcane', label: 'Arcane Violet', core: 0x9b5cff, rim: 0xe0c4ff, glow: 0x4c1d95 },
  { id: 'abyss', label: 'Abyssal Blue', core: 0x35a7ff, rim: 0xb8e4ff, glow: 0x0b4a7a },
  { id: 'blood', label: 'Blood Crimson', core: 0xe0473a, rim: 0xffb3a6, glow: 0x7a1108 },
  { id: 'pudding', label: 'Black Pudding', core: 0x3a3550, rim: 0x8f86b8, glow: 0x120f22 },
];

export const DEFAULT_SETTINGS = {
  difficulty: 'normal',
  oozeColor: 'acid',
  music: true,
  sfx: true,
  haptics: true,
};

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export const PALETTE = {
  floor: 0x1d1a22,
  floorAlt: 0x252029,
  wallTop: 0x4a4552,
  wallSide: 0x2e2a35,
  mortar: 0x14121a,
  coin: 0xffcf4d,
  exit: 0x6ad3ff,
  torch: 0xff9a3c,
  fog: 0x07060a,
};

/** Camera pitch in degrees away from straight-down. 0 = pure top-down. */
export const CAMERA_PITCH_DEG = 12;
/** Extra tiles of margin kept visible around the maze when fitting the camera. */
export const CAMERA_MARGIN_TILES = 1.2;

/** Fixed simulation step, seconds. The renderer interpolates between steps. */
export const FIXED_DT = 1 / 120;
/** Never simulate more than this much wall time in one frame. */
export const MAX_FRAME_DT = 0.25;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const STORAGE_KEY_SCORES = 'gelcube.scores.v1';
export const STORAGE_KEY_SETTINGS = 'gelcube.settings.v1';
export const MAX_LEADERBOARD_ENTRIES = 10;

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective per-level parameters.
 * @param {DifficultyId} difficultyId
 * @param {number} level 1-based
 */
export function levelParams(difficultyId, level) {
  const d = DIFFICULTIES[difficultyId] || DIFFICULTIES.normal;
  const n = Math.max(0, level - 1);
  return {
    difficulty: d.id,
    level,
    cubeSpeed: d.cubeSpeed,
    advSpeed: Math.min(LEVEL_RAMP.advSpeedCap, d.advSpeed + n * LEVEL_RAMP.advSpeedPerLevel),
    advCount: Math.min(
      LEVEL_RAMP.advCountCap,
      d.advCount + Math.floor(n / LEVEL_RAMP.advCountEveryNLevels),
    ),
    driedDuration: Math.min(LEVEL_RAMP.driedCap, d.driedDuration + n * LEVEL_RAMP.driedPerLevel),
    magicItems: Math.min(
      LEVEL_RAMP.magicItemCap,
      d.magicItems + Math.floor(n / LEVEL_RAMP.magicItemEveryNLevels),
    ),
    lootGoalFraction: d.lootGoalFraction,
    scoreMult: d.scoreMult,
  };
}
