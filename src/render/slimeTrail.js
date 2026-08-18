/**
 * WS-C — pooled slime splats left behind by the cube. See docs/SPEC.md §5.
 *
 * Contract signature is `update(dt, x, z, moving)`. This module additionally
 * accepts an optional 5th argument, `dried`, to suppress dropping new splats
 * while the cube is desiccated (documented in the WS-C report — a dried cube
 * has no slime to give). Callers that only pass 4 args keep working; `dried`
 * simply defaults to false.
 */
import * as THREE from 'three';
import { OOZE_COLORS } from '../config.js';

const POOL = 64;
const SPLAT_LIFETIME = 2.5;
const DROP_SPACING = 0.16; // world units between drops (splat radius ~0.22, so they overlap)
const JUMP_DIST = 3; // a per-frame move bigger than this is a wrap teleport, not real travel
const BASE_RADIUS = 0.22;

function makeSplatTexture() {
  const size = 64;
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = size;
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);
  const lobes = 7;
  ctx.beginPath();
  for (let i = 0; i <= lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    const rad = size * 0.32 * (0.72 + Math.random() * 0.34);
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.34);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fill();
  const tex = new THREE.CanvasTexture(cvs);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export function createSlimeTrail(scene, colorId) {
  const geo = new THREE.PlaneGeometry(BASE_RADIUS * 2, BASE_RADIUS * 2);
  geo.rotateX(-Math.PI / 2);
  const alphaArr = new Float32Array(POOL);
  const alphaAttr = new THREE.InstancedBufferAttribute(alphaArr, 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aAlpha', alphaAttr);

  const tex = makeSplatTexture();
  const palette = OOZE_COLORS.find((c) => c.id === colorId) || OOZE_COLORS[0];
  const material = new THREE.MeshBasicMaterial({
    map: tex,
    color: new THREE.Color(palette.core),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `attribute float aAlpha;\nvarying float vAlpha;\n#include <common>`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvAlpha = aAlpha;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `varying float vAlpha;\n#include <common>`)
      .replace('#include <map_fragment>', `#include <map_fragment>\ndiffuseColor.a *= vAlpha;`);
  };

  const mesh = new THREE.InstancedMesh(geo, material, POOL);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.position.y = 0.02;
  scene.add(mesh);

  // instanceMatrix starts zero-filled (not identity) — zero-scale every slot
  // up front so nothing renders before the first update() call.
  {
    const initDummy = new THREE.Object3D();
    initDummy.scale.setScalar(0);
    initDummy.updateMatrix();
    for (let i = 0; i < POOL; i++) mesh.setMatrixAt(i, initDummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }

  // per-slot state, plain typed/parallel arrays — zero per-frame allocation
  const px = new Float32Array(POOL);
  const pz = new Float32Array(POOL);
  const rot = new Float32Array(POOL);
  const scl = new Float32Array(POOL);
  const life = new Float32Array(POOL); // seconds remaining, <=0 = dead
  const variance = new Float32Array(POOL).fill(1);
  let cursor = 0;

  let lastX = null;
  let lastZ = null;
  let distSinceDrop = 0;

  const dummy = new THREE.Object3D();
  const tintColor = new THREE.Color(palette.core);
  const glowColor = new THREE.Color(palette.glow);

  function dropSplat(x, z) {
    const i = cursor;
    cursor = (cursor + 1) % POOL;
    px[i] = x;
    pz[i] = z;
    rot[i] = Math.random() * Math.PI * 2;
    scl[i] = 0.75 + Math.random() * 0.6;
    life[i] = SPLAT_LIFETIME;
    variance[i] = 0.8 + Math.random() * 0.4;
  }

  function setColor(id) {
    const p = OOZE_COLORS.find((c) => c.id === id) || OOZE_COLORS[0];
    tintColor.set(p.core);
    glowColor.set(p.glow);
    material.color.copy(tintColor);
  }

  function update(dt, x, z, moving, dried = false) {
    if (lastX !== null) {
      const dx = x - lastX;
      const dz = z - lastZ;
      const jump = Math.hypot(dx, dz) > JUMP_DIST;
      if (jump) {
        // wrap teleport: start a fresh segment, no connecting streak
        distSinceDrop = 0;
      } else if (moving && !dried) {
        distSinceDrop += Math.hypot(dx, dz);
        while (distSinceDrop >= DROP_SPACING) {
          dropSplat(x, z);
          distSinceDrop -= DROP_SPACING;
        }
      }
    }
    lastX = x;
    lastZ = z;

    for (let i = 0; i < POOL; i++) {
      if (life[i] <= 0) {
        if (life[i] !== -1) {
          dummy.position.set(0, 0, 0);
          dummy.scale.setScalar(0);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          alphaArr[i] = 0;
          life[i] = -1;
        }
        continue;
      }
      life[i] -= dt;
      const t = Math.max(0, life[i] / SPLAT_LIFETIME);
      const fade = t * t; // ease-out fade
      const shrink = THREE.MathUtils.lerp(0.5, 1, t);
      dummy.position.set(px[i], 0, pz[i]);
      dummy.rotation.set(0, rot[i], 0);
      dummy.scale.setScalar(scl[i] * shrink);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      alphaArr[i] = fade * 0.85 * variance[i];
    }
    mesh.instanceMatrix.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  }

  function reset() {
    life.fill(0);
    lastX = null;
    lastZ = null;
    distSinceDrop = 0;
    for (let i = 0; i < POOL; i++) alphaArr[i] = 0;
    alphaAttr.needsUpdate = true;
  }

  function dispose() {
    scene.remove(mesh);
    geo.dispose();
    material.dispose();
    tex.dispose();
  }

  return { update, setColor, reset, dispose };
}
