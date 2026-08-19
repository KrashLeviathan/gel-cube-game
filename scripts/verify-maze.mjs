#!/usr/bin/env node
/**
 * WS-A verification. `npm run verify:maze`
 *
 * Generates ~200 mazes across random seeds and checks: connectivity,
 * left/right symmetry, tunnel rows reaching both edges, exactly-one-door
 * lair, required feature counts, no isolated pockets, dead-end budget,
 * walkable ratio band, and pathfinding correctness/perf (including the
 * wrap shortcut). Prints one ASCII maze so a human can eyeball it.
 * No dependencies, ESM, Node 18+.
 */
import {
  COLS,
  ROWS,
  TILE_WALL,
  TILE_FLOOR,
  TILE_LAIR,
  TILE_LAIR_DOOR,
  TILE_TUNNEL,
  TILE_EXIT,
  DIR_NONE,
} from '../src/config.js';
import { idx, isWalkable, wrapCol } from '../src/maze/grid.js';
import { generateMaze } from '../src/maze/generator.js';
import { stepToward, findPath, distanceField } from '../src/maze/pathfinding.js';

const N_MAZES = 200;
const MAX_DEAD_ENDS_BUDGET = 6; // beyond the intentional exit alcoves

let failures = 0;
let sampleMaze = null;
const stats = {
  ratios: [],
  deadEnds: [],
  genTimesMs: [],
};

function fail(msg) {
  failures++;
  console.error(`  FAIL: ${msg}`);
}

function scanTiles(tiles, value) {
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (tiles[idx(c, r)] === value) out.push({ col: c, row: r });
    }
  }
  return out;
}

function floodFillCount(maze, startCol, startRow, who) {
  const visited = new Uint8Array(COLS * ROWS);
  const stack = [idx(startCol, startRow)];
  visited[stack[0]] = 1;
  let count = 0;
  while (stack.length) {
    const cur = stack.pop();
    count++;
    const row = (cur / COLS) | 0;
    const col = cur % COLS;
    const neigh = [
      [wrapCol(col), row - 1],
      [wrapCol(col + 1), row],
      [wrapCol(col), row + 1],
      [wrapCol(col - 1), row],
    ];
    for (const [nc, nr] of neigh) {
      if (nr < 0 || nr >= ROWS) continue;
      if (!isWalkable(maze, nc, nr, who)) continue;
      const ni = idx(nc, nr);
      if (!visited[ni]) {
        visited[ni] = 1;
        stack.push(ni);
      }
    }
  }
  return count;
}

function tileDegree(tiles, col, row) {
  const neigh = [
    [wrapCol(col), row - 1],
    [wrapCol(col + 1), row],
    [wrapCol(col), row + 1],
    [wrapCol(col - 1), row],
  ];
  let d = 0;
  for (const [nc, nr] of neigh) {
    if (nr < 0 || nr >= ROWS) continue;
    if (tiles[idx(nc, nr)] !== TILE_WALL) d++;
  }
  return d;
}

function checkSymmetry(maze) {
  const { tiles } = maze;
  const mismatches = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const mc = COLS - 1 - c;
      if (tiles[idx(c, r)] !== tiles[idx(mc, r)])
        mismatches.push({ c, mc, r, a: tiles[idx(c, r)], b: tiles[idx(mc, r)] });
    }
  }
  // The lair door is the one documented, spec-mandated exception: COLS is
  // even, so there's no self-mirroring center column and a *single* door
  // tile cannot be perfectly mirrored. Every mismatch must be exactly that
  // one door<->lair pair (mismatch count === 2: (door,lair) and (lair,door)).
  if (mismatches.length === 0) return true;
  if (mismatches.length !== 2) return false;
  return mismatches.every(
    ({ a, b }) =>
      (a === TILE_LAIR_DOOR && b === TILE_LAIR) || (a === TILE_LAIR && b === TILE_LAIR_DOOR),
  );
}

function checkTunnelReachesEdges(maze) {
  if (!maze.tunnelRows.length) return false;
  for (const r of maze.tunnelRows) {
    if (maze.tiles[idx(0, r)] !== TILE_TUNNEL) return false;
    if (maze.tiles[idx(COLS - 1, r)] !== TILE_TUNNEL) return false;
    for (let c = 0; c < COLS; c++) {
      if (maze.tiles[idx(c, r)] !== TILE_TUNNEL) return false;
    }
  }
  return true;
}

function checkLairAndDoor(maze) {
  const doorTiles = scanTiles(maze.tiles, TILE_LAIR_DOOR);
  if (doorTiles.length !== 1) return `expected exactly 1 door, found ${doorTiles.length}`;
  const lairTiles = scanTiles(maze.tiles, TILE_LAIR);
  if (lairTiles.length < 20) return `lair too small (${lairTiles.length} tiles)`;
  const door = doorTiles[0];
  const onTopEdge = door.row === maze.lair.row;
  if (!onTopEdge) return 'door is not on the lair top edge';
  return null;
}

function checkNoIsolatedPockets(maze) {
  // A "pocket" is a walkable tile with degree 0 (unreachable in principle,
  // caught by the flood-fill check too, but flag it explicitly & cheaply).
  for (let i = 0; i < maze.tiles.length; i++) {
    if (maze.tiles[i] === TILE_WALL) continue;
    const row = (i / COLS) | 0;
    const col = i % COLS;
    if (tileDegree(maze.tiles, col, row) === 0) return { col, row };
  }
  return null;
}

function renderAscii(maze) {
  const CHARS = {
    [TILE_WALL]: '#',
    [TILE_FLOOR]: '.',
    [TILE_LAIR]: 'L',
    [TILE_LAIR_DOOR]: 'D',
    [TILE_TUNNEL]: 'T',
    [TILE_EXIT]: 'E',
  };
  let out = '';
  for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let c = 0; c < COLS; c++) line += CHARS[maze.tiles[idx(c, r)]] ?? '?';
    out += line + '\n';
  }
  return out;
}

function randomWalkableTile(maze, who, rand) {
  for (let tries = 0; tries < 2000; tries++) {
    const c = Math.floor(rand() * COLS);
    const r = Math.floor(rand() * ROWS);
    if (isWalkable(maze, c, r, who)) return { col: c, row: r };
  }
  return null;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkMaze(seed, idxInRun) {
  const t0 = performance.now();
  const maze = generateMaze(seed);
  const t1 = performance.now();
  stats.genTimesMs.push(t1 - t0);

  const label = `seed=${seed}`;
  let ok = true;

  if (maze.cols !== COLS || maze.rows !== ROWS) {
    fail(`${label}: wrong dims`);
    ok = false;
  }

  // Connectivity: full flood fill from spawn ('cube'), and adventurer flood
  // fill from just outside the door, must cover 100% of the relevant tiles.
  let totalNonWall = 0;
  let totalAdvWalkable = 0;
  for (const t of maze.tiles) {
    if (t !== TILE_WALL) totalNonWall++;
    if (t !== TILE_WALL && t !== TILE_LAIR && t !== TILE_LAIR_DOOR) totalAdvWalkable++;
  }
  const cubeReach = floodFillCount(maze, maze.spawn.col, maze.spawn.row, 'cube');
  if (cubeReach !== totalNonWall) {
    fail(`${label}: cube flood fill reached ${cubeReach}/${totalNonWall} non-wall tiles`);
    ok = false;
  }

  const doorTiles = scanTiles(maze.tiles, TILE_LAIR_DOOR);
  if (doorTiles.length === 1) {
    let outside = null;
    const d = doorTiles[0];
    const cand = [
      [d.col, d.row - 1],
      [d.col + 1, d.row],
      [d.col, d.row + 1],
      [d.col - 1, d.row],
    ];
    for (const [c, r] of cand) {
      if (r < 0 || r >= ROWS) continue;
      if (isWalkable(maze, c, r, 'adventurer')) {
        outside = { col: c, row: r };
        break;
      }
    }
    if (outside) {
      const advReach = floodFillCount(maze, outside.col, outside.row, 'adventurer');
      if (advReach !== totalAdvWalkable) {
        fail(
          `${label}: adventurer flood fill reached ${advReach}/${totalAdvWalkable} tiles (must avoid lair)`,
        );
        ok = false;
      }
    } else {
      fail(`${label}: no walkable tile outside the door`);
      ok = false;
    }
  }

  if (!checkSymmetry(maze)) {
    fail(`${label}: not left/right symmetric (beyond the documented door exception)`);
    ok = false;
  }
  if (!checkTunnelReachesEdges(maze)) {
    fail(`${label}: tunnel row does not fully reach both edges`);
    ok = false;
  }

  const lairMsg = checkLairAndDoor(maze);
  if (lairMsg) {
    fail(`${label}: ${lairMsg}`);
    ok = false;
  }

  const pocket = checkNoIsolatedPockets(maze);
  if (pocket) {
    fail(`${label}: isolated pocket at ${JSON.stringify(pocket)}`);
    ok = false;
  }

  if (maze.exits.length < 2 || maze.exits.length > 4) {
    fail(`${label}: exits count ${maze.exits.length} out of [2,4]`);
    ok = false;
  }
  if (maze.advSpawns.length < 4) {
    fail(`${label}: advSpawns count ${maze.advSpawns.length} < 4`);
    ok = false;
  }
  if (maze.itemSpots.length < 8) {
    fail(`${label}: itemSpots count ${maze.itemSpots.length} < 8`);
    ok = false;
  }
  for (const s of maze.advSpawns) {
    const t = maze.tiles[idx(s.col, s.row)];
    if (t === TILE_LAIR || t === TILE_LAIR_DOOR) {
      fail(`${label}: advSpawn inside lair at ${JSON.stringify(s)}`);
      ok = false;
    }
  }

  let deadEnds = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const t = maze.tiles[idx(c, r)];
      if (t !== TILE_FLOOR && t !== TILE_TUNNEL && t !== TILE_EXIT) continue;
      if (tileDegree(maze.tiles, c, r) === 1) deadEnds++;
    }
  }
  stats.deadEnds.push(deadEnds);
  if (deadEnds > maze.exits.length + MAX_DEAD_ENDS_BUDGET) {
    fail(
      `${label}: ${deadEnds} dead ends exceeds budget (exits=${maze.exits.length}, budget=+${MAX_DEAD_ENDS_BUDGET})`,
    );
    ok = false;
  }

  const ratio = totalNonWall / maze.tiles.length;
  stats.ratios.push(ratio);
  if (ratio < 0.35 || ratio > 0.68) {
    fail(`${label}: walkable ratio ${ratio.toFixed(3)} outside sane band`);
    ok = false;
  }

  if (idxInRun === 0) sampleMaze = maze;
  return ok;
}

function checkPathfinding(seed) {
  const maze = generateMaze(seed);
  const rand = mulberry32(seed ^ 0xa53f9);
  let ok = true;

  for (let i = 0; i < 40; i++) {
    const start = randomWalkableTile(maze, 'adventurer', rand);
    const goal = randomWalkableTile(maze, 'adventurer', rand);
    if (!start || !goal) continue;
    const isGoal = (c, r) => c === goal.col && r === goal.row;
    const dir = stepToward(maze, start.col, start.row, isGoal, { who: 'adventurer' });
    const path = findPath(maze, start.col, start.row, isGoal, { who: 'adventurer' });
    const df = distanceField(maze, start.col, start.row, { who: 'adventurer' });
    const fieldDist = df[idx(goal.col, goal.row)];

    if (start.col === goal.col && start.row === goal.row) {
      if (dir !== DIR_NONE) {
        fail(`pathfinding: same-tile step should be DIR_NONE, got ${dir}`);
        ok = false;
      }
      continue;
    }
    if (fieldDist === -1) {
      if (dir !== DIR_NONE || path.length !== 0) {
        fail('pathfinding: unreachable goal should yield DIR_NONE / empty path');
        ok = false;
      }
      continue;
    }
    if (dir === DIR_NONE) {
      fail(`pathfinding: reachable goal (dist ${fieldDist}) returned DIR_NONE`);
      ok = false;
    }
    if (path.length !== fieldDist) {
      fail(
        `pathfinding: findPath length ${path.length} != distanceField ${fieldDist} for ${JSON.stringify(start)} -> ${JSON.stringify(goal)}`,
      );
      ok = false;
    }
  }

  // Wrap sanity: a tile near col 0 and a tile near col 27 on a tunnel row
  // should be a short hop through the wrap, not the long way around.
  for (const tr of maze.tunnelRows) {
    const left = { col: 1, row: tr };
    const right = { col: COLS - 2, row: tr };
    const path = findPath(maze, left.col, left.row, (c, r) => c === right.col && r === right.row, {
      who: 'adventurer',
    });
    if (path.length === 0) {
      fail(`pathfinding: no wrap path found on tunnel row ${tr}`);
      ok = false;
    } else if (path.length > 8) {
      fail(`pathfinding: wrap path length ${path.length} is not using the wrap (tunnel row ${tr})`);
      ok = false;
    }
  }

  return ok;
}

function checkPerf() {
  const maze = generateMaze(424242);
  const cubeDist = distanceField(maze, maze.spawn.col, maze.spawn.row, { who: 'cube' });
  const rand = mulberry32(9001);
  const N = 2000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const s = randomWalkableTile(maze, 'adventurer', rand);
    if (!s) continue;
    stepToward(maze, s.col, s.row, (c, r) => maze.exits.some((e) => e.col === c && e.row === r), {
      who: 'adventurer',
      avoid: cubeDist,
      avoidRadius: 6,
      avoidCost: 8,
    });
  }
  const t1 = performance.now();
  const usPerCall = ((t1 - t0) / N) * 1000;
  console.log(
    `\nperf: ${N} weighted stepToward calls in ${(t1 - t0).toFixed(1)}ms (${usPerCall.toFixed(1)}us/call)`,
  );
  // Budget: 8 adventurers x ~5 calls/sec = 40 calls/sec => needs to be well under 1ms/call.
  if (usPerCall > 2000) {
    fail(`perf: ${usPerCall.toFixed(1)}us/call is too slow for the 8-adventurer budget`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
console.log(`Generating and checking ${N_MAZES} mazes...\n`);

for (let i = 0; i < N_MAZES; i++) {
  const seed = 1000003 * (i + 1) + 17;
  checkMaze(seed, i);
}

console.log('Checking pathfinding correctness + wrap shortcut on 20 sample mazes...');
for (let i = 0; i < 20; i++) {
  checkPathfinding(2000003 * (i + 1) + 31);
}

checkPerf();

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * p)];
}

console.log('\n--- summary -------------------------------------------------');
console.log(`mazes checked:        ${N_MAZES}`);
console.log(
  `walkable ratio:        min ${Math.min(...stats.ratios).toFixed(3)}  p50 ${pct(stats.ratios, 0.5).toFixed(3)}  max ${Math.max(...stats.ratios).toFixed(3)}`,
);
console.log(
  `dead ends:              min ${Math.min(...stats.deadEnds)}  p50 ${pct(stats.deadEnds, 0.5)}  max ${Math.max(...stats.deadEnds)}`,
);
console.log(
  `generation time:        min ${Math.min(...stats.genTimesMs).toFixed(2)}ms  p50 ${pct(stats.genTimesMs, 0.5).toFixed(2)}ms  max ${Math.max(...stats.genTimesMs).toFixed(2)}ms`,
);

if (sampleMaze) {
  console.log('\n--- sample maze (ASCII: # wall, . floor, L lair, D door, T tunnel, E exit) ---\n');
  console.log(renderAscii(sampleMaze));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.\n`);
  process.exit(1);
} else {
  console.log('\nAll checks passed.\n');
}
