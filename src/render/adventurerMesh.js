/**
 * WS-E2 — adventurer figures: chunky low-poly Pac-Men seen from ~12deg off
 * top-down. See docs/SPEC.md §5 for the AdventurerView contract.
 *
 * `buildAdventurerMesh(scene, archetype, opts)` — opts (both optional):
 *   {
 *     colorTier: 'baseline'|'bright',  // difficulty-driven palette; see
 *                                       // levelParams().advColorTier. Rogue's
 *                                       // 'bright' tier is a hue swap (slate
 *                                       // grey), not just a lightness lift.
 *     haloMode: 'none'|'flash'|'persist', // see levelParams().haloMode. The
 *                                       // ground halo flashes 3x at
 *                                       // construction (= level start, since
 *                                       // levels.js always builds a fresh
 *                                       // view rather than reusing one) then
 *                                       // either hides or stays lit.
 *   }
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
 *     spotted: boolean,            // adv.spotted from adventurer.js — a rising
 *                                   // edge (false->true) pops the overhead "!"
 *                                   // notice tell. Purely edge-triggered: no
 *                                   // re-fire while sight is held, no cooldown
 *                                   // needed since losing sight re-arms it.
 *   }
 *
 * `group` (the returned view's root) is positioned by the CALLER every frame
 * (typically `view.group.position.set(x, 0, z)` from the Adventurer entity's
 * world x/z). This module never touches `group.position` or `group.rotation`
 * itself — all animation (bob, lean, sway, facing, dissolve) happens on an
 * internal child pivot, so callers are free to drive the group's transform
 * without fighting the animation system. The halo and notice sprite are
 * children of `group` directly (not the pivot) — see their construction below
 * for why.
 *
 * Archetype materials are cached and refcounted at module scope, keyed by
 * `${archetype}:${colorTier}` (see `acquireMaterials`/`releaseMaterials`),
 * same for the sack/halo/notice-icon shared geometry+texture (see
 * `acquireSack`/`acquireHalo`/`acquireNoticeTexture` and their `release*`
 * counterparts) — multiple concurrent adventurers share all of that GPU
 * state; only geometry (a few hundred triangles, built fresh per call) is
 * unique per instance, which is what makes the flesh-fades-first /
 * gear-lingers dissolve timing possible without per-instance material clones
 * (see the `fade` vertex attribute + shader injection below).
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
// Bumped up from the original 0.35 / 1.55 — playtest feedback was that a
// lightly-loaded pack read as a barely-there bump and a full one wasn't
// dramatic enough at gameplay zoom. See the adventurer legibility study.
const SACK_MIN = 0.6;
const SACK_MAX = 2.2;

// Overhead "notice" tell — pops when adv.spotted (see adventurer.js's
// losDistance/NOTICE_SIGHT_RADIUS check) flips false->true. Offset north
// (-Z, unrotated — screen "up" in the near-top-down camera regardless of
// which way the adventurer is facing) as well as up: a purely vertical
// offset visually collapses into the character's own silhouette from
// top-down and was unreadable in the legibility study.
const NOTICE_SIZE = R * 1.1;
const NOTICE_OFFSET_Y = R * 2.3;
const NOTICE_OFFSET_Z = -R * 1.5;
const NOTICE_POP_TIME = 0.16;
const NOTICE_HOLD_TIME = 0.55;
const NOTICE_TOTAL_TIME = 0.9;

// Ground halo — flashes at level start (haloMode !== 'none'), then either
// persists (Novice) or hides (Veteran); see buildLevel()/levelParams().
const HALO_RADIUS = R * 2.1;
const HALO_FLASH_TIME = 1.5;
const HALO_FLASH_PULSES = 3;
const HALO_FLASH_PEAK = 0.85;
const HALO_PERSIST_OPACITY = 0.5;

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
      .replace(
        '#include <common>',
        `attribute float fade;\nvarying float vFade;\n#include <common>`,
      )
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

const ARCHETYPE_COLORS_BASELINE = {
  fighter: { body: 0x8a231d, bodyDk: 0x5c1712, gear: 0x9aa4ad, gearDk: 0x62696f, glow: 0xffb199 },
  rogue: { body: 0x1c4a2a, bodyDk: 0x102e19, gear: 0x7d8790, gearDk: 0x454c51, glow: 0x9dffb8 },
  wizard: { body: 0x5836ad, bodyDk: 0x38226e, gear: 0x6a4a2c, gearDk: 0x442f1c, glow: 0x9fd8ff },
  cleric: { body: 0xf0e8cf, bodyDk: 0xcfc19a, gear: 0xd8b23a, gearDk: 0xa88626, glow: 0xfff2b3 },
};

// Novice difficulty's friendlier palette: lifted lightness/saturation on
// fighter/wizard/cleric. Rogue is a deliberate hue swap rather than a lift —
// slate grey instead of green, with a cool pale glow to match — not a
// brightness tweak, per direct art-direction call.
const ARCHETYPE_COLORS_BRIGHT = {
  fighter: { body: 0xc1271e, bodyDk: 0x921d15, gear: 0xb6c0c9, gearDk: 0x778692, glow: 0xffb199 },
  rogue: { body: 0x5c646e, bodyDk: 0x3d434a, gear: 0x9299a1, gearDk: 0x5d6369, glow: 0xcfeaff },
  wizard: { body: 0x7049d2, bodyDk: 0x4a27a1, gear: 0x986536, gearDk: 0x704a28, glow: 0x9fd8ff },
  cleric: { body: 0xf5f0de, bodyDk: 0xddd1b0, gear: 0xe5c256, gearDk: 0xd1a426, glow: 0xfff2b3 },
};

const ARCHETYPE_COLOR_TIERS = {
  baseline: ARCHETYPE_COLORS_BASELINE,
  bright: ARCHETYPE_COLORS_BRIGHT,
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

function acquireMaterials(archetype, tier) {
  const key = `${archetype}:${tier}`;
  let entry = materialCache.get(key);
  if (!entry) {
    const bodyMat = withFadeShader(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.85,
        metalness: 0.05,
        transparent: true,
      }),
    );
    const gearMat = withFadeShader(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.4,
        metalness: 0.6,
        transparent: true,
      }),
    );
    const palette = ARCHETYPE_COLOR_TIERS[tier] || ARCHETYPE_COLORS_BASELINE;
    const c = palette[archetype] || palette.fighter;
    const glowMat = new THREE.MeshBasicMaterial({
      color: c.glow,
      transparent: true,
      toneMapped: false,
    });
    entry = { bodyMat, gearMat, glowMat, refCount: 0 };
    materialCache.set(key, entry);
  }
  entry.refCount++;
  return entry;
}

function releaseMaterials(archetype, tier) {
  const key = `${archetype}:${tier}`;
  const entry = materialCache.get(key);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.bodyMat.dispose();
    entry.gearMat.dispose();
    entry.glowMat.dispose();
    materialCache.delete(key);
  }
}

let sackShared = null;
function acquireSack() {
  if (!sackShared) {
    sackShared = {
      mat: new THREE.MeshStandardMaterial({ color: 0x5b3d24, roughness: 0.85, metalness: 0.05 }),
      shineMat: new THREE.MeshBasicMaterial({
        color: 0xffd766,
        transparent: true,
        toneMapped: false,
      }),
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

/** Soft radial-gradient disc — opaque-ish center fading to nothing at the
 *  rim, drawn once into a canvas and reused as every halo's alpha map. */
function createHaloTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

let haloShared = null;
function acquireHalo() {
  if (!haloShared) {
    const geo = new THREE.CircleGeometry(HALO_RADIUS, 32);
    geo.rotateX(-Math.PI / 2);
    haloShared = { geo, texture: createHaloTexture(), refCount: 0 };
  }
  haloShared.refCount++;
  return haloShared;
}

function releaseHalo() {
  if (!haloShared) return;
  haloShared.refCount--;
  if (haloShared.refCount <= 0) {
    haloShared.geo.dispose();
    haloShared.texture.dispose();
    haloShared = null;
  }
}

/** A stubby capsule + dot "!" — the only overhead-notice shape kept from the
 *  legibility study (exclamation read best; sparkle/eye didn't earn a slot). */
function createNoticeTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.shadowColor = 'rgba(255,170,80,0.95)';
  ctx.shadowBlur = 20;
  const grad = ctx.createLinearGradient(0, 16, 0, 112);
  grad.addColorStop(0, '#fff2c4');
  grad.addColorStop(1, '#ff9a3c');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(size / 2 - 11, 18, 22, 58, 11);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(size / 2, 100, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

let noticeShared = null;
function acquireNoticeTexture() {
  if (!noticeShared) noticeShared = { texture: createNoticeTexture(), refCount: 0 };
  noticeShared.refCount++;
  return noticeShared.texture;
}

function releaseNoticeTexture() {
  if (!noticeShared) return;
  noticeShared.refCount--;
  if (noticeShared.refCount <= 0) {
    noticeShared.texture.dispose();
    noticeShared = null;
  }
}

// ---------------------------------------------------------------------------
// public factory
// ---------------------------------------------------------------------------

export function buildAdventurerMesh(scene, archetype, opts = {}) {
  const type = ARCHETYPE_BUILDERS[archetype] ? archetype : 'fighter';
  const tier = ARCHETYPE_COLOR_TIERS[opts.colorTier] ? opts.colorTier : 'baseline';
  const haloMode =
    opts.haloMode === 'persist' || opts.haloMode === 'flash' ? opts.haloMode : 'none';
  const mats = acquireMaterials(type, tier);
  const sack = acquireSack();
  const halo = haloMode !== 'none' ? acquireHalo() : null;
  const noticeTexture = acquireNoticeTexture();

  const group = new THREE.Group();
  group.name = `adventurer:${type}`;
  scene.add(group);

  // All animation lives on this child pivot — `group` itself is left alone
  // for the caller to position every frame. The halo and notice icon are
  // deliberately children of `group` instead: the halo must stay flat on the
  // floor through the pivot's bob/tilt, and the notice icon's "north" offset
  // must stay screen-fixed regardless of which way the pivot is facing.
  const pivot = new THREE.Group();
  group.add(pivot);

  const built = ARCHETYPE_BUILDERS[type](ARCHETYPE_COLOR_TIERS[tier][type]);
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

  let haloMesh = null;
  let haloMat = null;
  if (halo) {
    haloMat = new THREE.MeshBasicMaterial({
      color: 0xfff0d0,
      map: halo.texture,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    haloMesh = new THREE.Mesh(halo.geo, haloMat);
    haloMesh.position.y = 0.012;
    haloMesh.visible = false;
    group.add(haloMesh);
  }

  const noticeMat = new THREE.SpriteMaterial({
    map: noticeTexture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const noticeSprite = new THREE.Sprite(noticeMat);
  noticeSprite.scale.set(0, 0, 0);
  noticeSprite.position.set(0, NOTICE_OFFSET_Y, NOTICE_OFFSET_Z);
  group.add(noticeSprite);

  const s = {
    t: 0,
    walkPhase: 0,
    facing: 0,
    swayZ: 0,
    leanX: 0,
    dissolving: false,
    dissolved: false,
    dissolveT: 0,
    // 'flashing' -> 'persist'|'hidden'|'off' (off = haloMode 'none', never shown)
    haloPhase: haloMode === 'none' ? 'off' : 'flashing',
    haloT: 0,
    wasSpotted: false,
    noticeActive: false,
    noticeT: 0,
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

    const swayTarget = fleeing
      ? Math.sin(s.walkPhase * 1.7) * PANIC_SWAY
      : Math.sin(s.walkPhase) * IDLE_SWAY;
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

    stepHalo(dt);
    stepNotice(dt, !!opts.spotted);
  }

  function stepHalo(dt) {
    if (s.haloPhase === 'off' || s.haloPhase === 'hidden' || s.haloPhase === 'persist') return;
    s.haloT += dt;
    if (s.haloT >= HALO_FLASH_TIME) {
      if (haloMode === 'persist') {
        haloMat.opacity = HALO_PERSIST_OPACITY;
        s.haloPhase = 'persist';
      } else {
        haloMesh.visible = false;
        s.haloPhase = 'hidden';
      }
      return;
    }
    const cyclePos = (s.haloT / HALO_FLASH_TIME) * HALO_FLASH_PULSES;
    const withinPulse = cyclePos % 1;
    haloMesh.visible = true;
    haloMat.opacity = Math.sin(withinPulse * Math.PI) * HALO_FLASH_PEAK;
  }

  // Edge-triggered off adv.spotted (see adventurer.js) rather than any state
  // transition, so it fires the same "oh!" beat whether or not a fresh
  // itemTaken/hunt flip happens to line up with the moment sight is gained.
  function stepNotice(dt, spotted) {
    if (spotted && !s.wasSpotted) {
      s.noticeActive = true;
      s.noticeT = 0;
    }
    s.wasSpotted = spotted;

    if (!s.noticeActive) return;
    s.noticeT += dt;
    if (s.noticeT >= NOTICE_TOTAL_TIME) {
      s.noticeActive = false;
      noticeSprite.scale.set(0, 0, 0);
      return;
    }
    let scale;
    let opacity;
    let rise = 0;
    if (s.noticeT < NOTICE_POP_TIME) {
      const p = THREE.MathUtils.smoothstep(s.noticeT, 0, NOTICE_POP_TIME);
      scale =
        p < 0.7
          ? THREE.MathUtils.lerp(0, 1.2, p / 0.7)
          : THREE.MathUtils.lerp(1.2, 1, (p - 0.7) / 0.3);
      opacity = p;
    } else if (s.noticeT < NOTICE_HOLD_TIME) {
      scale = 1;
      opacity = 1;
    } else {
      const p = THREE.MathUtils.smoothstep(s.noticeT, NOTICE_HOLD_TIME, NOTICE_TOTAL_TIME);
      scale = THREE.MathUtils.lerp(1, 0.82, p);
      opacity = 1 - p;
      rise = p * R * 0.4;
    }
    noticeSprite.scale.set(NOTICE_SIZE * scale, NOTICE_SIZE * scale, 1);
    noticeMat.opacity = opacity;
    noticeSprite.position.y = NOTICE_OFFSET_Y + rise;
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
    s.haloPhase = haloMode === 'none' ? 'off' : 'flashing';
    s.haloT = 0;
    if (haloMesh) {
      haloMesh.visible = false;
      haloMat.opacity = 0;
    }
    s.wasSpotted = false;
    s.noticeActive = false;
    s.noticeT = 0;
    noticeSprite.scale.set(0, 0, 0);
  }

  function dispose() {
    scene.remove(group);
    bodyGeo.dispose();
    gearGeo.dispose();
    if (glowGeo) glowGeo.dispose();
    sackGeo.dispose();
    shineGeo.dispose();
    if (haloMat) haloMat.dispose();
    if (halo) releaseHalo();
    noticeMat.dispose();
    releaseNoticeTexture();
    releaseMaterials(type, tier);
    releaseSack();
  }

  return { group, update, playDissolve, reset, dispose };
}
