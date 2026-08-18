/**
 * Adventurer AI — WS-E1.
 *
 * Grid-locked, wrap-aware, centreline-snapped movement (same discipline as
 * the player module), driving the state machine from docs/SPEC.md §4
 * "Adventurer loop": COLLECT <-> BANK, with FLEE / SEEK_ITEM / HUNT layered
 * on top by threat level, and DEAD as a terminal sink.
 *
 * Movement and "which way to go" are deliberately separate mechanisms, on
 * purpose — collapsing them caused a real bug during development (see below):
 *  - `update()` runs every frame and integrates position along the current
 *    `dir` (turn decided fresh at each tile centre, instant reversal mid-tile
 *    on a sudden threat, centreline snap, wrap via `wrapWorldX`/`wrapCol`).
 *  - The *field* driving that decision is only refreshed at a throttled,
 *    per-instance-staggered planning tick (~4-8Hz, see PLAN_INTERVAL_*).
 *    Planning computes a path-distance field with `distanceField()` and
 *    caches it; walking its gradient by hand (rather than taking
 *    `stepToward`'s single answer) is what lets ties be broken in favour of
 *    the direction already being travelled — that's what kills the classic
 *    "oscillates between two equidistant goals" bug. `stepToward`/`findPath`
 *    are not used at all; `distanceField` alone covers both target
 *    *selection* (nearest coin/exit/item from the adventurer) and per-tile
 *    *movement* (gradient descent/ascent on a field rooted at the chosen
 *    target or at the cube).
 *  - Critically, the *decision* of which neighbour to step into is always
 *    made synchronously at the instant a tile centre is reached (in
 *    `decideAtTileCenter`), reading whatever field the last planning tick
 *    cached — never queued ahead of time from inside the throttled tick
 *    itself. An early version queued the decision from the plan tick instead,
 *    and because that tick runs on its own clock independent of frame
 *    boundaries, the queued turn would arrive either just before or just
 *    after the real arrival instant — sending the adventurer one tile past
 *    every junction, forever oscillating between the tile before and after.
 *    Reading the cached field fresh at the arrival instant instead removes
 *    the race entirely.
 *
 * ---------------------------------------------------------------------------
 * ctx contract — the integrator (rules.js) builds this fresh for every
 * `update(dt, ctx)` call:
 *
 *   ctx = {
 *     cube: { col: number, row: number, dried: boolean },
 *     hasCoinAt(col, row) -> boolean,
 *     takeCoinAt(col, row) -> boolean,          // true iff a coin was removed
 *     items: [{ col, row, type, taken }, ...],  // live reference to pickups.items
 *     takeItemAt(col, row) -> truthy | falsy,   // truthy (item or true) = taken
 *   }
 *
 * `hasCoinAt` / `takeCoinAt` / `items` / `takeItemAt` should be passed
 * straight through from the real `pickups` instance (src/entities/pickups.js,
 * SPEC §5) — this module never imports pickups.js itself, so it works
 * against whatever object satisfies that shape. The pathfinding helpers are
 * NOT threaded through ctx: pathfinding.js is itself a stable, read-only
 * contract module, so this module imports `distanceField` from it directly.
 *
 * update(dt, ctx) return value — at most one event per call:
 *
 *   null
 *   { type: 'banked', count, col, row }
 *     Finished standing on a stairwell. Hand `count` coins to
 *     state.coinsBanked, emit ADVENTURER_BANKED / LOOT_CHANGED / SCORE_CHANGED.
 *   { type: 'itemTaken', item, col, row }
 *     Picked up `item` (the same object reference from ctx.items — already
 *     removed from the board via ctx.takeItemAt before this returns). Start
 *     the cube's dried state (DRIED_STARTED, driedDuration timer) and emit
 *     ITEM_TAKEN.
 *
 * kill() — call on cube/adventurer contact (non-dried cube touching a live
 * adventurer). Returns:
 *
 *   null                     — pack was empty, nothing to spill
 *   { col, row, count }      — call pickups.spill(col, row, count)
 *
 * kill() needs no ctx: it only reads the adventurer's own state.
 *
 * reset(newSpawn?) — restores the adventurer to full health at its spawn
 * tile (or `newSpawn` if supplied, e.g. after a maze regenerates on a failed
 * level). Matches the documented `reset()` no-arg signature; the parameter
 * is an additive, backward-compatible convenience.
 * ---------------------------------------------------------------------------
 */

import {
  DIR_NONE,
  DIR_UP,
  DIR_DOWN,
  DIRS,
  PACK_CAPACITY,
  BANK_TIME,
  FLEE_RADIUS,
  ITEM_INTEREST_RADIUS,
  HUNT_SPEED_MULT,
  FLEE_SPEED_MULT,
  DIFFICULTIES,
} from '../config.js';
import { worldX, worldZ, wrapWorldX, idx, wrapCol, isWalkable, tileDistance } from '../maze/grid.js';
import { distanceField } from '../maze/pathfinding.js';

const WHO = 'adventurer';
const EPS = 1e-4;

// ---------------------------------------------------------------------------
// Archetypes — meaningful but not extreme, roughly +/-15% per axis around a
// baseline of 1.0. Every multiplier stays inside [0.85, 1.15].
//
//   speedMult        multiplies the caller-supplied base adventurer speed.
//   greedMult        multiplies PACK_CAPACITY to get the *effective* bank
//                     threshold (clamped to [PACK_CAPACITY-3, PACK_CAPACITY]).
//                     >1 = keeps collecting closer to a full pack before
//                     heading to bank; <1 = banks a little early/cautious.
//   fleeRadiusMult    multiplies FLEE_RADIUS. >1 = more skittish, flees from
//                     farther away; <1 = braver, lets the cube get closer.
//   itemInterestMult  multiplies ITEM_INTEREST_RADIUS and the probability of
//                     detouring for a magic item (both the "threatened"
//                     near-certain case and the rare unthreatened personality
//                     roll).
// ---------------------------------------------------------------------------
export const ARCHETYPES = {
  fighter: { speedMult: 1.0, greedMult: 1.08, fleeRadiusMult: 0.85, itemInterestMult: 0.85 },
  rogue: { speedMult: 1.12, greedMult: 0.9, fleeRadiusMult: 1.12, itemInterestMult: 1.05 },
  wizard: { speedMult: 0.88, greedMult: 0.95, fleeRadiusMult: 1.15, itemInterestMult: 1.15 },
  cleric: { speedMult: 0.95, greedMult: 1.1, fleeRadiusMult: 0.9, itemInterestMult: 0.9 },
};

// ---------------------------------------------------------------------------
// Tunables local to this module (not tuning knobs the integrator applies —
// those live in config.js — these just shape the "feel" of the AI).
// ---------------------------------------------------------------------------
const PLAN_INTERVAL_BASE = 0.18; // ~5.5Hz, inside the required 4-8Hz band
const PLAN_INTERVAL_JITTER = 0.05; // +/- randomised each cycle, desyncs further
const MIN_STATE_DWELL = 0.5; // seconds before FLEE/SEEK_ITEM can be left
const FLEE_EXIT_MARGIN = 2; // extra path-tiles required to fully disengage FLEE
const HESITATE_MIN = 0.08;
const HESITATE_MAX = 0.2;
const HESITATE_CHANCE = 0.35; // fraction of threatened junction-turns that pause first
const AVOID_RADIUS_PAD = 1;
const AVOID_COST = 10;
const PANIC_CHANCE_BASE = 0.14; // base chance of a "wrong turn" while fleeing
const SECOND_CHOICE_CHANCE = 0.12; // chance of taking the 2nd-nearest coin
const PASSIVE_ITEM_ROLL_BASE = 0.004; // per-plan-tick chance, unthreatened
const THREATENED_ITEM_CHANCE_BASE = 0.6; // per-plan-tick chance, threatened

let _nextId = 0;

/**
 * @param {import('../maze/grid.js').Maze} maze
 * @param {'fighter'|'rogue'|'wizard'|'cleric'} archetype
 * @param {{col:number,row:number}} spawn
 * @param {{speed?:number}} [opts] speed = base tiles/sec, caller-supplied so
 *   levelParams()/difficulty ramp control it, same pattern as the player.
 */
export function createAdventurer(maze, archetype, spawn, opts = {}) {
  const arche = ARCHETYPES[archetype] || ARCHETYPES.fighter;
  const id = _nextId++;
  const baseSpeed = opts.speed ?? DIFFICULTIES.normal.advSpeed;

  const adv = {
    col: spawn.col,
    row: spawn.row,
    x: worldX(spawn.col),
    z: worldZ(spawn.row),
    dir: DIR_NONE,
    state: 'collect',
    pack: 0,
    alive: true,
    archetype,

    // --- private bookkeeping (not part of the documented surface) ---
    _spawn: { col: spawn.col, row: spawn.row },
    _arche: arche,
    _baseSpeed: baseSpeed,
    _legProgress: 0, // [0,1) fraction of the current tile-to-tile leg completed
    _planTimer: (id % 8) * (PLAN_INTERVAL_BASE / 8),
    _stateTimer: 0,
    _hesitateTimer: 0,
    _pendingDir: DIR_NONE, // turn withheld during a hesitation pause
    _bankStanding: false,
    _bankTimer: 0,
    _target: null, // {col,row} (coin/exit) or an items[] entry, meaning depends on state
    _goalField: null, // cached Int16Array for the current stable target
    _cubeField: null, // recomputed every planning tick
    _activeField: null, // field decideAtTileCenter() reads from, set by replan()
    _activeWantMax: false,

    update(dt, ctx) {
      return updateAdventurer(adv, maze, ctx, dt);
    },
    kill() {
      return killAdventurer(adv);
    },
    reset(newSpawn) {
      resetAdventurer(adv, newSpawn);
    },
  };

  return adv;
}

// ---------------------------------------------------------------------------
// Frame update
// ---------------------------------------------------------------------------

function updateAdventurer(adv, maze, ctx, dt) {
  if (!adv.alive) return null;

  adv._hesitateTimer = Math.max(0, adv._hesitateTimer - dt);
  adv._stateTimer += dt;
  adv._planTimer -= dt;

  if (adv._bankStanding) {
    if (ctx.cube.dried) {
      // Rare override: abandon the stand and go hunt immediately.
      adv._bankStanding = false;
      enterState(adv, 'hunt');
      adv._planTimer = 0;
    } else {
      adv._bankTimer -= dt;
      if (adv._bankTimer <= 0) {
        const ev = { type: 'banked', count: adv.pack, col: adv.col, row: adv.row };
        adv.pack = 0;
        adv._bankStanding = false;
        enterState(adv, 'collect');
        adv._planTimer = 0;
        return ev;
      }
      return null;
    }
  }

  const wantHunt = !!ctx.cube.dried;
  if (wantHunt && adv.state !== 'hunt') {
    enterState(adv, 'hunt');
    adv._planTimer = 0;
  } else if (!wantHunt && adv.state === 'hunt') {
    enterState(adv, 'collect'); // re-evaluated properly by the plan tick below
    adv._planTimer = 0;
  }

  if (adv._planTimer <= 0) {
    adv._planTimer = PLAN_INTERVAL_BASE + (Math.random() * 2 - 1) * PLAN_INTERVAL_JITTER;
    replan(adv, maze, ctx);
  }

  // Idle (spawn, just finished hesitating, or previously blocked) -> take a
  // fresh crack at starting to move using whatever field is currently cached.
  // This runs every frame but is nearly free while genuinely idle, and it's
  // what makes the AI responsive to a freshly-elapsed hesitation pause.
  if (adv.dir === DIR_NONE && adv._hesitateTimer <= 0 && adv.state !== 'dead') {
    if (adv._pendingDir !== DIR_NONE) {
      const d = adv._pendingDir;
      adv._pendingDir = DIR_NONE;
      const nc = wrapCol(adv.col + DIRS[d].dc);
      const nr = adv.row + DIRS[d].dr;
      if (isWalkable(maze, nc, nr, WHO)) adv.dir = d;
    } else if (adv._activeField) {
      decideAtTileCenter(adv, maze);
    }
  }

  const speed = adv._baseSpeed * adv._arche.speedMult * stateSpeedMult(adv.state);
  stepMovement(adv, maze, dt, speed);

  let event = null;

  // Passive pickup: grab a coin underfoot in any state except full-tilt HUNT.
  if (adv.state !== 'hunt' && adv.pack < PACK_CAPACITY && ctx.hasCoinAt(adv.col, adv.row)) {
    if (ctx.takeCoinAt(adv.col, adv.row)) {
      adv.pack++;
      if (adv._target && adv._target.col === adv.col && adv._target.row === adv.row) {
        adv._target = null;
        adv._goalField = null;
      }
    }
  }

  if (adv.state === 'seekItem' && adv._target && adv.col === adv._target.col && adv.row === adv._target.row) {
    const taken = ctx.takeItemAt(adv.col, adv.row);
    if (taken) {
      event = { type: 'itemTaken', item: taken === true ? adv._target : taken, col: adv.col, row: adv.row };
      adv._target = null;
      adv._goalField = null;
    }
  }

  // Arrival at a stairwell with loot -> stand and bank, whichever state got
  // it there (a fleeing loot-carrier heads to a stairwell too; see replan()).
  if (
    adv.pack > 0 &&
    (adv.state === 'bank' || adv.state === 'flee') &&
    adv._target &&
    adv.col === adv._target.col &&
    adv.row === adv._target.row &&
    !adv._bankStanding
  ) {
    adv._bankStanding = true;
    adv._bankTimer = BANK_TIME;
    adv.dir = DIR_NONE;
    adv._pendingDir = DIR_NONE;
    adv.state = 'bank';
  }

  return event;
}

function stateSpeedMult(state) {
  if (state === 'hunt') return HUNT_SPEED_MULT;
  if (state === 'flee') return FLEE_SPEED_MULT;
  return 1;
}

// ---------------------------------------------------------------------------
// Planning (throttled, staggered)
// ---------------------------------------------------------------------------

function enterState(adv, newState) {
  if (adv.state === newState) return;
  adv.state = newState;
  adv._stateTimer = 0;
  adv._hesitateTimer = 0;
  adv._pendingDir = DIR_NONE;
  adv._bankStanding = false;
  // Target semantics differ per state family — always clear and let replan()
  // re-derive for the new state. This also gives free target-hysteresis:
  // while the state itself doesn't change, the target never gets reset.
  adv._target = null;
  adv._goalField = null;
  adv._activeField = null;
  adv._activeWantMax = false;
}

function replan(adv, maze, ctx) {
  const cubeField = distanceField(maze, ctx.cube.col, ctx.cube.row, { who: WHO });
  adv._cubeField = cubeField;
  const cubeDist = cubeField[idx(adv.col, adv.row)];
  const effectiveFleeRadius = FLEE_RADIUS * adv._arche.fleeRadiusMult;
  const enterThreat = cubeDist >= 0 && cubeDist <= effectiveFleeRadius;
  const exitThreat = cubeDist >= 0 && cubeDist <= effectiveFleeRadius + FLEE_EXIT_MARGIN;
  // Hysteresis band: tighter threshold to start fleeing, looser to stop.
  const threatenedNow = adv.state === 'flee' ? exitThreat : enterThreat;

  const decision = resolveDesiredState(adv, ctx, threatenedNow);
  if (decision.state !== adv.state) enterState(adv, decision.state);
  if (decision.item && adv._target !== decision.item) {
    adv._target = decision.item;
    adv._goalField = null;
  }

  let field = null;
  let wantMax = false;

  if (adv.state === 'hunt') {
    field = cubeField;
  } else if (adv.state === 'flee') {
    if (adv.pack > 0) {
      if (!adv._target) {
        const self = distanceField(maze, adv.col, adv.row, { who: WHO });
        adv._target = chooseExitTarget(maze, self);
      }
      if (adv._target) {
        field = distanceField(maze, adv._target.col, adv._target.row, {
          who: WHO,
          avoid: cubeField,
          avoidRadius: effectiveFleeRadius + AVOID_RADIUS_PAD,
          avoidCost: AVOID_COST,
        });
      } else {
        field = cubeField;
        wantMax = true;
      }
    } else {
      field = cubeField;
      wantMax = true; // maximise distance from the cube
    }
  } else if (adv.state === 'seekItem') {
    if (adv._target) {
      if (threatenedNow) {
        field = distanceField(maze, adv._target.col, adv._target.row, {
          who: WHO,
          avoid: cubeField,
          avoidRadius: effectiveFleeRadius + AVOID_RADIUS_PAD,
          avoidCost: AVOID_COST,
        });
      } else {
        if (!adv._goalField) {
          adv._goalField = distanceField(maze, adv._target.col, adv._target.row, { who: WHO });
        }
        field = adv._goalField;
      }
    }
  } else if (adv.state === 'bank') {
    ensureBankTarget(adv, maze);
    field = adv._goalField;
  } else {
    // collect
    if (adv._target && !ctx.hasCoinAt(adv._target.col, adv._target.row)) {
      adv._target = null;
      adv._goalField = null;
    }
    if (!adv._target) {
      const self = distanceField(maze, adv.col, adv.row, { who: WHO });
      const chosen = chooseCoinTarget(maze, ctx, self, SECOND_CHOICE_CHANCE);
      if (chosen) {
        adv._target = chosen;
        adv._goalField = distanceField(maze, chosen.col, chosen.row, { who: WHO });
      } else if (adv.pack > 0) {
        // No coins left anywhere reachable — go bank what we're carrying.
        enterState(adv, 'bank');
        ensureBankTarget(adv, maze);
      }
    }
    field = adv._goalField;
  }

  // `field`/`wantMax` are cached (not acted on here) so that the *next* tile
  // centre — whenever stepMovement() actually reaches one, on whatever frame
  // that happens to fall on — can make a fresh, correctly-timed turn decision
  // from them. Deciding "which way" here and queuing it for later is exactly
  // what caused adventurers to overshoot junctions and oscillate forever in
  // early testing: replan() runs on its own throttled clock, independent of
  // frame boundaries, so a queued turn could arrive either just before or
  // just after the actual arrival instant, sending the adventurer one tile
  // past the turn every time it approached that junction.
  adv._activeField = field;
  adv._activeWantMax = wantMax;

  // Mid-tile emergency reversal only (a full turn still waits for the next
  // tile centre, same discipline as the player). If the field now says the
  // exact opposite of the current heading is best, flip immediately — this
  // is what makes a suddenly-adjacent cube snap a fleeing adventurer around
  // without waiting out a whole tile crossing.
  if (field && adv.dir !== DIR_NONE) {
    const here = candidatesFrom(maze, adv.col, adv.row, field);
    const idealNow = pickBest(here, wantMax, adv.dir);
    const opposite = (adv.dir + 2) % 4;
    if (idealNow === opposite) {
      adv.dir = opposite;
      adv._pendingDir = DIR_NONE;
      adv._hesitateTimer = 0;
    }
  }
}

/** Decides the target STATE only (target *tile* selection happens in replan). */
function resolveDesiredState(adv, ctx, threatenedNow) {
  if (threatenedNow) {
    const item = pickThreatenedItem(adv, ctx);
    return item ? { state: 'seekItem', item } : { state: 'flee', item: null };
  }

  if (adv.state === 'seekItem' && adv._target && !adv._target.taken) {
    return { state: 'seekItem', item: adv._target }; // finish the errand once committed
  }

  const dwellOk = adv._stateTimer >= MIN_STATE_DWELL;
  if ((adv.state === 'flee' || adv.state === 'seekItem') && !dwellOk) {
    return { state: adv.state, item: adv.state === 'seekItem' ? adv._target : null };
  }

  const passive = rollPassiveItem(adv, ctx);
  if (passive) return { state: 'seekItem', item: passive };

  if (adv.pack > 0 && adv.pack >= effectivePackThreshold(adv)) return { state: 'bank', item: null };
  if (adv.state === 'bank' && adv.pack > 0) return { state: 'bank', item: null }; // finish the trip

  return { state: 'collect', item: null };
}

function effectivePackThreshold(adv) {
  const raw = Math.round(PACK_CAPACITY * adv._arche.greedMult);
  return Math.min(PACK_CAPACITY, Math.max(PACK_CAPACITY - 3, raw));
}

function ensureBankTarget(adv, maze) {
  if (!adv._target) {
    const self = distanceField(maze, adv.col, adv.row, { who: WHO });
    adv._target = chooseExitTarget(maze, self);
  }
  if (adv._target && !adv._goalField) {
    adv._goalField = distanceField(maze, adv._target.col, adv._target.row, { who: WHO });
  }
}

function pickThreatenedItem(adv, ctx) {
  const radius = ITEM_INTEREST_RADIUS * adv._arche.itemInterestMult;
  const chance = Math.min(0.95, THREATENED_ITEM_CHANCE_BASE * adv._arche.itemInterestMult);
  const best = nearestItemWithin(adv, ctx, radius);
  if (!best) return null;
  return Math.random() < chance ? best : null;
}

function rollPassiveItem(adv, ctx) {
  const radius = ITEM_INTEREST_RADIUS * adv._arche.itemInterestMult;
  const chance = PASSIVE_ITEM_ROLL_BASE * adv._arche.itemInterestMult;
  if (Math.random() >= chance) return null;
  return nearestItemWithin(adv, ctx, radius);
}

/** Manhattan/tile-distance proxy (wrap-aware, O(items)) — cheap enough to
 *  call every plan tick without a distanceField; exactness isn't needed for
 *  an interest/personality check. */
function nearestItemWithin(adv, ctx, radius) {
  let best = null;
  let bestD = Infinity;
  for (const it of ctx.items) {
    if (it.taken) continue;
    const d = tileDistance(adv.col, adv.row, it.col, it.row);
    if (d > radius) continue;
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

function chooseExitTarget(maze, selfField) {
  let best = null;
  let bestD = Infinity;
  for (const e of maze.exits) {
    const d = selfField[idx(e.col, e.row)];
    if (d < 0) continue;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function chooseCoinTarget(maze, ctx, selfField, secondChance) {
  const candidates = [];
  for (let r = 0; r < maze.rows; r++) {
    for (let c = 0; c < maze.cols; c++) {
      if (!ctx.hasCoinAt(c, r)) continue;
      const d = selfField[idx(c, r)];
      if (d < 0) continue;
      candidates.push({ col: c, row: r, d });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.d - b.d);
  if (candidates.length > 1 && Math.random() < secondChance) {
    return { col: candidates[1].col, row: candidates[1].row };
  }
  return { col: candidates[0].col, row: candidates[0].row };
}

// ---------------------------------------------------------------------------
// Direction selection (gradient walk with straight-preference tie-break)
// ---------------------------------------------------------------------------

function candidatesFrom(maze, col, row, field) {
  const out = [];
  for (let d = 0; d < 4; d++) {
    const nc = wrapCol(col + DIRS[d].dc);
    const nr = row + DIRS[d].dr;
    if (!isWalkable(maze, nc, nr, WHO)) continue;
    const v = field[idx(nc, nr)];
    if (v < 0) continue;
    out.push({ d, v });
  }
  return out;
}

/** Best neighbour by field value; ties prefer `preferDir` (continuing straight). */
function pickBest(candidates, wantMax, preferDir) {
  if (!candidates.length) return DIR_NONE;
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const better = wantMax ? c.v > best.v : c.v < best.v;
    if (better) {
      best = c;
      continue;
    }
    if (c.v === best.v && c.d === preferDir && best.d !== preferDir) best = c;
  }
  return best.d;
}

function maybePanic(dir, candidates, chance) {
  if (candidates.length <= 1) return dir;
  if (Math.random() >= chance) return dir;
  const others = candidates.filter((c) => c.d !== dir);
  if (!others.length) return dir;
  return others[Math.floor(Math.random() * others.length)].d;
}

/**
 * The one place a *turn* (as opposed to a mid-tile reversal) is decided —
 * called exactly once per tile, synchronously at the instant the adventurer
 * reaches a tile centre (from stepMovement's arrival branch, or from the
 * idle-retry check in updateAdventurer). Always reads whatever field
 * replan() most recently cached, so the decision is at most one plan
 * interval stale but never mistimed relative to the actual arrival.
 */
function decideAtTileCenter(adv, maze) {
  const field = adv._activeField;
  if (!field) return;

  const candidates = candidatesFrom(maze, adv.col, adv.row, field);
  let newDir = pickBest(candidates, adv._activeWantMax, adv.dir);
  if (adv.state === 'flee') {
    const panicChance = Math.min(0.6, PANIC_CHANCE_BASE * adv._arche.fleeRadiusMult);
    newDir = maybePanic(newDir, candidates, panicChance);
  }

  if (newDir === DIR_NONE) {
    adv.dir = DIR_NONE;
    return;
  }

  const isJunction = candidates.length >= 2;
  const isTurn = newDir !== adv.dir;
  const wantsHesitate = (adv.state === 'flee' || adv.state === 'seekItem') && isJunction && isTurn && adv.dir !== DIR_NONE;

  if (wantsHesitate && Math.random() < HESITATE_CHANCE) {
    adv.dir = DIR_NONE; // a beat of "thinking" right at the junction
    adv._pendingDir = newDir;
    adv._hesitateTimer = HESITATE_MIN + Math.random() * (HESITATE_MAX - HESITATE_MIN);
    return;
  }

  adv.dir = newDir;
  adv._pendingDir = DIR_NONE;
}

// ---------------------------------------------------------------------------
// Movement integration (every frame)
// ---------------------------------------------------------------------------

/**
 * Every leg is from one tile centre to an adjacent one, and TILE = 1 world
 * unit, so a leg is always exactly 1 unit long regardless of direction or
 * whether it crosses the wrap seam. Tracking progress as that plain [0,1)
 * tile-count (`adv._legProgress`) — rather than comparing raw world-space
 * coordinates — sidesteps wrap-boundary math entirely: an early version
 * wrapped `x` into [-COLS/2, COLS/2) every frame during a partial step and
 * compared it against an *unwrapped* target coordinate, so once `x` wrapped
 * mid-leg the remaining distance appeared to jump to ~COLS tiles and the
 * adventurer drifted forever, never "arriving" (col stuck, x sliding through
 * the whole board). Position is recomputed fresh from (col, row, dir,
 * progress) every frame instead of being incrementally mutated, so there's
 * nothing to desync.
 */
function stepMovement(adv, maze, dt, speed) {
  let travel = speed * dt; // tiles still to cover this frame
  let guard = 0;
  while (travel > EPS && adv.dir !== DIR_NONE && guard++ < 8) {
    const room = 1 - adv._legProgress; // tiles left to finish the current leg
    if (travel < room - EPS) {
      adv._legProgress += travel;
      travel = 0;
    } else {
      travel -= room;
      const nc = adv.col + DIRS[adv.dir].dc;
      const nr = adv.row + DIRS[adv.dir].dr;
      adv.col = wrapCol(nc);
      adv.row = nr;
      adv._legProgress = 0;
      // Arrive exactly at the tile centre, then decide the next leg right
      // here — see decideAtTileCenter's doc comment for why this can't be
      // precomputed by the throttled planner instead.
      decideAtTileCenter(adv, maze);
    }
  }

  // Render position: exact tile centre, offset along the current heading by
  // however much of the leg is complete (0 if idle/just arrived).
  if (adv.dir !== DIR_NONE && adv._legProgress > 0) {
    const vertical = adv.dir === DIR_UP || adv.dir === DIR_DOWN;
    if (vertical) {
      adv.x = worldX(adv.col);
      adv.z = worldZ(adv.row) + DIRS[adv.dir].dr * adv._legProgress;
    } else {
      adv.x = wrapWorldX(worldX(adv.col) + DIRS[adv.dir].dc * adv._legProgress);
      adv.z = worldZ(adv.row);
    }
  } else {
    adv.x = worldX(adv.col);
    adv.z = worldZ(adv.row);
  }
}

// ---------------------------------------------------------------------------
// kill() / reset()
// ---------------------------------------------------------------------------

function killAdventurer(adv) {
  if (!adv.alive) return null;
  adv.alive = false;
  adv.state = 'dead';
  adv.dir = DIR_NONE;
  adv._pendingDir = DIR_NONE;
  const spill = adv.pack > 0 ? { col: adv.col, row: adv.row, count: adv.pack } : null;
  adv.pack = 0;
  return spill;
}

function resetAdventurer(adv, newSpawn) {
  const s = newSpawn || adv._spawn;
  adv._spawn = { col: s.col, row: s.row };
  adv.col = s.col;
  adv.row = s.row;
  adv.x = worldX(s.col);
  adv.z = worldZ(s.row);
  adv.dir = DIR_NONE;
  adv.state = 'collect';
  adv.pack = 0;
  adv.alive = true;

  adv._legProgress = 0;
  adv._planTimer = 0;
  adv._stateTimer = 0;
  adv._hesitateTimer = 0;
  adv._pendingDir = DIR_NONE;
  adv._bankStanding = false;
  adv._bankTimer = 0;
  adv._target = null;
  adv._goalField = null;
  adv._cubeField = null;
  adv._activeField = null;
  adv._activeWantMax = false;
}
