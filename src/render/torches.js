/**
 * WS-B — wall sconces with layered-sine flicker.
 *
 * Cost is bounded on purpose: brackets are one static merged mesh, flames and
 * glow discs are each a single InstancedMesh (per-instance color/scale
 * updated in place, no per-frame allocation), and only a small pool of real
 * THREE.PointLights exists — reassigned each frame to whichever torches are
 * nearest `focus` (default the maze center). Every other torch fakes its
 * light with emissive color + the glow disc alone.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DIRS, PALETTE, TILE_WALL, TILE_FLOOR, TILE_TUNNEL, TILE_EXIT } from '../config.js';
import { worldX, worldZ, idx } from '../maze/grid.js';

const TARGET_COUNT = 11;
const MIN_COUNT = 8;
const MAX_COUNT = 14;
const LIGHT_POOL_SIZE = 6;
const MOUNT_Y = 0.6;
const OUTWARD = 0.47;

const FLAME_BASE = 0x7a2c08;
const FLAME_TIP = 0xffcf6a;
const BRACKET_COLOR = 0x1c1a20;
const BRACKET_COLOR_DARK = 0x110f14;

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

function angleForDir(dir) {
  const { dc, dr } = DIRS[dir];
  return Math.atan2(dc, dr);
}

function isCorridor(t) {
  return t === TILE_FLOOR || t === TILE_TUNNEL || t === TILE_EXIT;
}

/** Wall tiles with a corridor-facing side, deterministically thinned to a spread subset. */
function pickTorchSpots(maze, seed) {
  const candidates = [];
  for (let row = 0; row < maze.rows; row++) {
    for (let col = 0; col < maze.cols; col++) {
      if (maze.tiles[idx(col, row)] !== TILE_WALL) continue;
      for (let dir = 0; dir < DIRS.length; dir++) {
        const { dc, dr } = DIRS[dir];
        const nc = (((col + dc) % maze.cols) + maze.cols) % maze.cols;
        const nr = row + dr;
        if (nr < 0 || nr >= maze.rows) continue;
        if (!isCorridor(maze.tiles[idx(nc, nr)])) continue;
        candidates.push({ col, row, dir, score: hash01(seed, col, row, dir, 77) });
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score);

  let spacing = 6;
  let chosen = [];
  while (spacing >= 1) {
    chosen = [];
    for (const cand of candidates) {
      if (chosen.length >= MAX_COUNT) break;
      let ok = true;
      for (const c of chosen) {
        if (Math.abs(c.col - cand.col) + Math.abs(c.row - cand.row) < spacing) {
          ok = false;
          break;
        }
      }
      if (ok) chosen.push(cand);
    }
    if (chosen.length >= Math.min(MIN_COUNT, candidates.length) || spacing === 1) break;
    spacing--;
  }
  return chosen
    .slice(0, Math.max(chosen.length, Math.min(TARGET_COUNT, candidates.length)))
    .slice(0, MAX_COUNT);
}

function buildBracketParts(x, z, angle, parts) {
  const plate = new THREE.BoxGeometry(0.22, 0.3, 0.05);
  paintUniform(plate, BRACKET_COLOR_DARK);
  plate.rotateY(angle);
  plate.translate(x, MOUNT_Y, z);
  parts.push(plate);

  const arm = new THREE.BoxGeometry(0.05, 0.05, 0.24);
  arm.translate(0, 0, 0.12);
  paintUniform(arm, BRACKET_COLOR);
  arm.rotateY(angle);
  arm.translate(x, MOUNT_Y - 0.02, z);
  parts.push(arm);

  const bowl = new THREE.CylinderGeometry(0.09, 0.06, 0.09, 8, 1, true);
  bowl.translate(0, 0, 0.22);
  paintUniform(bowl, BRACKET_COLOR);
  bowl.rotateY(angle);
  bowl.translate(x, MOUNT_Y + 0.02, z);
  parts.push(bowl);
}

function buildFlameTemplate() {
  const parts = [];
  const base = new THREE.ConeGeometry(0.075, 0.16, 6);
  base.translate(0, 0.08, 0);
  paintUniform(base, FLAME_BASE);
  parts.push(base);
  const tip = new THREE.ConeGeometry(0.04, 0.12, 6);
  tip.translate(0, 0.19, 0);
  paintUniform(tip, FLAME_TIP);
  parts.push(tip);
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

export function buildTorches(scene, maze) {
  const group = new THREE.Group();
  group.name = 'torches';
  scene.add(group);

  const seed = maze.seed >>> 0 || 1;
  const spots = pickTorchSpots(maze, seed);

  const bracketParts = [];
  const torchData = [];
  for (const spot of spots) {
    const { dc, dr } = DIRS[spot.dir];
    const angle = angleForDir(spot.dir);
    const baseX = worldX(spot.col);
    const baseZ = worldZ(spot.row);
    const mountX = baseX + dc * OUTWARD;
    const mountZ = baseZ + dr * OUTWARD;
    buildBracketParts(baseX, baseZ, angle, bracketParts);
    torchData.push({
      pos: new THREE.Vector3(mountX, MOUNT_Y + 0.12, mountZ),
      phase: hash01(seed, spot.col, spot.row, spot.dir, 91) * Math.PI * 2,
      phase2: hash01(seed, spot.col, spot.row, spot.dir, 92) * Math.PI * 2,
    });
  }

  if (bracketParts.length) {
    const bracketGeo = mergeGeometries(bracketParts, false);
    for (const p of bracketParts) p.dispose();
    const bracketMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.7,
      metalness: 0.3,
    });
    const bracketMesh = new THREE.Mesh(bracketGeo, bracketMat);
    bracketMesh.name = 'torchBrackets';
    group.add(bracketMesh);
  }

  const count = torchData.length;
  const flameTemplate = buildFlameTemplate();
  const flameMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    emissive: new THREE.Color(PALETTE.torch),
    emissiveIntensity: 1.4,
    roughness: 0.5,
    toneMapped: false,
  });
  const flameMesh = count ? new THREE.InstancedMesh(flameTemplate, flameMat, count) : null;
  if (flameMesh) {
    flameMesh.name = 'torchFlames';
    flameMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    group.add(flameMesh);
  } else {
    flameTemplate.dispose();
  }

  const glowGeo = new THREE.CircleGeometry(0.42, 16);
  glowGeo.rotateX(-Math.PI / 2);
  const glowMat = new THREE.MeshBasicMaterial({
    color: PALETTE.torch,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexColors: false,
  });
  glowMat.opacity = 1;
  const glowMesh = count ? new THREE.InstancedMesh(glowGeo, glowMat, count) : null;
  if (glowMesh) {
    glowMesh.name = 'torchGlow';
    glowMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    group.add(glowMesh);
  } else {
    glowGeo.dispose();
  }

  const lightPool = [];
  const poolSize = Math.min(LIGHT_POOL_SIZE, count);
  for (let i = 0; i < poolSize; i++) {
    const light = new THREE.PointLight(PALETTE.torch, 0, 4.2, 2);
    light.visible = false;
    group.add(light);
    lightPool.push(light);
  }

  // Scratch buffers reused every frame — no per-frame allocation.
  const dummy = new THREE.Object3D();
  const flameColor = new THREE.Color();
  const glowColor = new THREE.Color();
  const baseTorchColor = new THREE.Color(PALETTE.torch);
  const distScratch = new Float32Array(count);
  const activeFlags = new Uint8Array(count);

  const focus = new THREE.Vector3(0, 0, 0);
  const api = {
    group,
    focus,
    update(dt, elapsed) {
      if (!count) return;

      for (let i = 0; i < count; i++) {
        const t = torchData[i];
        const flicker =
          0.78 +
          0.14 * Math.sin(elapsed * 6.6 + t.phase) +
          0.08 * Math.sin(elapsed * 13.1 + t.phase2);
        t.flicker = flicker;

        if (flameMesh) {
          const wobble = 0.92 + 0.1 * Math.sin(elapsed * 9.4 + t.phase2) + flicker * 0.06;
          dummy.position.set(t.pos.x, t.pos.y - 0.12, t.pos.z);
          dummy.rotation.set(0, t.phase, 0);
          dummy.scale.set(wobble, 0.85 + flicker * 0.3, wobble);
          dummy.updateMatrix();
          flameMesh.setMatrixAt(i, dummy.matrix);
          flameColor.setScalar(flicker);
          flameMesh.setColorAt(i, flameColor);
        }

        if (glowMesh) {
          const s = 0.85 + flicker * 0.35;
          dummy.position.set(t.pos.x, 0.012, t.pos.z);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(s, 1, s);
          dummy.updateMatrix();
          glowMesh.setMatrixAt(i, dummy.matrix);
          glowColor.copy(baseTorchColor).multiplyScalar(flicker * 0.8);
          glowMesh.setColorAt(i, glowColor);
        }

        const dx = t.pos.x - focus.x;
        const dz = t.pos.z - focus.z;
        distScratch[i] = dx * dx + dz * dz;
        activeFlags[i] = 0;
      }
      if (flameMesh) {
        flameMesh.instanceMatrix.needsUpdate = true;
        flameMesh.instanceColor.needsUpdate = true;
      }
      if (glowMesh) {
        glowMesh.instanceMatrix.needsUpdate = true;
        glowMesh.instanceColor.needsUpdate = true;
      }

      // Assign the pooled real lights to the `poolSize` nearest-to-focus torches.
      for (let k = 0; k < poolSize; k++) {
        let best = -1;
        let bestD = Infinity;
        for (let i = 0; i < count; i++) {
          if (activeFlags[i]) continue;
          if (distScratch[i] < bestD) {
            bestD = distScratch[i];
            best = i;
          }
        }
        if (best < 0) break;
        activeFlags[best] = 1;
        const light = lightPool[k];
        const t = torchData[best];
        light.visible = true;
        light.position.set(t.pos.x, t.pos.y, t.pos.z);
        light.intensity = 1.1 * t.flicker;
      }
    },
    dispose() {
      scene.remove(group);
      group.traverse((obj) => {
        if (!obj.isMesh && !obj.isInstancedMesh) return;
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m?.dispose();
      });
    },
  };
  return api;
}
