/**
 * WS-C — the gelatinous cube: a wobbling jelly body with a half-digested
 * adventurer tumbling inside. See docs/SPEC.md §5 for the CubeView contract.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { OOZE_COLORS, CUBE_RADIUS, DRIED_WARNING_TIME, DIGEST_TIME, DIRS } from '../config.js';

const R = CUBE_RADIUS;
const BODY_SIZE = R * 2;
const BODY_SEG = 10;
const BODY_ROUNDNESS = 0.62;
const DRIED_COLOR = new THREE.Color(0x6b5d4c);
const DRIED_SHRINK = 0.85;
const SPEED_STRETCH_REF = 6; // tiles/sec used to normalize squash-and-stretch strength

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

/** Box pushed toward a sphere by `roundness` (0=box, 1=sphere) — cheap rounded cube. */
function roundedCubeGeometry(size, seg, roundness) {
  const geo = new THREE.BoxGeometry(size, size, size, seg, seg, seg);
  const pos = geo.attributes.position;
  const half = size / 2;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const nx = v.x / half,
      ny = v.y / half,
      nz = v.z / half;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    const bx = THREE.MathUtils.lerp(nx, nx / len, roundness);
    const by = THREE.MathUtils.lerp(ny, ny / len, roundness);
    const bz = THREE.MathUtils.lerp(nz, nz / len, roundness);
    pos.setXYZ(i, bx * half, by * half, bz * half);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Bake each part's local transform into its geometry, then merge into one draw call. */
function mergeParts(parts) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const baked = parts.map(({ geometry, position, rotation, scale }) => {
    const g = geometry.clone();
    p.set(...(position || [0, 0, 0]));
    q.setFromEuler(new THREE.Euler(...(rotation || [0, 0, 0])));
    s.set(...(scale || [1, 1, 1]));
    m.compose(p, q, s);
    g.applyMatrix4(m);
    geometry.dispose();
    return g;
  });
  const merged = mergeGeometries(baked, false);
  baked.forEach((g) => g.dispose());
  return merged;
}

function tintVertexColors(geo, baseColor, variance) {
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const k = 1 - variance + Math.random() * variance;
    c.copy(baseColor).multiplyScalar(k);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// ---------------------------------------------------------------------------
// procedural textures
// ---------------------------------------------------------------------------

function makeCrackTexture() {
  const size = 256;
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = size;
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(20,14,10,0.95)';
  ctx.lineCap = 'round';
  const branch = (x, y, angle, len, depth) => {
    if (depth <= 0 || len < 4) return;
    const x2 = x + Math.cos(angle) * len;
    const y2 = y + Math.sin(angle) * len;
    ctx.lineWidth = Math.max(0.6, depth * 0.9);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const branches = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < branches; i++) {
      branch(
        x2,
        y2,
        angle + (Math.random() - 0.5) * 1.4,
        len * (0.55 + Math.random() * 0.25),
        depth - 1,
      );
    }
  };
  const seeds = 5;
  for (let i = 0; i < seeds; i++) {
    branch(Math.random() * size, Math.random() * size, Math.random() * Math.PI * 2, size * 0.22, 4);
  }
  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeShieldDeviceTexture() {
  const size = 128;
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = size;
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);
  ctx.fillStyle = '#8a1c1c';
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.34);
  ctx.lineTo(size * 0.28, size * 0.1);
  ctx.lineTo(0, size * 0.34);
  ctx.lineTo(-size * 0.28, size * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#e8d488';
  ctx.lineWidth = size * 0.045;
  ctx.stroke();
  const tex = new THREE.CanvasTexture(cvs);
  return tex;
}

// ---------------------------------------------------------------------------
// skeleton + gear part builders (all merged down to one draw call each)
// ---------------------------------------------------------------------------

function buildSkullGeo() {
  return mergeParts([
    { geometry: new THREE.SphereGeometry(R * 0.22, 10, 8) },
    {
      geometry: new THREE.BoxGeometry(R * 0.3, R * 0.06, R * 0.1),
      position: [0, -R * 0.04, R * 0.17],
    },
    {
      geometry: new THREE.BoxGeometry(R * 0.22, R * 0.09, R * 0.16),
      position: [0, -R * 0.18, R * 0.1],
      rotation: [0.25, 0, 0],
    },
  ]);
}

function buildEyeSocketsGeo() {
  return mergeParts([
    {
      geometry: new THREE.SphereGeometry(R * 0.05, 6, 6),
      position: [R * 0.1, -R * 0.02, R * 0.19],
    },
    {
      geometry: new THREE.SphereGeometry(R * 0.05, 6, 6),
      position: [-R * 0.1, -R * 0.02, R * 0.19],
    },
  ]);
}

function buildRibcageGeo() {
  const parts = [];
  const n = 4;
  for (let i = 0; i < n; i++) {
    const z = -R * 0.18 + (i / (n - 1)) * R * 0.36;
    parts.push({
      geometry: new THREE.BoxGeometry(R * 0.055, R * 0.055, R * 0.055),
      position: [0, 0, z],
    });
    parts.push({
      geometry: new THREE.TorusGeometry(R * 0.17, R * 0.015, 5, 10, Math.PI * 0.85),
      position: [0, -R * 0.02, z],
      rotation: [Math.PI / 2, 0, Math.PI / 2 + Math.PI * 0.075],
    });
  }
  return mergeParts(parts);
}

function buildFemurGeo() {
  return mergeParts([
    {
      geometry: new THREE.CapsuleGeometry(R * 0.032, R * 0.3, 3, 6),
      rotation: [0, 0, Math.PI / 2],
    },
    { geometry: new THREE.SphereGeometry(R * 0.055, 7, 6), position: [-R * 0.17, 0, 0] },
    { geometry: new THREE.SphereGeometry(R * 0.06, 7, 6), position: [R * 0.17, 0, 0] },
  ]);
}

function buildSwordGeo() {
  return mergeParts([
    { geometry: new THREE.BoxGeometry(R * 0.05, R * 0.018, R * 0.36), position: [0, 0, R * 0.05] },
    {
      geometry: new THREE.ConeGeometry(R * 0.032, R * 0.1, 4),
      position: [0, 0, R * 0.28],
      rotation: [Math.PI / 2, Math.PI / 4, 0],
    },
    { geometry: new THREE.BoxGeometry(R * 0.16, R * 0.02, R * 0.03), position: [0, 0, -R * 0.14] },
    {
      geometry: new THREE.CylinderGeometry(R * 0.018, R * 0.018, R * 0.12, 6),
      position: [0, 0, -R * 0.21],
      rotation: [Math.PI / 2, 0, 0],
    },
    { geometry: new THREE.SphereGeometry(R * 0.032, 6, 6), position: [0, 0, -R * 0.28] },
  ]);
}

function buildShieldBaseGeo() {
  return mergeParts([
    {
      geometry: new THREE.SphereGeometry(R * 0.22, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.42),
      rotation: [Math.PI, 0, 0],
    },
    { geometry: new THREE.TorusGeometry(R * 0.21, R * 0.018, 5, 16), position: [0, 0.001, 0] },
    { geometry: new THREE.SphereGeometry(R * 0.05, 8, 6), position: [0, R * 0.02, 0] },
  ]);
}

// ---------------------------------------------------------------------------
// public factory
// ---------------------------------------------------------------------------

export function buildCube(scene, colorId) {
  const disposables = { geos: new Set(), mats: new Set(), texs: new Set() };
  const track = (obj, set) => {
    set.add(obj);
    return obj;
  };

  const group = new THREE.Group();
  scene.add(group);

  const driftPivot = new THREE.Group();
  group.add(driftPivot);

  // -- body ------------------------------------------------------------
  const bodyGeo = track(roundedCubeGeometry(BODY_SIZE, BODY_SEG, BODY_ROUNDNESS), disposables.geos);
  const palette = OOZE_COLORS.find((c) => c.id === colorId) || OOZE_COLORS[0];
  const coreColor = new THREE.Color(palette.core);
  const rimColor = new THREE.Color(palette.rim);
  const glowColor = new THREE.Color(palette.glow);

  const bodyMat = track(
    new THREE.MeshPhysicalMaterial({
      color: coreColor,
      transmission: 0.88,
      roughness: 0.14,
      metalness: 0,
      thickness: BODY_SIZE * 0.6,
      ior: 1.28,
      attenuationColor: coreColor,
      attenuationDistance: 0.55,
      iridescence: 0.35,
      iridescenceIOR: 1.3,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
      emissive: glowColor,
      emissiveIntensity: 0.06,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
    }),
    disposables.mats,
  );

  let shaderRef = null;
  bodyMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uAmp = { value: 0.02 };
    shader.uniforms.uBulge = { value: 0 };
    shader.uniforms.uRimColor = { value: new THREE.Color(rimColor) };
    shader.uniforms.uRimStrength = { value: 0.6 };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `uniform float uTime;\nuniform float uAmp;\nuniform float uBulge;\n#include <common>`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float w = sin(transformed.x * 3.1 + uTime * 2.1) *
                    sin(transformed.y * 2.6 + uTime * 1.7) *
                    sin(transformed.z * 3.4 + uTime * 2.4);
          transformed += normal * (w * uAmp + uBulge);
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `uniform vec3 uRimColor;\nuniform float uRimStrength;\n#include <common>`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float fresnel = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 2.2);
          totalEmissiveRadiance += uRimColor * fresnel * uRimStrength;
        }`,
      );
    shaderRef = shader;
  };
  // force compile so uniforms exist before first update()
  bodyMat.needsUpdate = true;

  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  driftPivot.add(bodyMesh);

  // -- dried crack overlay ----------------------------------------------
  const crackTex = track(makeCrackTexture(), disposables.texs);
  const crackMat = track(
    new THREE.MeshBasicMaterial({
      map: crackTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
    disposables.mats,
  );
  const crackMesh = new THREE.Mesh(bodyGeo, crackMat);
  crackMesh.scale.setScalar(1.01);
  crackMesh.visible = false;
  driftPivot.add(crackMesh);

  // -- contents ----------------------------------------------------------
  const contentsGroup = new THREE.Group();
  driftPivot.add(contentsGroup);

  // a soft light from inside the goo — without it the transmissive shell
  // reads as near-black and the floating bones are unreadable at a distance.
  const innerLight = new THREE.PointLight(glowColor, 2.2, BODY_SIZE * 2.6, 2);
  contentsGroup.add(innerLight);

  // contents get a faint self-lit tint so they still read once wrapped in the
  // translucent, dimly-lit body — relying purely on external scene lights
  // left them nearly invisible inside the goo.
  const boneMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xe9e3d2,
      roughness: 0.75,
      metalness: 0,
      transparent: true,
      opacity: 0.9,
      emissive: 0x4a4230,
      emissiveIntensity: 0.25,
    }),
    disposables.mats,
  );
  const darkMat = track(
    new THREE.MeshStandardMaterial({ color: 0x0c0a0f, roughness: 0.6 }),
    disposables.mats,
  );
  const steelGeoTint = track(
    tintVertexColors(buildSwordGeo(), new THREE.Color(0x9aa4ad), 0.35),
    disposables.geos,
  );
  const steelMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.7,
      roughness: 0.55,
      vertexColors: true,
      emissive: 0x3a4048,
      emissiveIntensity: 0.2,
    }),
    disposables.mats,
  );
  const woodMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x5b3d24,
      roughness: 0.8,
      emissive: 0x2a1810,
      emissiveIntensity: 0.2,
    }),
    disposables.mats,
  );
  const goldMat = track(
    new THREE.MeshStandardMaterial({ color: 0xffcf4d, metalness: 0.85, roughness: 0.35 }),
    disposables.mats,
  );
  const deviceTex = track(makeShieldDeviceTexture(), disposables.texs);
  const deviceMat = track(
    new THREE.MeshBasicMaterial({ map: deviceTex, transparent: true, depthWrite: false }),
    disposables.mats,
  );

  const skullGeo = track(buildSkullGeo(), disposables.geos);
  const eyeGeo = track(buildEyeSocketsGeo(), disposables.geos);
  const ribGeo = track(buildRibcageGeo(), disposables.geos);
  const femurGeo = track(buildFemurGeo(), disposables.geos);
  const shieldGeo = track(buildShieldBaseGeo(), disposables.geos);
  const deviceGeo = track(new THREE.CircleGeometry(R * 0.17, 16), disposables.geos);
  const coinGeo = track(
    new THREE.CylinderGeometry(R * 0.06, R * 0.06, R * 0.02, 8),
    disposables.geos,
  );

  const skullGroup = new THREE.Group();
  skullGroup.add(new THREE.Mesh(skullGeo, boneMat), new THREE.Mesh(eyeGeo, darkMat));

  const ribGroup = new THREE.Group();
  ribGroup.add(new THREE.Mesh(ribGeo, boneMat));

  const femur1 = new THREE.Mesh(femurGeo, boneMat);
  const femur2 = new THREE.Mesh(femurGeo, boneMat);

  const swordGroup = new THREE.Group();
  swordGroup.add(new THREE.Mesh(steelGeoTint, steelMat));

  const shieldGroup = new THREE.Group();
  const shieldBase = new THREE.Mesh(shieldGeo, woodMat);
  const shieldDevice = new THREE.Mesh(deviceGeo, deviceMat);
  shieldDevice.position.y = R * 0.09;
  shieldDevice.rotation.x = -Math.PI / 2;
  shieldGroup.add(shieldBase, shieldDevice);

  const coinCap = 12;
  const coinMesh = new THREE.InstancedMesh(coinGeo, goldMat, coinCap);
  coinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const coinLocal = new Array(coinCap).fill(0).map(() => ({
    x: (Math.random() - 0.5) * R * 0.7,
    z: (Math.random() - 0.5) * R * 0.7,
    rot: Math.random() * Math.PI,
    phase: Math.random() * Math.PI * 2,
  }));

  contentsGroup.add(skullGroup, ribGroup, femur1, femur2, swordGroup, shieldGroup, coinMesh);

  const floaters = [
    {
      g: skullGroup,
      r: R * 0.16,
      speed: 0.35,
      phase: 0.0,
      ry: 0.6,
      rx: 0.2,
      rz: 0.1,
      by: R * 0.1,
      amp: R * 0.06,
    },
    {
      g: ribGroup,
      r: R * 0.1,
      speed: -0.22,
      phase: 1.4,
      ry: 0.15,
      rx: 0.35,
      rz: 0.05,
      by: -R * 0.02,
      amp: R * 0.05,
    },
    {
      g: femur1,
      r: R * 0.2,
      speed: 0.28,
      phase: 2.6,
      ry: 0.5,
      rx: 0.7,
      rz: 0.4,
      by: -R * 0.12,
      amp: R * 0.07,
    },
    {
      g: femur2,
      r: R * 0.22,
      speed: -0.31,
      phase: 4.1,
      ry: -0.4,
      rx: 0.3,
      rz: -0.6,
      by: -R * 0.16,
      amp: R * 0.06,
    },
    {
      g: swordGroup,
      r: R * 0.24,
      speed: 0.4,
      phase: 3.0,
      ry: 0.9,
      rx: 0.1,
      rz: 0.1,
      by: R * 0.02,
      amp: R * 0.08,
    },
    {
      g: shieldGroup,
      r: R * 0.19,
      speed: -0.26,
      phase: 5.2,
      ry: 0.2,
      rx: 0.15,
      rz: 0.55,
      by: -R * 0.06,
      amp: R * 0.05,
    },
  ];

  // -- mutable animation state -------------------------------------------
  const s = {
    t: 0,
    driedFactor: 0,
    driftRotY: 0,
    gulpT: null,
    wasDigesting: false,
    scaleCur: new THREE.Vector3(1, 1, 1),
    coreColor,
    rimColor,
    glowColor,
  };

  function setColor(id) {
    const p = OOZE_COLORS.find((c) => c.id === id) || OOZE_COLORS[0];
    s.coreColor.set(p.core);
    s.rimColor.set(p.rim);
    s.glowColor.set(p.glow);
    if (shaderRef) shaderRef.uniforms.uRimColor.value.copy(s.rimColor);
    bodyMat.emissive.copy(s.glowColor);
    bodyMat.attenuationColor.copy(s.coreColor);
    innerLight.color.copy(s.glowColor);
  }
  setColor(colorId);

  function update(dt, opts = {}) {
    const dried = !!opts.dried;
    const driedRatio = opts.driedRatio ?? (dried ? 1 : 0);
    const moveDir = opts.moveDir ?? -1;
    const speed = opts.speed ?? 0;
    const digesting = !!opts.digesting;
    const coinCount = Math.max(0, Math.min(coinCap, Math.round(opts.coinCount ?? 0)));

    s.t += dt;
    const t = s.t;

    // smooth dried transition + late-stage blink (pulses back toward healthy).
    // driedRatio is a 1->0 fraction of the dried duration remaining; we don't
    // receive the absolute duration here, so BLINK_RATIO approximates "last
    // DRIED_WARNING_TIME seconds" against a typical driedDuration (~7s @ normal
    // difficulty: 2.5/7 ~= 0.36). If callers can supply exact seconds, prefer
    // opts.driedSecondsLeft (optional) for a precise threshold instead.
    const target = dried ? 1 : 0;
    s.driedFactor += (target - s.driedFactor) * Math.min(1, dt * 4);
    let blink = 0;
    const secondsLeft = opts.driedSecondsLeft;
    const warning =
      secondsLeft !== undefined ? secondsLeft < DRIED_WARNING_TIME : dried && driedRatio < 0.36;
    if (warning) blink = 0.5 + 0.5 * Math.sin(t * 14);
    const eff = s.driedFactor * (1 - blink * 0.6);

    if (shaderRef) shaderRef.uniforms.uTime.value = t;

    // digest gulp envelope (retriggers on the false->true edge)
    if (digesting && !s.wasDigesting) s.gulpT = 0;
    s.wasDigesting = digesting;
    let gulp = 0;
    if (s.gulpT !== null) {
      s.gulpT += dt;
      const p = Math.min(1, s.gulpT / DIGEST_TIME);
      gulp = Math.sin(p * Math.PI) * 0.1 + Math.sin(p * Math.PI * 4) * 0.03 * Math.exp(-p * 6);
      if (p >= 1) s.gulpT = null;
    }
    if (shaderRef) shaderRef.uniforms.uBulge.value = gulp;
    if (shaderRef) shaderRef.uniforms.uAmp.value = THREE.MathUtils.lerp(0.02, 0.006, eff);

    // squash-and-stretch along the travel axis
    const stretchAmt = Math.min(0.16, (speed / SPEED_STRETCH_REF) * 0.22) * (1 - eff * 0.7);
    let tx = 1,
      ty = 1,
      tz = 1;
    if (moveDir !== -1 && speed > 0.05) {
      const d = DIRS[moveDir];
      if (d.dc !== 0) {
        tx = 1 + stretchAmt;
        tz = 1 - stretchAmt * 0.6;
        ty = 1 - stretchAmt * 0.4;
      } else {
        tz = 1 + stretchAmt;
        tx = 1 - stretchAmt * 0.6;
        ty = 1 - stretchAmt * 0.4;
      }
    }
    const lerpRate = Math.min(1, dt * 10);
    s.scaleCur.x += (tx - s.scaleCur.x) * lerpRate;
    s.scaleCur.y += (ty - s.scaleCur.y) * lerpRate;
    s.scaleCur.z += (tz - s.scaleCur.z) * lerpRate;

    const shrink = THREE.MathUtils.lerp(1, DRIED_SHRINK, eff);
    const gulpScale = 1 + gulp;
    bodyMesh.scale.set(
      s.scaleCur.x * shrink * gulpScale,
      s.scaleCur.y * shrink * gulpScale,
      s.scaleCur.z * shrink * gulpScale,
    );
    crackMesh.scale.copy(bodyMesh.scale).multiplyScalar(1.01);
    crackMesh.visible = eff > 0.01;
    crackMat.opacity = eff * 0.85;

    // material: healthy jelly -> dried crust
    bodyMat.roughness = THREE.MathUtils.lerp(0.14, 0.85, eff);
    bodyMat.transmission = THREE.MathUtils.lerp(1, 0.05, eff);
    bodyMat.clearcoat = THREE.MathUtils.lerp(0.6, 0.08, eff);
    bodyMat.iridescence = THREE.MathUtils.lerp(0.35, 0, eff);
    bodyMat.color.copy(s.coreColor).lerp(DRIED_COLOR, eff);
    bodyMat.emissiveIntensity = THREE.MathUtils.lerp(0.06, 0.015, eff);
    if (shaderRef) shaderRef.uniforms.uRimStrength.value = THREE.MathUtils.lerp(0.6, 0.15, eff);
    innerLight.intensity = THREE.MathUtils.lerp(2.2, 0.4, eff) * (1 + gulp * 1.5);

    // overall bob / drift -> stiff shudder when dried
    const bobY = Math.sin(t * 1.1) * R * 0.05;
    const shudderY = Math.sin(t * 41) * R * 0.012 + Math.sin(t * 57 + 1.1) * R * 0.008;
    driftPivot.position.y = THREE.MathUtils.lerp(bobY, shudderY, eff);
    s.driftRotY += 0.15 * (1 - eff * 0.9) * dt;
    driftPivot.rotation.y = s.driftRotY;
    driftPivot.rotation.x = Math.sin(t * 37) * 0.01 * eff;
    driftPivot.rotation.z = Math.sin(t * 31 + 0.7) * 0.01 * eff;

    // contents: independent tumble + slump to the bottom when dried
    for (const f of floaters) {
      const orbitR = f.r * (1 - eff * 0.8);
      const ang = f.phase + t * f.speed;
      const slumpY = -R * 0.28;
      const by = THREE.MathUtils.lerp(f.by, slumpY, eff);
      f.g.position.set(
        Math.cos(ang) * orbitR,
        by + Math.sin(t * 0.7 + f.phase) * f.amp * (1 - eff * 0.6),
        Math.sin(ang) * orbitR * 0.7,
      );
      const rate = 1 - eff * 0.85;
      f.g.rotation.x += f.rx * dt * rate;
      f.g.rotation.y += f.ry * dt * rate;
      f.g.rotation.z += f.rz * dt * rate;
    }

    // coin pile settling in the goo floor
    const dummy = update._dummy || (update._dummy = new THREE.Object3D());
    const bottomY = THREE.MathUtils.lerp(-R * 0.32, -R * 0.4, eff);
    for (let i = 0; i < coinCap; i++) {
      const c = coinLocal[i];
      if (i < coinCount) {
        dummy.position.set(c.x, bottomY + Math.sin(t * 0.9 + c.phase) * R * 0.01, c.z);
        dummy.rotation.set(Math.PI / 2 + Math.sin(t * 0.3 + c.phase) * 0.15, c.rot, 0);
        dummy.scale.setScalar(1);
      } else {
        dummy.scale.setScalar(0);
      }
      dummy.updateMatrix();
      coinMesh.setMatrixAt(i, dummy.matrix);
    }
    coinMesh.instanceMatrix.needsUpdate = true;
  }

  function dispose() {
    scene.remove(group);
    disposables.geos.forEach((g) => g.dispose());
    disposables.mats.forEach((m) => m.dispose());
    disposables.texs.forEach((t) => t.dispose());
  }

  return { group, update, setColor, dispose };
}
