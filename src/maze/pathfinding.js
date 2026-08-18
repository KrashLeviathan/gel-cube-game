/**
 * Grid pathfinding — WS-A.
 *
 * BFS (unweighted) or a small binary-heap Dijkstra (when `opts.avoid` is
 * supplied) over the tile grid. Wrap-aware on the column axis via
 * `wrapCol`/`forEachNeighbor` from grid.js.
 *
 * Performance: this runs several times per second for up to 8 adventurers on
 * a 28x31 (868-tile) grid, so it must not allocate in the hot path. All
 * scratch state (visited stamps, parent pointers, BFS queue, heap arrays) is
 * preallocated at module scope and reused across calls via a generation
 * counter — no per-call `new` for anything except the small, unavoidably
 * variable-length outputs (`findPath`'s array, `distanceField`'s Int16Array,
 * both bounded and small).
 */
import { COLS, ROWS, DIRS, DIR_NONE } from '../config.js';
import { idx, wrapCol, isWalkable, forEachNeighbor } from './grid.js';

const N = COLS * ROWS;

// ---------------------------------------------------------------------------
// Preallocated scratch (module-level, generation-stamped)
// ---------------------------------------------------------------------------

let gen = 0;
const visitedGen = new Int32Array(N); // "has a tentative cost / been queued" stamp
const finalizedGen = new Int32Array(N); // Dijkstra: "settled" stamp
const cameFrom = new Int32Array(N);
const bestCost = new Float64Array(N);
const bfsQueue = new Int32Array(N);

// Binary min-heap for Dijkstra. Sized generously — lazy deletion means a
// node can be pushed more than once, but on an 868-tile grid this never gets
// close to blowing the buffer.
const HEAP_CAP = N * 4;
const heapNode = new Int32Array(HEAP_CAP);
const heapCost = new Float64Array(HEAP_CAP);

function heapPush(size, node, cost) {
  let i = size;
  heapNode[i] = node;
  heapCost[i] = cost;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapCost[p] <= heapCost[i]) break;
    const tn = heapNode[p]; heapNode[p] = heapNode[i]; heapNode[i] = tn;
    const tc = heapCost[p]; heapCost[p] = heapCost[i]; heapCost[i] = tc;
    i = p;
  }
  return size + 1;
}

function heapPop(size) {
  const node = heapNode[0];
  const cost = heapCost[0];
  size--;
  heapNode[0] = heapNode[size];
  heapCost[0] = heapCost[size];
  let i = 0;
  for (;;) {
    const l = 2 * i + 1;
    const r = 2 * i + 2;
    let smallest = i;
    if (l < size && heapCost[l] < heapCost[smallest]) smallest = l;
    if (r < size && heapCost[r] < heapCost[smallest]) smallest = r;
    if (smallest === i) break;
    const tn = heapNode[smallest]; heapNode[smallest] = heapNode[i]; heapNode[i] = tn;
    const tc = heapCost[smallest]; heapCost[smallest] = heapCost[i]; heapCost[i] = tc;
    i = smallest;
  }
  return { node, cost, size };
}

function stepCost(opts, col, row) {
  let c = 1;
  if (opts && opts.avoid) {
    const d = opts.avoid[idx(col, row)];
    const radius = opts.avoidRadius ?? 4;
    const penalty = opts.avoidCost ?? 5;
    if (d >= 0 && d < radius) c += penalty;
  }
  return c;
}

/**
 * Core search shared by stepToward/findPath. Returns {startIdx, foundIdx}
 * (foundIdx === -1 if unreachable). Fills the shared `cameFrom` buffer for
 * the *current* generation only — read it before calling search() again.
 */
function search(maze, startCol, startRow, isGoal, opts) {
  const who = (opts && opts.who) || 'adventurer';
  const weighted = !!(opts && opts.avoid);
  gen++;
  const startIdx = idx(startCol, startRow);

  if (isGoal(startCol, startRow)) return { startIdx, foundIdx: startIdx };

  if (!weighted) {
    let qh = 0;
    let qt = 0;
    bfsQueue[qt++] = startIdx;
    visitedGen[startIdx] = gen;
    cameFrom[startIdx] = -1;
    while (qh < qt) {
      const cur = bfsQueue[qh++];
      const row = (cur / COLS) | 0;
      const col = cur % COLS;
      let found = -1;
      forEachNeighbor(col, row, (nc, nr) => {
        if (found !== -1) return;
        if (!isWalkable(maze, nc, nr, who)) return;
        const ni = idx(nc, nr);
        if (visitedGen[ni] === gen) return;
        visitedGen[ni] = gen;
        cameFrom[ni] = cur;
        if (isGoal(nc, nr)) { found = ni; return; }
        bfsQueue[qt++] = ni;
      });
      if (found !== -1) return { startIdx, foundIdx: found };
    }
    return { startIdx, foundIdx: -1 };
  }

  // Dijkstra, lazy-deletion binary heap.
  let heapSize = 0;
  bestCost[startIdx] = 0;
  visitedGen[startIdx] = gen;
  cameFrom[startIdx] = -1;
  heapSize = heapPush(heapSize, startIdx, 0);
  while (heapSize > 0) {
    const popped = heapPop(heapSize);
    heapSize = popped.size;
    const cur = popped.node;
    if (finalizedGen[cur] === gen) continue;
    finalizedGen[cur] = gen;
    const row = (cur / COLS) | 0;
    const col = cur % COLS;
    if (isGoal(col, row)) return { startIdx, foundIdx: cur };
    forEachNeighbor(col, row, (nc, nr) => {
      if (!isWalkable(maze, nc, nr, who)) return;
      const ni = idx(nc, nr);
      if (finalizedGen[ni] === gen) return;
      const cost = popped.cost + stepCost(opts, nc, nr);
      if (visitedGen[ni] !== gen || cost < bestCost[ni]) {
        bestCost[ni] = cost;
        cameFrom[ni] = cur;
        visitedGen[ni] = gen;
        heapSize = heapPush(heapSize, ni, cost);
      }
    });
  }
  return { startIdx, foundIdx: -1 };
}

function firstStepDir(startIdx, foundIdx, startCol, startRow) {
  if (foundIdx === startIdx) return DIR_NONE;
  let cur = foundIdx;
  let prev = cameFrom[cur];
  while (prev !== startIdx) {
    cur = prev;
    prev = cameFrom[cur];
  }
  const row = (cur / COLS) | 0;
  const col = cur % COLS;
  for (let d = 0; d < 4; d++) {
    const nc = wrapCol(startCol + DIRS[d].dc);
    const nr = startRow + DIRS[d].dr;
    if (nc === col && nr === row) return d;
  }
  return DIR_NONE;
}

function reconstructPath(startIdx, foundIdx) {
  const path = [];
  let cur = foundIdx;
  while (cur !== startIdx && cur !== -1) {
    path.push({ col: cur % COLS, row: (cur / COLS) | 0 });
    cur = cameFrom[cur];
  }
  path.reverse();
  return path;
}

/**
 * First STEP direction (DIR_*) from start toward the nearest tile satisfying
 * isGoal(col,row), or DIR_NONE if unreachable or already there.
 * @param {import('./grid.js').Maze} maze
 * @param {(col:number,row:number)=>boolean} isGoal
 * @param {{who?:'cube'|'adventurer', avoid?:Int16Array, avoidRadius?:number, avoidCost?:number}} [opts]
 */
export function stepToward(maze, startCol, startRow, isGoal, opts) {
  const { startIdx, foundIdx } = search(maze, startCol, startRow, isGoal, opts);
  if (foundIdx === -1) return DIR_NONE;
  return firstStepDir(startIdx, foundIdx, startCol, startRow);
}

/** Full path as {col,row}[], start-exclusive. Empty array if unreachable or already there. */
export function findPath(maze, startCol, startRow, isGoal, opts) {
  const { startIdx, foundIdx } = search(maze, startCol, startRow, isGoal, opts);
  if (foundIdx === -1 || foundIdx === startIdx) return [];
  return reconstructPath(startIdx, foundIdx);
}

/** Path-distance field from (col,row) as Int16Array(COLS*ROWS), -1 = unreachable. */
export function distanceField(maze, col, row, opts) {
  const who = (opts && opts.who) || 'adventurer';
  const weighted = !!(opts && opts.avoid);
  const out = new Int16Array(N).fill(-1);
  gen++;
  const startIdx = idx(col, row);

  if (!weighted) {
    let qh = 0;
    let qt = 0;
    bfsQueue[qt++] = startIdx;
    visitedGen[startIdx] = gen;
    out[startIdx] = 0;
    while (qh < qt) {
      const cur = bfsQueue[qh++];
      const r = (cur / COLS) | 0;
      const c = cur % COLS;
      const d = out[cur];
      forEachNeighbor(c, r, (nc, nr) => {
        if (!isWalkable(maze, nc, nr, who)) return;
        const ni = idx(nc, nr);
        if (visitedGen[ni] === gen) return;
        visitedGen[ni] = gen;
        out[ni] = d + 1;
        bfsQueue[qt++] = ni;
      });
    }
    return out;
  }

  let heapSize = 0;
  bestCost[startIdx] = 0;
  visitedGen[startIdx] = gen;
  heapSize = heapPush(heapSize, startIdx, 0);
  while (heapSize > 0) {
    const popped = heapPop(heapSize);
    heapSize = popped.size;
    const cur = popped.node;
    if (finalizedGen[cur] === gen) continue;
    finalizedGen[cur] = gen;
    out[cur] = Math.round(popped.cost);
    const r = (cur / COLS) | 0;
    const c = cur % COLS;
    forEachNeighbor(c, r, (nc, nr) => {
      if (!isWalkable(maze, nc, nr, who)) return;
      const ni = idx(nc, nr);
      if (finalizedGen[ni] === gen) return;
      const cost = popped.cost + stepCost(opts, nc, nr);
      if (visitedGen[ni] !== gen || cost < bestCost[ni]) {
        bestCost[ni] = cost;
        visitedGen[ni] = gen;
        heapSize = heapPush(heapSize, ni, cost);
      }
    });
  }
  return out;
}
