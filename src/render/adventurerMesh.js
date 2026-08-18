/**
 * WS-E2 — adventurer figures: chunky low-poly Pac-Men seen from ~12deg off
 * top-down. See docs/SPEC.md §5 for the AdventurerView contract.
 *
 * `update(dt, opts)` expects (all optional, sane defaults applied):
 *   {
 *     moving: boolean,             // is the adventurer currently translating
 *     state: string,               // one of the adventurer state-machine's
 *                                   // names, matched case-insensitively by
 *                                   // substring ('flee' / 'hunt') to drive
 *                                   // posture tells; anything else reads as
 *                                   // neutral collect/bank/idle behaviour.
 *     dir: number,                 // DIR_UP/RIGHT/DOWN/LEFT (config.js) or
 *                                   // DIR_NONE(-1)/undefined to hold facing.
 *     packFullness: number,        // 0..1, drives the loot-sack swell.
 *   }
 *
 * `group` (the returned view's root) is positioned by the CALLER every frame
 * (typically `view.group.position.set(x, 0, z)` from the Adventurer entity's
 * world x/z). This module never touches `group.position` or `group.rotation`
 * itself — all animation (bob, lean, sway, facing, dissolve) happens on an
 * internal child pivot, so callers are free to drive the group's transform
 * without fighting the animation system.
 *
 * Archetype materials are cached and refcounted at module scope (see
 * `acquireMaterials`/`releaseMaterials` and `acquireSack`/`releaseSack`) so
 * multiple concurrent adventurers of the same archetype share GPU state;
 * only geometry (a few hundred triangles, built fresh per call) is unique
 * per instance, which is what makes the flesh-fades-first / gear-lingers
 * dissolve timing possible without per-instance material clones (see the
 * `fade` vertex attribute + shader injection below).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DIRS, DIR_NONE, ADVENTURER_RADIUS } from '../config.js';

const R = ADVENTURER_RADIUS;

const DISSOLVE_TIME = 0.6;
const SINK_DEPTH = R * 1.3;
const TILT_MAX = 0.55;
const BOB_FREQ = 9;
const BOB_AMP = R * 0.22;
const PANIC_SWAY = 0.4;
const IDLE_SWAY = 0.09;
const HUNT_LEAN = 0.42;
const SACK_MIN = 0.35;
const SACK_MAX = 1.55;

// ---------------------------------------------------------------------------
// small local helpers (mirrors the pattern used in dungeonMesh.js/torches.js)
// ---------------------------------------------------------------------------

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
  // Polyhedron-family geometries (Dodecahedron/Octahedron/...) are built
  // non-indexed while Box/Sphere/Cylinder/Cone/Capsule are indexed;
  // mergeGeometries requires a uniform indexed-ness across the whole list,
  // so normalize everything to non-indexed first (cheap at this triangle
  // count, and correctly carries the per-vertex color attribute along).
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

/** A per-vertex opacity multiplier baked as a plain (non-instanced) geometry
 * attribute. Lives on the GEOMETRY (unique per adventurer instance), not the
 * material (shared per archetype), so each adventurer can fade independently
 * on a shared material. Mirrors the aAlpha technique in fx.js. */
function addFadeAttribute(geo) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n).fill(1);
  const attr = new THREE.BufferAttribute(arr, 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('fade', attr);
  return attr;
}

function withFadeShader(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `attribute float fade;\nvarying float vFade;\n#include <common>`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvFade = fade;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `varying float vFade;\n#include <common>`)
      .replace('#include <color_fragment>', `#include <color_fragment>\ndiffuseColor.a *= vFade;`);
  };
  material.needsUpdate = true;
  return material;
}

function smoothstep(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function shortestDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Matches torches.js's angleForDir: local +Z is "forward" for every part
 * builder below, so rotation.y = atan2(dc,dr) turns the model to face dir. */
function angleForDir(dir) {
  const { dc, dr } = DIRS[dir];
  return Math.atan2(dc, dr);
}

// ---------------------------------------------------------------------------
// archetype palettes
// ---------------------------------------------------------------------------

const ARCHETYPE_COLORS = {
  fighter: { body: 0x8a231d, bodyDk: 0x5c1712, gear: 0x9aa4ad, gearDk: 0x62696f, glow: 0xffb199 },
  rogue: { body: 0x1c4a2a, bodyDk: 0x102e19, gear: 0x7d8790, gearDk: 0x454c51, glow: 0x9dffb8 },
  wizard: { body: 0x5836ad, bodyDk: 0x38226e, gear: 0x6a4a2c, gearDk: 0x442f1c, glow: 0x9fd8ff },
  cleric: { body: 0xf0e8cf, bodyDk: 0xcfc19a, gear: 0xd8b23a, gearDk: 0xa88626, glow: 0xfff2b3 },
};

const SKIN = 0xd9b48f;

// ---------------------------------------------------------------------------
// per-archetype part builders — each returns { body:[geo...], gear:[geo...],
// glow:[geo...] }, already painted and positioned, ready to merge per group.
// "body" = torso/legs/head/headgear cloth+skin (fades first on dissolve).
// "gear" = held weapons/tools (lingers a moment longer on dissolve).
// "glow" = a small bright accent mesh (menace tell + dissolves with body).
// ---------------------------------------------------------------------------

function buildFighterParts(c) {
  const body = [];
  const gear = [];
  const glow = [];

  const legs = new THREE.CylinderGeometry(R * 0.34, R * 0.4, R * 0.5, 7);
  legs.translate(0, R * 0.25, 0);
  paintUniform(legs, c.bodyDk);
  body.push(legs);

  const torso = new THREE.BoxGeometry(R * 1.55, R * 0.85, R * 1.05);
  torso.translate(0, R * 0.85, 0);
  paintUniform(torso, c.body);
  body.push(torso);

  const head = new THREE.SphereGeometry(R * 0.4, 8, 6);
  head.translate(0, R * 1.42, 0);
  paintUniform(head, SKIN);
  body.push(head);

  const helm = new THREE.SphereGeometry(R * 0.46, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.6);
  helm.translate(0, R * 1.5, 0);
  paintUniform(helm, c.gear);
  body.push(helm);

  const shield = new THREE.CylinderGeometry(R * 0.65, R * 0.65, R * 0.1, 10);
  shield.translate(-R * 1.1, R * 0.85, 0);
  paintUniform(shield, c.gear);
  gear.push(shield);
  const boss = new THREE.SphereGeometry(R * 0.14, 6, 5);
  boss.translate(-R * 1.1, R * 0.85, R * 0.06);
  paintUniform(boss, c.gearDk);
  gear.push(boss);

  const blade = new THREE.BoxGeometry(R * 0.14, R * 0.9, R * 0.05);
  blade.translate(R * 1.05, R * 1.05, 0);
  paintUniform(blade, c.gear);
  gear.push(blade);
  const hilt = new THREE.BoxGeometry(R * 0.34, R * 0.1, R * 0.08);
  hilt.translate(R * 1.05, R * 0.62, 0);
  paintUniform(hilt, c.gearDk);
  gear.push(hilt);

  const rivet = new THREE.SphereGeometry(R * 0.07, 6, 5);
  rivet.translate(-R * 1.1, R * 0.85, R * 0.11);
  paintUniform(rivet, c.glow);
  glow.push(rivet);

  return { body, gear, glow };
}

function buildRogueParts(c) {
  const body = [];
  const gear = [];
  const glow = [];

  const legs = new THREE.CylinderGeometry(R * 0.22, R * 0.28, R * 0.55, 7);
  legs.translate(0, R * 0.28, 0);
  paintUniform(legs, c.bodyDk);
  body.push(legs);

  const torso = new THREE.CapsuleGeometry(R * 0.3, R * 0.5, 3, 6);
  torso.translate(0, R * 0.9, 0);
  paintUniform(torso, c.body);
  body.push(torso);

  // hood: apex points forward (+Z local) — reads as a dark arrowhead overhead.
  const hood = new THREE.ConeGeometry(R * 0.4, R * 0.62, 6);
  hood.rotateX(Math.PI * 0.5);
  hood.translate(0, R * 1.42, R * 0.18);
  paintUniform(hood, c.bodyDk);
  body.push(hood);
  const skull = new THREE.SphereGeometry(R * 0.3, 7, 5);
  skull.translate(0, R * 1.4, 0);
  paintUniform(skull, c.bodyDk);
  body.push(skull);

  for (const side of [-1, 1]) {
    const dagger = new THREE.ConeGeometry(R * 0.07, R * 0.4, 4);
    dagger.rotateX(Math.PI * 0.5);
    dagger.translate(side * R * 0.55, R * 0.55, R * 0.3);
    paintUniform(dagger, c.gear);
    gear.push(dagger);
  }

  const eyeGlow = new THREE.SphereGeometry(R * 0.055, 5, 4);
  eyeGlow.translate(0, R * 1.42, R * 0.34);
  paintUniform(eyeGlow, c.glow);
  glow.push(eyeGlow);

  return { body, gear, glow };
}

function buildWizardParts(c) {
  const body = [];
  const gear = [];
  const glow = [];

  const robe = new THREE.ConeGeometry(R * 0.62, R * 1.1, 9);
  robe.translate(0, R * 0.55, 0);
  paintUniform(robe, c.body);
  body.push(robe);

  // pointed hat — the archetype's overhead signature.
  const hat = new THREE.ConeGeometry(R * 0.42, R * 0.85, 7);
  hat.translate(0, R * 1.55, 0);
  paintUniform(hat, c.bodyDk);
  body.push(hat);
  const brim = new THREE.CylinderGeometry(R * 0.5, R * 0.5, R * 0.06, 9);
  brim.translate(0, R * 1.18, 0);
  paintUniform(brim, c.bodyDk);
  body.push(brim);

  const staff = new THREE.CylinderGeometry(R * 0.05, R * 0.06, R * 1.3, 5);
  staff.translate(R * 0.85, R * 0.7, 0);
  paintUniform(staff, c.gear);
  gear.push(staff);

  const orb = new THREE.SphereGeometry(R * 0.16, 7, 6);
  orb.translate(R * 0.85, R * 1.4, 0);
  paintUniform(orb, c.glow);
  glow.push(orb);

  return { body, gear, glow };
}

function buildClericParts(c) {
  const body = [];
  const gear = [];
  const glow = [];

  const legs = new THREE.CylinderGeometry(R * 0.35, R * 0.42, R * 0.5, 7);
  legs.translate(0, R * 0.25, 0);
  paintUniform(legs, c.bodyDk);
  body.push(legs);

  const robe = new THREE.CylinderGeometry(R * 0.42, R * 0.55, R * 0.85, 9);
  robe.translate(0, R * 0.85, 0);
  paintUniform(robe, c.body);
  body.push(robe);

  const helm = new THREE.SphereGeometry(R * 0.44, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.58);
  helm.translate(0, R * 1.48, 0);
  paintUniform(helm, c.gear);
  body.push(helm);

  const maceHandle = new THREE.CylinderGeometry(R * 0.05, R * 0.05, R * 0.7, 5);
  maceHandle.rotateZ(Math.PI * 0.12);
  maceHandle.translate(R * 0.95, R * 0.75, 0);
  paintUniform(maceHandle, c.gearDk);
  gear.push(maceHandle);
  const maceHead = new THREE.DodecahedronGeometry(R * 0.18, 0);
  maceHead.translate(R * 1.08, R * 1.12, 0);
  paintUniform(maceHead, c.gear);
  gear.push(maceHead);

  const symbol = new THREE.OctahedronGeometry(R * 0.17, 0);
  symbol.scale(1, 1, 0.35);
  symbol.translate(0, R * 0.95, R * 0.44);
  paintUniform(symbol, c.glow);
  glow.push(symbol);

  return { body, gear, glow };
}

const ARCHETYPE_BUILDERS = {
  fighter: buildFighterParts,
  rogue: buildRogueParts,
  wizard: buildWizardParts,
  cleric: buildClericParts,
};

// ---------------------------------------------------------------------------
// shared, refcounted material cache — reused across every adventurer of the
// same archetype, and across level regenerations if AdventurerViews are
// pooled by the integrator.
// ---------------------------------------------------------------------------

const materialCache = new Map();

function acquireMaterials(archetype) {
  let entry = materialCache.get(archetype);
  if (!entry) {
    const bodyMat = withFadeShader(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05, transparent: true })
    );
    const gearMat = withFadeShader(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.6, transparent: true })
    );
    const c = ARCHETYPE_COLORS[archetype] || ARCHETYPE_COLORS.fighter;
    const glowMat = new THREE.MeshBasicMaterial({ color: c.glow, transparent: true, toneMapped: false });
    entry = { bodyMat, gearMat, glowMat, refCount: 0 };
    materialCache.set(archetype, entry);
  }
  entry.refCount++;
  return entry;
}

function releaseMaterials(archetype) {
  const entry = materialCache.get(archetype);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.bodyMat.dispose();
    entry.gearMat.dispose();
    entry.glowMat.dispose();
    materialCache.delete(archetype);
  }
}

let sackShared = null;
function acquireSack() {
  if (!sackShared) {
    sackShared = {
      mat: new THREE.MeshStandardMaterial({ color: 0x5b3d24, roughness: 0.85, metalness: 0.05 }),
      shineMat: new THREE.MeshBasicMaterial({ color: 0xffd766, transparent: true, toneMapped: false }),
      refCount: 0,
    };
  }
  sackShared.refCount++;
  return sackShared;
}

function releaseSack() {
  if (!sackShared) return;
  sackShared.refCount--;
  if (sackShared.refCount <= 0) {
    sackShared.mat.dispose();
    sackShared.shineMat.dispose();
    sackShared = null;
  }
}

// ---------------------------------------------------------------------------
// public factory
// ---------------------------------------------------------------------------

export function buildAdventurerMesh(scene, archetype) {
  const type = ARCHETYPE_BUILDERS[archetype] ? archetype : 'fighter';
  const mats = acquireMaterials(type);
  const sack = acquireSack();

  const group = new THREE.Group();
  group.name = `adventurer:${type}`;
  scene.add(group);

  // All animation lives on this child pivot — `group` itself is left alone
  // for the caller to position every frame.
  const pivot = new THREE.Group();
  group.add(pivot);

  const built = ARCHETYPE_BUILDERS[type](ARCHETYPE_COLORS[type]);
  const bodyGeo = mergeAndDispose(built.body);
  const gearGeo = mergeAndDispose(built.gear);
  const glowGeo = built.glow.length ? mergeAndDispose(built.glow) : null;

  const bodyFadeAttr = addFadeAttribute(bodyGeo);
  const gearFadeAttr = addFadeAttribute(gearGeo);

  const bodyMesh = new THREE.Mesh(bodyGeo, mats.bodyMat);
  const gearMesh = new THREE.Mesh(gearGeo, mats.gearMat);
  pivot.add(bodyMesh, gearMesh);

  let glowMesh = null;
  if (glowGeo) {
    glowMesh = new THREE.Mesh(glowGeo, mats.glowMat);
    pivot.add(glowMesh);
  }

  // loot sack, worn on the back (-Z local, i.e. trailing the facing dir).
  const sackGeo = new THREE.SphereGeometry(R * 0.3, 7, 6);
  const sackMesh = new THREE.Mesh(sackGeo, sack.mat);
  sackMesh.position.set(0, R * 0.85, -R * 0.78);
  sackMesh.scale.setScalar(SACK_MIN);
  pivot.add(sackMesh);

  const shineGeo = new THREE.OctahedronGeometry(R * 0.14, 0);
  const shineMesh = new THREE.Mesh(shineGeo, sack.shineMat);
  shineMesh.position.set(0, R * 1.1, -R * 0.78);
  shineMesh.visible = false;
  pivot.add(shineMesh);

  const s = {
    t: 0,
    walkPhase: 0,
    facing: 0,
    swayZ: 0,
    leanX: 0,
    dissolving: false,
    dissolved: false,
    dissolveT: 0,
  };

  function stepDissolve(dt) {
    s.dissolveT += dt;
    const t = Math.min(1, s.dissolveT / DISSOLVE_TIME);

    const bodyFrac = 1 - smoothstep(0, 0.55, t);
    const gearFrac = 1 - smoothstep(0.35, 1, t);
    bodyFadeAttr.array.fill(bodyFrac);
    bodyFadeAttr.needsUpdate = true;
    gearFadeAttr.array.fill(gearFrac);
    gearFadeAttr.needsUpdate = true;

    const ease = smoothstep(0, 1, t);
    pivot.position.y = -SINK_DEPTH * ease;
    const scale = THREE.MathUtils.lerp(1, 0.12, ease);
    pivot.scale.setScalar(scale);
    pivot.rotation.z = THREE.MathUtils.lerp(s.swayZ, TILT_MAX, ease);
    pivot.rotation.x = THREE.MathUtils.lerp(s.leanX, TILT_MAX * 0.6, ease);

    if (t >= 1) {
      s.dissolving = false;
      s.dissolved = true;
      group.visible = false;
    }
  }

  function update(dt, opts = {}) {
    s.t += dt;
    if (s.dissolving) {
      stepDissolve(dt);
      return;
    }
    if (s.dissolved) return;

    const moving = !!opts.moving;
    const stateStr = String(opts.state || '').toLowerCase();
    const fleeing = stateStr.includes('flee');
    const hunting = stateStr.includes('hunt');
    const dir = opts.dir;
    const packFullness = THREE.MathUtils.clamp(opts.packFullness ?? 0, 0, 1);

    if (dir !== undefined && dir !== null && dir !== DIR_NONE && DIRS[dir]) {
      const target = angleForDir(dir);
      s.facing += shortestDelta(s.facing, target) * Math.min(1, dt * 12);
    }
    pivot.rotation.y = s.facing;

    let speedMult = 1;
    if (hunting) speedMult = 1.55;
    else if (fleeing) speedMult = 1.35;
    if (moving) s.walkPhase += dt * BOB_FREQ * speedMult;

    const bobAmp = moving ? BOB_AMP : BOB_AMP * 0.18;
    const bobRate = moving ? 1 : 0.35;
    const idleBreath = moving ? 0 : Math.sin(s.t * 1.6) * BOB_AMP * 0.1;
    pivot.position.y = Math.abs(Math.sin(s.walkPhase)) * bobAmp * bobRate + idleBreath;

    const swayTarget = fleeing ? Math.sin(s.walkPhase * 1.7) * PANIC_SWAY : Math.sin(s.walkPhase) * IDLE_SWAY;
    s.swayZ += (swayTarget - s.swayZ) * Math.min(1, dt * 8);
    pivot.rotation.z = s.swayZ;

    const leanTarget = hunting ? HUNT_LEAN : 0;
    s.leanX += (leanTarget - s.leanX) * Math.min(1, dt * 6);
    pivot.rotation.x = s.leanX;

    pivot.scale.setScalar(1);

    const sackScale = THREE.MathUtils.lerp(SACK_MIN, SACK_MAX, Math.pow(packFullness, 0.75));
    sackMesh.scale.setScalar(sackScale);
    const shineT = THREE.MathUtils.clamp((packFullness - 0.5) / 0.5, 0, 1);
    shineMesh.visible = shineT > 0.01;
    if (shineMesh.visible) {
      const pulse = 0.7 + 0.3 * Math.sin(s.t * 7);
      shineMesh.scale.setScalar(shineT * pulse);
      shineMesh.position.y = R * 1.1 + sackScale * R * 0.12;
    }

    if (glowMesh) {
      const base = hunting ? 1.5 : 1;
      glowMesh.scale.setScalar(base * (1 + 0.18 * Math.sin(s.t * 4 + 1.7)));
    }
  }

  function playDissolve() {
    if (s.dissolving || s.dissolved) return;
    s.dissolving = true;
    s.dissolveT = 0;
  }

  function reset() {
    s.dissolving = false;
    s.dissolved = false;
    s.dissolveT = 0;
    s.t = 0;
    s.walkPhase = 0;
    s.facing = 0;
    s.swayZ = 0;
    s.leanX = 0;
    group.visible = true;
    pivot.position.set(0, 0, 0);
    pivot.rotation.set(0, 0, 0);
    pivot.scale.setScalar(1);
    bodyFadeAttr.array.fill(1);
    bodyFadeAttr.needsUpdate = true;
    gearFadeAttr.array.fill(1);
    gearFadeAttr.needsUpdate = true;
    sackMesh.scale.setScalar(SACK_MIN);
    shineMesh.visible = false;
    if (glowMesh) glowMesh.scale.setScalar(1);
  }

  function dispose() {
    scene.remove(group);
    bodyGeo.dispose();
    gearGeo.dispose();
    if (glowGeo) glowGeo.dispose();
    sackGeo.dispose();
    shineGeo.dispose();
    releaseMaterials(type);
    releaseSack();
  }

  return { group, update, playDissolve, reset, dispose };
}
