/**
 * Pac-Man-style dungeon maze generator — WS-A.
 *
 * Algorithm:
 *   1. Lay a lattice of corridor nodes (spacing 3, so unconnected wall gaps
 *      are 2 tiles thick) over the LEFT HALF of the grid only.
 *   2. Randomized Kruskal spanning tree over the lattice -> a perfect maze
 *      (no loops yet), skipping nodes/edges that overlap the reserved lair
 *      box.
 *   3. Add a random subset of the remaining (non-tree) edges back in ->
 *      loops, so the maze reads as Pac-Man-loopy rather than a labyrinth.
 *   4. Force the vertical-middle row fully open as the wrap tunnel, and make
 *      sure it actually ties into several interior columns.
 *   5. Stamp the lair box + a single door tile.
 *   6. Eliminate accidental dead ends by punching a connector to a nearby
 *      corridor. Carve a couple of deliberate 1-tile stairwell alcoves
 *      (the one allowed exception to "no dead ends").
 *   7. Mirror the left half onto the right half so the whole maze is
 *      left/right symmetric, then derive spawn/exits/advSpawns/itemSpots
 *      generically by scanning the finished tile grid.
 *
 * Every tile write goes through `carve()`, which always writes both a tile
 * and its mirror partner, so symmetry is an invariant of construction rather
 * than something checked after the fact. The ONE deliberate exception is the
 * lair door: SPEC requires exactly one TILE_LAIR_DOOR tile, but COLS is even
 * (28), so there is no self-mirroring center column — a single door tile
 * cannot be perfectly mirrored. We place it after mirroring, as a one-tile,
 * documented departure from strict symmetry (see report).
 *
 * Determinism: a small mulberry32 PRNG seeded from the caller's `seed`.
 * Never calls Math.random(). Retries with derived sub-seeds (deterministic
 * function of the input seed) up to MAX_ATTEMPTS times, then falls back to a
 * baked, pre-validated template.
 */
import {
  COLS,
  ROWS,
  DIRS,
  TILE_WALL,
  TILE_FLOOR,
  TILE_LAIR,
  TILE_LAIR_DOOR,
  TILE_TUNNEL,
  TILE_EXIT,
} from '../config.js';
import { idx, isWalkable, forEachNeighbor } from './grid.js';

const N = COLS * ROWS;
const MIRROR = COLS - 1;

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Lattice layout constants
// ---------------------------------------------------------------------------

/** Corridor columns, left half only (spacing 3 -> 2-tile wall gaps). */
const COL_NODES = [1, 4, 7, 10, 13];
/**
 * Corridor rows. Row 15 (the tunnel) is deliberately NOT a lattice row —
 * it is forced open separately and ties into the lattice through the
 * 13<->16 edges (their 2-tile gap straddles the tunnel), which keeps the
 * top/bottom border margins to a single row instead of three.
 */
const ROW_NODES = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28];
const TUNNEL_ROW = 15;
const TUNNEL_ABOVE = 13;
const TUNNEL_BELOW = 16;
/** Symmetric (col + col+cols-1 == MIRROR): 10 + 17 == 27. */
const LAIR = { col: 10, row: 16, cols: 8, rows: 4 };
const DOOR_COL = 13;
const DOOR_ROW = LAIR.row;

const LOOP_CHANCE = 0.78;
const MAX_ATTEMPTS = 40;
const MIN_TUNNEL_LINKS = 3;

function inLairBox(col, row, pad = 0) {
  return (
    col >= LAIR.col - pad &&
    col < LAIR.col + LAIR.cols + pad &&
    row >= LAIR.row - pad &&
    row < LAIR.row + LAIR.rows + pad
  );
}

/** Write a tile and its mirror partner. The one invariant-preserving writer. */
function carve(tiles, col, row, type = TILE_FLOOR) {
  tiles[idx(col, row)] = type;
  tiles[idx(MIRROR - col, row)] = type;
}

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

function makeUnionFind(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent[ra] = rb;
    return true;
  }
  return { find, union };
}

// ---------------------------------------------------------------------------
// Lattice graph
// ---------------------------------------------------------------------------

function buildNodes() {
  const nodes = [];
  for (let j = 0; j < ROW_NODES.length; j++) {
    for (let i = 0; i < COL_NODES.length; i++) {
      const col = COL_NODES[i];
      const row = ROW_NODES[j];
      nodes.push({ i, j, col, row, valid: !inLairBox(col, row) });
    }
  }
  return nodes;
}

function buildEdges(nodes) {
  const nCols = COL_NODES.length;
  const nRows = ROW_NODES.length;
  const at = (i, j) => nodes[j * nCols + i];
  const edges = [];
  for (let j = 0; j < nRows; j++) {
    for (let i = 0; i < nCols - 1; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      if (!a.valid || !b.valid) continue;
      let ok = true;
      for (let c = a.col + 1; c < b.col; c++) {
        if (inLairBox(c, a.row)) { ok = false; break; }
      }
      if (ok) {
        edges.push({ a: j * nCols + i, b: j * nCols + i + 1, dir: 'h', row: a.row, c0: a.col, c1: b.col });
      }
    }
  }
  for (let j = 0; j < nRows - 1; j++) {
    for (let i = 0; i < nCols; i++) {
      const a = at(i, j);
      const b = at(i, j + 1);
      if (!a.valid || !b.valid) continue;
      let ok = true;
      for (let r = a.row + 1; r < b.row; r++) {
        if (inLairBox(a.col, r)) { ok = false; break; }
      }
      if (ok) {
        edges.push({ a: j * nCols + i, b: (j + 1) * nCols + i, dir: 'v', col: a.col, r0: a.row, r1: b.row });
      }
    }
  }
  return edges;
}

function carveEdge(tiles, e) {
  if (e.dir === 'h') {
    for (let c = e.c0; c <= e.c1; c++) carve(tiles, c, e.row);
  } else {
    for (let r = e.r0; r <= e.r1; r++) carve(tiles, e.col, r);
  }
}

function buildAdjacency(nodeCount, edges) {
  const adj = Array.from({ length: nodeCount }, () => []);
  for (const e of edges) {
    adj[e.a].push(e);
    adj[e.b].push(e);
  }
  return adj;
}

/** An edge's gap is always 2 tiles (uniform spacing-3 lattice); check one to know if carved. */
function edgeCarved(tiles, e) {
  return e.dir === 'h' ? tiles[idx(e.c0 + 1, e.row)] !== TILE_WALL : tiles[idx(e.col, e.r0 + 1)] !== TILE_WALL;
}

/** Randomized-Kruskal spanning tree + a random subset of extra edges for loops. */
function buildLattice(tiles, rand) {
  const nodes = buildNodes();
  for (const n of nodes) if (n.valid) carve(tiles, n.col, n.row);
  const edges = shuffle(buildEdges(nodes), rand);
  const adj = buildAdjacency(nodes.length, edges);
  const uf = makeUnionFind(nodes.length);
  const restEdges = [];
  for (const e of edges) {
    if (uf.union(e.a, e.b)) carveEdge(tiles, e);
    else restEdges.push(e);
  }
  for (const e of restEdges) {
    if (rand() < LOOP_CHANCE) carveEdge(tiles, e);
  }

  // Structural dead ends can only be lattice nodes with just one carved edge
  // (every non-node "gap" tile is always mid-corridor, degree 2, by
  // construction). Fix them at the graph level: carve one more full,
  // not-yet-carved incident edge — a single wall-tile poke can't bridge a
  // uniform 3-tile lattice gap, so this has to happen here, not on raw tiles.
  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    if (!node.valid) continue;
    if (tileDegree(tiles, node.col, node.row) > 1) continue;
    const candidates = shuffle(adj[ni].filter((e) => !edgeCarved(tiles, e)), rand);
    if (candidates.length) carveEdge(tiles, candidates[0]);
  }

  return { restEdges };
}

function rowSegOpen(tiles, col, rA, rB) {
  const r0 = Math.min(rA, rB);
  const r1 = Math.max(rA, rB);
  for (let r = r0; r <= r1; r++) if (tiles[idx(col, r)] === TILE_WALL) return false;
  return true;
}

/** Guarantee the tunnel row ties into the interior at several columns, not just one. */
function ensureTunnelConnections(tiles, restEdges, rand) {
  const countLinked = () => {
    let n = 0;
    for (const c of COL_NODES) {
      if (rowSegOpen(tiles, c, TUNNEL_ABOVE, TUNNEL_BELOW)) n++;
    }
    return n;
  };
  if (countLinked() >= MIN_TUNNEL_LINKS) return;
  const candidates = shuffle(
    restEdges.filter((e) => e.dir === 'v' && e.r0 === TUNNEL_ABOVE && e.r1 === TUNNEL_BELOW),
    rand
  );
  for (const e of candidates) {
    if (countLinked() >= MIN_TUNNEL_LINKS) break;
    carveEdge(tiles, e);
  }
}

// ---------------------------------------------------------------------------
// Dead-end elimination + stairwell alcoves
// ---------------------------------------------------------------------------

function tileDegree(tiles, col, row) {
  let d = 0;
  forEachNeighbor(col, row, (nc, nr) => {
    if (nr < 0 || nr >= ROWS) return;
    if (tiles[idx(nc, nr)] !== TILE_WALL) d++;
  });
  return d;
}

/**
 * Does carving (c1,r1) give the dead-end at (col,row) a second exit? True if
 * (c1,r1) itself touches some other already-open tile (a straight extension,
 * a T into a corridor, whatever) besides the dead end we're fixing.
 */
function wallOpensConnection(tiles, c1, r1, sourceCol, sourceRow) {
  let extra = false;
  forEachNeighbor(c1, r1, (nc, nr) => {
    if (extra) return;
    if (nr < 0 || nr >= ROWS) return;
    if (nc === sourceCol && nr === sourceRow) return;
    if (inLairBox(nc, nr)) return;
    if (tiles[idx(nc, nr)] !== TILE_WALL) extra = true;
  });
  return extra;
}

function eliminateDeadEnds(tiles, rand) {
  for (let pass = 0; pass < 6; pass++) {
    let fixedAny = false;
    for (let row = 0; row < ROWS; row++) {
      if (row === TUNNEL_ROW) continue;
      for (let col = 0; col < 14; col++) {
        const t = tiles[idx(col, row)];
        if (t !== TILE_FLOOR && t !== TILE_TUNNEL) continue;
        if (tileDegree(tiles, col, row) !== 1) continue;
        const order = shuffle([0, 1, 2, 3], rand);
        for (const d of order) {
          const { dc, dr } = DIRS[d];
          const c1 = col + dc;
          const r1 = row + dr;
          if (c1 < 0 || c1 >= COLS || r1 < 0 || r1 >= ROWS) continue;
          if (tiles[idx(c1, r1)] !== TILE_WALL) continue;
          if (inLairBox(c1, r1)) continue;
          if (wallOpensConnection(tiles, c1, r1, col, row)) {
            carve(tiles, c1, r1, TILE_FLOOR);
            fixedAny = true;
            break;
          }
        }
      }
    }
    if (!fixedAny) break;
  }
}

/** One deliberate 1-tile dead-end alcove per region (mirrored -> 2 total per call). */
function carveExitAlcoves(tiles, rand) {
  const regions = [
    [2, 12],
    [20, 29],
  ];
  for (const [r0, r1] of regions) {
    const candidates = [];
    // Keep away from the seam (col 13) so the mirrored pair reads as two
    // separate quadrant alcoves, not a pair huddled at the center.
    for (let row = r0; row <= r1; row++) {
      for (let col = 1; col <= 9; col++) {
        if (tiles[idx(col, row)] !== TILE_WALL) continue;
        if (inLairBox(col, row, 1)) continue;
        let openCount = 0;
        const neigh = [
          [col, row - 1],
          [col + 1, row],
          [col, row + 1],
          [col - 1, row],
        ];
        for (const [nc, nr] of neigh) {
          if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
          if (tiles[idx(nc, nr)] !== TILE_WALL) openCount++;
        }
        if (openCount === 1) candidates.push({ col, row });
      }
    }
    shuffle(candidates, rand);
    if (candidates.length) carve(tiles, candidates[0].col, candidates[0].row, TILE_EXIT);
  }
}

// ---------------------------------------------------------------------------
// Metadata derivation (shared by the generated path and the fallback path)
// ---------------------------------------------------------------------------

function scanTiles(tiles, value) {
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (tiles[idx(c, r)] === value) out.push({ col: c, row: r });
    }
  }
  return out;
}

function isAdvWalkableValue(t, allowExit) {
  return t === TILE_FLOOR || t === TILE_TUNNEL || (allowExit && t === TILE_EXIT);
}

/** Prefer plain floor/tunnel over an EXIT tile, so spawns don't land on a stairwell. */
function nearestAdvTile(tiles, col, row, maxR = 20) {
  for (let rad = 0; rad <= maxR; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
        if (isAdvWalkableValue(tiles[idx(c, r)], false)) return { col: c, row: r };
      }
    }
  }
  for (let rad = 0; rad <= maxR; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
        if (isAdvWalkableValue(tiles[idx(c, r)], true)) return { col: c, row: r };
      }
    }
  }
  return null;
}

function pickAdvSpawns(tiles) {
  const corners = [
    [1, 1],
    [COLS - 2, 1],
    [1, ROWS - 2],
    [COLS - 2, ROWS - 2],
  ];
  const out = [];
  for (const [cc, cr] of corners) {
    const t = nearestAdvTile(tiles, cc, cr);
    if (t && !out.some((o) => o.col === t.col && o.row === t.row)) out.push(t);
  }
  return out;
}

function pickItemSpots(tiles, lair) {
  const ccol = lair.col + lair.cols / 2;
  const crow = lair.row + lair.rows / 2;
  const floors = scanTiles(tiles, TILE_FLOOR);
  floors.sort((a, b) => {
    const da = (a.col - ccol) ** 2 + (a.row - crow) ** 2;
    const db = (b.col - ccol) ** 2 + (b.row - crow) ** 2;
    return db - da; // farthest from the lair first
  });
  const trySelect = (minSep) => {
    const chosen = [];
    for (const f of floors) {
      if (chosen.every((o) => Math.abs(o.col - f.col) + Math.abs(o.row - f.row) >= minSep)) {
        chosen.push(f);
      }
      if (chosen.length >= 14) break;
    }
    return chosen;
  };
  let sep = 6;
  let chosen = trySelect(sep);
  while (chosen.length < 8 && sep > 1) {
    sep -= 1;
    chosen = trySelect(sep);
  }
  return chosen;
}

function deriveMazeMeta(tiles, seed) {
  const lairTiles = scanTiles(tiles, TILE_LAIR).concat(scanTiles(tiles, TILE_LAIR_DOOR));
  let minC = COLS;
  let maxC = 0;
  let minR = ROWS;
  let maxR = 0;
  for (const t of lairTiles) {
    minC = Math.min(minC, t.col);
    maxC = Math.max(maxC, t.col);
    minR = Math.min(minR, t.row);
    maxR = Math.max(maxR, t.row);
  }
  const lair = { col: minC, row: minR, cols: maxC - minC + 1, rows: maxR - minR + 1 };

  const spawnCandidates = scanTiles(tiles, TILE_LAIR);
  const ccol = lair.col + lair.cols / 2;
  const crow = lair.row + lair.rows / 2;
  let spawn = spawnCandidates[0] || { col: lair.col + Math.floor(lair.cols / 2), row: lair.row + Math.floor(lair.rows / 2) };
  let bestD = Infinity;
  for (const t of spawnCandidates) {
    const d = (t.col - ccol) ** 2 + (t.row - crow) ** 2;
    if (d < bestD) {
      bestD = d;
      spawn = t;
    }
  }

  const exits = scanTiles(tiles, TILE_EXIT);

  const tunnelRows = [];
  for (let r = 0; r < ROWS; r++) {
    let full = true;
    for (let c = 0; c < COLS; c++) {
      if (tiles[idx(c, r)] !== TILE_TUNNEL) { full = false; break; }
    }
    if (full) tunnelRows.push(r);
  }

  const advSpawns = pickAdvSpawns(tiles);
  const itemSpots = pickItemSpots(tiles, lair);

  return { cols: COLS, rows: ROWS, tiles, lair, spawn, advSpawns, exits, tunnelRows, itemSpots, seed };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function floodFill(maze, startCol, startRow, who) {
  const visited = new Uint8Array(N);
  const stack = [idx(startCol, startRow)];
  visited[stack[0]] = 1;
  let count = 0;
  while (stack.length) {
    const cur = stack.pop();
    count++;
    const row = (cur / COLS) | 0;
    const col = cur % COLS;
    forEachNeighbor(col, row, (nc, nr) => {
      if (nr < 0 || nr >= ROWS) return;
      if (!isWalkable(maze, nc, nr, who)) return;
      const ni = idx(nc, nr);
      if (!visited[ni]) {
        visited[ni] = 1;
        stack.push(ni);
      }
    });
  }
  return count;
}

function validateMaze(maze) {
  const { tiles, spawn } = maze;
  if (!spawn) return false;

  let totalNonWall = 0;
  for (let i = 0; i < N; i++) if (tiles[i] !== TILE_WALL) totalNonWall++;
  if (floodFill(maze, spawn.col, spawn.row, 'cube') !== totalNonWall) return false;

  const doorTiles = [];
  for (let i = 0; i < N; i++) if (tiles[i] === TILE_LAIR_DOOR) doorTiles.push(i);
  if (doorTiles.length !== 1) return false;
  const doorRow = (doorTiles[0] / COLS) | 0;
  const doorCol = doorTiles[0] % COLS;

  let outside = null;
  forEachNeighbor(doorCol, doorRow, (nc, nr) => {
    if (outside || nr < 0 || nr >= ROWS) return;
    if (isWalkable(maze, nc, nr, 'adventurer')) outside = { col: nc, row: nr };
  });
  if (!outside) return false;

  let totalAdv = 0;
  for (let i = 0; i < N; i++) {
    const t = tiles[i];
    if (t !== TILE_WALL && t !== TILE_LAIR && t !== TILE_LAIR_DOOR) totalAdv++;
  }
  if (floodFill(maze, outside.col, outside.row, 'adventurer') !== totalAdv) return false;

  if (!maze.exits || maze.exits.length < 2 || maze.exits.length > 4) return false;
  if (!maze.advSpawns || maze.advSpawns.length < 4) return false;
  if (!maze.itemSpots || maze.itemSpots.length < 8) return false;
  if (!maze.tunnelRows || maze.tunnelRows.length < 1) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Generation entry points
// ---------------------------------------------------------------------------

function tryGenerate(trySeed, originalSeed) {
  const rand = mulberry32(trySeed);
  const tiles = new Uint8Array(N).fill(TILE_WALL);

  const { restEdges } = buildLattice(tiles, rand);
  ensureTunnelConnections(tiles, restEdges, rand);

  for (let c = 0; c < COLS; c++) tiles[idx(c, TUNNEL_ROW)] = TILE_TUNNEL;

  for (let r = LAIR.row; r < LAIR.row + LAIR.rows; r++) {
    for (let c = LAIR.col; c < LAIR.col + LAIR.cols; c++) tiles[idx(c, r)] = TILE_LAIR;
  }
  tiles[idx(DOOR_COL, DOOR_ROW)] = TILE_LAIR_DOOR;

  eliminateDeadEnds(tiles, rand);
  carveExitAlcoves(tiles, rand);

  const maze = deriveMazeMeta(tiles, originalSeed);
  return validateMaze(maze) ? maze : null;
}

const CHAR_TILE = {
  '#': TILE_WALL,
  '.': TILE_FLOOR,
  L: TILE_LAIR,
  D: TILE_LAIR_DOOR,
  T: TILE_TUNNEL,
  E: TILE_EXIT,
};

/**
 * Hand-validated fallback maze, baked as a string grid. Generated offline
 * with generateMaze's own algorithm at a known-good seed, then frozen here so
 * the safety net never depends on the algorithm at runtime. Re-verified by
 * scripts/verify-maze.mjs like any other maze.
 */
// prettier-ignore
const FALLBACK_TEMPLATE = [
  '############################',
  '#..........................#',
  '#.##.##.##.##..##.##.##.##.#',
  '#.##.##.##.##..##.##.##.##.#',
  '#..........................#',
  '#.##.##.#####..#####.##.##.#',
  '#.##.##.#E###..###E#.##.##.#',
  '#..........................#',
  '#.##.##.##.##..##.##.##.##.#',
  '#.##.##.##.##..##.##.##.##.#',
  '#..........................#',
  '#.##.##.##.##..##.##.##.##.#',
  '#.##.##.##.##..##.##.##.##.#',
  '#..........................#',
  '#.##.##.############.##.##.#',
  'TTTTTTTTTTTTTTTTTTTTTTTTTTTT',
  '#.......##LLLDLLLL##.......#',
  '#.##.##.##LLLLLLLL##.##.##.#',
  '#.##.##.##LLLLLLLL##.##.##.#',
  '#.......##LLLLLLLL##.......#',
  '#.##.##.############.##.##.#',
  '#.##.##.############.##.##.#',
  '#..........................#',
  '#.##.##.##.##..##.##.##.##.#',
  '#.##.##.##.##..##.##.##.##.#',
  '#....##..............##....#',
  '#.##.##.#####..#####.##.##.#',
  '#.##.##.#####..#####.##.##.#',
  '#..........................#',
  '#########E########E#########',
  '############################',
];

function buildFallback(seed) {
  const tiles = new Uint8Array(N);
  for (let r = 0; r < ROWS; r++) {
    const line = FALLBACK_TEMPLATE[r];
    for (let c = 0; c < COLS; c++) {
      tiles[idx(c, r)] = CHAR_TILE[line[c]] ?? TILE_WALL;
    }
  }
  return deriveMazeMeta(tiles, seed);
}

/** @returns {import('./grid.js').Maze} */
export function generateMaze(seed = Date.now()) {
  const baseSeed = seed >>> 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const trySeed = (baseSeed + attempt * 2654435761) >>> 0;
    const maze = tryGenerate(trySeed, baseSeed);
    if (maze) return maze;
  }
  return buildFallback(baseSeed);
}
