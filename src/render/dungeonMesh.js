/**
 * WS-B — stone dungeon: walls, flagstone floor, stairwells, lair, debris.
 *
 * Everything geometry-heavy is pre-merged at build time into a handful of
 * meshes/InstancedMeshes (never one mesh per tile) so the draw-call count
 * stays flat regardless of maze size.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TILE, WALL_HEIGHT, PALETTE, TILE_WALL, TILE_FLOOR, TILE_LAIR, TILE_LAIR_DOOR, TILE_EXIT } from '../config.js';
import { worldX, worldZ, idx, tileAt, forEachNeighbor } from '../maze/grid.js';

// Colors that don't have a PALETTE entry of their own.
const SLIME_STAIN_COLOR = 0x384a1e;
const SLIME_STAIN_GLOW = 0x0e1806;
const CURB_COLOR = 0x2c3320;
const BONE = 0xcfc7ae;
const BONE_DK = 0x9d9480;
const ROCK = 0x46424e;
const WOOD = 0x5b3d20;
const WOOD_DK = 0x3c2814;
const METAL = 0x8a8f9a;
const METAL_DK = 0x4a4d55;
const METAL_LT = 0xb9bec7;

const DEBRIS_DENSITY = 0.045; // ~4.5% of eligible floor tiles

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

/** Deterministic float in [0,1) from a seed plus any number of integer tags. */
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

function jitterColor(baseHex, amt, h) {
  const c = new THREE.Color(baseHex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const dl = (h - 0.5) * amt;
  return new THREE.Color().setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l + dl, 0, 1));
}

function cssColor(c) {
  const col = c instanceof THREE.Color ? c : new THREE.Color(c);
  return `#${col.getHexString()}`;
}

/** Fill every vertex of `geo` with one flat color. */
function paintUniform(geo, colorLike) {
  const c = colorLike instanceof THREE.Color ? colorLike : new THREE.Color(colorLike);
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/** Paint a BoxGeometry's +Y (top) face group one color and the rest another. */
function paintTopSide(geo, topColor, sideColor) {
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  const index = geo.index;
  for (const group of geo.groups) {
    const c = group.materialIndex === 2 ? topColor : sideColor; // 2 = +y face, see BoxGeometry source
    for (let i = group.start; i < group.start + group.count; i++) {
      const vi = index.getX(i);
      arr[vi * 3] = c.r;
      arr[vi * 3 + 1] = c.g;
      arr[vi * 3 + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

function mergeAndDispose(parts) {
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

// ---------------------------------------------------------------------------
// Walls — one merged mesh for every TILE_WALL block plus its mortar bed.
// ---------------------------------------------------------------------------

function buildWalls(group, maze, seed) {
  const parts = [];
  const inset = 0.9;
  const mortarH = 0.05;
  const blockYMin = 0.035;
  const blockH = WALL_HEIGHT - blockYMin;

  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      if (maze.tiles[idx(col, row)] !== TILE_WALL) continue;
      const x = worldX(col);
      const z = worldZ(row);

      const bed = new THREE.BoxGeometry(TILE, mortarH, TILE);
      paintUniform(bed, jitterColor(PALETTE.mortar, 0.1, hash01(seed, col, row, 1)));
      bed.translate(x, mortarH / 2, z);
      parts.push(bed);

      const block = new THREE.BoxGeometry(TILE * inset, blockH, TILE * inset);
      paintTopSide(
        block,
        jitterColor(PALETTE.wallTop, 0.14, hash01(seed, col, row, 2)),
        jitterColor(PALETTE.wallSide, 0.14, hash01(seed, col, row, 3))
      );
      block.translate(x, blockYMin + blockH / 2, z);
      parts.push(block);
    }
  }

  const merged = mergeAndDispose(parts);
  if (!merged) return;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.04 });
  const mesh = new THREE.Mesh(merged, mat);
  mesh.name = 'walls';
  group.add(mesh);
}

// ---------------------------------------------------------------------------
// Floor — one plane, procedural flagstone texture painted into a canvas.
// ---------------------------------------------------------------------------

function drawWrappedCircle(ctx, x, y, r, size) {
  const xs = [x];
  if (x - r < 0) xs.push(x + size);
  if (x + r > size) xs.push(x - size);
  const ys = [y];
  if (y - r < 0) ys.push(y + size);
  if (y + r > size) ys.push(y - size);
  for (const px of xs) {
    for (const py of ys) {
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawStone(ctx, x, y, w, h, color) {
  const r = Math.min(w, h) * 0.14;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

function createFlagstoneTexture(seed) {
  const size = 512;
  const gridN = 8; // stones across the texture (2 per world tile)
  const cell = size / gridN;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = cssColor(PALETTE.mortar);
  ctx.fillRect(0, 0, size, size);

  for (let gy = 0; gy < gridN; gy++) {
    for (let gx = 0; gx < gridN; gx++) {
      const altPick = hash01(seed, gx, gy, 42);
      const baseHex = altPick > 0.5 ? PALETTE.floor : PALETTE.floorAlt;
      const stone = jitterColor(baseHex, 0.18, hash01(seed, gx, gy, 41));
      const inset = 2 + hash01(seed, gx, gy, 43) * 2.5;
      const jx = (hash01(seed, gx, gy, 44) - 0.5) * 3;
      const jy = (hash01(seed, gx, gy, 45) - 0.5) * 3;
      drawStone(ctx, gx * cell + inset + jx, gy * cell + inset + jy, cell - inset * 2, cell - inset * 2, cssColor(stone));
    }
  }

  for (let i = 0; i < 260; i++) {
    const x = hash01(seed, i, 51) * size;
    const y = hash01(seed, i, 52) * size;
    const r = 0.6 + hash01(seed, i, 53) * 1.6;
    const a = 0.05 + hash01(seed, i, 54) * 0.09;
    ctx.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`;
    drawWrappedCircle(ctx, x, y, r, size);
  }
  for (let i = 0; i < 22; i++) {
    const x = hash01(seed, i, 61) * size;
    const y = hash01(seed, i, 62) * size;
    const r = 6 + hash01(seed, i, 63) * 14;
    const a = 0.04 + hash01(seed, i, 64) * 0.06;
    ctx.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`;
    drawWrappedCircle(ctx, x, y, r, size);
  }

  return canvas;
}

function buildFloor(group, maze, seed) {
  const canvas = createFlagstoneTexture(seed);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  const TILES_PER_TEX = 4;

  // Per-tile quads (merged into one draw call) rather than a single giant
  // plane: TILE_WALL tiles don't need a floor underneath, and TILE_EXIT
  // tiles must NOT get one — a continuous plane there would sit at y=0 and
  // fully hide the sunken stairwell built below it.
  const parts = [];
  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      const t = maze.tiles[idx(col, row)];
      if (t === TILE_WALL || t === TILE_EXIT) continue;
      const quad = new THREE.PlaneGeometry(TILE, TILE);
      quad.rotateX(-Math.PI / 2);
      const pos = quad.attributes.position;
      const uvArr = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uvArr[i * 2] = (col + 0.5 + pos.getX(i)) / TILES_PER_TEX;
        uvArr[i * 2 + 1] = (row + 0.5 + pos.getZ(i)) / TILES_PER_TEX;
      }
      quad.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
      quad.translate(worldX(col), 0, worldZ(row));
      parts.push(quad);
    }
  }

  const merged = mergeAndDispose(parts);
  if (!merged) return;
  const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.96, metalness: 0 });
  const mesh = new THREE.Mesh(merged, mat);
  mesh.name = 'floor';
  group.add(mesh);
}

// ---------------------------------------------------------------------------
// Tunnel rows — fade to darkness at the wrap edges.
// ---------------------------------------------------------------------------

function buildTunnelFade(group, maze) {
  if (!maze.tunnelRows || !maze.tunnelRows.length) return;
  const FADE_TILES = 4;
  const opacities = [0.85, 0.6, 0.35, 0.15];
  const bands = [[], [], [], []];

  for (const row of maze.tunnelRows) {
    for (let b = 0; b < FADE_TILES; b++) {
      for (const col of [b, maze.cols - 1 - b]) {
        const plane = new THREE.PlaneGeometry(TILE, TILE);
        plane.rotateX(-Math.PI / 2);
        plane.translate(worldX(col), 0.006, worldZ(row));
        bands[b].push(plane);
      }
    }
  }

  for (let b = 0; b < FADE_TILES; b++) {
    const merged = mergeAndDispose(bands[b]);
    if (!merged) continue;
    const mat = new THREE.MeshBasicMaterial({
      color: PALETTE.fog,
      transparent: true,
      opacity: opacities[b],
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = 'tunnelFade';
    group.add(mesh);
  }
}

// ---------------------------------------------------------------------------
// Lair — slime-stained pit, perimeter curb (gapped at the door), door glow.
// ---------------------------------------------------------------------------

function buildLair(group, maze, seed) {
  const { lair } = maze;
  if (!lair) return;

  const left = worldX(lair.col) - 0.5;
  const right = worldX(lair.col + lair.cols - 1) + 0.5;
  const top = worldZ(lair.row) - 0.5;
  const bottom = worldZ(lair.row + lair.rows - 1) + 0.5;

  const stainGeo = new THREE.PlaneGeometry(right - left, bottom - top);
  stainGeo.rotateX(-Math.PI / 2);
  stainGeo.translate((left + right) / 2, 0.012, (top + bottom) / 2);
  const stainMat = new THREE.MeshStandardMaterial({
    color: SLIME_STAIN_COLOR,
    transparent: true,
    opacity: 0.62,
    roughness: 1,
    emissive: SLIME_STAIN_GLOW,
    emissiveIntensity: 0.35,
  });
  const stainMesh = new THREE.Mesh(stainGeo, stainMat);
  stainMesh.name = 'lairStain';
  group.add(stainMesh);

  const curbH = 0.16;
  const curbT = 0.12;
  const curbParts = [];
  for (let row = lair.row; row < lair.row + lair.rows; row++) {
    for (let col = lair.col; col < lair.col + lair.cols; col++) {
      if (maze.tiles[idx(col, row)] !== TILE_LAIR) continue;
      forEachNeighbor(col, row, (nc, nr, dir) => {
        const nt = tileAt(maze, nc, nr);
        if (nt === TILE_LAIR || nt === TILE_LAIR_DOOR) return;
        const cx = worldX(col);
        const cz = worldZ(row);
        let box;
        if (dir === 0) {
          box = new THREE.BoxGeometry(TILE, curbH, curbT);
          box.translate(cx, curbH / 2, cz - 0.5);
        } else if (dir === 2) {
          box = new THREE.BoxGeometry(TILE, curbH, curbT);
          box.translate(cx, curbH / 2, cz + 0.5);
        } else if (dir === 1) {
          box = new THREE.BoxGeometry(curbT, curbH, TILE);
          box.translate(cx + 0.5, curbH / 2, cz);
        } else {
          box = new THREE.BoxGeometry(curbT, curbH, TILE);
          box.translate(cx - 0.5, curbH / 2, cz);
        }
        paintUniform(box, jitterColor(CURB_COLOR, 0.1, hash01(seed, col, row, dir + 20)));
        curbParts.push(box);
      });
    }
  }
  const curbMerged = mergeAndDispose(curbParts);
  if (curbMerged) {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    const mesh = new THREE.Mesh(curbMerged, mat);
    mesh.name = 'lairCurb';
    group.add(mesh);
  }

  const doorParts = [];
  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      if (maze.tiles[idx(col, row)] !== TILE_LAIR_DOOR) continue;
      const plane = new THREE.PlaneGeometry(0.92, 0.92);
      plane.rotateX(-Math.PI / 2);
      plane.translate(worldX(col), 0.02, worldZ(row));
      doorParts.push(plane);
    }
  }
  const doorMerged = mergeAndDispose(doorParts);
  if (doorMerged) {
    const mat = new THREE.MeshBasicMaterial({
      color: PALETTE.torch,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(doorMerged, mat);
    mesh.name = 'lairDoor';
    group.add(mesh);
  }
}

// ---------------------------------------------------------------------------
// Exits — sunken descending stairs with a cool glow at the bottom.
// ---------------------------------------------------------------------------

function buildExits(group, maze) {
  if (!maze.exits || !maze.exits.length) return;
  const STEP_COUNT = 4;
  const stepParts = [];
  const glowParts = [];
  const baseColor = new THREE.Color(PALETTE.wallSide);
  const exitColor = new THREE.Color(PALETTE.exit);

  for (const exit of maze.exits) {
    const cx = worldX(exit.col);
    const cz = worldZ(exit.row);
    for (let s = 0; s < STEP_COUNT; s++) {
      const t = s / (STEP_COUNT - 1);
      const size = THREE.MathUtils.lerp(0.98, 0.3, t);
      const stepH = 0.11;
      const y = -0.02 - t * 0.4;
      const box = new THREE.BoxGeometry(size, stepH, size);
      box.translate(cx, y - stepH / 2, cz);
      paintUniform(box, baseColor.clone().lerp(exitColor, 0.15 + t * 0.45));
      stepParts.push(box);
    }
    const glow = new THREE.CircleGeometry(0.42, 20);
    glow.rotateX(-Math.PI / 2);
    glow.translate(cx, -0.44, cz);
    glowParts.push(glow);
  }

  const stepsMerged = mergeAndDispose(stepParts);
  if (stepsMerged) {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
    const mesh = new THREE.Mesh(stepsMerged, mat);
    mesh.name = 'exitSteps';
    group.add(mesh);
  }

  const glowMerged = mergeAndDispose(glowParts);
  if (glowMerged) {
    const mat = new THREE.MeshBasicMaterial({
      color: PALETTE.exit,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(glowMerged, mat);
    mesh.name = 'exitGlow';
    group.add(mesh);
  }
}

// ---------------------------------------------------------------------------
// Debris — sparse, deterministic, instanced clutter.
// ---------------------------------------------------------------------------

function buildSkullGeometry() {
  const parts = [];
  const cranium = new THREE.SphereGeometry(0.12, 8, 6);
  cranium.translate(0, 0.12, 0.01);
  paintUniform(cranium, BONE);
  parts.push(cranium);
  const jaw = new THREE.BoxGeometry(0.13, 0.045, 0.09);
  jaw.translate(0, 0.045, 0.07);
  paintUniform(jaw, BONE_DK);
  parts.push(jaw);
  for (const sx of [-0.05, 0.05]) {
    const socket = new THREE.SphereGeometry(0.024, 6, 6);
    socket.translate(sx, 0.13, 0.1);
    paintUniform(socket, 0x0a0810);
    parts.push(socket);
  }
  return mergeAndDispose(parts);
}

function buildBonepileGeometry() {
  const parts = [];
  for (const a of [0.2, 1.6, 2.7]) {
    const bone = new THREE.CapsuleGeometry(0.018, 0.2, 2, 5);
    bone.rotateZ(Math.PI / 2);
    bone.rotateY(a);
    bone.translate(Math.cos(a) * 0.02, 0.02, Math.sin(a) * 0.02);
    paintUniform(bone, BONE);
    parts.push(bone);
  }
  return mergeAndDispose(parts);
}

function buildRubbleGeometry() {
  const parts = [];
  const specs = [
    [0, 0, 0.09],
    [0.1, 0.06, 0.075],
    [-0.09, 0.05, 0.065],
    [0.02, -0.1, 0.06],
  ];
  for (const [x, z, r] of specs) {
    const rock = new THREE.DodecahedronGeometry(r, 0);
    rock.translate(x, r * 0.55, z);
    paintUniform(rock, ROCK);
    parts.push(rock);
  }
  return mergeAndDispose(parts);
}

function buildBarrelGeometry() {
  const parts = [];
  const body = new THREE.CylinderGeometry(0.13, 0.15, 0.22, 10, 1, true);
  body.translate(0, 0.11, 0);
  paintUniform(body, WOOD);
  parts.push(body);
  for (let i = 0; i < 2; i++) {
    const stave = new THREE.BoxGeometry(0.03, 0.02, 0.24);
    stave.rotateY(i * 0.8 + 0.4);
    stave.translate(0.16 * (i ? 1 : -1), 0.01, 0.08 * (i ? -1 : 1));
    paintUniform(stave, WOOD_DK);
    parts.push(stave);
  }
  return mergeAndDispose(parts);
}

function buildShieldGeometry() {
  const parts = [];
  const disc = new THREE.CylinderGeometry(0.14, 0.14, 0.02, 12);
  paintUniform(disc, METAL);
  parts.push(disc);
  const crack = new THREE.BoxGeometry(0.018, 0.024, 0.24);
  crack.rotateY(0.35);
  paintUniform(crack, METAL_DK);
  parts.push(crack);
  const boss = new THREE.SphereGeometry(0.035, 6, 6);
  boss.translate(0, 0.02, 0);
  paintUniform(boss, METAL_LT);
  parts.push(boss);
  const geo = mergeAndDispose(parts);
  geo.rotateZ(0.1);
  return geo;
}

function buildDebris(group, maze, seed) {
  const templates = [
    buildSkullGeometry(),
    buildBonepileGeometry(),
    buildRubbleGeometry(),
    buildBarrelGeometry(),
    buildShieldGeometry(),
  ];
  const buckets = templates.map(() => []);

  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      if (maze.tiles[idx(col, row)] !== TILE_FLOOR) continue;
      const roll = hash01(seed, col, row, 201);
      if (roll >= DEBRIS_DENSITY) continue;
      const typeIdx = Math.min(templates.length - 1, Math.floor(hash01(seed, col, row, 202) * templates.length));
      buckets[typeIdx].push({ col, row });
    }
  }

  const dummy = new THREE.Object3D();
  templates.forEach((geo, typeIdx) => {
    const spots = buckets[typeIdx];
    if (!spots.length) {
      geo.dispose();
      return;
    }
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.05 });
    const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
    mesh.name = `debris${typeIdx}`;
    spots.forEach((spot, i) => {
      const { col, row } = spot;
      const ox = (hash01(seed, col, row, 203) - 0.5) * 0.32;
      const oz = (hash01(seed, col, row, 204) - 0.5) * 0.32;
      const rotY = hash01(seed, col, row, 205) * Math.PI * 2;
      const scale = 0.82 + hash01(seed, col, row, 206) * 0.4;
      dummy.position.set(worldX(col) + ox, 0, worldZ(row) + oz);
      dummy.rotation.set(0, rotY, 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildDungeon(scene, maze) {
  const group = new THREE.Group();
  group.name = 'dungeon';
  scene.add(group);

  const seed = (maze.seed >>> 0) || 1;

  buildFloor(group, maze, seed);
  buildTunnelFade(group, maze);
  buildLair(group, maze, seed);
  buildExits(group, maze);
  buildWalls(group, maze, seed);
  buildDebris(group, maze, seed);

  function dispose() {
    scene.remove(group);
    group.traverse((obj) => {
      if (!obj.isMesh && !obj.isInstancedMesh) return;
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.map) m.map.dispose();
        m.dispose();
      }
    });
  }

  return { group, dispose };
}
