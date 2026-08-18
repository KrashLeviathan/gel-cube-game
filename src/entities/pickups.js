/**
 * WS-E2 — coins and magic items. See docs/SPEC.md §5 for the Pickups
 * contract.
 *
 * Build model: `createPickups(scene, maze, itemCount)` is REBUILT FRESH each
 * level (dispose the old instance, call this again with the new maze), the
 * same pattern WS-B already established for `buildDungeon`/`buildTorches`.
 * Reason: every level (clear OR fail — see SPEC §4) regenerates the maze,
 * and a new maze generally has a different number of TILE_FLOOR tiles, so
 * the coin InstancedMesh's fixed capacity can't just be "reset" in place.
 * `reset()` is still implemented per the spec contract — it fully re-arms
 * the board (all coins + items back, no active spills) for the CURRENT
 * maze without rebuilding any mesh, which is cheap and useful for a
 * same-maze retry/debug path if the integrator ever wants one — but the
 * main level-transition flow should call `dispose()` + `createPickups()`.
 *
 * `items` element shape (contractual fields WS-E1/WS-F should rely on):
 *   { col, row, type, taken }
 * `type` is one of 'wand'|'orb'|'tome'|'potion'|'horn'. Each item object
 * also carries rendering-internal fields (group/mesh/mat/phase/...) used
 * only by this module — do not depend on those.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TILE_FLOOR } from '../config.js';
import { idx, worldX, worldZ, wrapCol, isWalkable, forEachNeighbor, tileDistance } from '../maze/grid.js';

const COIN_Y = 0.055;
const COIN_RADIUS = 0.16;
const COIN_HEIGHT = 0.055;

const SPILL_POOL_SIZE = 64;
const SPILL_ARC_HEIGHT = 0.55;

const ITEM_TYPES = ['wand', 'orb', 'tome', 'potion', 'horn'];
const ITEM_GLOW = {
  wand: 0xffe27a,
  orb: 0x7fd0ff,
  tome: 0xd8b23a,
  potion: 0xff5a7a,
  horn: 0xe8ddb8,
};
const ITEM_BOB_FREQ = 1.6;
const ITEM_BOB_AMP = 0.12;
const ITEM_SPIN_SPEED = 1.1;
const ITEM_PULSE_FREQ = 2.2;
const ITEM_TAKEN_TIME = 0.5;
const ITEM_TAKEN_SINK = 0.4;
const RING_RADIUS = 0.55;

// ---------------------------------------------------------------------------
// small local helpers (same pattern as dungeonMesh.js/torches.js)
// ---------------------------------------------------------------------------

function hash01(seed, ...vals) {
  let h = seed | 0;
  for (const v of vals) {
    h = Math.imul(h ^ (v | 0), 2654435761);
    h = (h ^ (h >>> 15)) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function paintUniform(geo, colorHex) {
  const c = new THREE.Color(colorHex);
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function mergeAndDispose(parts) {
  if (!parts.length) return new THREE.BufferGeometry();
  // Polyhedron-family geometries (Octahedron/...) are built non-indexed
  // while Box/Sphere/Cylinder/Cone/Torus are indexed; mergeGeometries
  // requires uniform indexed-ness across the whole list, so normalize
  // everything to non-indexed first (cheap at this triangle count, and
  // correctly carries the per-vertex color attribute along).
  const normalized = parts.map((g) => {
    if (!g.index) return g;
    const g2 = g.toNonIndexed();
    g.dispose();
    return g2;
  });
  const merged = mergeGeometries(normalized, false);
  for (const p of normalized) p.dispose();
  return merged;
}

// ---------------------------------------------------------------------------
// coin geometry
// ---------------------------------------------------------------------------

function buildCoinGeometry() {
  const geo = new THREE.CylinderGeometry(COIN_RADIUS, COIN_RADIUS, COIN_HEIGHT, 8);
  paintUniform(geo, 0xffcf4d);
  return geo;
}

// ---------------------------------------------------------------------------
// magic item geometry — 5 distinct chunky prop types.
// ---------------------------------------------------------------------------

function buildWandGeometry() {
  const parts = [];
  const shaft = new THREE.CylinderGeometry(0.035, 0.045, 0.5, 6);
  paintUniform(shaft, 0x6a4a2c);
  parts.push(shaft);
  const tip = new THREE.OctahedronGeometry(0.09, 0);
  tip.translate(0, 0.3, 0);
  paintUniform(tip, ITEM_GLOW.wand);
  parts.push(tip);
  return mergeAndDispose(parts);
}

function buildOrbGeometry() {
  const parts = [];
  const sphere = new THREE.SphereGeometry(0.18, 10, 8);
  paintUniform(sphere, ITEM_GLOW.orb);
  parts.push(sphere);
  const stand = new THREE.CylinderGeometry(0.05, 0.1, 0.12, 6);
  stand.translate(0, -0.2, 0);
  paintUniform(stand, 0x3a2f26);
  parts.push(stand);
  return mergeAndDispose(parts);
}

function buildTomeGeometry() {
  const parts = [];
  const book = new THREE.BoxGeometry(0.3, 0.08, 0.22);
  paintUniform(book, 0x8a2a2a);
  parts.push(book);
  const pages = new THREE.BoxGeometry(0.26, 0.05, 0.19);
  pages.translate(0, 0.06, 0);
  paintUniform(pages, 0xe8ddb8);
  parts.push(pages);
  const clasp = new THREE.BoxGeometry(0.04, 0.1, 0.04);
  clasp.translate(0.13, 0.02, 0);
  paintUniform(clasp, ITEM_GLOW.tome);
  parts.push(clasp);
  return mergeAndDispose(parts);
}

function buildPotionGeometry() {
  const parts = [];
  const bodyGeo = new THREE.SphereGeometry(0.14, 10, 8);
  bodyGeo.scale(1, 1.2, 1);
  paintUniform(bodyGeo, ITEM_GLOW.potion);
  parts.push(bodyGeo);
  const neck = new THREE.CylinderGeometry(0.05, 0.07, 0.14, 8);
  neck.translate(0, 0.2, 0);
  paintUniform(neck, 0x9fd8ff);
  parts.push(neck);
  const cork = new THREE.CylinderGeometry(0.045, 0.045, 0.06, 6);
  cork.translate(0, 0.28, 0);
  paintUniform(cork, 0x6a4a2c);
  parts.push(cork);
  return mergeAndDispose(parts);
}

function buildHornGeometry() {
  const parts = [];
  const horn = new THREE.ConeGeometry(0.1, 0.42, 8, 1, true);
  horn.rotateZ(Math.PI * 0.42);
  paintUniform(horn, ITEM_GLOW.horn);
  parts.push(horn);
  const rim = new THREE.TorusGeometry(0.1, 0.022, 6, 10);
  rim.rotateZ(Math.PI * 0.42);
  rim.translate(Math.sin(Math.PI * 0.42) * 0.18, Math.cos(Math.PI * 0.42) * 0.18, 0);
  paintUniform(rim, 0xd8b23a);
  parts.push(rim);
  return mergeAndDispose(parts);
}

const ITEM_GEO_BUILDERS = {
  wand: buildWandGeometry,
  orb: buildOrbGeometry,
  tome: buildTomeGeometry,
  potion: buildPotionGeometry,
  horn: buildHornGeometry,
};

function buildRingGeometry() {
  const geo = new THREE.RingGeometry(RING_RADIUS * 0.55, RING_RADIUS, 20);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

// ---------------------------------------------------------------------------
// greedy farthest-point selection over maze.itemSpots
// ---------------------------------------------------------------------------

function selectItemSpots(spots, count) {
  if (count <= 0 || !spots.length) return [];
  if (spots.length <= count) return spots.slice();

  const remaining = spots.slice();
  // deterministic seed: the spot farthest from the maze center.
  let cx = 0, cz = 0;
  for (const s of spots) { cx += s.col; cz += s.row; }
  cx /= spots.length;
  cz /= spots.length;
  let seedIdx = 0, seedDist = -1;
  for (let i = 0; i < remaining.length; i++) {
    const d = tileDistance(remaining[i].col, remaining[i].row, Math.round(cx), Math.round(cz));
    if (d > seedDist) { seedDist = d; seedIdx = i; }
  }
  const chosen = [remaining.splice(seedIdx, 1)[0]];

  while (chosen.length < count && remaining.length) {
    let bestIdx = -1, bestMinDist = -1;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      let minDist = Infinity;
      for (const c of chosen) {
        const d = tileDistance(cand.col, cand.row, c.col, c.row);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) { bestMinDist = minDist; bestIdx = i; }
    }
    chosen.push(remaining.splice(bestIdx, 1)[0]);
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// public factory
// ---------------------------------------------------------------------------

export function createPickups(scene, maze, itemCount) {
  const group = new THREE.Group();
  group.name = 'pickups';
  scene.add(group);

  const seed = (maze.seed >>> 0) || 1;
  const cols = maze.cols;
  const rows = maze.rows;
  const cellCount = cols * rows;

  // -- coins --------------------------------------------------------------
  const coinTiles = [];
  const tileToInstance = new Int32Array(cellCount).fill(-1);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (maze.tiles[idx(col, row)] !== TILE_FLOOR) continue;
      tileToInstance[idx(col, row)] = coinTiles.length;
      coinTiles.push({ col, row });
    }
  }
  const coinCount = coinTiles.length;
  const occ = new Uint8Array(cellCount);

  const coinGeo = buildCoinGeometry();
  const coinMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.75 });
  const coinMesh = coinCount ? new THREE.InstancedMesh(coinGeo, coinMat, coinCount) : null;
  if (coinMesh) {
    coinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    coinMesh.name = 'coins';
    group.add(coinMesh);
  }

  const coinRot = new Float32Array(coinCount);
  for (let i = 0; i < coinCount; i++) {
    coinRot[i] = hash01(seed, coinTiles[i].col, coinTiles[i].row, 301) * Math.PI * 2;
  }

  const _dummy = new THREE.Object3D();
  function setCoinTransform(instIdx, x, y, z, scale, rotY) {
    if (!coinMesh || instIdx < 0) return;
    _dummy.position.set(x, y, z);
    _dummy.rotation.set(0, rotY || 0, 0);
    _dummy.scale.setScalar(scale);
    _dummy.updateMatrix();
    coinMesh.setMatrixAt(instIdx, _dummy.matrix);
  }

  function coinRestPos(i) {
    const t = coinTiles[i];
    return { x: worldX(t.col), z: worldZ(t.row) };
  }

  function armAllCoins() {
    for (let i = 0; i < coinCount; i++) {
      const t = coinTiles[i];
      occ[idx(t.col, t.row)] = 1;
      setCoinTransform(i, worldX(t.col), COIN_Y, worldZ(t.row), 1, coinRot[i]);
    }
    if (coinMesh) coinMesh.instanceMatrix.needsUpdate = true;
  }
  armAllCoins();

  let coinsRemainingCount = coinCount;

  function hasCoinAt(col, row) {
    const c = wrapCol(col);
    if (row < 0 || row >= rows) return false;
    return occ[idx(c, row)] === 1;
  }

  function takeCoinAt(col, row) {
    const c = wrapCol(col);
    if (row < 0 || row >= rows) return false;
    const i = idx(c, row);
    if (!occ[i]) return false;
    occ[i] = 0;
    const instIdx = tileToInstance[i];
    setCoinTransform(instIdx, 0, -999, 0, 0, 0);
    if (coinMesh) coinMesh.instanceMatrix.needsUpdate = true;
    coinsRemainingCount--;
    api.coinsRemaining = coinsRemainingCount;
    return true;
  }

  // -- spill animation pool (pooled, fixed-size — no per-frame allocation) --
  const spillActive = new Uint8Array(SPILL_POOL_SIZE);
  const spillInst = new Int32Array(SPILL_POOL_SIZE);
  const spillTargetIdx = new Int32Array(SPILL_POOL_SIZE);
  const spillFromX = new Float32Array(SPILL_POOL_SIZE);
  const spillFromZ = new Float32Array(SPILL_POOL_SIZE);
  const spillToX = new Float32Array(SPILL_POOL_SIZE);
  const spillToZ = new Float32Array(SPILL_POOL_SIZE);
  const spillT = new Float32Array(SPILL_POOL_SIZE);
  const spillDur = new Float32Array(SPILL_POOL_SIZE);
  const spillRot = new Float32Array(SPILL_POOL_SIZE);
  let spillCursor = 0;

  function spawnSpillSlot(instIdx, targetIdx, fromX, fromZ, toX, toZ) {
    const k = spillCursor;
    spillCursor = (spillCursor + 1) % SPILL_POOL_SIZE;
    spillActive[k] = 1;
    spillInst[k] = instIdx;
    spillTargetIdx[k] = targetIdx;
    spillFromX[k] = fromX;
    spillFromZ[k] = fromZ;
    spillToX[k] = toX;
    spillToZ[k] = toZ;
    spillT[k] = 0;
    spillDur[k] = 0.5 + Math.random() * 0.35;
    spillRot[k] = Math.random() * Math.PI * 2;
  }

  function stepSpillSlot(k, dt) {
    // another take/reset may have already cleared this tile's coin —
    // bail out without stomping whatever state it's in now.
    if (!occ[spillTargetIdx[k]]) {
      spillActive[k] = 0;
      return;
    }
    spillT[k] += dt;
    const dur = spillDur[k];
    const t = Math.min(1, spillT[k] / dur);
    const x = THREE.MathUtils.lerp(spillFromX[k], spillToX[k], t);
    const z = THREE.MathUtils.lerp(spillFromZ[k], spillToZ[k], t);
    const arc = Math.max(0, Math.sin(Math.PI * Math.min(1, t * 1.15)));
    let y = COIN_Y + SPILL_ARC_HEIGHT * arc;
    if (t > 0.85) {
      const bt = (t - 0.85) / 0.15;
      y += Math.sin(bt * Math.PI) * 0.15 * (1 - bt);
    }
    setCoinTransform(spillInst[k], x, y, z, 1, spillRot[k]);
    if (t >= 1) {
      setCoinTransform(spillInst[k], spillToX[k], COIN_Y, spillToZ[k], 1, spillRot[k]);
      spillActive[k] = 0;
    }
  }

  function spill(col, row, count) {
    if (count <= 0 || !coinMesh) return;
    const fromX = worldX(col);
    const fromZ = worldZ(row);
    const visited = new Uint8Array(cellCount);
    visited[idx(wrapCol(col), Math.max(0, Math.min(rows - 1, row)))] = 1;
    const queue = [{ col: wrapCol(col), row }];
    let qi = 0;
    const targets = [];
    while (qi < queue.length && targets.length < count) {
      const cur = queue[qi++];
      forEachNeighbor(cur.col, cur.row, (nc, nr) => {
        if (nr < 0 || nr >= rows) return;
        const ni = idx(nc, nr);
        if (visited[ni]) return;
        visited[ni] = 1;
        if (!isWalkable(maze, nc, nr, 'adventurer')) return;
        queue.push({ col: nc, row: nr });
        if (tileToInstance[ni] >= 0 && !occ[ni] && targets.length < count) {
          targets.push({ col: nc, row: nr, i: ni });
        }
      });
    }
    for (const t of targets) {
      occ[t.i] = 1;
      coinsRemainingCount++;
      const instIdx = tileToInstance[t.i];
      setCoinTransform(instIdx, fromX, COIN_Y, fromZ, 1, coinRot[instIdx]);
      spawnSpillSlot(instIdx, t.i, fromX, fromZ, worldX(t.col), worldZ(t.row));
    }
    api.coinsRemaining = coinsRemainingCount;
    if (coinMesh) coinMesh.instanceMatrix.needsUpdate = true;
  }

  // -- magic items ----------------------------------------------------------
  const chosenSpots = selectItemSpots(maze.itemSpots || [], itemCount | 0);
  const items = chosenSpots.map((spot, i) => {
    const type = ITEM_TYPES[Math.floor(hash01(seed, spot.col, spot.row, 401) * ITEM_TYPES.length) % ITEM_TYPES.length];
    const propGeo = ITEM_GEO_BUILDERS[type]();
    const propMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.35,
      metalness: 0.4,
      transparent: true,
      emissive: new THREE.Color(ITEM_GLOW[type]),
      emissiveIntensity: 0.55,
    });
    const propMesh = new THREE.Mesh(propGeo, propMat);
    propMesh.position.y = 0.32;

    const ringGeo = buildRingGeometry();
    const ringMat = new THREE.MeshBasicMaterial({
      color: ITEM_GLOW[type],
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.position.y = 0.02;

    const itemGroup = new THREE.Group();
    itemGroup.position.set(worldX(spot.col), 0, worldZ(spot.row));
    itemGroup.add(propMesh, ringMesh);
    group.add(itemGroup);

    return {
      col: spot.col,
      row: spot.row,
      type,
      taken: false,
      // internal rendering state — not part of the documented contract:
      itemGroup,
      propMesh,
      propMat,
      ringMesh,
      ringMat,
      propGeo,
      ringGeo,
      phase: hash01(seed, spot.col, spot.row, 402) * Math.PI * 2,
      t: 0,
      taking: false,
      takenT: 0,
    };
  });

  function findItemAt(col, row) {
    for (const it of items) {
      if (!it.taken && it.col === col && it.row === row) return it;
    }
    return null;
  }

  function takeItemAt(col, row) {
    const it = findItemAt(col, row);
    if (!it) return null;
    it.taken = true;
    it.taking = true;
    it.takenT = 0;
    return it;
  }

  // -- per-frame animation --------------------------------------------------
  function update(dt) {
    for (let k = 0; k < SPILL_POOL_SIZE; k++) {
      if (spillActive[k]) stepSpillSlot(k, dt);
    }
    if (coinMesh) coinMesh.instanceMatrix.needsUpdate = true;

    for (const it of items) {
      if (it.taking) {
        it.takenT += dt;
        const t = Math.min(1, it.takenT / ITEM_TAKEN_TIME);
        const ease = t * t * (3 - 2 * t);
        it.itemGroup.position.y = -ITEM_TAKEN_SINK * ease;
        it.itemGroup.scale.setScalar(1 - ease);
        it.propMat.opacity = 1 - ease;
        it.ringMat.opacity = 0.5 * (1 - ease);
        if (t >= 1) {
          it.taking = false;
          it.itemGroup.visible = false;
        }
        continue;
      }
      if (it.taken) continue;
      it.t += dt;
      it.itemGroup.position.y = Math.sin(it.t * ITEM_BOB_FREQ + it.phase) * ITEM_BOB_AMP + ITEM_BOB_AMP;
      it.propMesh.rotation.y += dt * ITEM_SPIN_SPEED;
      const pulse = 0.6 + 0.4 * Math.sin(it.t * ITEM_PULSE_FREQ + it.phase);
      it.propMat.emissiveIntensity = 0.4 + 0.5 * pulse;
      it.ringMat.opacity = 0.35 + 0.25 * pulse;
      it.ringMesh.scale.setScalar(1 + 0.08 * pulse);
    }
  }

  function reset() {
    for (let k = 0; k < SPILL_POOL_SIZE; k++) spillActive[k] = 0;
    armAllCoins();
    coinsRemainingCount = coinCount;
    api.coinsRemaining = coinsRemainingCount;

    for (const it of items) {
      it.taken = false;
      it.taking = false;
      it.takenT = 0;
      it.t = 0;
      it.itemGroup.visible = true;
      it.itemGroup.position.set(worldX(it.col), 0, worldZ(it.row));
      it.itemGroup.scale.setScalar(1);
      it.propMat.opacity = 1;
      it.ringMat.opacity = 0.5;
    }
  }

  function dispose() {
    scene.remove(group);
    coinGeo.dispose();
    coinMat.dispose();
    for (const it of items) {
      it.propGeo.dispose();
      it.propMat.dispose();
      it.ringGeo.dispose();
      it.ringMat.dispose();
    }
  }

  const api = {
    coinsRemaining: coinsRemainingCount,
    hasCoinAt,
    takeCoinAt,
    items,
    takeItemAt,
    spill,
    update,
    reset,
    dispose,
    group,
  };
  return api;
}
