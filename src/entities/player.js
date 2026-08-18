// WS-D — Player (gelatinous cube) entity. Grid-locked, Pac-Man-style movement.
//
// createPlayer(maze, opts) -> Player
//   opts: reserved for future use (none read today); pass {} or omit.
//
// Player.update(dt, input, ctx) — EXACT contract other workstreams build against:
//   dt    : number, seconds elapsed this step.
//   input : a DIR_* constant (DIR_UP/RIGHT/DOWN/LEFT) — the direction currently
//           requested — or DIR_NONE for "no new request this frame". Feed this
//           from the input system's LIVE, persistent `input.dir` property every
//           frame (do NOT drain it with consumeDir() — see src/game/input.js's
//           header comment for why). Pac-Man movement needs the request to keep
//           re-arriving every frame until it is honored at a junction; a
//           one-shot value would be forgotten before the cube reaches the turn.
//   ctx   : { speed } — REQUIRED, supplied by the caller (rules.js) every frame.
//           `speed` is tiles/second, fully resolved for this frame — base
//           cubeSpeed already multiplied by any dried/digesting multiplier the
//           caller wants applied. This module never reads speed from config.
//           A missing ctx or ctx.speed is treated as speed 0 (cube holds
//           position) rather than throwing.
//
// Wrap detection: `player.wrapped` is true only during the update() call in
// which the cube's column crossed the horizontal wrap seam (src/maze/grid.js
// wrapCol/wrapWorldX). It is cleared to false at the top of every update() —
// read it right after calling update(), before the next call. Consumers:
// the slime trail (suppress a smear across the board) and audio (a wrap stinger).
//
// Movement model (why it's built this way):
//   Position is derived from three pieces of state: an anchor tile (col,row —
//   the last tile CENTER fully reached), a "leg direction" (the direction that
//   defines the position offset from the anchor) and a progress scalar in
//   [0,1] measuring distance traveled from the anchor along that leg. World
//   x/z are always recomputed as anchor-center + legDir-vector * progress, so
//   the off-axis coordinate is exactly the anchor's centerline every frame —
//   never independently accumulated — which is what makes corner-snapping
//   drift-free over arbitrarily long play sessions.
//
//   Instant reversal doesn't move the anchor or jump position: it just flips
//   which way `progress` is heading (toward 0, i.e. back to the anchor) using
//   the SAME leg direction/vector, so the cube smoothly retraces its steps
//   instead of teleporting to a mirrored offset.
//
//   No object/array allocation happens inside update() or any function it
//   calls — all state lives as plain fields on the returned player object.

import { DIR_NONE, DIR_UP, DIR_RIGHT, DIR_DOWN, DIR_LEFT, DIRS } from '../config.js';
import { worldX, worldZ, wrapWorldX, wrapCol, isWalkable } from '../maze/grid.js';

const EPS = 1e-6;
const MAX_ITERS = 8; // safety cap on multi-tile-per-frame crossings; never hit at normal dt/speed

// OPPOSITE[d] is the reverse of DIR_* d, indexed UP,RIGHT,DOWN,LEFT.
const OPPOSITE = [DIR_DOWN, DIR_LEFT, DIR_UP, DIR_RIGHT];

export function createPlayer(maze, opts) {
  void opts; // reserved

  const spawn = maze.spawn;

  const player = {
    col: spawn.col,
    row: spawn.row,
    x: worldX(spawn.col),
    z: worldZ(spawn.row),
    dir: DIR_NONE,
    wrapped: false,
    update,
    setDir,
    reset,
    teleportTo,
  };

  // Internal-only state, not part of the public contract.
  let queuedDir = DIR_NONE;
  let progress = 0; // 0..1, distance traveled from (col,row) along legDir
  let legDir = DIR_UP; // arbitrary valid default; only meaningful once progress > 0

  function isWalkableDir(col, row, d) {
    const v = DIRS[d];
    return isWalkable(maze, col + v.dc, row + v.dr, 'cube');
  }

  function applyQueuedTurn() {
    if (queuedDir !== DIR_NONE && isWalkableDir(player.col, player.row, queuedDir)) {
      player.dir = queuedDir;
      queuedDir = DIR_NONE;
    }
  }

  function setDir(requestedDir) {
    if (requestedDir === DIR_NONE) return;
    if (requestedDir === player.dir) {
      // Re-affirming the current heading clears any stale buffered turn.
      queuedDir = DIR_NONE;
      return;
    }
    if (player.dir !== DIR_NONE && requestedDir === OPPOSITE[player.dir]) {
      // Instant reversal: always legal (it's the tile we just came from),
      // applies immediately even mid-tile, no junction wait.
      player.dir = requestedDir;
      queuedDir = DIR_NONE;
      return;
    }
    // Not opposite, not current: buffer it. Pre-turn buffering persists
    // until a tile centre where it IS legal — not just the very next one —
    // so a slightly-early or slightly-stale touch input still fires.
    queuedDir = requestedDir;
  }

  function advanceAnchor() {
    const v = DIRS[legDir];
    const rawCol = player.col + v.dc;
    const newCol = wrapCol(rawCol);
    if (newCol !== rawCol) player.wrapped = true;
    player.col = newCol;
    player.row += v.dr;
  }

  function syncPosition() {
    const v = DIRS[legDir];
    const rawX = worldX(player.col) + v.dc * progress;
    player.x = wrapWorldX(rawX);
    player.z = worldZ(player.row) + v.dr * progress;
  }

  function update(dt, input, ctx) {
    player.wrapped = false;

    if (input !== undefined && input !== null && input !== DIR_NONE) {
      setDir(input);
    }
    if (progress === 0) applyQueuedTurn();

    const speed = ctx && typeof ctx.speed === 'number' && ctx.speed > 0 ? ctx.speed : 0;
    let remaining = speed * dt;
    let guard = 0;

    while (remaining > EPS && player.dir !== DIR_NONE && guard < MAX_ITERS) {
      guard++;

      if (progress === 0) {
        // Fresh leg: confirm the current heading is actually walkable before
        // committing to it. If not, stop here — cleanly at the centre,
        // keep facing `dir`, and wait for the next legal request.
        if (!isWalkableDir(player.col, player.row, player.dir)) break;
        legDir = player.dir;
      }

      const forward = player.dir === legDir;
      const distLeft = forward ? 1 - progress : progress;
      const step = distLeft < remaining ? distLeft : remaining;
      progress += forward ? step : -step;
      remaining -= step;

      if (forward && progress >= 1 - EPS) {
        advanceAnchor();
        progress = 0;
        applyQueuedTurn();
      } else if (!forward && progress <= EPS) {
        progress = 0;
        applyQueuedTurn();
      }
    }

    syncPosition();
  }

  function reset() {
    player.col = spawn.col;
    player.row = spawn.row;
    player.dir = DIR_NONE;
    player.wrapped = false;
    queuedDir = DIR_NONE;
    progress = 0;
    legDir = DIR_UP;
    syncPosition();
  }

  function teleportTo(col, row) {
    player.col = wrapCol(col);
    player.row = row;
    player.dir = DIR_NONE;
    player.wrapped = false;
    queuedDir = DIR_NONE;
    progress = 0;
    legDir = DIR_UP;
    syncPosition();
  }

  return player;
}
